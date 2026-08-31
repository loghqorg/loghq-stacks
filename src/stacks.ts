/**
 * The Stacks adapter: one call, and the app's own log stream ships to loghq.
 *
 * A Stacks application already logs. It has `log.info` / `log.error` at every
 * interesting point and a `log.struct` namespace for the framework's own
 * events. The job of this file is to drain that stream without asking anyone to
 * rewrite a single call site, which is why the whole surface is `install()`.
 *
 * Two seams exist, probed in preference order at runtime:
 *
 *   1. A transport registry on `@stacksjs/logging`. This is where a logger is
 *      supposed to be extended. It landed upstream as `registerTransport()`
 *      plus a `transports` key on `config/logging.ts`, so a modern framework
 *      version takes this branch. See {@link tryTransport}, and
 *      {@link loghqTransport} for the declarative form.
 *   2. Teeing the mutable `log` singleton. Stacks exports `log` as a plain
 *      object whose methods are reassignable, and `log.struct` routes back
 *      through those same methods, so wrapping six functions captures both the
 *      ad-hoc and the structured stream. This is the fallback on a framework
 *      version that predates the registry.
 *
 * The recursion hazard is the thing to understand before changing anything
 * here. We are wrapping the very logger the SDK would reach for if it ever
 * reported a problem, so a transport failure logged through `log.error` would
 * arrive back at the wrapper that produced it. Every diagnostic in this file
 * goes to `console` directly, and {@link forward} holds a module-level
 * re-entrancy flag so a fault inside the forward path cannot start a second
 * one.
 */

import type { DisabledReason, LogHQConfig, LogHQEntry, LogHQLevel, StacksLogRecord, StacksLogTransport } from './types'
import { LogHQClient } from './client'
import { atLeast, isLossy, toLogHQLevel } from './levels'

/** Options the adapter adds on top of {@link LogHQConfig}. */
export interface StacksOptions {
  /**
   * Install process-level handlers for uncaught exceptions and unhandled
   * rejections. Default `true`.
   *
   * A crash never reaches `log.*`, so the last and most interesting thing the
   * process did would otherwise be the one thing missing from the stream.
   */
  captureUnhandled?: boolean

  /**
   * Forward `log.struct` events: `http.request`, `db.query`, `db.slow_query`,
   * `job.*`, `cache.*`. Default `true`.
   *
   * Worth turning off once the framework emits these per request and the volume
   * costs more quota than the visibility is worth.
   */
  captureStruct?: boolean

  /**
   * The Stacks `log` singleton, or the whole `@stacksjs/logging` namespace,
   * handed over explicitly.
   *
   * Skips the runtime probe, which is the only way to attach synchronously and
   * the seam tests use to attach to a double. Applications should leave it
   * unset and let `install()` find the real one.
   */
  logger?: unknown
}

/** Options {@link loghqTransport} adds on top of {@link LogHQConfig}. */
export interface TransportOptions {
  /**
   * The transport's name in the framework's diagnostics. Default `loghq`.
   *
   * Worth changing only when an app declares two of these, e.g. one project for
   * application logs and another for audit.
   */
  name?: string

  /** Forward `log.struct` events. Default `true`. See {@link StacksOptions}. */
  captureStruct?: boolean
}

/**
 * Which attachment point the adapter ended up using.
 *
 * `conflict` means another copy of this package in the same process already
 * owns the logger, so this installation is inert. It is reported separately
 * from `none` because the fix is completely different: `none` means no logger
 * was found, `conflict` means one was found and someone else got there first.
 */
export type LoggerSeam = 'transport' | 'tee' | 'none' | 'conflict'

export interface SeamInfo {
  seam: LoggerSeam
  /** The exact entry point taken, e.g. `registerTransport` or `log.*`. Null when unattached. */
  via: string | null
}

/**
 * A seam, plus whether anything will actually come out of it.
 *
 * Attachment and delivery are separate failures and only the first is visible
 * from the outside. A transport with no ingest key attaches perfectly: the
 * logger holds it, it is called for every record, and it drops all of them,
 * because the client disabled itself on construction. Reporting that as
 * attached is true and useless — it is exactly the state an app sits in when
 * `LOGHQ_KEY` never reached the box.
 */
export interface AttachmentInfo extends SeamInfo {
  /** True when the client behind this seam will send. */
  live: boolean
  /**
   * Why the client stopped, when it diagnosed a failure — `auth` for a missing
   * or rejected key. Null both when nothing is wrong and when the client is
   * merely configured `enabled: false`, so check {@link live} first.
   */
  disabledReason: DisabledReason | null
  /**
   * Whether {@link live} was measured or assumed.
   *
   * False when the logger holds a matching transport this copy of the package
   * did not build — another copy did, and its client is not reachable from
   * here. `live` is then optimistic. Assert on this too if you would rather a
   * boot check be strict than forgiving.
   */
  introspected: boolean
}

/** The Stacks logger methods worth draining. `toLogHQLevel` maps each name. */
const TEE_METHODS = ['info', 'success', 'warn', 'warning', 'error', 'debug'] as const

/**
 * Marks a function as one of ours.
 *
 * `Symbol.for` rather than a private symbol so that two copies of this package
 * in one process (a hoisting accident, or an app and a plugin on different
 * versions) recognize each other's wrappers instead of stacking a second layer
 * on the first.
 */
const WRAPPED = Symbol.for('loghq.stacks.wrapped')

/** Function names a transport registry might plausibly ship under. */
const REGISTRARS = ['registerTransport', 'addTransport', 'registerSink', 'addSink'] as const

/** Resolved lazily and never statically, so bundlers do not try to resolve it. */
const LOGGING_MODULE = '@stacksjs/logging'

const MAX_DEPTH = 4
const MAX_ITEMS = 50
const MAX_STRING = 4096
const MAX_CAUSES = 3

