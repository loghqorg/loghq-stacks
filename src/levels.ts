/**
 * Severity translation between Stacks' logger and loghq's wire format.
 *
 * These two vocabularies do not line up, and the mismatch is lossy in both
 * directions:
 *
 *   Stacks (clarity)  debug  info  success  warning  error
 *   loghq (RFC 5424)  debug  info  notice   warning  error  critical  alert  emergency
 *
 * So `success` has no destination, and `notice` and everything above `error`
 * has no source. `success` is mapped to `info` with the original preserved in
 * context rather than invented into `notice`, because `notice` means "normal
 * but significant" and a success message is neither reliably. The severities a
 * Stacks app cannot currently emit are a framework limitation, not one this
 * package can paper over.
 */
import type { LogHQLevel } from './types'
import { LEVEL_ORDER } from './types'

const VALID = new Set<string>(LEVEL_ORDER)

/**
 * Aliases seen in the wild, mapped to the nearest RFC 5424 severity.
 *
 * `fatal` and `panic` deliberately land above `error`: a logger that
 * distinguishes them means something more severe, and collapsing them to
 * `error` would erase the only signal the author gave.
 */
const ALIASES: Record<string, LogHQLevel> = {
  // Stacks / clarity
  success: 'info',
  warn: 'warning',
  // Common elsewhere
  trace: 'debug',
  verbose: 'debug',
  fine: 'debug',
  log: 'info',
  information: 'info',
  warning_: 'warning',
  err: 'error',
  fatal: 'critical',
  crit: 'critical',
  panic: 'emergency',
  emerg: 'emergency',
  alert_: 'alert',
}

/** Levels whose original name is worth preserving when it is not round-trippable. */
const LOSSY = new Set(['success', 'fatal', 'panic', 'trace', 'verbose', 'fine'])

/**
 * Coerce any logger's level name to a loghq severity.
 *
 * Unrecognized input falls back to `fallback` rather than throwing: a log call
 * must never fail because of its own severity string.
 */
export function toLogHQLevel(input: unknown, fallback: LogHQLevel = 'info'): LogHQLevel {
  if (typeof input !== 'string')
    return fallback

  const key = input.trim().toLowerCase()
  if (!key)
    return fallback
  if (VALID.has(key))
    return key as LogHQLevel

  return ALIASES[key] ?? fallback
}

/**
 * Whether the original level name survives the mapping.
 *
 * Callers use this to decide if `context.original_level` is worth setting;
 * recording `original_level: "error"` on an entry already at `error` is noise.
 */
export function isLossy(input: unknown): boolean {
  return typeof input === 'string' && LOSSY.has(input.trim().toLowerCase())
}

/** RFC 5424 rank. Higher is more severe. Unknown levels rank as `info`. */
export function rankOf(level: LogHQLevel): number {
  const i = LEVEL_ORDER.indexOf(level)
  return i === -1 ? LEVEL_ORDER.indexOf('info') : i
}

/** Whether `level` is at least as severe as `min`. */
export function atLeast(level: LogHQLevel, min: LogHQLevel): boolean {
  return rankOf(level) >= rankOf(min)
}
