import type { LogHQConfig, LogHQEntry } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { LogHQClient, parseDsn, resolveConfig } from '../src/client'
import { DEFAULT_HOST, SDK_NAME, SDK_VERSION } from '../src/types'

// A key-shaped string. The client never validates the hex, but using the real
// shape keeps the assertions honest about what travels in the header.
const KEY = `loghq_${'a1b2c3d4'.repeat(8)}`
const HOST = 'http://ingest.test'

interface Call {
  url: string
  init: Record<string, any>
  body: any
}

/** Real timers, captured before any test is allowed to collapse them. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

let calls: Call[]
let respond: (call: Call, index: number) => unknown
let clients: LogHQClient[]
let restoreFetch: () => void
let restoreTimers: (() => void) | null

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** The happy path: everything sent was stored. */
function accepted(call: Call) {
  const n = call.body?.logs?.length ?? 1
  return response(201, { ok: true, stored: n, dropped: 0, skipped: 0 })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => realSetTimeout(resolve, ms))
}

/**
 * Poll instead of sleeping a fixed amount. The deadline is a guard against a
 * hung suite, never part of an assertion, so a slow machine cannot flake a test.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('waitFor: condition never became true')
    await sleep(2)
  }
}

/**
 * Collapse short timers so backoff can be asserted without waiting it out.
 *
 * Delays at or above the ceiling stay on the real clock, because a request
 * timeout is also a `setTimeout` and firing it as a microtask would abort every
 * send instead of testing the retry.
 */
function collapseTimers(ceilingMs = 60000): number[] {
  const delays: number[] = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...a: any[]) => void, delay?: number, ...rest: any[]) => {
    const ms = delay ?? 0
    delays.push(ms)
    if (ms >= ceilingMs)
      return (original as any)(fn, ms, ...rest)
    queueMicrotask(() => fn())
    return 0
  }) as unknown as typeof globalThis.setTimeout
  restoreTimers = () => { globalThis.setTimeout = original }
  return delays
}

function make(config: LogHQConfig = {}): LogHQClient {
  const client = new LogHQClient({ key: KEY, host: HOST, flushInterval: 0, batchSize: 100, ...config })
  clients.push(client)
  return client
}

function bodyOf(index: number): any {
  return calls[index]?.body
}

function lastBody(): any {
  return calls[calls.length - 1]?.body
}

function headerOf(call: Call, name: string): string | undefined {
  const headers = call.init?.headers
  if (!headers)
    return undefined
  if (typeof headers.get === 'function')
    return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === wanted)
      return value
  }
  return undefined
}

function messages(body: any): string[] {
  return (body?.logs ?? []).map((entry: LogHQEntry) => entry.message)
}

beforeEach(() => {
  calls = []
  clients = []
  restoreTimers = null
  respond = accepted
  const original = globalThis.fetch
  globalThis.fetch = mock(async (url: any, init: any) => {
    let body: any
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    }
    catch {
      body = init?.body
    }
    const call: Call = { url: String(url), init: init ?? {}, body }
    calls.push(call)
    return respond(call, calls.length)
  }) as unknown as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
})

afterEach(async () => {
  // Put the transport back on the happy path first: teardown must not inherit a
  // failing responder and spend the retry budget on its way out.
  respond = accepted
  for (const client of clients) {
    try {
      await client.close()
    }
    catch {
      // a client that already failed hard is not a teardown problem
    }
  }
  restoreTimers?.()
  restoreFetch()
})

describe('parseDsn', () => {
  it('splits a dsn into host and key', () => {
    expect(parseDsn(`https://${KEY}@loghq.org`)).toEqual({ host: 'https://loghq.org', key: KEY })
  })

  it('keeps the scheme and port it was given', () => {
    expect(parseDsn(`http://${KEY}@localhost:3000`)).toEqual({ host: 'http://localhost:3000', key: KEY })
  })

  it('returns null on junk rather than throwing', () => {
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('')).toBeNull()
  })

  it('returns null when the dsn carries no key, since it identifies nothing', () => {
    expect(parseDsn('https://loghq.org')).toBeNull()
  })
})

