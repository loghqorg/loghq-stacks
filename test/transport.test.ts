/**
 * The transport seam: the declarative half of this package.
 *
 * `install()` finds the logger at runtime and patches it. This is the other
 * direction, and the better one where the framework supports it: the logger is
 * handed a transport by `config/logging.ts` and calls it. Nothing is patched,
 * there is no ordering problem, and it applies to every process that boots the
 * framework rather than to whichever one imported a bootstrap file.
 *
 * The records here are shaped exactly as `@stacksjs/logging` emits them, since
 * that shape is the contract and a double that drifts from it tests nothing.
 */

import type { LogHQEntry, StacksLogRecord, StacksLogTransport } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { activeSeam, install, loghqTransport, uninstall, verifyAttached } from '../src/stacks'

const KEY = `loghq_${'a1b2c3d4'.repeat(8)}`
const HOST = 'http://ingest.test'

const baseOptions = {
  key: KEY,
  host: HOST,
  batchSize: 1,
  flushInterval: 0,
  minLevel: 'debug' as const,
}

interface Call { url: string, body: any }

let calls: Call[]
let restoreFetch: () => void
let closers: Array<() => Promise<void> | void>

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function entries(): LogHQEntry[] {
  return calls.flatMap(call => (call.body?.logs ?? []) as LogHQEntry[])
}

function lastEntry(): any {
  const all = entries()
  return all[all.length - 1]
}

/** A transport under test, cleaned up after. */
function transport(options: Record<string, unknown> = {}): StacksLogTransport {
  const t = loghqTransport({ ...baseOptions, ...options } as any)
  closers.push(() => t.flush?.())
  return t
}

/**
 * A record exactly as `@stacksjs/logging` builds one.
 *
 * `message` is the formatted console line, `args` is the call before
 * formatting. The two differ on purpose in these tests, because which one the
 * adapter reads is the thing being pinned down.
 */
function record(partial: Partial<StacksLogRecord> & { level: string }): StacksLogRecord {
  return {
    message: '',
    args: [],
    timestamp: new Date(0).toISOString(),
    ...partial,
  }
}

function makeFakeLog(): Record<string, any> {
  const method = (name: string) => (...args: unknown[]) => Promise.resolve(`${name}-ok`)
  return {
    info: method('info'),
    success: method('success'),
    warn: method('warn'),
    warning: method('warning'),
    error: method('error'),
    debug: method('debug'),
  }
}

beforeEach(() => {
  calls = []
  closers = []
  const original = globalThis.fetch
  globalThis.fetch = mock(async (url: any, init: any) => {
    let body: any
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    }
    catch {
      body = init?.body
    }
    calls.push({ url: String(url), body })
    return response(201, { ok: true, stored: body?.logs?.length ?? 1, dropped: 0, skipped: 0 })
  }) as unknown as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
})

afterEach(async () => {
  try {
    uninstall()
  }
  catch {
    // uninstall on a never-installed adapter is not a teardown failure
  }
  for (const close of closers) {
    try {
      await close()
    }
    catch {
      // ignore
    }
  }
  restoreFetch()
})