interface Installation {
  client: LogHQClient
  debug: boolean
  captureStruct: boolean
  seam: LoggerSeam
  via: string | null
  /** Undo steps, run newest first by {@link uninstall}. */
  restore: Array<() => void>
  /** `getLogContext` from the host, when the host gave us one. */
  getLogContext: (() => unknown) | null
  /** Install generation, so an async attach that lost a race can stand down. */
  token: number
}

interface LoggingHandle {
  ns: Record<string, unknown>
  log: Record<string, unknown>
}

/** What {@link teeLog} managed to do to the log singleton. */
interface TeeResult {
  /** Methods this installation now owns. */
  wrapped: number
  /** Methods already carrying our marker, so owned by another copy. */
  foreign: number
}

let current: Installation | null = null
let attaching: Promise<SeamInfo> | null = null
let generation = 0

/**
 * Transport object → the installation behind it, for {@link verifyAttached}.
 *
 * A declared transport hands the logger `{ name, log, flush }` and keeps its
 * client in a closure, so the object the logger holds cannot answer whether it
 * will actually send. This is the way back. Weak, so a transport dropped by a
 * reloaded config does not pin its client.
 *
 * Note this is a lookup table, not a signal: presence here means "constructed",
 * which happens whether or not the framework ever reads the config. Only
 * `transports()` proves attachment, and this map is consulted after it.
 */
const declaredTransports = new WeakMap<StacksLogTransport, Installation>()

/**
 * The forward path is running.
 *
 * Module level and not per-install, because the point is to stop a cycle that
 * crosses instances. Safe as a plain boolean only because the forward path is
 * strictly synchronous: it serializes and enqueues, it never awaits, and the
 * transport is the client's problem on its own timer.
 */
let forwarding = false

// --- Public surface ---------------------------------------------------------

/**
 * Start streaming this Stacks app's logs to loghq.
 *
 * Returns immediately with a live client. When the logger has to be discovered
 * by dynamic import the attachment lands a microtask later, so lines emitted in
 * the same tick as `install()` can be missed. Pass `logger` or await
 * {@link whenAttached} if that matters.
 */
export function install(config: LogHQConfig & StacksOptions): LogHQClient {
  // Idempotent by teardown rather than by early return. Hot reload calls
  // install() again on every rebuild, often with changed config, and a second
  // wrap over the first would duplicate every line for the rest of the process.
  // Restoring first guarantees exactly one layer, whatever the caller does.
  if (current) {
    const previous = current.client
    uninstall()
    // Let the outgoing client ship what it already queued. Dropping it on the
    // floor is the one outcome nobody wants from a rebuild.
    void previous.close().catch(() => {})
  }

  const client = new LogHQClient(config)
  const inst: Installation = {
    client,
    debug: config.debug === true,
    captureStruct: config.captureStruct !== false,
    seam: 'none',
    via: null,
    restore: [],
    getLogContext: null,
    token: ++generation,
  }
  current = inst

  if (config.captureUnhandled !== false)
    installUnhandled(inst)
  installLifecycle(inst)

  const provided = asLoggingHandle(config.logger)
  if (provided) {
    attachTo(inst, provided)
    attaching = Promise.resolve(seamInfo(inst))
  }
  else {
    attaching = importLogging().then((ns) => {
      // Uninstalled, or superseded by a later install(), while the import was
      // in flight. Attaching now would wrap on behalf of a dead installation.
      if (inst.token !== generation)
        return { seam: 'none', via: null }

      const handle = ns ?? asLoggingHandle((globalThis as Record<string, unknown>).log)
      if (handle)
        attachTo(inst, handle)
      else
        diag(inst, `no Stacks logger found, nothing is being drained (is ${LOGGING_MODULE} installed?)`)

      return seamInfo(inst)
    })
  }

  return client
}

/**
 * Detach from the logger and the process, restoring what was there before.
 *
 * Leaves the client alive and holding its queue, because a caller who wants the
 * queued entries gone should say so by closing the client.
 */
export function uninstall(): void {
  const inst = current
  if (!inst)
    return

  current = null
  attaching = null
  generation++

  // Newest first: a later step may have been layered on an earlier one.
  for (let i = inst.restore.length - 1; i >= 0; i--) {
    try {
      inst.restore[i]!()
    }
    catch (err) {
      diag(inst, 'a teardown step failed', err)
    }
  }
  inst.restore = []
  inst.seam = 'none'
  inst.via = null
}

/** Which seam is live right now. Cheap, synchronous, and safe to log. */
export function activeSeam(): SeamInfo {
  return current ? seamInfo(current) : { seam: 'none', via: null }
}

/** Resolves once the attach attempt started by {@link install} has settled. */
export function whenAttached(): Promise<SeamInfo> {
  return attaching ?? Promise.resolve(activeSeam())
}

/** The client the current installation owns, if any. */
export function installedClient(): LogHQClient | null {
  return current ? current.client : null
}

/**
 * Whether loghq is really attached — asked of the logger, not inferred.
 *
 * {@link activeSeam} only sees installations {@link install} created, because a
 * transport declared in `config/logging.ts` is owned by that config and
 * deliberately never becomes this module's `current` installation. So on the
 * seam most apps ship — the declarative one — `activeSeam()` answers `none`,
 * which reads as failure and is not one.
 *
 * Nor does constructing the transport prove anything: a config file is
 * evaluated whether or not the framework goes on to read `transports`. On a
 * framework version without transport support, the config loads, this package
 * loads, `loghqTransport()` returns a perfectly good transport, and not one
 * record is ever delivered. Since 0.2.3 carries no `peerDependencies`, nothing
 * upstream of this warns about it either.
 *
 * Asking the logger which transports it actually holds is the only question
 * whose answer separates those two cases, so it is the one worth putting in a
 * boot assertion.
 *
 * @param options.name Transport name to look for. Match the `name` given to
 * {@link loghqTransport}, which defaults to `loghq`.
 * @param options.logger The logger to interrogate, skipping the runtime probe
 * for `@stacksjs/logging`. The same injection point {@link install} takes, and
 * the only way to ask the question of something that is not a real Stacks app.
 */
