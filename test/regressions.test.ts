/**
 * One test per defect found by review, and nothing else.
 *
 * Every test in here failed against the commit that introduced it. That is the
 * bar for adding one: the 129 tests in the other three files all passed while
 * all nine of these bugs were live, because each bug sits on a path those tests
 * reach only on the happy side. A regression test that passes both before and
 * after the fix is documentation, not a test.
 *
 * Each `it` names the defect in the terms a reader would hit it in production.
 */
import type { LogHQEntry } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { LogHQClient } from '../src/client'
import { activeSeam, install, uninstall } from '../src/stacks'
import pkg from '../package.json'

const KEY = `loghq_${'a1b2c3d4'.repeat(8)}`
const HOST = 'http://ingest.test'
const WRAPPED = Symbol.for('loghq.stacks.wrapped')

interface Call {
  url: string
  raw: string
  body: any
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

let calls: Call[]
let respond: (call: Call, index: number) => unknown
let clients: LogHQClient[]
let warnings: string[]
let restore: Array<() => void>

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function accepted(call: Call) {
  const n = call.body?.logs?.length ?? 1
  return response(201, { ok: true, stored: n, dropped: 0, skipped: 0 })
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

/**
 * Collapse the backoff sleeps without collapsing the request timeout.
 *
 * The ceiling has to sit between the two: backoff starts at 250ms and the
 * client's own timeout is 10s, so anything at or above the ceiling stays on the
 * real clock and the abort timer does not fire as a microtask and cancel every
 * send under test.
 */
function collapseTimers(ceilingMs = 5000): void {
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...a: any[]) => void, delay?: number, ...rest: any[]) => {
    const ms = delay ?? 0
    if (ms >= ceilingMs)
      return (original as any)(fn, ms, ...rest)
    queueMicrotask(() => fn())
    return 0
  }) as unknown as typeof globalThis.setTimeout
  restore.push(() => { globalThis.setTimeout = original })
}

/** Capture the SDK's diagnostics instead of printing them through the suite. */
function captureConsole(): void {
  const warn = console.warn
  const error = console.error
  const record = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')) }
  console.warn = record as typeof console.warn
  console.error = record as typeof console.error
  restore.push(() => { console.warn = warn; console.error = error })
}

function make(config: Record<string, unknown> = {}): LogHQClient {
  const client = new LogHQClient({ key: KEY, host: HOST, flushInterval: 0, batchSize: 100, ...config } as any)
  clients.push(client)
  return client
}

/** Every message that reached the wire, oldest first. */
function shipped(): string[] {
  return calls.flatMap(call => ((call.body?.logs ?? []) as LogHQEntry[]).map(entry => entry.message))
}

interface LogCall { method: string, args: unknown[] }

function makeFakeLog() {
  const logCalls: LogCall[] = []
  const method = (name: string) => (...args: unknown[]): Promise<string> => {
    logCalls.push({ method: name, args })
    return Promise.resolve(`${name}-ok`)
  }

  const log: Record<string, any> = {
    info: method('info'),
    success: method('success'),
    warn: method('warn'),
    warning: method('warning'),
    error: method('error'),
    debug: method('debug'),
  }

  log.struct = {
    slowQuery: (sql: string, durationMs: number) =>
      log.warn('[db.slow_query]', { event: 'db.slow_query', sql, durationMs }),
    request: (path: string, status: number) =>
      log.info({ event: 'http.request', path, status }),
  }

  return { log, logCalls }
}

const adapterOptions: Record<string, unknown> = {
  key: KEY,
  host: HOST,
  batchSize: 1,
  flushInterval: 0,
  minLevel: 'debug',
  captureUnhandled: false,
}

/** The last entry the adapter put on the wire. */
function lastEntry(): any {
  const all = calls.flatMap(call => (call.body?.logs ?? []) as LogHQEntry[])
  return all[all.length - 1]
}

beforeEach(() => {
  calls = []
  clients = []
  warnings = []
  restore = []
  respond = accepted

  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (url: any, init: any) => {
    const raw = typeof init?.body === 'string' ? init.body : ''
    let body: any
    try {
      body = raw ? JSON.parse(raw) : undefined
    }
    catch {
      body = undefined
    }
    const call: Call = { url: String(url), raw, body }
    calls.push(call)
    return respond(call, calls.length)
  }) as unknown as typeof globalThis.fetch
  restore.push(() => { globalThis.fetch = originalFetch })
})

