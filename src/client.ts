/**
 * The batching ingest transport.
 *
 * Everything in this file exists to keep a log call cheap and safe for the
 * caller: `enqueue` does bounded synchronous work and returns, and the network
 * happens later on a timer or a size trigger. Nothing here is allowed to throw
 * into application code, and nothing here is allowed to write through the host
 * logger, because this package is usually installed as a drain on that very
 * logger and a diagnostic would loop straight back in.
 *
 * The status handling is the interesting part, and it is dictated by
 * `docs/ingest.md`: a `201` is not proof of delivery (reconcile
 * `stored`/`dropped`/`skipped`), `401`/`403`/`404` are permanent and retrying
 * them is a self-inflicted flood, `413` means split rather than back off, and
 * `429` always carries `Retry-After`.
 */
import type { DisabledReason, IngestResult, LogHQConfig, LogHQEntry, LogHQLevel, LogHQUser, ResolvedConfig } from './types'
import { atLeast, toLogHQLevel } from './levels'
import { DEFAULT_HOST, SDK_NAME, SDK_VERSION } from './types'

// Wire limits, mirrored from app/Logs/normalize.ts in the loghq repo. We clip to
// these before sending so the server's own clipping is a no-op: it truncates
// silently, and only the client still holds the data it could have summarized.
// Lengths are counted in UTF-16 units because that is what the server measures.
const MAX_MESSAGE = 16 * 1024
const MAX_JSON = 96 * 1024
const MAX_SDK_JSON = 4 * 1024
const MAX_VARCHAR = 255
const MAX_CORRELATION = 64
const MAX_BATCH = 500

/**
 * Marker appended to a clipped message.
 *
 * The room for it is taken out of the budget rather than added on top, so the
 * clipped message lands at or under the cap and the server does not clip it a
 * second time and bury this marker under its own.
 */
const TRUNCATED = '...[truncated]'

/** Stand-ins the server uses for a payload it will not store. Matched exactly. */
const OVERSIZED = { _truncated: 'oversized context dropped' }
const UNSERIALIZABLE = { _truncated: 'unserializable context dropped' }

/** Transport backoff bounds. Five attempts at these numbers spans a few seconds. */
const BACKOFF_BASE_MS = 250
const BACKOFF_MAX_MS = 30_000

/**
 * Bounds on a `Retry-After` we will honor.
 *
 * A missing or unparseable header still pauses us, because a `429` we answer
 * immediately is the flood the limit exists to stop. The ceiling is there so a
 * malformed header cannot mute a process for hours.
 */
const RETRY_AFTER_FALLBACK_S = 5
const RETRY_AFTER_MAX_S = 300

/** How far `captureException` walks an error's `cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 5

// --- Runtime probing --------------------------------------------------------

/** `process` if this runtime has one. Never assume it: the SDK also runs in workers. */
function nodeProcess(): { env?: Record<string, string | undefined>, versions?: Record<string, unknown> } | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined>, versions?: Record<string, unknown> } }).process
  return proc && typeof proc === 'object' ? proc : undefined
}

/** Read an env var, treating empty as unset so `FOO=` does not beat a good default. */
function env(name: string): string | undefined {
  const value = nodeProcess()?.env?.[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

let cachedHostname: string | undefined
let hostnameProbe: Promise<void> | null = null

/**
 * Best-effort machine name.
 *
 * `os.hostname()` is the answer we want but the import is async and only exists
 * on Node-like runtimes, so this returns `$HOSTNAME` (which containers set)
 * immediately and lets {@link whenHostnameResolves} upgrade it a tick later.
 * The specifier is held in a variable so bundlers targeting the browser do not
 * try to resolve `node:os` at build time.
 */
function detectHostname(): string | undefined {
  if (cachedHostname)
    return cachedHostname
  if (!hostnameProbe && nodeProcess()?.versions) {
    const specifier = 'node:os'
    hostnameProbe = import(/* @vite-ignore */ specifier)
      .then((os: { hostname?: () => string }) => {
        if (typeof os?.hostname === 'function')
          cachedHostname = os.hostname()
      })
      .catch(() => {
        // Not a Node-like runtime after all. The env fallback stands.
      })
  }
  return env('HOSTNAME')
}

/** Hand the real hostname to `apply` once (and if) the probe lands. */
function whenHostnameResolves(apply: (hostname: string) => void): void {
  if (cachedHostname) {
    apply(cachedHostname)
    return
  }
  if (hostnameProbe) {
    void hostnameProbe.then(() => {
      if (cachedHostname)
        apply(cachedHostname)
    })
  }
}

/**
 * Detach a timer from the event loop where the runtime allows it.
 *
 * A logging SDK that keeps a CLI or a job process alive for an extra flush
 * interval is a bug report, so every timer here is expendable.
 */
function unref(timer: unknown): void {
  const handle = timer as { unref?: () => void } | undefined
  if (handle && typeof handle.unref === 'function')
    handle.unref()
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    unref(setTimeout(resolve, ms))
  })
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n))
    return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// --- Payload shaping --------------------------------------------------------

