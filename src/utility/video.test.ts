import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { formatCount, formatRecentTimestamp, formatTimestamp, parseCount, parseDuration } from './video'

describe.concurrent('$utility/video', () => {
  it('.parseDuration', () => {
    expect(parseDuration('01:23')).to.equal(83)
    expect(parseDuration('00:01:23')).to.equal(83)
  })

  it('.parseCount', () => {
    expect(parseCount('10000')).to.equal(1_0000)
    expect(parseCount('1.2万')).to.equal(1_2000)
    expect(parseCount('2万')).to.equal(2_0000)
    expect(parseCount('1.9亿')).to.equal(1_9000_0000) // https://www.bilibili.com/bangumi/play/ep327118
  })

  it('.formatCount', () => {
    expect(formatCount(1_0000)).to.equal('1万')
    expect(formatCount(1_2000)).to.equal('1.2万')
    expect(formatCount(2_0000)).to.equal('2万')
    expect(formatCount(1234)).to.equal('1234')
    expect(formatCount(1_9000_0000)).to.equal('1.9亿')
    expect(formatCount(undefined)).to.equal(undefined)
    expect(formatCount(0)).to.equal('0')
  })

  it('.formatTimeStamp', () => {
    const cur = Math.floor(Date.now() / 1000)
    expect(formatTimestamp(cur)).to.equal(dayjs().format('M-D'))
    expect(formatTimestamp(cur, true)).to.equal(dayjs().format('M-D HH:mm'))
  })

  it('.formatRecentTimestamp 使用同一时钟，保留分钟、小时和日期边界', () => {
    const now = dayjs('2026-10-02T16:00:00')
    const format = (ts: string, zhDate = true, includeTime = false) =>
      formatRecentTimestamp(dayjs(ts).unix(), zhDate, includeTime, now.valueOf())
    expect(format('2026-10-02T15:59:30')).toBe('刚刚')
    expect(format('2026-10-02T15:58:59')).toBe('1分钟前')
    expect(format('2026-10-02T14:30:00')).toBe('1小时前')
    expect(format('2026-10-02T04:00:00')).toBe('12小时前')
    expect(format('2026-10-02T03:59:59')).toBe('今天 03:59')
    expect(format('2026-10-01T18:20:00')).toBe('昨天 18:20')
    expect(format('2026-09-30T18:20:00')).toBe('9月30日')
    expect(format('2026-09-30T18:20:00', false, true)).toBe('9-30 18:20')
    expect(format('2025-09-30T18:20:00')).toBe('2025年9月30日')
    expect(formatRecentTimestamp(0, true, true, now.valueOf())).toBeUndefined()
  })

  it('.formatRecentTimestamp 跨午夜后从相对时间切换为昨天', () => {
    const ts = dayjs('2026-10-01T23:59:30').unix()
    expect(formatRecentTimestamp(ts, true, false, dayjs('2026-10-01T23:59:59').valueOf())).toBe('刚刚')
    expect(formatRecentTimestamp(ts, true, false, dayjs('2026-10-02T00:00:00').valueOf())).toBe('昨天 23:59')
  })
})