export async function verifyAttached(options: { name?: string, logger?: unknown } = {}): Promise<AttachmentInfo> {
  const name = options.name ?? 'loghq'

  // An `install()` attach settles asynchronously, so wait for it before
  // concluding anything. Only a *delivering* install seam is the answer: a
  // `conflict` never receives a record, and a tee whose client disabled itself
  // does not disprove a declared transport that is working. Both are held as
  // the fallback while the registry is asked.
  const installed = await whenAttached()
  const viaInstall = installed.seam === 'none' ? null : withLiveness(installed, current)
  if (viaInstall?.live)
    return viaInstall

  const handle = options.logger !== undefined
    ? asLoggingHandle(options.logger)
    : await importLogging()

  // The framework registers `config/logging.ts` transports inside the logger's
  // own lazy initialisation, not at module load, and `transports()` is a plain
  // read of a list that stays empty until something triggers it. Reading it
  // straight after the import answers `[]` for a transport that is declared,
  // keyed and delivering — a false negative that a boot assertion turns into a
  // crash, and the earlier the assertion runs the more certain it is to fire.
  // This is the same initialisation the app's first log line performs, and it
  // is idempotent once it has run.
  const init = handle && pickFn(handle.ns, 'logger')
  if (init) {
    try {
      await init()
    }
    catch {
      // A logger that will not initialise holds no transports. Fall through and
      // let the registry read answer, rather than taking down the boot.
    }
  }

  const read = handle && pickFn(handle.ns, 'transports')
  if (!read)
    return viaInstall ?? DETACHED

  try {
    const list = read()
    if (Array.isArray(list)) {
      // One delivering transport under this name is the answer. A dead one only
      // answers when nothing under that name delivers, so a duplicate left by a
      // re-evaluated config cannot mask a working one by being first.
      // eslint-disable-next-line prefer-const -- reassigned below via `??=`, which the rule misses
      let dead: AttachmentInfo | null = null
      for (const held of list) {
        if ((held as { name?: unknown } | null)?.name !== name)
          continue
        const inst = declaredTransports.get(held as StacksLogTransport) ?? null
        const info = inst === current && viaInstall
          ? viaInstall
          : withLiveness({ seam: 'transport', via: 'config/logging.ts' }, inst)
        if (info.live)
          return info
        dead ??= info
      }
      if (dead)
        return dead
    }
  }
  catch {
    // A reader that throws tells us nothing; report unattached rather than
    // taking down the boot of an app whose logging is otherwise fine.
  }

  return viaInstall ?? DETACHED
}

const DETACHED: AttachmentInfo = { seam: 'none', via: null, live: false, disabledReason: null, introspected: false }

/**
 * Pair a seam with whether its client will actually send.
 *
 * Two cases cannot be answered by asking a client. A `conflict` install is one:
 * another copy of this package owns the logger, so this installation's client
 * is perfectly enabled and will still never see a record — enabled is not the
 * same question as attached, and only here do they come apart. And a transport
 * this copy did not build has no client to ask; it is reported live because
 * failing a working app is the worse error for a boot assertion to make, with
 * `introspected: false` so a caller who wants to be strict still can be.
 */
function withLiveness(seam: SeamInfo, inst: Installation | null): AttachmentInfo {
  if (seam.seam === 'conflict')
    return { ...seam, live: false, disabledReason: null, introspected: true }
  if (!inst)
    return { ...seam, live: true, disabledReason: null, introspected: false }
  return {
    ...seam,
    live: inst.client.isEnabled(),
    disabledReason: inst.client.disabledReason(),
    introspected: true,
  }
}

/**
 * A loghq transport for `config/logging.ts`.
 *
 * The declarative half of this package, and the better half where the
 * framework supports it. `install()` has to find a seam at runtime and patch
 * it; this is handed the stream by the logger itself, which means no patching,
 * no ordering problem, and no per-process install: every process that boots the
 * framework reads the same config.
 *
 * @example
 * ```ts
 * // config/logging.ts
 * import { loghqTransport } from '@loghq/stacks'
 *
 * export default {
 *   logsPath: storagePath('logs/stacks.log'),
 *   deploymentsPath: storagePath('logs/deployments.log'),
 *   transports: [loghqTransport({ key: env.LOGHQ_KEY })],
 * } satisfies LoggingConfig
 * ```
 *
 * Crash reports arrive without any extra wiring: the framework's own
 * `uncaughtException` and `unhandledRejection` handlers funnel through
 * `report()`, which calls `log.error`, which reaches this transport like any
 * other line. That is why this does not install process handlers of its own the
 * way `install()` does. A bare script with no framework entry point still wants
 * `install()`.
 *
 * Returns a plain object, so a config file stays a config file: nothing is
 * patched and nothing is registered until the logger reads it.
 */