/**
 * A `JSON.stringify` replacer that keeps the things a log context is actually
 * full of.
 *
 * Errors are the motivating case: they serialize to `{}` by default, so a
 * `context: { err }` would arrive empty and the one field worth reading would
 * be gone. `seen` is only passed on the retry after a circular-structure throw,
 * because a WeakSet cannot tell a cycle from a shared reference and would label
 * the second sighting of a perfectly fine object `[Circular]`.
 */
function jsonReplacer(seen: WeakSet<object> | null): (key: string, value: unknown) => unknown {
  return function (_key: string, value: unknown): unknown {
    if (typeof value === 'bigint')
      return `${value}`
    if (typeof value === 'function')
      return `[Function ${value.name || 'anonymous'}]`
    if (value instanceof Map)
      return Object.fromEntries(value as Map<string, unknown>)
    if (value instanceof Set)
      return Array.from(value)
    if (value instanceof Error)
      return { name: value.name, message: value.message, stack: value.stack }
    if (value !== null && typeof value === 'object') {
      if (seen) {
        if (seen.has(value))
          return '[Circular]'
        seen.add(value)
      }
    }
    return value
  }
}

/**
 * Serialize, size-check, and re-parse an object field.
 *
 * The round trip is deliberate. Whatever survives here is what gets queued, so
 * the batch-level `JSON.stringify` at flush time cannot fail on a cycle that
 * was smuggled in via `context` and take fifty unrelated entries down with it.
 * Empty objects become `undefined` because the server stores them as null.
 */
function boundedJson<T>(value: unknown, max: number): T | undefined {
  if (value == null || typeof value !== 'object')
    return undefined

  let json: string
  try {
    json = JSON.stringify(value, jsonReplacer(null))
  }
  catch {
    try {
      json = JSON.stringify(value, jsonReplacer(new WeakSet<object>()))
    }
    catch {
      return UNSERIALIZABLE as unknown as T
    }
  }

  if (!json || json === '{}' || json === '[]')
    return undefined
  if (json.length > max)
    return OVERSIZED as unknown as T

  try {
    return JSON.parse(json) as T
  }
  catch {
    return undefined
  }
}

/** Clip a `text` column value, spending part of the budget on the marker. */
function clipMessage(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE - TRUNCATED.length)}${TRUNCATED}` : value
}

/**
 * Hard-cap a varchar value.
 *
 * Cut to exactly the column width rather than the server's width-minus-one plus
 * an ellipsis, so the value arrives already fitting and is passed through
 * untouched.
 */
function clipVarchar(value: unknown, max: number): string | undefined {
  if (value == null)
    return undefined
  const s = String(value)
  return s.length > max ? s.slice(0, max) : s
}

/** Turn anything into a message string without ever throwing on it. */
function stringifyMessage(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (value == null)
    return ''
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value, jsonReplacer(new WeakSet<object>()))
      if (json && json !== '{}')
        return json
    }
    catch {
      // fall through to String()
    }
  }
  try {
    return String(value)
  }
  catch {
    return ''
  }
}

interface DescribedError {
  type: string | undefined
  message: string
  stack: string | undefined
}

/** Pull a type, message, and stack off anything that was thrown. */
function describeError(err: unknown): DescribedError {
  if (err instanceof Error) {
    return {
      type: err.name || err.constructor?.name || 'Error',
      message: err.message || String(err),
      stack: typeof err.stack === 'string' ? err.stack : undefined,
    }
  }
  if (err !== null && typeof err === 'object') {
    const shape = err as { name?: unknown, message?: unknown, stack?: unknown, constructor?: { name?: unknown } }
    const type = shape.name ? String(shape.name) : (shape.constructor?.name ? String(shape.constructor.name) : undefined)
    return {
      type: type === 'Object' ? undefined : type,
      message: shape.message != null ? String(shape.message) : stringifyMessage(err),
      stack: typeof shape.stack === 'string' ? shape.stack : undefined,
    }
  }
  return { type: undefined, message: stringifyMessage(err), stack: undefined }
}

/**
 * Walk `cause` links, depth-capped and cycle-guarded.
 *
 * A wrapped error carries its real explanation several links down, and losing
 * it turns "request failed" into an unactionable line. The cap keeps a
 * self-referencing chain from filling the context with the same frame.
 */
function describeChain(err: unknown): DescribedError[] {
  const chain: DescribedError[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current != null && chain.length < MAX_CAUSE_DEPTH) {
    if (typeof current === 'object') {
      if (seen.has(current))
        break
      seen.add(current)
    }
    chain.push(describeError(current))
    current = current !== null && typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

// --- Config -----------------------------------------------------------------

/**
 * Parse `https://<key>@<host>`.
 *
 * A DSN without a key is not a usable DSN, so it returns null rather than half
 * a config that would fail later with a less obvious error.
 */