afterEach(async () => {
  respond = accepted
  try {
    uninstall()
  }
  catch {
    // uninstall on a never-installed adapter is not a teardown failure
  }
  for (const client of clients) {
    try {
      await client.close()
    }
    catch {
      // a client that already failed hard is not a teardown problem
    }
  }
  for (let i = restore.length - 1; i >= 0; i--)
    restore[i]!()
})

describe('client lifecycle', () => {
  it('retries during close instead of spending its whole budget on one attempt', async () => {
    collapseTimers()
    const client = make({ maxRetries: 5 })
    client.enqueue({ message: 'last words' })

    // One network failure, then a working server. A client that respects its
    // retry budget delivers this; one that treats its own `closed` marker as a
    // permanent failure gives up after the first attempt and loses the entry.
    respond = (call, index) => {
      if (index === 1)
        throw new Error('connection reset')
      return accepted(call)
    }

    await client.close()

    expect(calls.length).toBeGreaterThan(1)
    expect(shipped()).toContain('last words')
  })

  it('issues the request synchronously, so a beforeExit flush is not lost on Bun', () => {
    const client = make()
    client.enqueue({ message: 'on the way out' })
    expect(calls.length).toBe(0)

    // Deliberately not awaited. `beforeExit` handlers get no further turns of
    // the loop on Bun, so a flush that only queues its work behind a microtask
    // never reaches the network. The request has to be on the wire by the time
    // flush() returns, not merely scheduled.
    const pending = client.flush()
    expect(calls.length).toBe(1)

    return pending
  })

  it('stops draining at close when the server accepts nothing', async () => {
    // Every entry reported as dropped, forever. The batch comes straight back
    // to the queue each pass, which used to spin close() at network speed and
    // never resolve.
    respond = (call) => {
      const n = call.body?.logs?.length ?? 1
      return response(201, { ok: true, stored: 0, dropped: n, skipped: 0 })
    }

    const client = make()
    for (let i = 0; i < 4; i++)
      client.enqueue({ message: `entry-${i}` })

    await client.close()

    expect(calls.length).toBeLessThanOrEqual(4)
  })
})

describe('client accounting', () => {
  it('counts the in-flight batch when a bad key disables the client', async () => {
    captureConsole()
    const client = make({ debug: true })
    for (let i = 0; i < 3; i++)
      client.enqueue({ message: `entry-${i}` })

    respond = () => response(401, { message: 'invalid key' })
    await client.flush()

    // The batch was spliced out of the queue before the send, so counting only
    // what remained in the queue reported zero losses for three lost entries.
    const said = warnings.join('\n')
    expect(said).toContain('client disabled: auth')
    expect(said).toMatch(/dropped 3 entries/)
  })

  it('does not strand entries by requeueing them into a disabled client', async () => {
    captureConsole()
    // 413 on the first batch forces a split; the half that has not been sent
    // is handed back to `requeue` once the 404 has disabled the client. It can
    // never be delivered from there, so it has to be charged, not filed.
    respond = (_call, index) => index === 1 ? response(413, {}) : response(404, { message: 'no such project' })

    const client = make({ debug: true, batchSize: 2 })
    for (let i = 0; i < 4; i++)
      client.enqueue({ message: `entry-${i}` })
    await client.flush()

    expect(client.isEnabled()).toBe(false)
    expect(client.disabledReason()).toBe('unknown-project')

    // All four are gone, and the count says so. The stranded requeue used to
    // leave one of them sitting in a queue nothing would ever drain, so the
    // client reported two losses for four lost entries.
    expect(warnings.join('\n')).toContain('4 lost in total')
  })

  it('reports a clean flush when entries arrive while the drain is in flight', async () => {
    const client = make()

    // Two rounds of concurrent logging, exactly as a busy request path would
    // produce. The queue is the same size after each send as before it, which
    // a stall detector watching queue length reads as no progress.
    let injections = 0
    respond = (call) => {
      if (injections < 2) {
        injections++
        client.enqueue({ message: `late-${injections}-a` })
        client.enqueue({ message: `late-${injections}-b` })
      }
      return accepted(call)
    }

    client.enqueue({ message: 'first' })
    client.enqueue({ message: 'second' })

    expect(await client.flush()).toBe(true)
    expect(shipped()).toContain('late-2-b')
  })

  it('drops only the entry that cannot be serialized, not the batch around it', async () => {
    const client = make()
    client.enqueue({ message: 'before' })
    // A BigInt is spread onto the entry verbatim and throws on stringify. The
    // throw used to happen on the assembled body and cost every entry queued
    // alongside it.
    client.enqueue({ message: 'poison', detail: 1n } as unknown as LogHQEntry)
    client.enqueue({ message: 'after' })

    await client.flush()

    expect(shipped()).toContain('before')
    expect(shipped()).toContain('after')
    expect(shipped()).not.toContain('poison')
  })
})