export function loghqTransport(config: LogHQConfig & TransportOptions = {}): StacksLogTransport {
  const client = new LogHQClient(config)

  // The record's own context, for the duration of the record. `toEntry` reads
  // correlation ids through `getLogContext`, and in this seam the logger has
  // already resolved them and put them on the record, so pointing that lookup
  // at the record is more accurate than calling into the framework again from
  // a different async context.
  let inFlight: unknown

  const inst: Installation = {
    client,
    debug: config.debug === true,
    captureStruct: config.captureStruct !== false,
    seam: 'transport',
    via: 'config/logging.ts',
    restore: [],
    getLogContext: () => inFlight,
    // Not part of the install generation: this transport is owned by the config
    // that declared it, and `uninstall()` must not silently detach it.
    token: -1,
  }

  const transport: StacksLogTransport = {
    name: config.name ?? 'loghq',
    // Deliberately no `level`: the transport asks for everything and filters on
    // `minLevel` instead. The framework's five levels and loghq's eight are
    // different scales, so a threshold expressed in the framework's vocabulary
    // would be filtering against the wrong one.
    log(record: StacksLogRecord): void {
      inFlight = record?.context
      try {
        forwardRecord(inst, record)
      }
      finally {
        inFlight = undefined
      }
    },
    async flush(): Promise<void> {
      await client.flush()
    },
  }

  declaredTransports.set(transport, inst)
  return transport
}

// --- Attachment -------------------------------------------------------------

function seamInfo(inst: Installation): SeamInfo {
  return { seam: inst.seam, via: inst.via }
}

async function importLogging(): Promise<LoggingHandle | null> {
  try {
    // Optional at runtime and invisible at build time. The specifier is a
    // variable so a bundler treats it as external instead of failing to resolve
    // a package this SDK deliberately does not depend on.
    const ns = await import(LOGGING_MODULE)
    return asLoggingHandle(ns)
  }
  catch {
    return null
  }
}

/** Accept either the `@stacksjs/logging` namespace or the bare `log` object. */
function asLoggingHandle(candidate: unknown): LoggingHandle | null {
  if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function'))
    return null

  const c = candidate as Record<string, unknown>
  if (isLogLike(c.log))
    return { ns: c, log: c.log as Record<string, unknown> }
  if (isLogLike(c))
    return { ns: c, log: c }
  return null
}

function isLogLike(value: unknown): boolean {
  if (!value || typeof value !== 'object')
    return false
  const o = value as Record<string, unknown>
  return typeof o.info === 'function' && typeof o.error === 'function'
}

function attachTo(inst: Installation, handle: LoggingHandle): void {
  // Capture `getLogContext` while we have the namespace. It is the only route
  // to the router's AsyncLocalStorage, and without it every entry loses its
  // correlation ids.
  inst.getLogContext = pickFn(handle.ns, 'getLogContext') ?? pickFn(globalThis, 'getLogContext')

  const via = tryTransport(inst, handle.ns)
  if (via) {
    inst.seam = 'transport'
    inst.via = via
    diag(inst, `attached through ${via}`)
    return
  }

  const tee = teeLog(inst, handle.log)
  if (tee.wrapped > 0) {
    inst.seam = 'tee'
    inst.via = 'log.*'
    diag(inst, 'attached by teeing the log singleton')
    return
  }

  if (tee.foreign > 0) {
    inst.seam = 'conflict'
    inst.via = null
    // Deliberately not behind `debug`. Every method is already wrapped by
    // another copy of this package, so this client is fully configured, holds
    // a queue, reports itself enabled, and will never receive a single line.
    // Nothing about that is observable from the outside except an empty
    // dashboard, which is exactly when a warning is worth interrupting for.
    warnOnce(
      'another copy of @loghq/stacks already owns the logger, so this install() is inert '
      + 'and its client will receive nothing. Deduplicate the package so one copy is '
      + 'hoisted for the whole process, or call install() once from the app.',
    )
    return
  }

  inst.seam = 'none'
  inst.via = null
  diag(inst, 'found a logger but could not attach to it')
}

/**
 * The forward path: register as a first-class transport if the host has one.
 *
 * FORWARD LOOKING AND UNPROVEN. Verified against `@stacksjs/logging` 0.70.366:
 * the module exports `log`, `struct`, `logger`, `getLogContext`, `report`, and
 * the parse helpers, and nothing sink-shaped. So this branch is written against
 * a contract nobody has fixed yet, and it must fail soft in every direction
 * rather than break `install()` on a shape it guessed wrong.
 *
 * The shape assumed, and why each part is hedged:
 *
 *   registerTransport(sink) => (() => void) | void
 *
 *   sink = {
 *     name: 'loghq',
 *     level: 'debug',                      // give us everything, we filter
 *     log|write|handle|emit(record): void  // four aliases, one function
 *   }
 *
 *   record = { level?, message?, args?, context?, timestamp?, event? }
 *
 * Four handler aliases are supplied because the method name is the single most
 * likely thing to differ, and supplying all of them costs three property
 * assignments. A returned function is taken as the unsubscribe; if nothing is
 * returned the sink is neutered by a flag instead, so `uninstall()` still stops
 * the flow even when it cannot undo the registration.
 *
 * A plain `transports` array is also honored, since a config-level array is the
 * other common way this gets designed.
 */
function tryTransport(inst: Installation, ns: Record<string, unknown>): string | null {
  const handler = (record: unknown): void => {
    if (detached)
      return
    forwardRecord(inst, record)
  }
  let detached = false

  const sink: Record<string, unknown> = {
    name: 'loghq',
    // Ask for everything. The host's levels are clarity's five and ours are
    // RFC 5424's eight, so a threshold expressed in their vocabulary would be
    // filtering against the wrong scale. `minLevel` is applied in forward().
    level: 'debug',
    log: handler,
    write: handler,
    handle: handler,
    emit: handler,
  }

  for (const name of REGISTRARS) {
    const register = pickFn(ns, name)
    if (!register)
      continue
    try {
      const result = register(sink)
      // This sink is named `loghq` and lives in the host's registry, so
      // `verifyAttached` will find it. Without this it would miss the map and
      // be laundered into "a foreign transport, assume it works" — including
      // after `uninstall()`, when a registrar that returned no undo leaves the
      // sink in place with `detached` set and forwarding nothing.
      declaredTransports.set(sink as unknown as StacksLogTransport, inst)
      inst.restore.push(() => {
        detached = true
        if (typeof result === 'function')
          (result as () => void)()
      })
      return name
    }
    catch (err) {
      diag(inst, `${name} rejected the sink, falling through`, err)
    }
  }

  const arrays = [ns.transports, (ns.log as Record<string, unknown> | undefined)?.transports]
  for (const arr of arrays) {
    if (!Array.isArray(arr))
      continue
    try {
      arr.push(sink)
      inst.restore.push(() => {
        detached = true
        const at = arr.indexOf(sink)
        if (at !== -1)
          arr.splice(at, 1)
      })
      return 'transports[]'
    }
    catch (err) {
      diag(inst, 'could not push onto the transports array, falling through', err)
    }
  }

  return null
}

