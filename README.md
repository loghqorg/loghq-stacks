# @loghq/stacks

Streams a [Stacks](https://stacksjs.org) application's logs into
[loghq](https://loghq.org). It wraps the framework's `log` facade, so every
`log.info(...)` already in your codebase becomes a searchable, correlated log
entry without touching a single call site.

```sh
bun add @loghq/stacks
```

No dependencies. Runs on Bun and Node 18+. The `@stacksjs/*` packages are
optional at runtime, so nothing breaks if you pull this into a plain script.

## Quick start

Declare a transport in `config/logging.ts`:

```ts
// config/logging.ts
import { loghqTransport } from '@loghq/stacks'
import { storagePath } from '@stacksjs/path'

export default {
  logsPath: storagePath('logs/stacks.log'),
  deploymentsPath: storagePath('logs/deployments.log'),
  transports: [
    loghqTransport({
      key: process.env.LOGHQ_KEY,
      environment: process.env.APP_ENV,
      release: process.env.APP_VERSION,
    }),
  ],
} satisfies LoggingConfig
```

That is the whole integration. Keep logging exactly as you were:

```ts
import { log } from '@stacksjs/logging'

await log.info('checkout started', { orderId: 42 })
await log.error(new Error('gateway timeout'))
```

Config is the right home for this, and not only on taste. It applies to every
process that boots the framework, so your scheduler and queue workers ship
their logs too, which a bootstrap import in `app/Routes.ts` would miss. Nothing
is monkey-patched, so there is no ordering window in which lines are lost. And
crash reports arrive without extra wiring: the framework's own
`uncaughtException` and `unhandledRejection` handlers funnel through `report()`,
which calls `log.error`, which reaches this transport like any other line.

### On an older framework version

`transports` needs a framework version that has it. Without one, wire it
yourself with a side-effect import that runs early:

```ts
// app/Bootstrap.ts
import { install } from '@loghq/stacks'

install({ key: process.env.LOGHQ_KEY })
```

```ts
// app/Routes.ts
import './Bootstrap'
// ... your existing route registrations
```

`install()` probes for the transport registry first and falls back to teeing
the mutable `log` singleton, so the same call works on both. Two things are
true of the fallback that are not true of the config path: anything logged
before `install()` runs is never captured, and it only covers the process that
imported it.

You can pass a single `dsn` instead of `key` plus `host`:

```ts
install({ dsn: 'https://loghq_your_key@loghq.org' })
```

### Manual capture

`install()` returns the client, and the same operations are exported at module
level:

```ts
import { capture, captureException, close, flush, setUser } from '@loghq/stacks'

setUser({ id: 8821, email: 'jane@acme.com' })
capture('critical', 'replica lag over threshold', { lagMs: 9400 })

try { await work() }
catch (err) { captureException(err, { job: 'nightly' }); throw err }

await flush()   // drain the queue now
await close()   // flush, then stop accepting, on shutdown
```

## What gets captured

- **Every `log.*` call.** `info`, `success`, `warn`, `warning`, `error`, and
  `debug`. Arguments are read raw, before clarity formats them, so an object
  logged as an object stays an object in `context` instead of arriving as a
  pretty-printed string.
- **`log.struct` events.** `request`, `query`, `slowQuery`, `job`, and `cache`
  all route through the same `log` methods, so the wrap picks them up with no
  extra wiring. A `struct.request` that ends in a 5xx arrives at `log.error` as
  one structured object; `struct.slowQuery` arrives at `log.warn` as
  `('[db.slow_query]', { event, sql, durationMs })`. Worth knowing: nothing in
  the framework calls `log.struct` yet, so this is a hook waiting for callers
  rather than a stream you will see today.
- **Uncaught exceptions**, via `process.on('uncaughtException')`.
- **Unhandled promise rejections**, via `process.on('unhandledRejection')`.

Deliberately not captured: `log.dump`, `log.dd`, `log.echo`, and `log.time`.
Those are interactive debugging tools, not log records, and shipping them to a
log service would be noise. Also not captured: anything emitted before
`install()` runs.

## Configuration

Every option is optional except `key` (or a `dsn` carrying one).

| Option | Type | Default | Notes |
|---|---|---|---|
| `key` | `string` | required | Project ingest key, `loghq_<64 hex>`. Public by design: it identifies a project, is revocable, and grants no read access, so it is safe in app config. |
| `dsn` | `string` | none | `https://<key>@<host>`. An alternative to `key` plus `host`. An explicit `key` or `host` wins over the DSN part. |
| `host` | `string` | `https://loghq.org` | Point at your own instance if you self-host. |
| `environment` | `string` | `APP_ENV`, then `NODE_ENV`, else `production` | |
| `release` | `string` | `APP_VERSION` or `RELEASE` when set | Version or commit the entry came from. |
| `channel` | `string` | none | Applied to entries that do not carry their own. |
| `hostname` | `string` | `os.hostname()` | Reporting machine. |
| `user` | `LogHQUser \| null` | `null` | Attributed to every entry until changed with `setUser()`. |
| `minLevel` | `LogHQLevel` | `info` | Anything less severe is dropped before it is queued. Set `debug` to capture everything. |
| `enabled` | `boolean` | `true` | Master switch. |
| `batchSize` | `number` | `50` | Flush when the queue reaches this many entries. The server caps a request at 500. |
| `flushInterval` | `number` | `2000` | Flush at least this often, in ms. `0` disables the timer. |
| `maxQueueSize` | `number` | `1000` | Hard ceiling on queued entries. Oldest are discarded past it, so a logging burst cannot grow the process out of memory. |
| `timeout` | `number` | `10000` | Per-request timeout, in ms. |
| `maxRetries` | `number` | `5` | Transport attempts before a batch is abandoned. |
| `beforeSend` | `(entry) => entry \| null` | none | Last chance to redact, enrich, or drop. Return `null` to discard the entry. Throwing is caught and treated as `null`. |
| `debug` | `boolean` | `false` | SDK diagnostics. Written to `console` only, never through the host logger. |
| `sdk` | `{ name, version }` | `loghq.stacks` at this package's version | Override the SDK identity. Integrations set this; applications should not. |

## Levels

loghq speaks the eight RFC 5424 / PSR-3 severities. clarity, the logger behind
Stacks, has five. The two sets do not line up, so the bridge is lossy in both
directions and this is exactly how it resolves:

| Stacks call | loghq level | Note |
|---|---|---|
| `log.debug()` | `debug` | Below the default `minLevel`, so set `minLevel: 'debug'` to keep it. |
| `log.info()` | `info` | |
| `log.success()` | `info` | `context.original_level` is set to `success`. |
| `log.warn()` / `log.warning()` | `warning` | |
| `log.error()` | `error` | |

**A Stacks app cannot currently emit `notice`, `critical`, `alert`, or
`emergency` through `log`.** There is no source for them in clarity's level set,
and this package does not invent one. If you need those severities, send them
deliberately with `capture('critical', ...)`, which takes any of the eight.

`success` maps to `info` rather than `notice` on purpose. `notice` means "normal
but significant", and a success message is not reliably either one, so the
mapping keeps the severity honest and preserves the original name in
`context.original_level` instead.

## Correlation

The Stacks router keeps a per-request context in `AsyncLocalStorage`, and
`getLogContext()` reads it. Every entry is stamped at enqueue time with whatever
is in there: `trace_id` becomes loghq's `trace_id`, `requestId` becomes
`request_id`. A line written deep inside a controller carries both without you
threading anything through your own code.

Outside a request (a queue worker, a scheduled command, boot) the lookup returns
nothing and both fields are omitted rather than faked.

In loghq these are join keys, not grouping keys. Nothing is collapsed or
deduplicated; the ids exist so one line expands into everything that happened
around it:

```
GET /api/projects/{id}/logs?trace=<trace_id>
GET /api/projects/{id}/logs?request=<request_id>
```

Use the 32-hex trace id from a W3C `traceparent` header when you have one, so
traces line up with other OpenTelemetry-aware tools.

## Reliability

**Batching.** Entries queue in memory and flush when the queue reaches
`batchSize` or `flushInterval` elapses, whichever comes first. Your `log` call is
never blocked or awaited on the network: the enqueue is synchronous and returns
immediately, and the original logger method still runs first.

**Backpressure.** `maxQueueSize` is a hard ceiling. Past it the oldest queued
entries are discarded, because a log service being slow must never turn into an
out-of-memory kill in your application.

**Retry.** Transport failures and `5xx` responses back off exponentially, up to
`maxRetries`. A `429` honors `Retry-After`. A `413` splits the batch, and a
single entry that still will not fit is dropped rather than retried forever.

**Permanent stop.** Some statuses never become success by retrying, so the
client disables itself instead of producing a self-inflicted flood:

| Response | `disabledReason()` |
|---|---|
| `401 invalid ingest key` | `auth` |
| `403 project inactive` or no ingest key | `inactive-project` |
| `404 unknown project` | `unknown-project` |
| after `close()` | `closed` |

From then on `isEnabled()` is `false` and enqueueing is a no-op. If logs stop
arriving, check `disabledReason()` first.

**Reconciliation.** A `201` returns `{ ok, stored, dropped, skipped }`, and a
`201` does not mean every entry landed. The client compares those counts against
what it sent and warns locally when they disagree.

**No recursion.** This is the one rule the SDK will not bend. It is draining the
host logger, so routing its own failures back through `log.*` would feed itself
forever. Every diagnostic goes straight to `console`, and only when `debug` is
`true`. If loghq is unreachable, your application logs behave exactly as they did
before you installed this.

## Two seams, and why

`@stacksjs/logging` grew a transports API: a `transports` key on
`config/logging.ts` and a `registerTransport()` export. That is the seam this
package prefers, and the one `loghqTransport()` uses. The logger hands every
record to the transport before formatting, so an `Error` is still an `Error` and
a context object is still an object, rather than both being flattened into the
console line.

Before that existed, the only hook was clarity's `formatter`, which is the wrong
shape: it is called for its return value, on the finished string, after the
level has been flattened. Building structured output through it means parsing
back out what the logger just finished formatting.

So the fallback is teeing the mutable `log` singleton, which Stacks exports as a
plain object with reassignable methods. `install()` keeps that intervention as
small as it can: the wrapper calls the original first, returns exactly what it
returned, enqueues a copy after, and is reversible by identity. `log.struct`
routes back through those same methods, so wrapping six functions captures the
structured stream too.

`install()` probes for the registry first and only tees if it finds none, so the
same call works on any framework version and upgrades itself when the app does.

## Roadmap

Severity is still lossy in one direction. Stacks has five levels, including
`success`, and loghq has the eight RFC 5424 severities. `success` maps to `info`
with the original kept in `context.original_level`, and `notice`, `critical`,
`alert`, and `emergency` have no source at all: a Stacks app cannot currently
emit them. That is a framework limitation this package will not paper over by
guessing.

## License

MIT
