import type { LogHQEntry } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { install, uninstall } from '../src/stacks'

const KEY = `loghq_${'a1b2c3d4'.repeat(8)}`
const HOST = 'http://ingest.test'

/**
 * batchSize 1 turns every forwarded call into exactly one request, so the wire
 * is a faithful transcript of what the adapter produced. flushInterval 0 keeps
 * a timer from firing partway through an assertion.
 */
const baseOptions: Record<string, unknown> = {
  key: KEY,
  host: HOST,
  batchSize: 1,
  flushInterval: 0,
  minLevel: 'debug',
  // Process-level handlers outlive the test that installed them, and a stray
  // one turns an unrelated failure elsewhere in the suite into a loghq entry.
  captureUnhandled: false,
}

interface Call {
  url: string
  body: any
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

let fetchCalls: Call[]
let respond: () => unknown
let restoreFetch: () => void
let installed: Array<{ close?: () => Promise<void> | void }>

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => realSetTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('waitFor: condition never became true')
    await sleep(2)
  }
}

/** Every entry the adapter has put on the wire so far, oldest first. */
function entries(): LogHQEntry[] {
  return fetchCalls.flatMap(call => (call.body?.logs ?? []) as LogHQEntry[])
}

function lastEntry(): any {
  const all = entries()
  return all[all.length - 1]
}

interface LogCall {
  method: string
  args: unknown[]
}

/**
 * A stand-in for the Stacks `log` singleton.
 *
 * The real one is a mutable object whose methods can be reassigned at runtime,
 * which is the whole reason a bridge is possible. `struct` routes back through
 * these same methods, exactly as the framework's does, so wrapping the five
 * severity methods is enough to capture structured events too.
 */
function makeFakeLog() {
  const calls: LogCall[] = []

  const asyncMethod = (method: string) => (...args: unknown[]): Promise<string> => {
    calls.push({ method, args })
    return Promise.resolve(`${method}-ok`)
  }
  const syncMethod = (method: string) => (...args: unknown[]): string => {
    calls.push({ method, args })
    return `${method}-ok`
  }

  const log: Record<string, any> = {
    info: asyncMethod('info'),
    success: asyncMethod('success'),
    warn: asyncMethod('warn'),
    warning: asyncMethod('warning'),
    error: asyncMethod('error'),
    debug: asyncMethod('debug'),
    dump: asyncMethod('dump'),
    dd: asyncMethod('dd'),
    echo: asyncMethod('echo'),
    flush: asyncMethod('flush'),
    time: syncMethod('time'),
    syncWarn: syncMethod('syncWarn'),
    syncError: syncMethod('syncError'),
    fatal: syncMethod('fatal'),
    exit: syncMethod('exit'),
  }

  log.struct = {
    request: (method: string, path: string, status: number, durationMs: number) => {
      const event = { event: 'http.request', method, path, status, durationMs }
      return status >= 500 ? log.error(event) : log.info(event)
    },
    query: (sql: string, durationMs: number) => log.debug('[db.query]', { event: 'db.query', sql, durationMs }),
    slowQuery: (sql: string, durationMs: number) => log.warn('[db.slow_query]', { event: 'db.slow_query', sql, durationMs }),
    job: (name: string, status: string) => log.info('[queue.job]', { event: 'queue.job', name, status }),
    cache: (op: string, key: string, hit: boolean) => log.debug('[cache]', { event: 'cache', op, key, hit }),
  }

  const countOf = (method: string) => calls.filter(call => call.method === method).length

  return { log, calls, countOf }
}

const SEVERITY_METHODS = ['info', 'success', 'warn', 'warning', 'error', 'debug'] as const

/**
 * Install against the double.
 *
 * `logger` is the adapter's documented injection point: handing the singleton
 * over skips the runtime probe for `@stacksjs/logging`, which is both the only
 * way to attach synchronously and the only way to attach to something that is
 * not a real Stacks app.
 *
 * The post-check turns a silent non-attachment into one clear failure here,
 * rather than a dozen confusing ones in the assertions below.
 */
