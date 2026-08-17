/**
 * The wire contract, as types.
 *
 * Every shape here mirrors `docs/ingest.md` in the loghq repo, which is the
 * authoritative spec. Where the two disagree, the spec wins and this file is
 * the bug.
 */

/** SDK identity sent on every entry. It is the only version signal loghq gets. */
export const SDK_NAME = 'loghq.stacks'
export const SDK_VERSION = '0.1.0'

/**
 * Where entries go when neither `host` nor a DSN says otherwise.
 *
 * POINTED AT LOCAL DEVELOPMENT ON PURPOSE, AND TEMPORARILY. loghq is not
 * serving production ingest for these SDKs yet, so every consumer today runs
 * against `bun run dev` in the loghq repo, which serves the API on 3008. An app
 * should not have to configure an endpoint to do the only thing currently
 * possible.
 *
 * The IPv4 literal rather than `localhost` is deliberate: the dev server binds
 * 127.0.0.1 only, so on a machine where `localhost` resolves to `::1` first,
 * the connection is refused.
 *
 * This has to become `https://loghq.org` before release, and that release needs
 * a version bump, because a library defaulting to a loopback address fails in
 * the worst way available: it deploys, connects to nothing, the transport
 * swallows the error by design, and missing logs are the only symptom.
 */
export const DEFAULT_HOST = 'http://127.0.0.1:3008'

/**
 * The eight RFC 5424 / PSR-3 severities loghq accepts, least to most severe.
 *
 * Note there is no `trace` and no `success`. Stacks' own logger has a five
 * value set that includes `success` and omits everything above `error`, so
 * bridging is lossy in both directions. See `mapLevel` in `./levels`.
 */
export type LogHQLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency'

/** Severity order, used for `minLevel` filtering. Index is the RFC 5424 rank. */
export const LEVEL_ORDER: readonly LogHQLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
]

/** The authenticated user an entry is attributed to. Free-form beyond `id`. */
export interface LogHQUser {
  id?: string | number
  email?: string
  name?: string
  [key: string]: unknown
}

/**
 * One log entry on the wire.
 *
 * Only `message` is required. Everything else is either defaulted by the client
 * or omitted, and unknown fields are ignored by the server rather than rejected.
 */
export interface LogHQEntry {
  message: string
  level?: LogHQLevel
  /** Source or logger name: `queue`, `billing`, `http`. */
  channel?: string
  /** Arbitrary structured data. Capped at 96 KiB on the wire. */
  context?: Record<string, unknown>
  environment?: string
  /** Version or commit the entry came from. */
  release?: string
  framework?: string
  /** Reporting machine. */
  host?: string
  sdk?: { name: string, version: string }
  user?: LogHQUser
  /** ISO-8601. Defaults to the moment the entry was queued, not flushed. */
  timestamp?: string
  /** Distributed trace id. Prefer the 32 hex W3C `traceparent` trace-id. */
  trace_id?: string
  /** Single inbound request. */
  request_id?: string
}

/** The `201` body. `stored + dropped + skipped` equals what you sent. */
export interface IngestResult {
  ok: boolean
  /** Rows written. */
  stored: number
  /** Past the 500 cap, never examined by the server. Resend these. */
  dropped: number
  /** Examined and rejected as unusable. Resending will not help. */
  skipped: number
}

export interface LogHQConfig {
  /**
   * Project ingest key, `loghq_<64 hex>`. Public by design: it identifies a
   * project, is revocable, and grants no read access. Safe in app config.
   */
  key?: string
  /** `https://<key>@<host>`. Explicit `key` / `host` win over DSN parts. */
  dsn?: string
  /** Ingest host. Defaults to {@link DEFAULT_HOST}. */
  host?: string

  /** Defaults to `APP_ENV` / `NODE_ENV`, else `production`. */
  environment?: string
  /** Version or commit. Defaults to `APP_VERSION` / `RELEASE` when set. */
  release?: string
  /** Applied to entries that do not carry their own. */
  channel?: string
  /** Reporting machine. Defaults to `os.hostname()` on the server. */
  hostname?: string
  /** Attributed to every entry until changed. */
  user?: LogHQUser | null

  /** Drop anything less severe than this. Default `info`. */
  minLevel?: LogHQLevel
  /** Master switch. Default `true`. */
  enabled?: boolean

  /** Flush when the queue reaches this many entries. Default 50, max 500. */
  batchSize?: number
  /** Flush at least this often, in ms. Default 2000. `0` disables the timer. */
  flushInterval?: number
  /**
   * Hard ceiling on queued entries. Oldest are discarded past it, so a burst
   * cannot grow the process out of memory. Default 1000.
   */
  maxQueueSize?: number
  /** Per-request timeout in ms. Default 10000. */
  timeout?: number
  /** Give up on a batch after this many transport attempts. Default 5. */
  maxRetries?: number

  /**
   * Last chance to redact, enrich, or drop. Returning `null` discards the
   * entry. Throwing is caught and treated as `null`.
   */
  beforeSend?: (entry: LogHQEntry) => LogHQEntry | null

  /**
   * Diagnostics. Writes to `console`, never through the host logger, because
   * routing SDK diagnostics back into the logger it is draining recurses.
   */
  debug?: boolean

  /** Override the SDK identity. Integrations set this; applications should not. */
  sdk?: { name: string, version: string }
}

/** Config after defaults, DSN parsing, and validation. */
export interface ResolvedConfig extends Required<Omit<LogHQConfig, 'dsn' | 'beforeSend' | 'user' | 'release' | 'channel' | 'hostname'>> {
  release: string | undefined
  channel: string | undefined
  hostname: string | undefined
  user: LogHQUser | null
  // The parameter name is documentation on a type, not a binding. pickier reads
  // the parenthesized function type as a declaration and reports it unused.
  // eslint-disable-next-line pickier/no-unused-vars
  beforeSend: ((entry: LogHQEntry) => LogHQEntry | null) | undefined
  endpoint: string
}

/**
 * One log call, as the Stacks logger hands it to a transport.
 *
 * Declared here rather than imported from `@stacksjs/types` so this package
 * keeps no hard dependency on the framework: it is an optional peer, and a
 * `.d.ts` referencing a package the consumer does not have is a type error in
 * someone else's build.
 *
 * Deliberately wider than the upstream `LogRecord` in every field. That is what
 * makes {@link StacksLogTransport} assignable to the upstream `LogTransport`:
 * a handler that accepts more than it will be given is safe, one that accepts
 * less is not.
 */
export interface StacksLogRecord {
  level: string
  /** The formatted line. Lossier than `args`, which is why it is a fallback. */
  message?: string
  /** The call before formatting: an `Error` is still an `Error` here. */
  args?: unknown[]
  /** Trace id, request id, and whatever `withLogContext` added. */
  context?: Record<string, unknown>
  timestamp?: string
  [key: string]: unknown
}

/**
 * A Stacks log transport, structurally.
 *
 * Matches `LogTransport` from `@stacksjs/types`. `level` is spelled out as the
 * literal union rather than `string` because that is the one field the upstream
 * type narrows, and a widened copy would not be assignable.
 */
export interface StacksLogTransport {
  name: string
  level?: 'debug' | 'info' | 'success' | 'warning' | 'error'
  log: (record: StacksLogRecord) => void
  flush?: () => Promise<void>
}

/**
 * Why a client stopped accepting entries.
 *
 * `auth` and `unknown-project` are permanent: the spec is explicit that
 * retrying a bad key is a self-inflicted flood, so the client disables itself
 * rather than backing off.
 */
export type DisabledReason = 'auth' | 'unknown-project' | 'inactive-project' | 'closed'