export function parseDsn(dsn: string): { host: string, key: string } | null {
  try {
    const url = new URL(dsn)
    const key = url.username || url.password || ''
    if (!key)
      return null
    return { host: `${url.protocol}//${url.host}`, key: decodeURIComponent(key) }
  }
  catch {
    return null
  }
}

/**
 * Apply defaults, DSN parts, and bounds.
 *
 * Explicit `key`/`host` beat the DSN because the DSN is the bulk convenience
 * and an explicit field is a deliberate override. Numeric options are clamped
 * rather than validated: a bad `batchSize` should not stop a process from
 * logging, and 501 entries per request would be silently halved by the server's
 * 500 cap anyway.
 */
export function resolveConfig(config: LogHQConfig): ResolvedConfig {
  let key = config.key
  let host = config.host

  if (config.dsn) {
    const parsed = parseDsn(config.dsn)
    if (parsed) {
      key = key ?? parsed.key
      host = host ?? parsed.host
    }
  }

  const resolvedHost = (host ?? DEFAULT_HOST).replace(/\/+$/, '')

  return {
    key: key ?? '',
    host: resolvedHost,
    endpoint: `${resolvedHost}/logs`,

    // APP_ENV first: a Stacks app sets it, and it is the one the app itself
    // considers authoritative. NODE_ENV is the fallback everything else reads.
    environment: config.environment ?? env('APP_ENV') ?? env('NODE_ENV') ?? 'production',
    release: config.release ?? env('APP_VERSION') ?? env('RELEASE'),
    channel: config.channel,
    hostname: config.hostname ?? detectHostname(),
    user: config.user ?? null,

    minLevel: toLogHQLevel(config.minLevel, 'info'),
    enabled: config.enabled !== false,

    batchSize: clampInt(config.batchSize, 1, MAX_BATCH, 50),
    // 0 is a documented value meaning "no timer", so it clamps down to 0 while
    // any positive interval is held above a value that would busy-flush.
    flushInterval: config.flushInterval === 0 ? 0 : clampInt(config.flushInterval, 50, 600_000, 2000),
    maxQueueSize: clampInt(config.maxQueueSize, 1, 1_000_000, 1000),
    timeout: clampInt(config.timeout, 100, 120_000, 10_000),
    // Floored at 1: `maxRetries: 0` reads as "do not retry", not "do not send".
    maxRetries: clampInt(config.maxRetries, 1, 20, 5),

    beforeSend: config.beforeSend,
    debug: config.debug === true,
    sdk: config.sdk ?? { name: SDK_NAME, version: SDK_VERSION },
  }
}

// --- Client -----------------------------------------------------------------

/** What one delivery attempt did with its batch. */
interface DeliveryOutcome {
  /** False when entries were lost or deferred, which makes a flush unclean. */
  clean: boolean
}

export class LogHQClient {
  readonly config: ResolvedConfig

  private queue: LogHQEntry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disabledBy: DisabledReason | null = null
  /** Epoch ms before which nothing is sent, set from a `429` `Retry-After`. */
  private pausedUntil = 0
  /** Serializes drains so two flushes cannot splice the same queue. */
  private chain: Promise<boolean> = Promise.resolve(true)
  /** The drain currently on the wire, if any. See {@link flush}. */
  private running: Promise<boolean> | null = null
  /** Entries this client is known to have thrown away, for the debug channel. */
  private lost = 0
  /**
   * How many times a batch has come back to the queue.
   *
   * The drain loops use this to tell progress from a stall. Counting requeues
   * rather than watching the queue length is what makes them immune to entries
   * arriving while a send is in flight.
   */
  private requeues = 0