function installAdapter(log: Record<string, any>, options: Record<string, unknown> = {}, logger: unknown = log): void {
  const before = log.info
  installed.push(install({ ...baseOptions, ...options, logger } as any))
  if (log.info === before)
    throw new Error('install() did not attach to the fake logger')
}

/** A second install over the first, for the double-wrap test. */
function installAgain(log: Record<string, any>, options: Record<string, unknown> = {}): void {
  installed.push(install({ ...baseOptions, ...options, logger: log } as any))
}

beforeEach(() => {
  fetchCalls = []
  installed = []
  respond = () => response(201, { ok: true, stored: 1, dropped: 0, skipped: 0 })
  const original = globalThis.fetch
  globalThis.fetch = mock(async (url: any, init: any) => {
    let body: any
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    }
    catch {
      body = init?.body
    }
    fetchCalls.push({ url: String(url), body })
    return respond()
  }) as unknown as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
})

afterEach(async () => {
  respond = () => response(201, { ok: true, stored: 1, dropped: 0, skipped: 0 })
  try {
    uninstall()
  }
  catch {
    // uninstall on a never-installed adapter is not a teardown failure
  }
  for (const client of installed) {
    try {
      await client?.close?.()
    }
    catch {
      // ignore
    }
  }
  restoreFetch()
})

describe('install', () => {
  it('forwards to loghq while still calling the original with the same arguments', async () => {
    const { log, calls } = makeFakeLog()
    installAdapter(log)

    const result = await log.info('checkout started', { orderId: 42 })

    expect(result).toBe('info-ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('info')
    expect(calls[0]!.args).toEqual(['checkout started', { orderId: 42 }])

    await waitFor(() => fetchCalls.length >= 1)
    expect(String(lastEntry().message)).toContain('checkout started')
    expect(lastEntry().framework).toBe('stacks')
  })

  it('replaces the severity methods and leaves the object identity alone', async () => {
    const { log } = makeFakeLog()
    const originals = Object.fromEntries(SEVERITY_METHODS.map(name => [name, log[name]]))
    installAdapter(log)

    for (const name of SEVERITY_METHODS)
      expect(typeof log[name]).toBe('function')
    expect(log.info).not.toBe(originals.info)
    expect(log.error).not.toBe(originals.error)
  })

  it('maps each Stacks severity onto the loghq vocabulary', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    await log.debug('d')
    await log.info('i')
    await log.warn('w')
    await log.warning('w2')
    await log.error('e')
    await waitFor(() => entries().length >= 5)

    const byMessage = new Map(entries().map(entry => [entry.message, entry.level]))
    expect(byMessage.get('d')).toBe('debug')
    expect(byMessage.get('i')).toBe('info')
    expect(byMessage.get('w')).toBe('warning')
    expect(byMessage.get('w2')).toBe('warning')
    expect(byMessage.get('e')).toBe('error')
  })

  it('records the original level when success collapses to info', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    await log.success('order placed')
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.level).toBe('info')
    // The collapse is lossy, so the name the author chose is kept in context.
    expect(entry.context?.original_level).toBe('success')
  })

  it('carries an Error message through log.error', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    await log.error(new TypeError('gateway exploded'))
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.level).toBe('error')
    expect(String(entry.message)).toContain('gateway exploded')
  })

  it('drops no argument of a multi-argument call', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    await log.info('user', 'signed in', 42)
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(String(entry.message)).toContain('user')
    // Where the trailing arguments land is the adapter's call; that none of them
    // vanish is the contract.
    const serialized = JSON.stringify(entry)
    expect(serialized).toContain('signed in')
    expect(serialized).toContain('42')
  })

  it('respects minLevel, so a filtered call still reaches the original', async () => {
    const { log, calls } = makeFakeLog()
    installAdapter(log, { minLevel: 'error' })

    await log.info('too quiet to send')
    await sleep(30)

    expect(calls).toHaveLength(1)
    expect(fetchCalls).toHaveLength(0)
  })

  it('does not double-wrap when installed twice', async () => {
    const { log, countOf } = makeFakeLog()
    const original = log.info
    installAdapter(log)
    installAgain(log)

    expect(log.info).not.toBe(original)

    await log.info('once please')
    await sleep(40)

    // A second wrapper layered on the first would call the original twice and
    // ship the line twice, which is how a hot reload quietly doubles a bill.
    expect(countOf('info')).toBe(1)
    expect(entries()).toHaveLength(1)
  })
})