/**
 * Wrap the mutable `log` singleton.
 *
 * Each wrapper runs the original first and returns exactly what it returned, so
 * an awaiting caller sees no change. The forward happens after, and the send is
 * never awaited: a log call must not become slower or more failure-prone
 * because something is watching it.
 */
function teeLog(inst: Installation, log: Record<string, unknown>): TeeResult {
  let wrapped = 0
  let foreign = 0

  for (const method of TEE_METHODS) {
    const original = log[method]
    if (typeof original !== 'function')
      continue

    // Already ours, from this copy of the package or another one in the same
    // process. Wrapping again would duplicate every line downstream. Counted,
    // because a tee that wraps nothing at all means someone else owns the
    // logger and the caller needs to hear about it.
    if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) {
      foreign++
      continue
    }

    const fn = original as (...args: unknown[]) => unknown
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      let result: unknown
      let thrown: unknown
      let threw = false
      try {
        result = fn.apply(this, args)
      }
      catch (err) {
        threw = true
        thrown = err
      }

      // Forward even when the original blew up. A logger that just failed is
      // exactly when the remote copy of the line is worth the most.
      forward(inst, method, args)

      if (threw)
        throw thrown
      return result
    }

    Object.defineProperty(wrapper, WRAPPED, { value: true })
    log[method] = wrapper
    wrapped++

    inst.restore.push(() => {
      // Only reclaim the slot if it is still ours. Someone who wrapped on top
      // of us owns the chain now, and yanking the original back underneath them
      // would silently drop their layer.
      if (log[method] === wrapper)
        log[method] = original
    })
  }

  return { wrapped, foreign }
}

function pickFn(source: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  if (!source || (typeof source !== 'object' && typeof source !== 'function'))
    return null
  const fn = (source as Record<string, unknown>)[name]
  return typeof fn === 'function' ? fn as (...args: unknown[]) => unknown : null
}

// --- Forwarding -------------------------------------------------------------

/**
 * Turn one `log.*` call into one queued entry.
 *
 * Guarded by the module-level re-entrancy flag: if anything in here reaches the
 * host logger, directly or through a getter with an opinion, the second pass
 * returns immediately instead of recursing until the stack gives out.
 */
function forward(inst: Installation, method: string, args: unknown[]): void {
  if (forwarding)
    return
  forwarding = true
  try {
    const client = inst.client
    if (!client.isEnabled())
      return

    const level = toLogHQLevel(method)
    // Filter before serializing. In development the debug stream is the bulk of
    // the volume and all of it is about to be discarded.
    if (!atLeast(level, client.config.minLevel))
      return

    const entry = toEntry(inst, level, method, args)
    if (entry)
      client.enqueue(entry)
  }
  catch (err) {
    diag(inst, 'dropped an entry while forwarding', err)
  }
  finally {
    forwarding = false
  }
}

/** The transport-seam equivalent of {@link forward}, for a host log record. */
function forwardRecord(inst: Installation, record: unknown): void {
  if (forwarding)
    return
  forwarding = true
  try {
    const client = inst.client
    if (!client.isEnabled())
      return

    const r = isPlainObject(record) ? record : { message: record }
    const rawLevel = typeof r.level === 'string' ? r.level : 'info'
    const level = toLogHQLevel(rawLevel)
    if (!atLeast(level, client.config.minLevel))
      return

    const args = Array.isArray(r.args) && r.args.length
      ? r.args
      : (r.message === undefined ? [] : [r.message])

    const entry = toEntry(inst, level, rawLevel, args)
    if (!entry)
      return

    // Prefer what `toEntry` derived from the raw arguments, and fall back to
    // the record's own message only when there was nothing to derive.
    //
    // The record's `message` is the formatted console line. It carries the
    // request-id prefix and the whole context object pretty-printed into the
    // string, which is exactly the noise this package exists to avoid shipping:
    // `log.info('checkout started', { orderId: 42 })` formats to
    // `checkout started {\n  "orderId": 42\n}`, while the args give a clean
    // message and a queryable `context.orderId`.
    if (!entry.message && typeof r.message === 'string' && r.message)
      entry.message = r.message
    if (typeof r.channel === 'string')
      entry.channel = r.channel
    if (typeof r.timestamp === 'string')
      entry.timestamp = r.timestamp
    if (isPlainObject(r.context))
      entry.context = { ...serializeObject(r.context), ...entry.context }

    client.enqueue(entry)
  }
  catch (err) {
    diag(inst, 'dropped a transport record while forwarding', err)
  }
  finally {
    forwarding = false
  }
}

/**
 * Add a context field without letting its name reach the prototype.
 *
 * Two traps, both silent, and both hit by field names an application picks
 * without a second thought:
 *
 *   - `'toString' in context` is true for every `{}`, so a `!(key in context)`
 *     guard dropped every field named after an `Object.prototype` member:
 *     `constructor`, `valueOf`, `hasOwnProperty`, `toString`, and friends.
 *   - `context.__proto__ = value` reassigns the prototype instead of adding a
 *     key, so that field vanished and took the object's shape with it.
 *
 * An own-property check answers the first and `defineProperty` answers the
 * second. Enumerable, so `JSON.stringify` still sees it.
 *
 * `hasOwnProperty` is called off `Object.prototype` rather than off `context`,
 * for the same reason the guard exists at all: `context` may now carry a field
 * of that name.
 */