describe('resolveConfig', () => {
  it('points the endpoint at the ingest path on the default host', () => {
    expect(resolveConfig({ key: KEY }).endpoint).toBe(`${DEFAULT_HOST}/logs`)
  })

  it('does not double the slash when the host has a trailing one', () => {
    expect(resolveConfig({ key: KEY, host: 'https://example.test/' }).endpoint).toBe('https://example.test/logs')
  })

  it('fills key and host from a dsn', () => {
    const resolved = resolveConfig({ dsn: `https://${KEY}@dsn.example.test` })
    expect(resolved.key).toBe(KEY)
    expect(resolved.endpoint).toBe('https://dsn.example.test/logs')
  })

  it('lets an explicit key and host win over the dsn', () => {
    const resolved = resolveConfig({
      dsn: 'https://loghq_fromdsn@dsn.example.test',
      key: KEY,
      host: 'https://explicit.example.test',
    })
    expect(resolved.key).toBe(KEY)
    expect(resolved.endpoint).toBe('https://explicit.example.test/logs')
  })

  it('caps batchSize at the 500 entries the server will examine', () => {
    expect(resolveConfig({ key: KEY, batchSize: 5000 }).batchSize).toBe(500)
  })

  it('applies the documented defaults', () => {
    const resolved = resolveConfig({ key: KEY })
    expect(resolved.minLevel).toBe('info')
    expect(resolved.batchSize).toBe(50)
    expect(resolved.flushInterval).toBe(2000)
    expect(resolved.maxQueueSize).toBe(1000)
    expect(resolved.timeout).toBe(10000)
    expect(resolved.maxRetries).toBe(5)
    expect(resolved.enabled).toBe(true)
    expect(resolved.sdk).toEqual({ name: SDK_NAME, version: SDK_VERSION })
  })
})