  constructor(config: LogHQConfig) {
    this.config = resolveConfig(config)

    // No key means no project to attribute to, and every send would 401. Fail
    // quiet and permanent: an app that forgot to configure the SDK should not
    // pay a request per log line to find out.
    if (!this.config.key) {
      this.disabledBy = 'auth'
      this.debug('warn', 'no ingest key, client disabled')
    }

    if (!this.config.hostname)
      whenHostnameResolves((hostname) => { this.config.hostname = hostname })
  }

  // --- Scope ----------------------------------------------------------------

  setUser(user: LogHQUser | null): void {
    this.config.user = user
  }

  setRelease(release: string): void {
    this.config.release = release
  }

  setEnvironment(environment: string): void {
    this.config.environment = environment
  }

  /** False once disabled, closed, or switched off in config. */
  isEnabled(): boolean {
    return this.config.enabled && this.disabledBy === null
  }

  /**
   * Why this client stopped, or null.
   *
   * Null while a client is merely configured `enabled: false`: that is not a
   * failure the SDK diagnosed, so there is no reason to report.
   */
  disabledReason(): DisabledReason | null {
    return this.disabledBy
  }

  // --- Capture --------------------------------------------------------------

  /**
   * The single ingress. Everything else in this class funnels through here.
   *
   * Filtering happens before defaulting so a dropped entry costs almost
   * nothing, and clipping happens after `beforeSend` so a hook that enriches an
   * entry cannot push it back over a wire limit.
   */
  enqueue(entry: LogHQEntry): void {
    try {
      if (!this.isEnabled())
        return

      const level = toLogHQLevel(entry?.level, 'info')
      if (!atLeast(level, this.config.minLevel))
        return

      const message = clipMessage(stringifyMessage(entry?.message))
      // The server counts a message-less entry as `skipped`, which is a loss it
      // cannot recover from. Dropping it here at least keeps the batch honest.
      if (!message.trim()) {
        this.discard(1, 'entry has no message')
        return
      }

      let shaped: LogHQEntry = {
        ...entry,
        level,
        message,
        channel: entry.channel ?? this.config.channel,
        environment: entry.environment ?? this.config.environment,
        release: entry.release ?? this.config.release,
        host: entry.host ?? this.config.hostname,
        sdk: entry.sdk ?? this.config.sdk,
        user: entry.user ?? this.config.user ?? undefined,
        // Stamped now, not at flush time: a batch that waits out a rate limit
        // would otherwise report a burst of entries as if they all happened
        // when the limit lifted.
        timestamp: entry.timestamp ?? new Date().toISOString(),
      }

      if (this.config.beforeSend) {
        let result: LogHQEntry | null
        try {
          result = this.config.beforeSend(shaped)
        }
        catch (err) {
          // A hook that throws is a hook that did not approve this entry.
          this.debug('warn', 'beforeSend threw, entry dropped', err)
          return
        }
        if (!result)
          return
        shaped = result
      }

      this.queue.push(this.clip(shaped))
      this.enforceQueueLimit()

      if (this.queue.length >= this.config.batchSize)
        void this.flush()
      else
        this.scheduleFlush()
    }
    catch (err) {
      // Logging must never be the reason a request fails.
      this.debug('warn', 'enqueue failed', err)
    }
  }

  capture(level: LogHQLevel, message: string, context?: Record<string, unknown>): void {
    this.enqueue({ level, message, context })
  }

  /**
   * Report a thrown value.
   *
   * The stack goes in `context` because loghq stores a flat stream with no
   * stack column, and the type is folded into the message because there is no
   * type column either: `TypeError: x is not a function` is what a reader needs
   * on the line itself.
   */
  captureException(err: unknown, extra?: Record<string, unknown>): void {
    try {
      const chain = describeChain(err)
      const head = chain[0] ?? { type: undefined, message: 'unknown error', stack: undefined }

      const context: Record<string, unknown> = { ...(extra ?? {}) }
      if (head.type)
        context.error_type = head.type
      if (head.stack)
        context.stack = head.stack
      if (chain.length > 1)
        context.causes = chain.slice(1)

      const message = head.type && !head.message.startsWith(head.type)
        ? `${head.type}: ${head.message}`
        : head.message

      this.enqueue({ level: 'error', message, context })
    }
    catch (error) {
      this.debug('warn', 'captureException failed', error)
    }
  }