const hasOwn = Object.prototype.hasOwnProperty

function setField(context: Record<string, unknown>, key: string, value: unknown): void {
  if (hasOwn.call(context, key))
    return
  Object.defineProperty(context, key, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * Build the wire entry.
 *
 * The first argument arrives raw and can be any of three things, because
 * `log.*` is called three different ways across the framework:
 *
 *   - a string, the ordinary case
 *   - an `Error`, from `log.error(err)`
 *   - a structured object, which is how `log.struct` arrives. `struct.request`
 *     lands as a single object on `log.error`; `struct.slowQuery` lands as
 *     `('[db.slow_query]', { event, sql, durationMs })` on `log.warn`.
 *
 * Returns null when the call carries nothing worth shipping.
 */
function toEntry(inst: Installation, level: LogHQLevel, rawLevel: string, args: unknown[]): LogHQEntry | null {
  if (!args.length)
    return null

  const context: Record<string, unknown> = {}
  // Only when the name does not survive the mapping. Recording
  // `original_level: "error"` on an entry already at `error` is noise.
  if (isLossy(rawLevel))
    context.original_level = rawLevel.trim().toLowerCase()

  let message = ''
  let channel: string | undefined
  const rest: unknown[] = []

  // The object wins over the string tag: `[db.slow_query]` is a formatting
  // artifact, the object is the event.
  //
  // Recognising it by `typeof event === 'string'` alone was too greedy. An
  // application writing `log.info('user signed up', { event: 'signup' })` hit
  // this branch and had its message replaced by `signup`, which is the worst
  // thing this package can do to a line: `message` is the only field the
  // dashboard's `?q=` searches, so the entry became unfindable by the words its
  // author chose. The emitter always pairs the object with its own bracketed
  // tag or sends it alone, and an ordinary call with a trailing context object
  // matches neither.
  const structAt = args.findIndex(a => isPlainObject(a) && typeof a.event === 'string')
  const structEvent = structAt === -1
    ? null
    : String((args[structAt] as Record<string, unknown>).event)
  const isStructCall = structEvent !== null && (
    args.length === 1
    || args.some(a => typeof a === 'string' && (a === `[${structEvent}]` || a === structEvent))
  )

  if (isStructCall) {
    if (!inst.captureStruct)
      return null

    const fields = args[structAt] as Record<string, unknown>
    const event = structEvent
    channel = event
    message = event
    for (const [key, value] of Object.entries(fields).slice(0, MAX_ITEMS)) {
      if (key !== 'event')
        setField(context, key, serialize(value, 1, new WeakSet()))
    }

    for (let i = 0; i < args.length; i++) {
      if (i === structAt)
        continue
      // Drop the bracketed tag the emitter pairs with the object. It is the
      // event name twice over.
      if (typeof args[i] === 'string' && (args[i] === `[${event}]` || args[i] === event))
        continue
      rest.push(args[i])
    }
  }
  else {
    const first = args[0]
    if (first instanceof Error) {
      message = `${first.name}: ${first.message}`
      context.exception = describeError(first, 0)
      rest.push(...args.slice(1))
    }
    else if (typeof first === 'string') {
      message = first
      // `log.error(message, error, context)` is the framework's own signature,
      // and the error is the payload, not an incidental argument.
      if (args[1] instanceof Error) {
        context.exception = describeError(args[1] as Error, 0)
        rest.push(...args.slice(2))
      }
      else {
        rest.push(...args.slice(1))
      }
    }
    else {
      message = messageOf(first)
      rest.push(...args.slice(1))
    }
  }

  if (rest.length === 1 && isPlainObject(rest[0])) {
    // A single trailing plain object is the context argument by convention in
    // every logger with this signature, so its keys are worth having at the top
    // of `context` where they are queryable, not nested inside `args[0]`.
    for (const [key, value] of Object.entries(rest[0] as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      setField(context, key, serialize(value, 1, new WeakSet()))
    }
  }
  else if (rest.length) {
    context.args = rest.slice(0, MAX_ITEMS).map(a => serialize(a, 1, new WeakSet()))
  }

  const entry: LogHQEntry = {
    message,
    level,
    framework: 'stacks',
  }
  if (channel)
    entry.channel = channel
  if (Object.keys(context).length)
    entry.context = context

  applyCorrelation(inst, entry, context)
  return entry
}

/**
 * Populate `trace_id` / `request_id` from the host's ambient log context.
 *
 * Read here, synchronously inside the wrapper, and never at flush time: the
 * context lives in AsyncLocalStorage and has unwound long before a batch ships.
 *
 * The host names the request id `requestId` and loghq names it `request_id`, so
 * this is a rename, not a copy.
 */
function applyCorrelation(inst: Installation, entry: LogHQEntry, context: Record<string, unknown>): void {
  let ctx: unknown
  try {
    ctx = inst.getLogContext ? inst.getLogContext() : undefined
  }
  catch {
    // A context lookup must never cost a log line.
    ctx = undefined
  }

  if (isPlainObject(ctx)) {
    if (typeof ctx.trace_id === 'string' && ctx.trace_id)
      entry.trace_id = ctx.trace_id
    if (typeof ctx.requestId === 'string' && ctx.requestId)
      entry.request_id = ctx.requestId
    if (ctx.userId !== undefined && ctx.userId !== null) {
      // Request-scoped and therefore more accurate than the process-wide user,
      // but the configured one may carry an email or a name worth keeping.
      const base = inst.client.config.user
      entry.user = { ...(base ?? {}), id: ctx.userId as string | number }
    }
  }

  // `log.struct` payloads carry a `traceId` field that the emitter fills from
  // `getLogContext()?.requestId`. It is a request id wearing the wrong name, so
  // treat it as one rather than as a trace.
  if (!entry.request_id && typeof context.traceId === 'string' && context.traceId)
    entry.request_id = context.traceId
}

// --- Process handlers -------------------------------------------------------

function getProcess(): Record<string, any> | null {
  const p = (globalThis as Record<string, any>).process
  return p && typeof p.on === 'function' && typeof p.removeListener === 'function' ? p : null
}

/**
 * Watch for crashes without changing what a crash does.
 *
 * `uncaughtExceptionMonitor` exists precisely for this: it fires alongside the
 * default handler instead of replacing it, so the process still prints and dies
 * exactly as it did before. A plain `uncaughtException` listener would suppress
 * that, which is a far worse trade than missing an entry.
 *
 * Delivery is best effort and honestly so: after the monitor runs, the runtime
 * tears down without giving an async POST a turn. It earns its keep on the
 * throws that never reach the framework, since the ones that do reach it go
 * through `report()` into `log.error` and are already captured by the tee.
 */
function installUnhandled(inst: Installation): void {
  const proc = getProcess()
  if (!proc)
    return

  // Identity dedupe: in the default rejection mode the same value arrives twice,
  // once as a rejection and once as the uncaught exception it is re-raised as.
  let lastReported: unknown

  const onMonitor = (err: unknown): void => {
    if (err === lastReported)
      return
    lastReported = err
    reportCrash(inst, err, 'uncaughtException', 'critical')
  }
  proc.on('uncaughtExceptionMonitor', onMonitor)
  inst.restore.push(() => proc.removeListener('uncaughtExceptionMonitor', onMonitor))

  // The monitor is a Node 13.7+ / Bun API. If the runtime lacks it, only take
  // the ordinary event when somebody else already owns the crash policy, so we
  // are never the listener that turned a fatal error into a silent one.
  if (proc.listenerCount('uncaughtException') > 0) {
    const onUncaught = (err: unknown): void => {
      if (err === lastReported)
        return
      lastReported = err
      reportCrash(inst, err, 'uncaughtException', 'critical')
    }
    proc.on('uncaughtException', onUncaught)
    inst.restore.push(() => proc.removeListener('uncaughtException', onUncaught))
  }

  // Rejections have no monitor equivalent, and attaching a listener is itself
  // what suppresses the runtime's default. So: report, then hand the default
  // back by throwing, but only when we are the sole listener and the runtime
  // was not explicitly configured to be lenient. Throwing from here is how the
  // default mode already works, so this restores behavior rather than forcing
  // an exit.
  const soleListener = proc.listenerCount('unhandledRejection') === 0
  const reraise = soleListener && rejectionsAreFatal(proc)

  const onRejection = (reason: unknown): void => {
    // An unhandled rejection is a bug, not a dead process. `error`, not
    // `critical`, keeps the severity honest.
    reportCrash(inst, reason, 'unhandledRejection', 'error')
    if (reraise) {
      lastReported = reason
      throw reason
    }
  }
  proc.on('unhandledRejection', onRejection)
  inst.restore.push(() => proc.removeListener('unhandledRejection', onRejection))
}

/** Whether the runtime turns an unhandled rejection into a fatal error. */
function rejectionsAreFatal(proc: Record<string, any>): boolean {
  const flags = [
    ...(Array.isArray(proc.execArgv) ? proc.execArgv.map(String) : []),
    String(proc.env?.NODE_OPTIONS ?? ''),
  ].join(' ')
  const mode = flags.match(/--unhandled-rejections=([\w-]+)/)
  // Node 15+ and Bun both default to throwing when nothing says otherwise.
  return mode ? (mode[1] === 'throw' || mode[1] === 'strict') : true
}

function reportCrash(inst: Installation, err: unknown, mechanism: string, level: LogHQLevel): void {
  if (forwarding)
    return
  forwarding = true
  try {
    if (!inst.client.isEnabled())
      return

    const context: Record<string, unknown> = { mechanism }
    context.exception = err instanceof Error ? describeError(err, 0) : serialize(err, 1, new WeakSet())

    const entry: LogHQEntry = {
      message: messageOf(err),
      level,
      channel: 'process',
      framework: 'stacks',
      context,
    }
    applyCorrelation(inst, entry, context)
    inst.client.enqueue(entry)

    // Fire the batch now. It probably loses the race with process teardown, but
    // the cost of trying is one already-scheduled fetch.
    void inst.client.flush().catch(() => false)
  }
  catch (e) {
    diag(inst, `dropped a ${mechanism} report`, e)
  }
  finally {
    forwarding = false
  }
}

/**
 * Flush on the way out.
 *
 * A batch that sits in the queue while the process exits is worse than never
 * having queued it: the app paid for the capture and got nothing. `beforeExit`
 * covers a natural end, the signals cover a container being told to stop.
 */
function installLifecycle(inst: Installation): void {
  const proc = getProcess()
  if (!proc)
    return

  let exitDrains = 0
  const onBeforeExit = (): void => {
    // `beforeExit` re-fires whenever the handler schedules more work, so this is
    // deliberately timer-free and capped. A flush with an empty queue settles on
    // a microtask and does not keep the loop alive.
    if (exitDrains++ > 3)
      return
    void inst.client.flush().catch(() => false)
  }
  proc.on('beforeExit', onBeforeExit)
  inst.restore.push(() => proc.removeListener('beforeExit', onBeforeExit))

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // Attaching a signal listener is what suppresses the default termination,
    // so remember whether we are the one doing that.
    const hadListeners = proc.listenerCount(signal) > 0
    let handled = false

    const onSignal = (): void => {
      if (handled)
        return
      handled = true

      // Bounded, because ctrl-c means the person wants it to stop now. A lost
      // batch is a smaller problem than a shutdown that appears to hang.
      const budget = Math.min(inst.client.config.timeout || 2000, 2000)
      const deadline = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, budget) as unknown as { unref?: () => void }
        t.unref?.()
      })

      void Promise.race([inst.client.flush().catch(() => false), deadline]).then(() => {
        if (hadListeners)
          return
        // We were the only listener, so the default is ours to give back.
        proc.removeListener(signal, onSignal)
        try {
          proc.kill(proc.pid, signal)
        }
        catch {
          proc.exit?.(0)
        }
      })
    }

    proc.on(signal, onSignal)
    inst.restore.push(() => proc.removeListener(signal, onSignal))
  }
}