describe('the request', () => {
  it('posts a batch to /logs with the key in the header', async () => {
    const client = make()
    client.capture('error', 'gateway timeout')
    expect(await client.flush()).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${HOST}/logs`)
    expect(String(calls[0]!.init.method).toUpperCase()).toBe('POST')
    expect(headerOf(calls[0]!, 'X-LogHQ-Key')).toBe(KEY)
    expect(headerOf(calls[0]!, 'Content-Type')).toContain('application/json')
  })

  it('wraps entries in { logs: [...] } even for a single entry', async () => {
    const client = make()
    client.capture('info', 'only one')
    await client.flush()

    const body = bodyOf(0)
    expect(Array.isArray(body.logs)).toBe(true)
    expect(body.logs).toHaveLength(1)
    expect(body.logs[0].message).toBe('only one')
  })
})

describe('entry defaults', () => {
  it('stamps level, environment, sdk, and a timestamp', async () => {
    const client = make({ environment: 'staging' })
    client.enqueue({ message: 'bare' })
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.level).toBe('info')
    expect(entry.environment).toBe('staging')
    expect(entry.sdk).toEqual({ name: SDK_NAME, version: SDK_VERSION })
    expect(typeof entry.timestamp).toBe('string')
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false)
  })

  it('applies the configured channel, hostname, release, and user', async () => {
    const client = make({
      channel: 'queue',
      hostname: 'worker-1',
      release: 'a1b2c3d',
      user: { id: 8821, email: 'a@b.test' },
    })
    client.capture('error', 'job failed')
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.channel).toBe('queue')
    expect(entry.host).toBe('worker-1')
    expect(entry.release).toBe('a1b2c3d')
    expect(entry.user.id).toBe(8821)
  })

  it('lets an entry keep its own channel over the configured default', async () => {
    const client = make({ channel: 'queue' })
    client.enqueue({ message: 'from http', channel: 'http' })
    await client.flush()
    expect(bodyOf(0).logs[0].channel).toBe('http')
  })

  it('carries the per-call context through', async () => {
    const client = make()
    client.capture('warning', 'retrying', { attempt: 3, provider: 'stripe' })
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.context.attempt).toBe(3)
    expect(entry.context.provider).toBe('stripe')
  })

  it('applies setUser, setRelease, and setEnvironment to later entries', async () => {
    const client = make()
    client.setUser({ id: 'u_1' })
    client.setRelease('v9')
    client.setEnvironment('canary')
    client.capture('info', 'after scope change')
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.user).toEqual({ id: 'u_1' })
    expect(entry.release).toBe('v9')
    expect(entry.environment).toBe('canary')
  })

  it('clears the user when set to null', async () => {
    const client = make({ user: { id: 'u_1' } })
    client.setUser(null)
    client.capture('info', 'anonymous now')
    await client.flush()
    expect(bodyOf(0).logs[0].user ?? null).toBeNull()
  })

  it('captures an exception at error level with its message', async () => {
    const client = make()
    client.captureException(new TypeError('gateway exploded'), { orderId: 7 })
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.level).toBe('error')
    expect(entry.message).toContain('gateway exploded')
    expect(entry.context.orderId).toBe(7)
  })

  it('captures a non-Error throw without failing', async () => {
    const client = make()
    expect(() => client.captureException('a bare string')).not.toThrow()
    expect(() => client.captureException(null)).not.toThrow()
    expect(() => client.captureException({ weird: true })).not.toThrow()
    await client.flush()
    expect(bodyOf(0).logs).toHaveLength(3)
  })
})

describe('minLevel', () => {
  it('drops everything below the threshold', async () => {
    const client = make({ minLevel: 'warning' })
    client.capture('debug', 'd')
    client.capture('info', 'i')
    client.capture('notice', 'n')
    client.capture('warning', 'w')
    client.capture('error', 'e')
    await client.flush()

    expect(messages(bodyOf(0))).toEqual(['w', 'e'])
  })

  it('sends no request at all when everything is filtered out', async () => {
    const client = make({ minLevel: 'critical' })
    client.capture('error', 'not severe enough')
    expect(await client.flush()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('defaults to info, so debug is dropped without configuration', async () => {
    const client = make()
    client.capture('debug', 'noisy')
    client.capture('info', 'kept')
    await client.flush()
    expect(messages(bodyOf(0))).toEqual(['kept'])
  })
})

describe('batching', () => {
  it('flushes as soon as batchSize is reached', async () => {
    const client = make({ batchSize: 3 })
    client.capture('info', 'a')
    client.capture('info', 'b')
    await sleep(20)
    expect(calls).toHaveLength(0)

    client.capture('info', 'c')
    await waitFor(() => calls.length >= 1)
    expect(messages(bodyOf(0))).toEqual(['a', 'b', 'c'])
  })

  it('flushes on the interval without reaching batchSize', async () => {
    const client = make({ batchSize: 500, flushInterval: 15 })
    client.capture('info', 'lonely')
    await waitFor(() => calls.length >= 1)
    expect(messages(bodyOf(0))).toEqual(['lonely'])
  })

  it('does not start an interval timer when flushInterval is 0', async () => {
    const client = make({ batchSize: 500, flushInterval: 0 })
    client.capture('info', 'stays queued')
    await sleep(60)
    expect(calls).toHaveLength(0)
    await client.flush()
    expect(calls).toHaveLength(1)
  })

  it('resolves true and sends nothing when the queue is empty', async () => {
    const client = make()
    expect(await client.flush()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('leaves the queue empty after a clean flush', async () => {
    const client = make()
    client.capture('info', 'once')
    await client.flush()
    await client.flush()
    expect(calls).toHaveLength(1)
  })
})

describe('client-side clipping', () => {
  it('truncates an oversized message and marks it', async () => {
    const client = make()
    const huge = 'a'.repeat(20 * 1024)
    client.capture('error', huge)
    await client.flush()

    const message: string = bodyOf(0).logs[0].message
    expect(message.length).toBeLessThan(huge.length)
    expect(message.length).toBeLessThanOrEqual(16 * 1024)
    expect(message).toContain('[truncated]')
    expect(message.startsWith('aaaa')).toBe(true)
  })

  it('leaves a message that fits exactly as it was written', async () => {
    const client = make()
    client.capture('error', 'short and sweet')
    await client.flush()
    expect(bodyOf(0).logs[0].message).toBe('short and sweet')
  })

  it('replaces an oversized context wholesale rather than half-sending it', async () => {
    const client = make()
    client.capture('error', 'fat context', { blob: 'x'.repeat(200 * 1024), keep: 1 })
    await client.flush()

    const context = bodyOf(0).logs[0].context
    expect(context.blob).toBeUndefined()
    // A partial context is worse than none: it looks complete and is not.
    expect(Object.keys(context)).toHaveLength(1)
    expect(typeof context._truncated).toBe('string')
  })

  it('leaves a context that fits untouched', async () => {
    const client = make()
    client.capture('error', 'thin context', { a: 1, b: 'two' })
    await client.flush()
    expect(bodyOf(0).logs[0].context).toEqual({ a: 1, b: 'two' })
  })

  it('cuts correlation ids to the 64 characters the column holds', async () => {
    const client = make()
    client.enqueue({
      message: 'traced',
      trace_id: 't'.repeat(200),
      request_id: 'r'.repeat(200),
    })
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.trace_id).toHaveLength(64)
    expect(entry.request_id).toHaveLength(64)
  })

  it('leaves a 32 hex trace id alone', async () => {
    const client = make()
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    client.enqueue({ message: 'traced', trace_id: traceId })
    await client.flush()
    expect(bodyOf(0).logs[0].trace_id).toBe(traceId)
  })
})

describe('201 reconciliation', () => {
  it('re-queues entries the server counted as dropped', async () => {
    respond = call => (calls.length === 1
      ? response(201, { ok: true, stored: 1, dropped: 2, skipped: 0 })
      : accepted(call))

    const client = make()
    client.capture('info', 'a')
    client.capture('info', 'b')
    client.capture('info', 'c')
    await client.flush()
    await client.flush()

    expect(calls).toHaveLength(2)
    expect(bodyOf(1).logs).toHaveLength(2)
    for (const message of messages(bodyOf(1)))
      expect(['a', 'b', 'c']).toContain(message)
  })

  it('does not re-queue entries the server skipped, since resending cannot help', async () => {
    respond = call => (calls.length === 1
      ? response(201, { ok: true, stored: 1, dropped: 0, skipped: 2 })
      : accepted(call))

    const client = make()
    client.capture('info', 'a')
    client.capture('info', 'b')
    client.capture('info', 'c')
    await client.flush()
    await client.flush()

    expect(calls).toHaveLength(1)
  })

  it('re-queues nothing when everything was stored', async () => {
    const client = make()
    client.capture('info', 'a')
    client.capture('info', 'b')
    await client.flush()
    await client.flush()
    expect(calls).toHaveLength(1)
  })
})

describe('permanent failures', () => {
  const permanent: Array<[number, string]> = [
    [401, 'auth'],
    [403, 'inactive-project'],
    [404, 'unknown-project'],
  ]

  it.each(permanent)('a %s disables the client permanently', async (status, reason) => {
    respond = () => response(status as number, { error: 'nope' })

    const client = make()
    client.capture('error', 'first')
    expect(await client.flush()).toBe(false)

    expect(calls).toHaveLength(1)
    expect(client.isEnabled()).toBe(false)
    expect(client.disabledReason()).toBe(reason as any)
  })

  it.each(permanent)('a %s stops all further requests', async (status) => {
    respond = () => response(status as number, { error: 'nope' })

    const client = make()
    client.capture('error', 'first')
    await client.flush()
    const after = calls.length

    for (let i = 0; i < 5; i++)
      client.capture('error', `later ${i}`)
    await client.flush()
    await client.flush()
    await sleep(30)

    // Retrying a rejected key is a self-inflicted flood, so the count must not
    // move again for the life of the process.
    expect(calls).toHaveLength(after)
  })

  it('stays disabled across a batchSize-triggered flush', async () => {
    respond = () => response(401, { error: 'invalid ingest key' })

    const client = make({ batchSize: 2 })
    client.capture('error', 'a')
    client.capture('error', 'b')
    await waitFor(() => calls.length >= 1)
    await waitFor(() => !client.isEnabled())

    client.capture('error', 'c')
    client.capture('error', 'd')
    await sleep(40)
    expect(calls).toHaveLength(1)
  })
})

describe('413 payload too large', () => {
  it('splits the batch and drops singles that still fail', async () => {
    respond = () => response(413, { error: 'payload too large' })

    const client = make()
    for (const message of ['a', 'b', 'c', 'd'])
      client.capture('error', message)
    await client.flush()

    // The exact split shape is the client's business; that it split at all, got
    // down to one entry, and then stopped is the contract.
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.length).toBeLessThanOrEqual(15)
    expect(Math.min(...calls.map(call => call.body.logs.length))).toBe(1)

    const settled = calls.length
    await sleep(50)
    await client.flush()
    expect(calls).toHaveLength(settled)
  }, 10000)

  it('drops a single oversized entry after one attempt', async () => {
    respond = () => response(413, { error: 'payload too large' })

    const client = make()
    client.capture('error', 'one enormous line')
    await client.flush()

    expect(calls).toHaveLength(1)
    await client.flush()
    expect(calls).toHaveLength(1)
  })

  it('keeps the client enabled, because the payload was the problem', async () => {
    respond = () => response(413, { error: 'payload too large' })

    const client = make()
    client.capture('error', 'too big')
    await client.flush()

    expect(client.isEnabled()).toBe(true)
    expect(client.disabledReason()).toBeNull()
  })
})

describe('429 rate limited', () => {
  it('honors Retry-After and does not send again before the deadline', async () => {
    respond = () => response(429, { error: 'rate limited' }, { 'Retry-After': '2' })

    const client = make()
    client.capture('error', 'first')
    expect(await client.flush()).toBe(false)
    expect(calls).toHaveLength(1)

    client.capture('error', 'second')
    await client.flush()
    await client.flush()
    await sleep(60)

    // Two seconds is far longer than this suite takes, so any second request
    // here is a violation and not a timing race.
    expect(calls).toHaveLength(1)
  }, 10000)

  it('does not disable the client, since the limit is temporary', async () => {
    respond = () => response(429, { error: 'rate limited' }, { 'Retry-After': '2' })

    const client = make()
    client.capture('error', 'first')
    await client.flush()

    expect(client.isEnabled()).toBe(true)
    expect(client.disabledReason()).toBeNull()
  })

  it('keeps the rate limited entries instead of discarding them', async () => {
    let limited = true
    respond = (call) => {
      if (limited)
        return response(429, { error: 'rate limited' }, { 'Retry-After': '1' })
      return accepted(call)
    }

    const client = make()
    client.capture('error', 'survivor')
    await client.flush()
    limited = false

    // Wait out the advertised second before asking again, so this measures
    // re-queueing and not whether the client ignored Retry-After.
    await sleep(1200)
    await client.flush()
    await waitFor(() => calls.length >= 2)
    expect(messages(lastBody())).toContain('survivor')
  }, 15000)
})

describe('5xx', () => {
  it('retries with growing backoff and gives up at maxRetries', async () => {
    const delays = collapseTimers()
    respond = () => response(500)

    const client = make({ maxRetries: 3, timeout: 987654 })
    client.capture('error', 'server is unwell')
    expect(await client.flush()).toBe(false)

    expect(calls).toHaveLength(3)

    const backoffs = delays.filter(ms => ms > 0 && ms < 60000)
    expect(backoffs.length).toBeGreaterThanOrEqual(2)
    expect(backoffs[1]!).toBeGreaterThan(backoffs[0]!)
  }, 10000)

  it('stops after the budget rather than looping forever', async () => {
    collapseTimers()
    respond = () => response(503)

    const client = make({ maxRetries: 2, timeout: 987654 })
    client.capture('error', 'still unwell')
    await client.flush()

    const settled = calls.length
    expect(settled).toBe(2)
    await sleep(50)
    expect(calls).toHaveLength(settled)
  }, 10000)

  it('succeeds without exhausting the budget when a retry lands', async () => {
    collapseTimers()
    respond = call => (calls.length === 1 ? response(500) : accepted(call))

    const client = make({ maxRetries: 5, timeout: 987654 })
    client.capture('error', 'transient')
    expect(await client.flush()).toBe(true)
    expect(calls).toHaveLength(2)
  }, 10000)

  it('retries a rejected fetch the same way as a 5xx', async () => {
    collapseTimers()
    respond = () => { throw new TypeError('network unreachable') }

    const client = make({ maxRetries: 2, timeout: 987654 })
    client.capture('error', 'no route to host')
    expect(await client.flush()).toBe(false)
    expect(calls).toHaveLength(2)
  }, 10000)

  it('resolves flush() false when the batch failed', async () => {
    collapseTimers()
    respond = () => response(500)

    const client = make({ maxRetries: 1, timeout: 987654 })
    client.capture('error', 'doomed')
    expect(await client.flush()).toBe(false)
  }, 10000)
})

describe('beforeSend', () => {
  it('drops an entry when it returns null', async () => {
    const client = make({ beforeSend: () => null })
    client.capture('error', 'secret')
    await client.flush()
    expect(calls).toHaveLength(0)
  })

  it('drops without throwing out of enqueue when it throws', async () => {
    const client = make({
      beforeSend: () => { throw new Error('redaction blew up') },
    })

    expect(() => client.capture('error', 'boom')).not.toThrow()
    expect(() => client.enqueue({ message: 'also boom' })).not.toThrow()
    await client.flush()
    expect(calls).toHaveLength(0)
  })

  it('keeps a throwing beforeSend from poisoning later entries', async () => {
    let calledFor = 0
    const client = make({
      beforeSend: (entry) => {
        calledFor++
        if (entry.message === 'bad')
          throw new Error('nope')
        return entry
      },
    })

    client.capture('error', 'bad')
    client.capture('error', 'good')
    await client.flush()

    expect(calledFor).toBe(2)
    expect(messages(bodyOf(0))).toEqual(['good'])
  })

  it('sends the entry it returns, not the one it was given', async () => {
    const client = make({
      beforeSend: entry => ({ ...entry, message: 'redacted', context: { safe: true } }),
    })
    client.capture('error', 'card 4242424242424242')
    await client.flush()

    const entry = bodyOf(0).logs[0]
    expect(entry.message).toBe('redacted')
    expect(entry.context).toEqual({ safe: true })
  })
})

describe('maxQueueSize', () => {
  it('discards the oldest entries once the ceiling is reached', async () => {
    const client = make({ maxQueueSize: 3, batchSize: 500 })
    for (const message of ['a', 'b', 'c', 'd', 'e'])
      client.capture('error', message)
    await client.flush()

    expect(bodyOf(0).logs).toHaveLength(3)
    expect(messages(bodyOf(0))).toEqual(['c', 'd', 'e'])
  })

  it('bounds memory during a burst far larger than the queue', async () => {
    const client = make({ maxQueueSize: 10, batchSize: 500 })
    for (let i = 0; i < 5000; i++)
      client.capture('error', `burst ${i}`)
    await client.flush()

    expect(bodyOf(0).logs).toHaveLength(10)
    expect(messages(bodyOf(0))[9]).toBe('burst 4999')
  })
})

describe('robustness', () => {
  it('never throws out of enqueue, whatever it is handed', () => {
    const client = make()
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    expect(() => client.enqueue({ message: 'circular', context: circular })).not.toThrow()
    expect(() => client.enqueue({ message: 'undefined level', level: undefined })).not.toThrow()
    expect(() => client.enqueue({ message: undefined as unknown as string })).not.toThrow()
    expect(() => client.enqueue(null as unknown as LogHQEntry)).not.toThrow()
    expect(() => client.enqueue({ message: 'bigint', context: { n: 1n } })).not.toThrow()
    expect(() => client.capture('info', 'fn context', { fn: () => 1 })).not.toThrow()
  })

  it('survives a flush of unserializable entries without an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => { seen.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      respond = () => { throw new Error('transport is gone') }
      const client = make({ maxRetries: 1 })
      const circular: Record<string, unknown> = {}
      circular.self = circular
      client.enqueue({ message: 'circular', context: circular })
      client.capture('error', 'plain')
      await client.flush()
      await sleep(60)

      expect(seen).toHaveLength(0)
    }
    finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 10000)

  it('accepts entries silently when disabled by configuration', async () => {
    const client = make({ enabled: false })
    expect(client.isEnabled()).toBe(false)
    expect(() => client.capture('error', 'ignored')).not.toThrow()
    expect(await client.flush()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('is disabled without a key, because there is nowhere to send', async () => {
    const client = make({ key: '' })
    expect(client.isEnabled()).toBe(false)
    client.capture('error', 'ignored')
    await client.flush()
    expect(calls).toHaveLength(0)
  })

  it('drains the queue on close and refuses entries afterwards', async () => {
    const client = make()
    client.capture('error', 'last words')
    await client.close()

    expect(calls).toHaveLength(1)
    expect(messages(bodyOf(0))).toEqual(['last words'])
    expect(client.isEnabled()).toBe(false)
    expect(client.disabledReason()).toBe('closed')

    client.capture('error', 'after the funeral')
    await client.flush()
    expect(calls).toHaveLength(1)
  })

  it('tolerates close being called twice', async () => {
    const client = make()
    await client.close()
    await client.close()
    expect(calls).toHaveLength(0)
  })

  it('does not send SDK diagnostics through the transport when debug is on', async () => {
    const originals = { warn: console.warn, error: console.error, info: console.info, log: console.log }
    const written: string[] = []
    const capture = (...args: unknown[]) => { written.push(args.map(String).join(' ')) }
    console.warn = capture
    console.error = capture
    console.info = capture
    console.log = capture

    try {
      respond = () => response(500)
      collapseTimers()
      const client = make({ debug: true, maxRetries: 1, timeout: 987654 })
      client.capture('error', 'the one real entry')
      await client.flush()

      // Diagnostics belong on console; the wire must carry only the app's entry.
      expect(calls).toHaveLength(1)
      expect(bodyOf(0).logs).toHaveLength(1)
      expect(bodyOf(0).logs[0].message).toBe('the one real entry')
    }
    finally {
      console.warn = originals.warn
      console.error = originals.error
      console.info = originals.info
      console.log = originals.log
    }
  }, 10000)
})
