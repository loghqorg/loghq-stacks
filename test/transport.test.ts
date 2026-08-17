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
import { activeSeam, install, loghqTransport, uninstall } from '../src/stacks'

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