// --- Serialization ----------------------------------------------------------

/**
 * Flatten an arbitrary value into something JSON can hold.
 *
 * Bounded on every axis, because the input is whatever an application passed to
 * `log.info` and the output has to fit loghq's 96 KiB context cap. Cycles are
 * tracked per path, not globally, so a value referenced twice in one object
 * still serializes twice instead of being reported as circular.
 */
function serialize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined)
    return null

  const t = typeof value
  if (t === 'string')
    return clip(value as string)
  if (t === 'number')
    return Number.isFinite(value as number) ? value : String(value)
  if (t === 'boolean')
    return value
  if (t === 'bigint')
    return `${(value as bigint).toString()}n`
  if (t === 'symbol')
    return String(value as symbol)
  if (t === 'function')
    return `[Function ${(value as { name?: string }).name || 'anonymous'}]`

  if (value instanceof Error)
    return describeError(value, 0)
  if (value instanceof Date)
    return isoOf(value)
  if (value instanceof RegExp)
    return String(value)

  const obj = value as object
  if (seen.has(obj))
    return '[Circular]'
  if (depth >= MAX_DEPTH)
    return Array.isArray(value) ? `[Array(${(value as unknown[]).length})]` : '[Object]'

  seen.add(obj)
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ITEMS).map(v => serialize(v, depth + 1, seen))
      if (value.length > MAX_ITEMS)
        out.push(`[+${value.length - MAX_ITEMS} more]`)
      return out
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {}
      let n = 0
      for (const [k, v] of value) {
        if (n++ >= MAX_ITEMS)
          break
        out[String(k)] = serialize(v, depth + 1, seen)
      }
      return out
    }

    if (value instanceof Set)
      return [...value].slice(0, MAX_ITEMS).map(v => serialize(v, depth + 1, seen))

    if (ArrayBuffer.isView(value))
      return `[${(value as { constructor?: { name?: string } }).constructor?.name ?? 'TypedArray'}(${(value as ArrayBufferView).byteLength})]`

    return serializeObject(value as Record<string, unknown>, depth, seen)
  }
  finally {
    seen.delete(obj)
  }
}