describe('adapter', () => {
  it('keeps the application message when a context object has an event key', async () => {
    const { log } = makeFakeLog()
    install({ ...adapterOptions, logger: log } as any)

    await log.info('user signed up', { event: 'signup', userId: 42 })
    await waitFor(() => calls.length >= 1)

    // `message` is the only field the dashboard's `?q=` searches. Replacing it
    // with the event name made the entry unfindable by the words its author
    // wrote.
    expect(lastEntry().message).toBe('user signed up')
    expect(lastEntry().context.event).toBe('signup')
    expect(lastEntry().context.userId).toBe(42)
  })

  // The counter-test to the one above, and the only test in this file that
  // passes both before and after the fix. It is here to prove the narrowed
  // struct check did not over-correct and stop recognizing the emitter it was
  // written for, which is the obvious way to "fix" the defect above and break
  // something worse.
  it('still recognizes a real struct event', async () => {
    const { log } = makeFakeLog()
    install({ ...adapterOptions, logger: log } as any)

    await log.struct.slowQuery('select 1', 900)
    await waitFor(() => calls.length >= 1)

    expect(lastEntry().message).toBe('db.slow_query')
    expect(lastEntry().channel).toBe('db.slow_query')
    expect(lastEntry().context.sql).toBe('select 1')

    // The other emitter shape: a lone object with no bracketed tag.
    await log.struct.request('/checkout', 500)
    await waitFor(() => calls.length >= 2)
    expect(lastEntry().message).toBe('http.request')
  })

  it('keeps context fields named after Object.prototype members', async () => {
    const { log } = makeFakeLog()
    install({ ...adapterOptions, logger: log } as any)

    await log.info('shape report', {
      constructor: 'a',
      toString: 'b',
      valueOf: 'c',
      hasOwnProperty: 'd',
      // A computed key, because `__proto__:` in a literal sets the prototype
      // rather than adding a property. That is the same trap the adapter hit.
      ['__proto__']: 'e',
    })
    await waitFor(() => calls.length >= 1)

    const context = lastEntry().context
    expect(context.constructor).toBe('a')
    expect(context.toString).toBe('b')
    expect(context.valueOf).toBe('c')
    expect(context.hasOwnProperty).toBe('d')
    // Asserted on the raw body: a `__proto__` key survives JSON but not every
    // route back out of it.
    expect(calls[calls.length - 1]!.raw).toContain('"__proto__":"e"')
  })

  it('says so when another copy of the package already owns the logger', () => {
    const { log } = makeFakeLog()

    // Stand in for a second copy of @loghq/stacks in the same process, which is
    // what a hoisting accident produces. The marker is a `Symbol.for`, so both
    // copies genuinely see it.
    for (const name of ['info', 'success', 'warn', 'warning', 'error', 'debug']) {
      const original = log[name]
      const impostor = (...args: unknown[]): unknown => original(...args)
      Object.defineProperty(impostor, WRAPPED, { value: true })
      log[name] = impostor
    }

    captureConsole()
    const client = install({ ...adapterOptions, logger: log } as any)
    clients.push(client)

    // Previously this returned a fully configured client, reported itself
    // enabled, and received nothing, with no way to tell from the outside.
    expect(activeSeam().seam).toBe('conflict')
    expect(warnings.join('\n')).toContain('another copy of @loghq/stacks')
  })
})

describe('peer range', () => {
  // `^0.70.366` on a 0.x version means `>=0.70.366 <0.71.0`, so it excluded the
  // 0.72 line the framework had already moved to. Installing this package into
  // a real Stacks app therefore resolved a SECOND @stacksjs/logging to satisfy
  // the peer, and the package manager hoisted that older copy over the app's
  // own. The app then ran a logging build whose config loader never reads
  // `transports`, so a correctly declared transport in config/logging.ts was
  // silently ignored: no error, no warning, no logs.
  //
  // Found by installing into bughq, which went from 0.72.76 to a hoisted
  // 0.70.380 and delivered nothing until the range was widened.
  it('accepts framework versions past the 0.70 line', () => {
    const range = (pkg.peerDependencies ?? {})['@stacksjs/logging'] as string
    expect(range).toBeDefined()

    // A caret (or tilde) on a 0.x range is the specific shape that caused this.
    expect(range.startsWith('^0.')).toBe(false)
    expect(range.startsWith('~0.')).toBe(false)

    // The floor stays: the fallback seam is what supports the older line.
    expect(range).toContain('>=')
  })
})
