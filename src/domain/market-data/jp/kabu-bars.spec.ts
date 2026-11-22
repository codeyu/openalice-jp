import { describe, expect, it, vi } from 'vitest'

import { adjustRow, aggregateWeekly, fetchKabuBars, normalizeKabuCode, weekStart } from './kabu-bars.js'

const cfg = { baseUrl: 'https://gw.example.com/', token: 'read-only' }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('kabu bars', () => {
  it('normalizes TSE codes and rejects anything else', () => {
    expect(normalizeKabuCode('7203')).toBe('7203')
    expect(normalizeKabuCode('7203.T')).toBe('7203')
    expect(normalizeKabuCode(' 130a ')).toBe('130A')
    expect(() => normalizeKabuCode('AAPL')).toThrow('4-character TSE code')
    expect(() => normalizeKabuCode('7203&order=x')).toThrow('4-character TSE code')
  })

  it('split-adjusts OHLC and volume with the adjusted_close factor (Toyota 2021 5:1)', () => {
    expect(adjustRow({ ts: '2021-09-28T00:00:00+09:00', open: 10420, high: 10460, low: 10250, close: 10385, volume: 7563400, turnover: 78545909000, adjusted_close: 2077 }))
      .toEqual({ date: '2021-09-28', open: 2084, high: 2092, low: 2050, close: 2077, volume: 37817000, rawClose: 10385, turnover: 78545909000 })
    expect(adjustRow({ ts: '2026-11-06T00:00:00+09:00', open: 3300, high: 3350, low: 3200, close: 3338, volume: 100, turnover: null, adjusted_close: null }))
      .toMatchObject({ close: 3338, volume: 100 })
    expect(adjustRow({ ts: '2026-11-06T00:00:00+09:00', open: null, high: 1, low: 1, close: 1, volume: 1, turnover: null, adjusted_close: 1 })).toBeNull()
  })

  it('reads the daily table newest-first, then returns ascending bars', async () => {
    const fetchImpl = vi.fn(async () => json([
      { ts: '2026-11-06T00:00:00+09:00', open: 3300, high: 3350, low: 3200, close: 3338, volume: 2, turnover: 1, adjusted_close: 3338 },
      { ts: '2026-11-05T00:00:00+09:00', open: 3400, high: 3450, low: 3380, close: 3420, volume: 1, turnover: 1, adjusted_close: 3420 },
    ]))
    const bars = await fetchKabuBars(cfg, '7203.T', { interval: '1d', count: 2, start: '2026-01-01', end: '2026-11-06' }, fetchImpl)
    expect(bars.map((b) => b.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gw.example.com/rest/v1/ohlcv_daily?select=ts,open,high,low,close,volume,turnover,adjusted_close&stock_code=eq.7203&ts=gte.2026-01-01&ts=lte.2026-11-06T23:59:59%2B09:00&order=ts.desc&limit=2&offset=0',
      expect.anything(),
    )
    await expect(fetchKabuBars(cfg, '7203', { interval: '1h' as never }, fetchImpl)).rejects.toThrow('1d and 1w')
    await expect(fetchKabuBars(cfg, '7203', { interval: '1d', end: '2026/11/06' }, fetchImpl)).rejects.toThrow('YYYY-MM-DD')
  })

  it('builds weekly bars from adjusted days, so a mid-week split cannot mix raw prices', async () => {
    // Toyota's 5:1 split took effect on Wednesday 2021-09-29 (raw rows, newest first).
    const raw = [
      { ts: '2021-10-01T00:00:00+09:00', open: 1980, high: 2004, low: 1965.5, close: 1967, volume: 27672500, turnover: 54431807500, adjusted_close: 1967 },
      { ts: '2021-09-30T00:00:00+09:00', open: 2088, high: 2088, low: 2000, close: 2000, volume: 33149100, turnover: 66298200000, adjusted_close: 2000 },
      { ts: '2021-09-29T00:00:00+09:00', open: 2052, high: 2080.5, low: 2040.5, close: 2073, volume: 34887300, turnover: 72321372900, adjusted_close: 2073 },
      { ts: '2021-09-28T00:00:00+09:00', open: 10420, high: 10460, low: 10250, close: 10385, volume: 7563400, turnover: 78545909000, adjusted_close: 2077 },
      { ts: '2021-09-27T00:00:00+09:00', open: 10155, high: 10350, low: 10150, close: 10330, volume: 5362000, turnover: 55389460000, adjusted_close: 2066 },
    ]
    const fetchImpl = vi.fn(async (_url: string) => json(raw))
    const [week] = await fetchKabuBars(cfg, '7203', { interval: '1w', start: '2021-09-27', end: '2021-10-01' }, fetchImpl)
    expect(week).toEqual({
      date: '2021-09-27',
      open: 2031, // 10155 × 0.2, not the raw 10155 the gateway's weekly table reports
      high: 2092, // max(10350, 10460) × 0.2 and the post-split 2088 / 2080.5
      low: 1965.5,
      close: 1967,
      volume: 26810000 + 37817000 + 34887300 + 33149100 + 27672500,
      rawClose: 1967,
      turnover: 55389460000 + 78545909000 + 72321372900 + 66298200000 + 54431807500,
    })
    expect(fetchImpl.mock.calls[0][0]).toContain('/rest/v1/ohlcv_daily?')
  })

  it('handles reverse splits (consolidations) the same way', () => {
    // 6731: 10:1 consolidation on 2026-03-30 — pre-consolidation raw 39 yen reads as 390.
    expect(adjustRow({ ts: '2026-03-27T00:00:00+09:00', open: 36, high: 38, low: 34, close: 37, volume: 4579300, turnover: null, adjusted_close: 370 }))
      .toMatchObject({ open: 360, high: 380, low: 340, close: 370, volume: 457930, rawClose: 37 })
  })

  it('labels weeks by Monday and drops a count-cut oldest week', async () => {
    expect(weekStart('2021-10-01')).toBe('2021-09-27')
    expect(weekStart('2021-09-27')).toBe('2021-09-27')
    expect(weekStart('2021-10-03')).toBe('2021-09-27')
    expect(aggregateWeekly([])).toEqual([])
    // count 1 week → asks for (1 + 1) × 5 = 10 days; a full page means the oldest week may be partial.
    const days = Array.from({ length: 10 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 6) - i * 86400000).toISOString().slice(0, 10)
      return { ts: `${d}T00:00:00+09:00`, open: 1, high: 1, low: 1, close: 1, volume: 1, turnover: 1, adjusted_close: 1 }
    })
    const fetchImpl = vi.fn(async (_url: string) => json(days))
    const weeks = await fetchKabuBars(cfg, '7203', { interval: '1w', count: 1 }, fetchImpl)
    expect(weeks.map((w) => w.date)).toEqual(['2026-11-02'])
    expect(fetchImpl.mock.calls[0][0]).toContain('&limit=10&offset=0')
  })
})