function serializeObject(source: Record<string, unknown>, depth = 0, seen: WeakSet<object> = new WeakSet()): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(source)
  for (const key of keys.slice(0, MAX_ITEMS))
    out[key] = serialize(source[key], depth + 1, seen)
  if (keys.length > MAX_ITEMS)
    out['[truncated]'] = `${keys.length - MAX_ITEMS} more keys`
  return out
}

/**
 * Capture an error as data.
 *
 * `JSON.stringify(new Error())` is `{}`, which is how an error survives a log
 * pipeline as nothing at all. Name, message, and stack are pulled out by hand,
 * and the `cause` chain is walked to a bounded depth.
 */
function describeError(err: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: String(err.name ?? 'Error'),
    message: String(err.message ?? ''),
  }
  if (err.stack)
    out.stack = clip(String(err.stack), 8192)

  const cause = (err as { cause?: unknown }).cause
  if (cause !== undefined && cause !== null && depth < MAX_CAUSES)
    out.cause = cause instanceof Error ? describeError(cause, depth + 1) : serialize(cause, MAX_DEPTH - 1, new WeakSet())

  // Anything the application hung off a custom error subclass, e.g. a status.
  for (const key of Object.keys(err).slice(0, MAX_ITEMS)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause')
      out[key] = serialize((err as unknown as Record<string, unknown>)[key], MAX_DEPTH - 1, new WeakSet())
  }
  return out
}

function messageOf(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (value instanceof Error)
    return `${value.name}: ${value.message}`
  if (value === null || value === undefined)
    return String(value)
  try {
    const s = JSON.stringify(serialize(value, 0, new WeakSet()))
    return s === undefined ? String(value) : s
  }
  catch {
    return String(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function clip(value: string, max = MAX_STRING): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

function isoOf(date: Date): string {
  try {
    return date.toISOString()
  }
  catch {
    return String(date)
  }
}

/**
 * SDK diagnostics.
 *
 * `console` on purpose and without exception. This code runs inside the very
 * logger it is draining, so routing a word of it through `log.*` would hand the
 * wrapper its own output and recurse until the stack ends.
 */
/**
 * A misconfiguration serious enough to report without being asked.
 *
 * Once per copy of this package, never per entry: an SDK that talks over the
 * application's own console output has misjudged whose terminal it is.
 */
let warnedOnce = false
function warnOnce(message: string): void {
  if (warnedOnce)
    return
  warnedOnce = true
  console.warn(`[loghq/stacks] ${message}`)
}

function diag(inst: Installation, message: string, detail?: unknown): void {
  if (!inst.debug)
    return
  if (detail === undefined)
    console.warn(`[loghq/stacks] ${message}`)
  else
    console.warn(`[loghq/stacks] ${message}`, detail)
}