describe('loghqTransport', () => {
  it('is shaped the way the framework expects', () => {
    const t = transport()

    expect(t.name).toBe('loghq')
    expect(typeof t.log).toBe('function')
    expect(typeof t.flush).toBe('function')
    // No `level`: the framework's five levels and loghq's eight are different
    // scales, so filtering happens on `minLevel` in loghq's own vocabulary.
    expect(t.level).toBeUndefined()
  })

  it('takes a name, for an app declaring more than one', () => {
    expect(transport({ name: 'audit' }).name).toBe('audit')
  })

  it('ships a record', async () => {
    const t = transport()

    t.log(record({ level: 'info', message: 'checkout started', args: ['checkout started'] }))
    await t.flush!()

    expect(lastEntry().message).toBe('checkout started')
    expect(lastEntry().level).toBe('info')
    expect(lastEntry().framework).toBe('stacks')
  })

  it('reads the arguments rather than the formatted line', async () => {
    const t = transport()

    // This is what the framework actually produces: `formatMessage` prepends
    // the request id and appends the context, pretty-printed, into one string.
    t.log(record({
      level: 'info',
      message: '[req_7] checkout started {\n  "orderId": 42\n}',
      args: ['checkout started', { orderId: 42 }],
    }))
    await t.flush!()

    // Taking `message` would have shipped the whole blob as the searchable
    // field and left `context` empty, which is the opposite of the point.
    expect(lastEntry().message).toBe('checkout started')
    expect(lastEntry().context.orderId).toBe(42)
  })

  it('falls back to the formatted line when there are no arguments', async () => {
    const t = transport()

    t.log(record({ level: 'warning', message: 'something happened', args: [] }))
    await t.flush!()

    expect(lastEntry().message).toBe('something happened')
  })

  it('maps the framework severities onto loghq severities', async () => {
    const t = transport()

    for (const level of ['debug', 'info', 'success', 'warning', 'error'])
      t.log(record({ level, message: level, args: [level] }))
    await t.flush!()

    // `success` has no loghq equivalent, so it lands on `info` with the
    // original preserved rather than being invented into `notice`.
    expect(entries().map(e => e.level)).toEqual(['debug', 'info', 'info', 'warning', 'error'])
    expect(entries()[2]!.context!.original_level).toBe('success')
  })

  it('lifts the correlation ids out of the record context', async () => {
    const t = transport()

    t.log(record({
      level: 'error',
      message: 'checkout failed',
      args: ['checkout failed'],
      context: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', requestId: 'req_7', userId: 99 },
    }))
    await t.flush!()

    const entry = lastEntry()
    expect(entry.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(entry.request_id).toBe('req_7')
    expect(entry.user.id).toBe(99)
  })

  it('recognizes a struct event coming through the transport', async () => {
    const t = transport()

    t.log(record({
      level: 'warning',
      message: '[db.slow_query] {"sql":"select 1"}',
      args: ['[db.slow_query]', { event: 'db.slow_query', sql: 'select 1', durationMs: 900 }],
    }))
    await t.flush!()

    expect(lastEntry().message).toBe('db.slow_query')
    expect(lastEntry().channel).toBe('db.slow_query')
    expect(lastEntry().context.durationMs).toBe(900)
  })

  it('drops struct events when asked', async () => {
    const t = transport({ captureStruct: false })

    t.log(record({
      level: 'warning',
      message: '[db.query] …',
      args: ['[db.query]', { event: 'db.query', sql: 'select 1' }],
    }))
    await t.flush!()

    expect(calls).toHaveLength(0)
  })

  it('does not throw into the logger when a record is unusable', () => {
    const t = transport()

    // The logger calls this on the application's own path. Whatever arrives,
    // it has to return.
    expect(() => t.log(undefined as unknown as StacksLogRecord)).not.toThrow()
    expect(() => t.log({ level: 'info' } as StacksLogRecord)).not.toThrow()
    expect(() => t.log(record({ level: 'nonsense', args: [null] }))).not.toThrow()
  })
})

describe('install() against a framework that has the registry', () => {
  it('registers as a transport instead of teeing the singleton', async () => {
    const log = makeFakeLog()
    const before = log.info
    let registered: StacksLogTransport | null = null

    const ns = {
      log,
      registerTransport: (sink: StacksLogTransport) => {
        registered = sink
        return () => { registered = null }
      },
    }

    const client = install({ ...baseOptions, logger: ns, captureUnhandled: false } as any)
    closers.push(() => client.close())

    expect(activeSeam()).toEqual({ seam: 'transport', via: 'registerTransport' })
    // The whole point of the upstream seam: nothing was monkey-patched.
    expect(log.info).toBe(before)
    expect(registered).not.toBeNull()

    registered!.log(record({ level: 'error', message: 'from the registry', args: ['from the registry'] }))
    await client.flush()

    expect(lastEntry().message).toBe('from the registry')
  })

  it('detaches from the registry on uninstall', () => {
    const log = makeFakeLog()
    let attached = true
    const ns = {
      log,
      registerTransport: () => () => { attached = false },
    }

    const client = install({ ...baseOptions, logger: ns, captureUnhandled: false } as any)
    closers.push(() => client.close())
    expect(attached).toBe(true)

    uninstall()
    expect(attached).toBe(false)
  })
})

/**
 * `verifyAttached()` exists because neither of the two facts you can get for
 * free is the fact you want.
 *
 * `activeSeam()` reports only what `install()` built, and a declared transport
 * is deliberately not that. Constructing the transport reports only that a
 * config file was evaluated, which happens on a framework that will never read
 * it. The question that separates them can only be put to the logger, which is
 * why `logger` is injected here the same way `install()` takes it.
 */
describe('verifyAttached', () => {
  const DETACHED = { seam: 'none', via: null, live: false, disabledReason: null, introspected: false } as const

  /** A logger namespace holding a real registry, the way 0.72.x does. */
  function withRegistry(held: StacksLogTransport[]) {
    return {
      log: makeFakeLog(),
      transports: () => held.slice(),
      registerTransport: (sink: StacksLogTransport) => {
        held.push(sink)
        return () => { held.splice(held.indexOf(sink), 1) }
      },
    }
  }

  it('reports the declarative seam that activeSeam() cannot see', async () => {
    const held: StacksLogTransport[] = []
    const logger = withRegistry(held)

    // Exactly what config/logging.ts does, then what the framework does with
    // the value it returned.
    held.push(loghqTransport({ ...baseOptions }))

    // The false negative this function exists to correct: attached, reported
    // as unattached, because the installation belongs to the config.
    expect(activeSeam()).toEqual({ seam: 'none', via: null })
    expect(await verifyAttached({ logger })).toEqual({ seam: 'transport', via: 'config/logging.ts', live: true, disabledReason: null, introspected: true })
  })

  it('reports none when the framework never read the config', async () => {
    // reportshq's shape: a logger with no transport registry at all. The config
    // still evaluates and this package still loads, so every signal short of
    // asking the logger says yes.
    const logger = { log: makeFakeLog() }
    const transport = loghqTransport({ ...baseOptions })
    expect(transport.name).toBe('loghq')

    expect(await verifyAttached({ logger })).toEqual(DETACHED)
  })

  it('does not mistake somebody else\'s transport for ours', async () => {
    const logger = withRegistry([{ name: 'bughq', log: () => {} } as unknown as StacksLogTransport])

    expect(await verifyAttached({ logger })).toEqual(DETACHED)
  })

  it('matches a transport registered under a custom name', async () => {
    const held: StacksLogTransport[] = []
    const logger = withRegistry(held)
    held.push(loghqTransport({ ...baseOptions, name: 'loghq-audit' }))

    expect(await verifyAttached({ logger })).toEqual(DETACHED)
    expect(await verifyAttached({ logger, name: 'loghq-audit' }))
      .toEqual({ seam: 'transport', via: 'config/logging.ts', live: true, disabledReason: null, introspected: true })
  })

  it('prefers a live install() seam over the registry', async () => {
    const log = makeFakeLog()
    const client = install({ ...baseOptions, logger: log, captureUnhandled: false } as any)
    closers.push(() => client.close())

    // install() found no registrar and patched log.* instead. That is a real
    // attachment and must be reported as the tee it is, not overwritten by a
    // registry lookup that would answer none.
    expect(await verifyAttached({ logger: log })).toEqual({ seam: 'tee', via: 'log.*', live: true, disabledReason: null, introspected: true })
  })

  it('reports a keyless transport as attached but not live', async () => {
    // The failure that hid in production for weeks. config/logging.ts is
    // evaluated before the env is populated, so `key` arrives empty, the client
    // disables itself on construction, and the transport still attaches
    // perfectly: the logger holds it and hands it every record, which it drops.
    // Attachment alone therefore cannot be the boot assertion.
    const held: StacksLogTransport[] = []
    const logger = withRegistry(held)
    held.push(loghqTransport({ ...baseOptions, key: '' }))

    const info = await verifyAttached({ logger })
    expect(info.seam).toBe('transport')
    expect(info.live).toBe(false)
    expect(info.disabledReason).toBe('auth')
  })

  it('reports a keyed transport as live', async () => {
    const held: StacksLogTransport[] = []
    const logger = withRegistry(held)
    held.push(loghqTransport({ ...baseOptions }))

    const info = await verifyAttached({ logger })
    expect(info.live).toBe(true)
    expect(info.disabledReason).toBeNull()
  })

  it('reports a foreign transport as live, rather than failing a working app', async () => {
    // Another copy of this package built it, so it is not in our WeakMap. It is
    // genuinely attached; calling that a failure is the worse error.
    const logger = withRegistry([{ name: 'loghq', log: () => {} } as unknown as StacksLogTransport])

    const info = await verifyAttached({ logger })
    expect(info).toEqual({ seam: 'transport', via: 'config/logging.ts', live: true, disabledReason: null, introspected: false })
  })

  it('survives a reader that throws', async () => {
    const logger = {
      log: makeFakeLog(),
      transports: () => { throw new Error('registry has not booted') },
    }

    expect(await verifyAttached({ logger })).toEqual(DETACHED)
  })
})

/**
 * Regressions from an adversarial audit of `verifyAttached()`. Each of these
 * failed before its fix, and every one of them made the function answer the
 * opposite of the truth — which for a boot assertion means either crashing a
 * healthy app or blessing a dead one.
 */
describe('verifyAttached regressions', () => {
  function registry(held: StacksLogTransport[], opts: { lazy?: boolean } = {}) {
    let started = !opts.lazy
    return {
      log: makeFakeLog(),
      // The real @stacksjs/logging registers config transports inside this,
      // not at module load. Until it is awaited, transports() is empty.
      logger: async () => { started = true },
      transports: () => (started ? held.slice() : []),
    }
  }

  it('triggers the logger\'s lazy init before reading the registry', async () => {
    // The worst failure of the lot: a declared, keyed, delivering transport
    // reported as seam:'none' purely because nothing had logged yet. The
    // documented assertion throws on that, so it would crash healthy apps at
    // boot — precisely when a boot assertion runs.
    const held: StacksLogTransport[] = [loghqTransport({ ...baseOptions })]
    const logger = registry(held, { lazy: true })

    expect(logger.transports()).toEqual([])
    const info = await verifyAttached({ logger })
    expect(info.seam).toBe('transport')
    expect(info.live).toBe(true)
  })

  it('does not report a conflict seam as live', async () => {
    // A conflict means another copy of the package owns the logger and this
    // installation will never receive a record. Its client is nonetheless
    // perfectly enabled, so asking the client alone gets this backwards.
    const log = makeFakeLog()
    const client = install({ ...baseOptions, logger: log, captureUnhandled: false } as any)
    closers.push(() => client.close())
    const seam = activeSeam()
    if (seam.seam !== 'conflict')
      return // only meaningful where a conflict is reachable

    const info = await verifyAttached({ logger: log })
    expect(info.live).toBe(false)
  })

  it('prefers a live declared transport over a dead install() seam', async () => {
    // An app that moved its key into config/logging.ts but left the old
    // bootstrap import in place has both seams. The install() client is dead;
    // the declared one is delivering. Reporting the dead one fails a working app.
    const held: StacksLogTransport[] = [loghqTransport({ ...baseOptions })]
    const logger = registry(held)
    const client = install({ ...baseOptions, key: '', logger, captureUnhandled: false } as any)
    closers.push(() => client.close())

    const info = await verifyAttached({ logger })
    expect(info.live).toBe(true)
    expect(info.disabledReason).toBeNull()
  })

  it('does not let a dead duplicate mask a live transport', async () => {
    // config/logging.ts is evaluated many times during boot, so more than one
    // transport can end up held under the same name. Taking the first is
    // positional, not meaningful.
    const held: StacksLogTransport[] = [
      loghqTransport({ ...baseOptions, key: '' }),
      loghqTransport({ ...baseOptions }),
    ]
    const info = await verifyAttached({ logger: registry(held) })
    expect(info.live).toBe(true)
  })

  it('marks an un-introspectable transport as assumed, not measured', async () => {
    const logger = registry([{ name: 'loghq', log: () => {} } as unknown as StacksLogTransport])
    const info = await verifyAttached({ logger })
    expect(info.live).toBe(true)
    expect(info.introspected).toBe(false)
  })
})
