/**
 * `@loghq/stacks` - stream a Stacks application's logs into loghq.
 *
 * The short version, in a Stacks app:
 *
 *   import { install } from '@loghq/stacks'
 *   install({ key: 'loghq_...' })
 *
 * That attaches to the framework's `log` singleton, so every existing
 * `log.info` / `log.error` / `log.struct` call site starts shipping without
 * being touched. See `./stacks` for how the attachment is chosen.
 *
 * Outside a Stacks app the same client works standalone through `init()` and
 * the capture helpers, since `@stacksjs/*` is only ever an optional runtime
 * probe and never a dependency.
 */

import type { LogHQConfig, LogHQLevel, LogHQUser } from './types'
import { LogHQClient } from './client'
import { install, installedClient, uninstall } from './stacks'

export * from './types'
export * from './levels'
export * from './client'
export * from './stacks'

/**
 * The client `init()` created.
 *
 * `install()` keeps its own in `./stacks`, so {@link getClient} reads both and
 * an app that used either entry point gets a working `capture()`.
 */
let defaultClient: LogHQClient | null = null

/** Create a client without touching the Stacks logger. Use `install()` in a Stacks app. */
export function init(config: LogHQConfig): LogHQClient {
  defaultClient = new LogHQClient(config)
  return defaultClient
}

export function getClient(): LogHQClient | null {
  return defaultClient ?? installedClient()
}

export function capture(level: LogHQLevel, message: string, context?: Record<string, unknown>): void {
  getClient()?.capture(level, message, context)
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  getClient()?.captureException(err, extra)
}

export function setUser(user: LogHQUser | null): void {
  getClient()?.setUser(user)
}

/** Resolves `true` when the queue drained, `false` when something was lost. */
export function flush(): Promise<boolean> {
  const client = getClient()
  return client ? client.flush() : Promise.resolve(true)
}

/** Detach from the logger, then drain and shut the client down. */
export async function close(): Promise<void> {
  // Grab the client before uninstalling: uninstall() drops the installation,
  // and with it the only reference `getClient()` had to fall back on.
  const client = getClient()
  uninstall()
  defaultClient = null
  if (client)
    await client.close()
}

/** The object the docs advertise: `loghq.install({ key })`. */
export const loghq = {
  install,
  init,
  capture,
  captureException,
  flush,
  close,
  getClient,
}

export default loghq