  // --- Queue ----------------------------------------------------------------

  /**
   * Clip to the wire limits.
   *
   * Runs last so that whatever is queued is exactly what will be sent, and the
   * server has nothing left to truncate.
   */
  private clip(entry: LogHQEntry): LogHQEntry {
    const out: LogHQEntry = {
      ...entry,
      message: clipMessage(stringifyMessage(entry.message)),
      channel: clipVarchar(entry.channel, MAX_VARCHAR),
      environment: clipVarchar(entry.environment, MAX_VARCHAR),
      release: clipVarchar(entry.release, MAX_VARCHAR),
      framework: clipVarchar(entry.framework, MAX_VARCHAR),
      host: clipVarchar(entry.host, MAX_VARCHAR),
      trace_id: clipVarchar(entry.trace_id, MAX_CORRELATION),
      request_id: clipVarchar(entry.request_id, MAX_CORRELATION),
      context: boundedJson<Record<string, unknown>>(entry.context, MAX_JSON),
      user: boundedJson<LogHQUser>(entry.user, MAX_JSON),
      sdk: boundedJson<{ name: string, version: string }>(entry.sdk, MAX_SDK_JSON),
    }
    return out
  }

  /**
   * Hold the queue under its ceiling by dropping the oldest entries.
   *
   * Oldest-first is the deliberate choice: during an incident the newest lines
   * are the ones describing what is happening now, and a queue that drops the
   * tail would preserve the calm before it instead.
   */
  private enforceQueueLimit(): void {
    const overflow = this.queue.length - this.config.maxQueueSize
    if (overflow > 0) {
      this.queue.splice(0, overflow)
      this.discard(overflow, 'queue full')
    }
  }

  /** Put a batch back at the head of the queue, oldest-first order preserved. */
  private requeue(entries: LogHQEntry[]): void {
    if (!entries.length)
      return

    // A stopped client never drains again, so putting entries back would strand
    // them somewhere nothing will ever count them. Charge them here, while the
    // count is still accurate.
    if (this.stopped()) {
      this.discard(entries.length, `client disabled: ${this.disabledBy}`)
      return
    }

    this.queue.unshift(...entries)
    this.requeues++
    this.enforceQueueLimit()
  }

  private discard(count: number, reason: string): void {
    if (count <= 0)
      return
    this.lost += count
    this.debug('warn', `dropped ${count} ${count === 1 ? 'entry' : 'entries'} (${reason}), ${this.lost} lost in total`)
  }

