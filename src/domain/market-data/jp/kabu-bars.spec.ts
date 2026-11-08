import { describe, expect, it, vi } from 'vitest'

import { adjustRow, fetchKabuBars, normalizeKabuCode } from './kabu-bars.js'

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

  it('queries the right table newest-first, then returns ascending bars', async () => {
    const fetchImpl = vi.fn(async () => json([
      { ts: '2026-11-06T00:00:00+09:00', open: 3300, high: 3350, low: 3200, close: 3338, volume: 2, turnover: 1, adjusted_close: 3338 },
      { ts: '2026-11-05T00:00:00+09:00', open: 3400, high: 3450, low: 3380, close: 3420, volume: 1, turnover: 1, adjusted_close: 3420 },
    ]))
    const bars = await fetchKabuBars(cfg, '7203.T', { interval: '1w', count: 2, start: '2026-01-01', end: '2026-11-06' }, fetchImpl)
    expect(bars.map((b) => b.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gw.example.com/rest/v1/ohlcv_weekly?select=ts,open,high,low,close,volume,turnover,adjusted_close&stock_code=eq.7203&ts=gte.2026-01-01&ts=lte.2026-11-06T23:59:59%2B09:00&order=ts.desc&limit=2',
      expect.anything(),
    )
    await expect(fetchKabuBars(cfg, '7203', { interval: '1h' as never }, fetchImpl)).rejects.toThrow('1d and 1w')
    await expect(fetchKabuBars(cfg, '7203', { interval: '1d', end: '2026/11/06' }, fetchImpl)).rejects.toThrow('YYYY-MM-DD')
  })
})
