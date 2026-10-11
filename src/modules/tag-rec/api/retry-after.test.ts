import { AxiosHeaders } from 'axios'
import { describe, expect, it } from 'vitest'
import { retryAfterDelay } from './retry-after'

describe('Retry-After response parsing', () => {
  it('also accepts AxiosHeaders and case-insensitive plain response-header maps', () => {
    expect(retryAfterDelay(new AxiosHeaders({ 'Retry-After': '900' }))).toBe(900_000)
    expect(retryAfterDelay({ 'RETRY-AFTER': 120 })).toBe(120_000)
    expect(retryAfterDelay({ 'retry-after': ['120', '5'] })).toBe(120_000)
    expect(retryAfterDelay({ 'Retry-After': false })).toBeUndefined()
    const now = Date.parse('Thu, 08 Oct 2026 00:00:00 GMT')
    expect(retryAfterDelay({ 'Retry-After': 'Thu, 08 Oct 2026 00:15:00 GMT' }, now)).toBe(900_000)
  })
  it('accepts case-insensitive seconds and zero without imposing the local 60s cap', () => {
    expect(retryAfterDelay('Content-Type: application/json\r\nRetry-After: 120\r\n')).toBe(120_000)
    expect(retryAfterDelay('retry-after: 0')).toBe(0)
    expect(retryAfterDelay('RETRY-AFTER: 86400')).toBe(86_400_000)
  })
  it('parses HTTP dates and expired deadlines', () => {
    const now = Date.parse('Thu, 08 Oct 2026 00:00:00 GMT')
    expect(retryAfterDelay('Retry-After: Thu, 08 Oct 2026 00:02:00 GMT', now)).toBe(120_000)
    expect(retryAfterDelay('Retry-After: Wed, 07 Oct 2026 00:00:00 GMT', now)).toBe(0)
  })
  it.each([undefined, '', 'Retry-After: -1', 'Retry-After: 1.5', 'Retry-After: nonsense', 'Retry-After: Infinity'])(
    'ignores invalid input: %s',
    (input) => {
      expect(retryAfterDelay(input)).toBeUndefined()
    },
  )
  it('does not shorten a wait when duplicate header lines disagree', () => {
    expect(retryAfterDelay('Retry-After: 120\nRetry-After: 5')).toBe(120_000)
  })
})
