/**
 * The wire contract, as types.
 *
 * Every shape here mirrors `docs/ingest.md` in the loghq repo, which is the
 * authoritative spec. Where the two disagree, the spec wins and this file is
 * the bug.
 */

/** SDK identity sent on every entry. It is the only version signal loghq gets. */
export const SDK_NAME = 'loghq.stacks'
export const SDK_VERSION = '0.2.0'

/**
 * Where entries go when neither `host` nor a DSN says otherwise.
 *
 * Entries POST to `{host}/logs`. The path is not this SDK's to choose:
 * `docs/ingest.md` in the loghq repo is the wire contract and specifies
 * `POST /logs` at the app root, which `app/Routes.ts` registers with an empty
 * prefix. Every client in every language targets that same URL.
 *
 * Self-hosters, and only they, override with `host` or a DSN. Set
 * `http://127.0.0.1:3008` to develop against `bun run dev` in the loghq repo,
 * using the IPv4 literal rather than `localhost` since that server binds
 * 127.0.0.1 only and `localhost` may resolve to `::1` first.
 */
export const DEFAULT_HOST = 'https://loghq.org'

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