describe('struct events', () => {
  it('maps event to channel and the rest to context', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    log.struct.request('GET', '/checkout', 500, 42)
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.level).toBe('error')
    expect(entry.channel).toBe('http.request')
    expect(entry.context.method).toBe('GET')
    expect(entry.context.path).toBe('/checkout')
    expect(entry.context.status).toBe(500)
    expect(entry.context.durationMs).toBe(42)
    // `event` became the channel, so leaving a copy in context is duplication.
    expect(entry.context.event).toBeUndefined()
    expect(typeof entry.message).toBe('string')
    expect(String(entry.message).length).toBeGreaterThan(0)
  })

  it('reads the event out of a trailing object beside a message string', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    log.struct.slowQuery('select * from orders', 900)
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.level).toBe('warning')
    expect(entry.channel).toBe('db.slow_query')
    expect(entry.context.sql).toBe('select * from orders')
    expect(entry.context.durationMs).toBe(900)
    expect(String(entry.message)).toContain('db.slow_query')
  })

  it('routes a successful request through info, not error', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    log.struct.request('GET', '/health', 200, 3)
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.level).toBe('info')
    expect(entry.channel).toBe('http.request')
  })

  it('lifts the correlation ids out of the ambient log context', async () => {
    const { log } = makeFakeLog()
    // The namespace shape: `@stacksjs/logging` exports the singleton alongside
    // getLogContext, which is the only route to the router's AsyncLocalStorage.
    const namespace = {
      log,
      getLogContext: () => ({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', requestId: 'req_9f2c' }),
    }
    installAdapter(log, {}, namespace)

    await log.error('inside a request')
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    // The host names it requestId and the wire names it request_id, so this is a
    // rename and a missed one loses the join key entirely.
    expect(entry.request_id).toBe('req_9f2c')
  })

  it('ships the entry anyway when the context lookup throws', async () => {
    const { log } = makeFakeLog()
    const namespace = {
      log,
      getLogContext: () => { throw new Error('storage has unwound') },
    }
    installAdapter(log, {}, namespace)

    await log.error('outside any request')
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(String(entry.message)).toContain('outside any request')
    expect(entry.trace_id).toBeUndefined()
  })

  it('leaves a plain object argument without an event alone', async () => {
    const { log } = makeFakeLog()
    installAdapter(log)

    await log.info('plain payload', { orderId: 7, total: 1200 })
    await waitFor(() => fetchCalls.length >= 1)

    const entry = lastEntry()
    expect(entry.context.orderId).toBe(7)
    expect(entry.context.total).toBe(1200)
  })
})

describe('uninstall', () => {
  it('restores the exact original function identities', async () => {
    const { log } = makeFakeLog()
    const originals: Record<string, unknown> = {}
    for (const name of SEVERITY_METHODS)
      originals[name] = log[name]

    installAdapter(log)
    expect(log.info).not.toBe(originals.info)

    uninstall()

    for (const name of SEVERITY_METHODS)
      expect(log[name]).toBe(originals[name])
  })

  it('stops forwarding once uninstalled', async () => {
    const { log, countOf } = makeFakeLog()
    installAdapter(log)
    uninstall()

    await log.error('after teardown')
    await sleep(30)

    expect(countOf('error')).toBe(1)
    expect(fetchCalls).toHaveLength(0)
  })

  it('is safe to call twice and before any install', async () => {
    expect(() => uninstall()).not.toThrow()
    expect(() => uninstall()).not.toThrow()

    const { log } = makeFakeLog()
    const original = log.info
    installAdapter(log)
    uninstall()
    uninstall()
    expect(log.info).toBe(original)
  })

  it('can be reinstalled after an uninstall', async () => {
    const { log, countOf } = makeFakeLog()
    installAdapter(log)
    uninstall()
    installAdapter(log)

    await log.info('second life')
    await waitFor(() => fetchCalls.length >= 1)

    expect(countOf('info')).toBe(1)
    expect(String(lastEntry().message)).toContain('second life')
  })
})

