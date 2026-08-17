import type { LogHQLevel } from '../src/types'
import { describe, expect, it } from 'bun:test'
import { atLeast, isLossy, rankOf, toLogHQLevel } from '../src/levels'
import { LEVEL_ORDER } from '../src/types'

/**
 * The alias table is duplicated here on purpose. Importing the private map would
 * make this suite agree with the implementation by construction, which is the
 * one thing a mapping test must not do.
 */
const ALIASES: Array<[string, LogHQLevel]> = [
  ['success', 'info'],
  ['warn', 'warning'],
  ['trace', 'debug'],
  ['verbose', 'debug'],
  ['fine', 'debug'],
  ['log', 'info'],
  ['information', 'info'],
  ['warning_', 'warning'],
  ['err', 'error'],
  ['fatal', 'critical'],
  ['crit', 'critical'],
  ['panic', 'emergency'],
  ['emerg', 'emergency'],
  ['alert_', 'alert'],
]

describe('toLogHQLevel', () => {
  it('passes every RFC 5424 severity through untouched', () => {
    for (const level of LEVEL_ORDER)
      expect(toLogHQLevel(level)).toBe(level)
  })

  it.each(ALIASES)('maps %s to %s', (input, expected) => {
    expect(toLogHQLevel(input)).toBe(expected)
  })

  it('collapses success to info rather than inventing notice', () => {
    // notice means "normal but significant", which a success message is not
    // reliably, so the collapse is deliberate and the loss is recorded by
    // isLossy instead.
    expect(toLogHQLevel('success')).toBe('info')
    expect(toLogHQLevel('success')).not.toBe('notice')
  })

  it('lifts fatal and panic above error so the author signal survives', () => {
    expect(rankOf(toLogHQLevel('fatal'))).toBeGreaterThan(rankOf('error'))
    expect(rankOf(toLogHQLevel('panic'))).toBeGreaterThan(rankOf('error'))
  })

  it('falls back instead of throwing on an unknown name', () => {
    expect(() => toLogHQLevel('galactic')).not.toThrow()
    expect(toLogHQLevel('galactic')).toBe('info')
    expect(toLogHQLevel('galactic', 'error')).toBe('error')
    expect(toLogHQLevel('notice-ish', 'debug')).toBe('debug')
  })

  it('falls back on anything that is not a string', () => {
    const notStrings: unknown[] = [undefined, null, 42, 0, true, false, {}, [], Symbol('info'), new Date(), () => 'info']
    for (const value of notStrings)
      expect(toLogHQLevel(value)).toBe('info')
    for (const value of notStrings)
      expect(toLogHQLevel(value, 'critical')).toBe('critical')
  })

  it('falls back on empty and whitespace-only input', () => {
    expect(toLogHQLevel('')).toBe('info')
    expect(toLogHQLevel('   ')).toBe('info')
    expect(toLogHQLevel('\t\n')).toBe('info')
    expect(toLogHQLevel('', 'warning')).toBe('warning')
  })

  it('ignores case', () => {
    expect(toLogHQLevel('ERROR')).toBe('error')
    expect(toLogHQLevel('Warn')).toBe('warning')
    expect(toLogHQLevel('SUCCESS')).toBe('info')
    expect(toLogHQLevel('EmErGeNcY')).toBe('emergency')
    expect(toLogHQLevel('PANIC')).toBe('emergency')
  })

  it('ignores surrounding whitespace', () => {
    expect(toLogHQLevel('  error ')).toBe('error')
    expect(toLogHQLevel('\twarn\n')).toBe('warning')
    expect(toLogHQLevel(' \r\n CRIT \t ')).toBe('critical')
  })

  it('is idempotent, so a mapped level maps to itself', () => {
    for (const [input] of ALIASES) {
      const once = toLogHQLevel(input)
      expect(toLogHQLevel(once)).toBe(once)
    }
  })
})

describe('isLossy', () => {
  it('flags the names that do not survive the mapping', () => {
    for (const name of ['success', 'fatal', 'panic', 'trace', 'verbose', 'fine'])
      expect(isLossy(name)).toBe(true)
  })

  it('does not flag names whose meaning is preserved', () => {
    for (const name of [...LEVEL_ORDER, 'warn', 'err', 'crit', 'emerg', 'log', 'information', 'warning_', 'alert_'])
      expect(isLossy(name)).toBe(false)
  })

  it('does not flag unknown names, because there is nothing to preserve', () => {
    expect(isLossy('galactic')).toBe(false)
    expect(isLossy('')).toBe(false)
  })

  it('applies the same case and whitespace tolerance as the mapping', () => {
    expect(isLossy(' SUCCESS ')).toBe(true)
    expect(isLossy('\tFatal\n')).toBe(true)
    expect(isLossy('  Trace')).toBe(true)
  })

  it('is false for anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], () => 'fatal'])
      expect(isLossy(value)).toBe(false)
  })

  it('agrees with the mapping: a lossy name never lands on itself', () => {
    for (const name of ['success', 'fatal', 'panic', 'trace', 'verbose', 'fine'])
      expect(toLogHQLevel(name)).not.toBe(name)
  })
})

describe('rankOf', () => {
  it('ranks the eight severities least to most severe', () => {
    expect(LEVEL_ORDER.map(rankOf)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('ranks an unknown level as info rather than throwing', () => {
    expect(rankOf('galactic' as LogHQLevel)).toBe(rankOf('info'))
    expect(rankOf('' as LogHQLevel)).toBe(rankOf('info'))
    expect(() => rankOf(undefined as unknown as LogHQLevel)).not.toThrow()
  })

  it('is strictly increasing across the whole order', () => {
    for (let i = 1; i < LEVEL_ORDER.length; i++)
      expect(rankOf(LEVEL_ORDER[i]!)).toBeGreaterThan(rankOf(LEVEL_ORDER[i - 1]!))
  })
})

describe('atLeast', () => {
  it('holds for every ordered pair of severities', () => {
    for (const level of LEVEL_ORDER) {
      for (const min of LEVEL_ORDER)
        expect(atLeast(level, min)).toBe(rankOf(level) >= rankOf(min))
    }
  })

  it('is inclusive at the threshold', () => {
    for (const level of LEVEL_ORDER)
      expect(atLeast(level, level)).toBe(true)
  })

  it('rejects everything below the threshold', () => {
    expect(atLeast('debug', 'info')).toBe(false)
    expect(atLeast('info', 'warning')).toBe(false)
    expect(atLeast('warning', 'error')).toBe(false)
    expect(atLeast('error', 'critical')).toBe(false)
    expect(atLeast('critical', 'alert')).toBe(false)
    expect(atLeast('alert', 'emergency')).toBe(false)
  })

  it('accepts everything above the threshold', () => {
    expect(atLeast('emergency', 'debug')).toBe(true)
    expect(atLeast('error', 'info')).toBe(true)
    expect(atLeast('critical', 'warning')).toBe(true)
    expect(atLeast('notice', 'debug')).toBe(true)
  })

  it('treats a debug threshold as accepting everything', () => {
    for (const level of LEVEL_ORDER)
      expect(atLeast(level, 'debug')).toBe(true)
  })

  it('treats an emergency threshold as accepting only emergency', () => {
    for (const level of LEVEL_ORDER)
      expect(atLeast(level, 'emergency')).toBe(level === 'emergency')
  })
})