  // --- Flushing -------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.timer || this.disabledBy || this.config.flushInterval <= 0 || !this.queue.length)
      return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.config.flushInterval)
    unref(this.timer)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Drain the queue.
   *
   * Resolves true only when every queued entry was accepted and the server
   * reported none skipped. A rate-limit pause, a permanent disable, or a batch
   * that exhausted its retries all resolve false, so a caller flushing before
   * exit can tell delivery from an attempt.
   *
   * A drain already on the wire counts toward this verdict. Hitting `batchSize`
   * starts one on its own, so entries the caller just logged are often in that
   * drain rather than in the queue this call will take, and ignoring it would
   * report a clean flush for a batch that had just been refused.
   */
  flush(): Promise<boolean> {
    const inFlight = this.running
    const mine = this.chainDrain(false)
    if (!inFlight)
      return mine
    return Promise.all([inFlight.catch(() => false), mine]).then(([a, b]) => a && b)
  }

  /**
   * Queue a drain behind whatever is already draining, and publish it as the
   * one in flight.
   *
   * `running` is assigned synchronously, before the chained drain gets its
   * microtask, because the caller most likely to need it is a `flush()` landing
   * in the same tick as the `batchSize` trigger that scheduled this one.
   *
   * The drain itself also starts synchronously when nothing is already
   * draining. Going through `.then()` unconditionally cost the `beforeExit`
   * flush its request on Bun, which exits without running a pending microtask:
   * the handler queued the drain, the process ended, and the fetch was never
   * issued. Deferring only when there is genuinely something to queue behind
   * keeps the serialization guarantee and gets the request onto the wire in the
   * same tick. `running === null` implies the previous drain settled, so this
   * cannot overlap two drains.
   */
  private chainDrain(final: boolean): Promise<boolean> {
    const start = (): Promise<boolean> => (final ? this.finalDrain() : this.drain())
    const next = this.running === null ? start() : this.chain.then(start, start)
    this.chain = next
    this.running = next
    const clear = (): void => {
      if (this.running === next)
        this.running = null
    }
    void next.then(clear, clear)
    return next
  }

  private async drain(): Promise<boolean> {
    let clean = true
    let stalled = 0
    try {
      this.clearTimer()

      while (this.queue.length) {
        if (this.blocked())
          return false

        const marker = this.requeues
        const batch = this.queue.splice(0, this.config.batchSize)
        const outcome = await this.deliver(batch, 0)
        if (!outcome.clean)
          clean = false

        // A pause or a permanent disable landed mid-batch: stop immediately
        // rather than throwing the rest of the queue at a server that just said
        // no. Anything still queued waits for the next enqueue or flush.
        if (this.blocked())
          return false

        // Progress means the batch left the queue and stayed gone, so the next
        // pass will send something new. Measured by requeues, not by queue
        // length: entries logged while the send was in flight make the queue
        // grow during a perfectly healthy drain, and length alone read that as
        // a stall and reported a clean flush as failed.
        if (this.requeues > marker) {
          // The same batch is about to be sent again. Hand off to the timer
          // rather than spin: this needs a server that reports every entry as
          // over-cap, but a tight loop against one is far worse than a late
          // flush.
          if (++stalled >= 2)
            return false
        }
        else {
          stalled = 0
        }
      }
    }
    catch (err) {
      this.debug('warn', 'flush failed', err)
      clean = false
    }
    finally {
      // The queue can be non-empty here after a requeue. Re-arm so the entries
      // are not stranded until the next log call.
      this.scheduleFlush()
    }
    return clean
  }

  /**
   * True while sending would be pointless: permanently stopped, or paused.
   *
   * `closed` is deliberately not one of these. `close()` sets it before running
   * the final drain, so counting it here gave that drain a retry budget of one:
   * the first network blip inside `close()` reached `backoff`, saw a disabled
   * client, and threw the batch away rather than retrying it. Ingress is closed
   * by `isEnabled`, which does treat `closed` as disabled.
   */
  private blocked(): boolean {
    return this.stopped() || Date.now() < this.pausedUntil
  }

  /** Permanently stopped. No later send can succeed, so nothing should queue. */
  private stopped(): boolean {
    return this.disabledBy !== null && this.disabledBy !== 'closed'
  }

  /**
   * Stop for good.
   *
   * `401`/`403`/`404` never become success by being retried, and a client that
   * keeps trying turns a misconfigured key into an outbound flood. The queue is
   * released too, since nothing in it can ever be delivered.
   */
  private disable(reason: DisabledReason, detail: string, inFlight: readonly LogHQEntry[] = []): void {
    this.disabledBy = reason
    this.clearTimer()
    // The in-flight batch was spliced out of the queue before the send, so it
    // is not in `this.queue` and went uncounted: a client killed by a bad key
    // under-reported its losses by up to a full batch, and `lost` is the only
    // number an operator has to reconcile against what the server stored.
    const stranded = this.queue.length + inFlight.length
    this.queue = []
    this.debug('warn', `disabled (${reason}): ${detail}`)
    this.discard(stranded, `client disabled: ${reason}`)
  }

  // --- Transport ------------------------------------------------------------

  private async deliver(batch: LogHQEntry[], attempt: number): Promise<DeliveryOutcome> {
    if (!batch.length)
      return { clean: true }

    let body: string
    try {
      body = JSON.stringify({ logs: batch })
    }
    catch (err) {
      // One bad entry, not a bad batch. `clip` round-trips `context`, `user`,
      // and `sdk`, but an entry is spread verbatim, so any other field the
      // caller attached (a BigInt, a circular reference, a `toJSON` that
      // throws) reaches this line intact and used to cost all 500 entries
      // around it. Isolate it instead.
      return this.isolate(batch, attempt, err)
    }

    let response: Response
    try {
      response = await this.post(body)
    }
    catch (err) {
      // Network error, DNS failure, or our own abort on timeout.
      return this.backoff(batch, attempt, err)
    }

    // Always read the body, even when it is uninteresting: an unconsumed
    // response body holds a socket open in Node.
    const text = await response.text().catch(() => '')
    const status = response.status

    if (status >= 200 && status < 300)
      return this.reconcile(batch, text)

    switch (status) {
      case 400:
        // Malformed payload. The server will reject it identically forever.
        this.debug('warn', `ingest rejected the payload: ${text.slice(0, 200)}`)
        this.discard(batch.length, 'rejected as malformed')
        return { clean: false }

      case 401:
        this.disable('auth', 'invalid ingest key', batch)
        return { clean: false }

      case 403:
        this.disable('inactive-project', 'project inactive or has no ingest key', batch)
        return { clean: false }

      case 404:
        this.disable('unknown-project', 'unknown project', batch)
        return { clean: false }

      case 413:
        return this.split(batch, attempt)

      case 429:
        this.pause(response.headers.get('retry-after'))
        this.requeue(batch)
        return { clean: false }

      default:
        // 5xx, and anything else unexpected, is treated as transient.
        return this.backoff(batch, attempt, `HTTP ${status}`)
    }
  }

  private post(body: string): Promise<Response> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.config.timeout)
      : null
    if (timeout)
      unref(timeout)

    // No `keepalive`: browsers cap keepalive bodies at 64 KiB and a full batch
    // is allowed to be eight times that.
    return fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LogHQ-Key': this.config.key,
      },
      body,
      signal: controller ? controller.signal : undefined,
    }).finally(() => {
      if (timeout)
        clearTimeout(timeout)
    })
  }

  /**
   * Read `stored`/`dropped`/`skipped` off a `201` and act on the difference.
   *
   * A `201` is an acknowledgement of the request, not of the entries. `dropped`
   * entries fell past the server's 500 cap without ever being examined, so they
   * are worth resending; `skipped` entries were examined and refused, so
   * resending them would produce the same refusal and waste the quota.
   */
  private reconcile(batch: LogHQEntry[], text: string): DeliveryOutcome {
    const result = parseResult(text)
    if (!result) {
      this.debug('warn', 'ingest returned an unreadable body, assuming stored')
      return { clean: true }
    }

    if (result.dropped > 0 || result.skipped > 0) {
      this.debug(
        'warn',
        `ingest stored ${result.stored}, dropped ${result.dropped}, skipped ${result.skipped} of ${batch.length}`,
      )
    }

    if (result.skipped > 0)
      this.discard(result.skipped, 'rejected by the server as unusable')

    if (result.dropped > 0) {
      // The server reads from the front of the batch, so the overflow is the
      // tail. Send exactly that back.
      const overflow = batch.slice(Math.max(0, batch.length - result.dropped))
      this.requeue(overflow)
    }

    // Only `skipped` is a loss. Requeued entries are still in play and the
    // drain loop decides their verdict when it sends them again.
    return { clean: result.skipped === 0 }
  }

  /**
   * Halve an oversized batch and send both halves.
   *
   * A single entry that still comes back `413` is over the request limit all by
   * itself, and no amount of splitting will save it.
   */
  private async split(batch: LogHQEntry[], attempt: number): Promise<DeliveryOutcome> {
    if (batch.length === 1) {
      this.debug('warn', 'a single entry exceeds the ingest body limit')
      this.discard(1, 'entry too large to send')
      return { clean: false }
    }
    return this.halve(batch, attempt)
  }

  /**
   * Find the entries that cannot be serialized and drop only those.
   *
   * Bisecting costs log2(n) extra requests in the rare case something in the
   * batch is unserializable, and nothing at all otherwise, which is a better
   * trade than losing every entry that happened to be queued alongside it.
   */
  private async isolate(batch: LogHQEntry[], attempt: number, cause: unknown): Promise<DeliveryOutcome> {
    if (batch.length === 1) {
      this.debug('warn', 'entry could not be serialized, dropping it', cause)
      this.discard(1, 'unserializable entry')
      return { clean: false }
    }
    return this.halve(batch, attempt)
  }

  /**
   * Deliver a batch as two halves.
   *
   * The attempt count is deliberately not incremented. Neither caller is
   * reacting to a transport failure: a `413` is a sizing answer and a
   * serialization throw is a content answer, so each half deserves its own full
   * retry budget.
   */
  private async halve(batch: LogHQEntry[], attempt: number): Promise<DeliveryOutcome> {
    const mid = Math.ceil(batch.length / 2)
    const first = await this.deliver(batch.slice(0, mid), attempt)
    if (this.blocked()) {
      this.requeue(batch.slice(mid))
      return { clean: false }
    }
    const second = await this.deliver(batch.slice(mid), attempt)
    return { clean: first.clean && second.clean }
  }

  /**
   * Pause every send until the server's deadline.
   *
   * The pause is client-wide rather than per batch: the limit is charged per
   * entry per project, so another batch racing ahead would only deepen it.
   */
  private pause(retryAfter: string | null): void {
    const parsed = Number(retryAfter)
    const seconds = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, RETRY_AFTER_MAX_S)
      : RETRY_AFTER_FALLBACK_S
    this.pausedUntil = Date.now() + seconds * 1000
    this.debug('warn', `rate limited, pausing for ${seconds}s`)
  }

  /**
   * Wait, then try the same batch again.
   *
   * Jittered because every instance of an app hits the same outage at the same
   * moment, and a bare doubling would send them all back in lockstep.
   */
  private async backoff(batch: LogHQEntry[], attempt: number, cause: unknown): Promise<DeliveryOutcome> {
    const next = attempt + 1
    if (next >= this.config.maxRetries) {
      this.debug('warn', `giving up after ${next} attempts`, cause)
      this.discard(batch.length, 'transport failed')
      return { clean: false }
    }

    const window = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
    await sleep(window / 2 + Math.random() * (window / 2))

    if (this.blocked()) {
      // Stopped or paused while we were waiting. Hold the batch instead of
      // firing it into a wall, unless there is nothing left to hold it for.
      if (this.stopped())
        this.discard(batch.length, 'client disabled mid-retry')
      else
        this.requeue(batch)
      return { clean: false }
    }

    return this.deliver(batch, next)
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Flush and shut down.
   *
   * Ingress closes first so a log call racing the shutdown cannot extend the
   * drain forever, but `closed` is not treated as a transport failure, so the
   * final flush still gets to run.
   */
  async close(): Promise<void> {
    this.clearTimer()
    if (this.disabledBy === null)
      this.disabledBy = 'closed'
    else
      this.queue = []

    try {
      // Bypass `flush`, whose drain would refuse to run against a disabled
      // client. This is the one drain allowed to ignore `closed`.
      await this.chainDrain(true)
    }
    catch (err) {
      this.debug('warn', 'close failed', err)
    }
    this.clearTimer()
  }

  private async finalDrain(): Promise<boolean> {
    let clean = true
    let stalled = 0

    while (this.queue.length) {
      // Permanent reasons still stop us; `closed` does not.
      if (this.stopped())
        return false
      if (Date.now() < this.pausedUntil) {
        this.discard(this.queue.length, 'rate limited at close')
        this.queue = []
        return false
      }

      const marker = this.requeues
      const batch = this.queue.splice(0, this.config.batchSize)
      const outcome = await this.deliver(batch, 0)
      if (!outcome.clean)
        clean = false

      // The same guard `drain` has, and it matters more here. Without it, a
      // server that answers every batch with `dropped` kept this loop
      // requeueing and resending the same entries as fast as the network
      // allowed, and `close()` never resolved. Give up and say what was lost.
      if (this.requeues > marker) {
        if (++stalled >= 2) {
          this.discard(this.queue.length, 'no progress at close')
          this.queue = []
          return false
        }
      }
      else {
        stalled = 0
      }
    }

    return clean
  }

  // --- Diagnostics ----------------------------------------------------------

  /**
   * Write to the console, never to the host logger.
   *
   * This SDK is normally installed as a drain on the application's logger, so a
   * diagnostic routed through that logger would come straight back in as an
   * entry, which produces another diagnostic. Console is the only safe channel,
   * and it stays silent unless `debug` is on.
   */
  private debug(kind: 'info' | 'warn', message: string, detail?: unknown): void {
    if (!this.config.debug)
      return
    try {
      const line = `[loghq] ${message}`
      const write = kind === 'warn' ? console.warn : console.info
      if (detail === undefined)
        write(line)
      else
        write(line, detail)
    }
    catch {
      // A console that throws is not worth a second attempt.
    }
  }
}

/** Read a `201` body defensively: a proxy in the path may have rewritten it. */
function parseResult(text: string): IngestResult | null {
  if (!text)
    return null
  try {
    const parsed = JSON.parse(text) as Partial<IngestResult> | null
    if (!parsed || typeof parsed !== 'object')
      return null
    return {
      ok: parsed.ok !== false,
      stored: countOf(parsed.stored),
      dropped: countOf(parsed.dropped),
      skipped: countOf(parsed.skipped),
    }
  }
  catch {
    return null
  }
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