describe('a hostile host logger', () => {
  it('forwards and rethrows when the original throws', async () => {
    const { log } = makeFakeLog()
    let originalCalls = 0
    log.error = () => {
      originalCalls++
      throw new Error('the host logger is broken')
    }
    installAdapter(log)

    expect(() => log.error('still worth reporting')).toThrow('the host logger is broken')
    expect(originalCalls).toBe(1)

    // Losing the entry because the host logger failed is the exact case the
    // bridge exists for, so forwarding must not be conditional on it.
    await waitFor(() => fetchCalls.length >= 1)
    expect(String(lastEntry().message)).toContain('still worth reporting')
  })

  it('propagates a rejected promise from the original', async () => {
    const { log } = makeFakeLog()
    log.warn = () => Promise.reject(new Error('async host failure'))
    installAdapter(log)

    await expect(log.warn('unstable')).rejects.toThrow('async host failure')
    await waitFor(() => fetchCalls.length >= 1)
    expect(String(lastEntry().message)).toContain('unstable')
  })

  it('does not re-enter without bound when the forward path itself logs', async () => {
    const { log, countOf } = makeFakeLog()
    let beforeSendCalls = 0

    installAdapter(log, {
      beforeSend: (entry: LogHQEntry) => {
        beforeSendCalls++
        // The real hazard: anything on the forward path that logs lands back on
        // the very method that is being wrapped. The cap only stops this test
        // hanging if the guard is missing; a guarded client never reaches it.
        if (beforeSendCalls < 200)
          void log.info('diagnostic raised inside the forward path')
        return entry
      },
    })

    expect(() => { void log.info('outer call') }).not.toThrow()
    await sleep(60)

    expect(beforeSendCalls).toBeGreaterThanOrEqual(1)
    expect(beforeSendCalls).toBeLessThan(10)
    expect(countOf('info')).toBeGreaterThanOrEqual(1)
    expect(countOf('info')).toBeLessThan(10)
  }, 10000)

  it('keeps its own transport failures out of the host logger', async () => {
    const originals = { warn: console.warn, error: console.error, info: console.info, log: console.log }
    const written: string[] = []
    const capture = (...args: unknown[]) => { written.push(args.map(String).join(' ')) }
    console.warn = capture
    console.error = capture
    console.info = capture
    console.log = capture

    try {
      const { log, countOf } = makeFakeLog()
      respond = () => { throw new Error('ingest is unreachable') }
      installAdapter(log, { debug: true, maxRetries: 1 })

      await log.error('a real application error')
      await sleep(80)

      // One application call in, one call to the original out. A diagnostic
      // that went through `log` instead of `console` would show up as a second.
      expect(countOf('error')).toBe(1)
      expect(countOf('warn')).toBe(0)
      expect(countOf('info')).toBe(0)
    }
    finally {
      console.warn = originals.warn
      console.error = originals.error
      console.info = originals.info
      console.log = originals.log
    }
  }, 10000)

  it('never leaves an unhandled rejection behind', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => { seen.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const { log } = makeFakeLog()
      respond = () => { throw new Error('ingest is unreachable') }
      installAdapter(log, { maxRetries: 1 })

      const circular: Record<string, unknown> = {}
      circular.self = circular
      await log.info('circular payload', circular)
      await log.error(new Error('boom'))
      await sleep(80)

      expect(seen).toHaveLength(0)
    }
    finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 10000)
})
