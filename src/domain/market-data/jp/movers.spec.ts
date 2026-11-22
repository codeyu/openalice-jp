import { describe, expect, it, vi } from 'vitest'

import { fetchJpMovers, fetchJpRankingDates, fetchJpRankingTypes, stripIndexPrefix, toMoverRow } from './movers.js'
import { createKeyedCache } from './service.js'

const cfg = { baseUrl: 'https://gw.example.com', token: 'read-only' }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const types = [
  { type: 'gain', title: '今日の値上がり率', subject: 'stock' },
  { type: 'sector_loss', title: '業種別値下がり率', subject: 'sector' },
]

describe('jp movers', () => {
  it('maps stock, credit and sector rows to one shape', () => {
    expect(toMoverRow({
      trade_date: '2026-11-06', rank_no: 1, stock_code: '4475', stock_name: 'ＨＥＮＮＧＥ', exchange_name: '東証プ', category_name: '情報・通信業',
      price: 2211, change_ratio: 400, change_pct: 22.08, volume: 2099.6, turnover: 4471.08, as_of_time: '15:30', extras: { Trend: '1' },
    })).toEqual({ rank: 1, code: '4475', name: 'ＨＥＮＮＧＥ', exchange: '東証プ', category: '情報・通信業', price: 2211, change: 400, changePct: 22.08, volume: 2099.6, turnover: 4471.08, asOfTime: '15:30', marginRatio: null })
    expect(toMoverRow({
      trade_date: '2026-11-06', rank_no: 1, stock_code: '1360', stock_name: '日経ベア２', exchange_name: '東証ETF/ETN', category_name: 'その他',
      price: null, change_ratio: null, change_pct: null, volume: null, turnover: null, as_of_time: null, extras: { Ratio: 1.96 },
    }).marginRatio).toBe(1.96)
    expect(toMoverRow({
      trade_date: '2026-11-06', rank_no: 1, stock_code: null, stock_name: null, exchange_name: null, category_name: 'IS 食料',
      price: 2802.92, change_ratio: -311.97, change_pct: -10.02, volume: null, turnover: null, as_of_time: '15:30', extras: null,
    }).name).toBe('食料')
    // Only index rows lose the prefix; a stock whose name starts with "IS" keeps it.
    expect(toMoverRow({
      trade_date: '2026-11-06', rank_no: 1, stock_code: '9999', stock_name: 'IS テスト', exchange_name: '東証プ', category_name: 'IS 業種',
      price: 1, change_ratio: 0, change_pct: 0, volume: null, turnover: null, as_of_time: null, extras: null,
    })).toMatchObject({ name: 'IS テスト', category: 'IS 業種' })
    expect(stripIndexPrefix('IS　精密')).toBe('精密')
  })

  it('reads ranking types and the latest stored trading day for the requested type', async () => {
    const fetchImpl = fakeDb({ rankingDates: ['2026-11-06'], tradingDays: ['2026-11-06'], latestBar: '2026-11-06' })
    expect(await fetchJpRankingTypes(cfg, fetchImpl)).toEqual([{ type: 'gain', title: '今日の値上がり率', subject: 'stock' }])
    const board = await fetchJpMovers(cfg, 'gain', types, fetchImpl, new Date('2026-11-08T00:00:00Z'))
    expect(board).toMatchObject({ date: '2026-11-06', type: { type: 'gain' }, rows: [{ rank: 1, code: '318A', changePct: 23.52 }], meta: { provider: 'kabu-db' } })
    const urls = fetchImpl.mock.calls.map(([u]) => u as string)
    expect(urls.some((u) => u.includes('rankings?select=trade_date&ranking_type=eq.gain&rank_no=lte.5&order=trade_date.desc'))).toBe(true)
    expect(urls.some((u) => u.includes('ranking_type=eq.gain&trade_date=eq.2026-11-06&order=rank_no'))).toBe(true)
  })

  it('refuses unknown or malformed types before querying', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchJpMovers(cfg, 'nope', types, fetchImpl)).rejects.toThrow('unknown ranking type')
    await expect(fetchJpMovers(cfg, 'gain&order=x', types, fetchImpl)).rejects.toThrow('invalid ranking type')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caches per key and retries after a failed load', async () => {
    const cache = createKeyedCache<number>(60_000)
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(7)
    await expect(cache.get('a', load)).rejects.toThrow('down')
    expect(await cache.get('a', load)).toBe(7)
    expect(await cache.get('a', load)).toBe(7)
    expect(await cache.get('b', async () => 9)).toBe(9)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

/**
 * A tiny fake of the gateway: rankings stored for `rankingDates` (holidays
 * included, as the importer does), daily bars only on `tradingDays`.
 */
function fakeDb(opts: { rankingDates: string[]; tradingDays: string[]; latestBar: string }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url)
    const lte = u.searchParams.get('trade_date')?.replace(/^lte\./, '')
    if (u.pathname.endsWith('/ranking_types')) return json([{ ranking_type: 'gain', title: '今日の値上がり率', subject: 'stock' }])
    if (u.pathname.endsWith('/ohlcv_daily') && !u.searchParams.get('stock_code')) return json([{ ts: `${opts.latestBar}T00:00:00+09:00` }])
    if (u.pathname.endsWith('/ohlcv_daily')) {
      // one row per bellwether per trading day
      return json(opts.tradingDays.flatMap((d) => [{ ts: `${d}T00:00:00+09:00` }, { ts: `${d}T00:00:00+09:00` }]))
    }
    if (u.searchParams.get('select') === 'trade_date') {
      const dates = opts.rankingDates.filter((d) => !lte || d <= lte)
      return json(dates.flatMap((d) => [{ trade_date: d }, { trade_date: d }]))
    }
    const eq = u.searchParams.get('trade_date')?.replace(/^eq\./, '')
    return json([{ trade_date: eq, rank_no: 1, stock_code: '318A', stock_name: 'ＶＩＸＥＴＦ', exchange_name: null, category_name: null, price: 420, change_ratio: 80, change_pct: 23.52, volume: null, turnover: null, as_of_time: '15:30', extras: null }])
  })
}

describe('jp movers by date', () => {
  // The rankings importer stored 2026-11-03 (文化の日) as a copy of 11-02; daily bars have no 11-03.
  const db = { rankingDates: ['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02'], tradingDays: ['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-02'], latestBar: '2026-11-06' }

  it('lists only real trading days and skips holiday rows', async () => {
    expect(await fetchJpRankingDates(cfg, 'sector_gain', 4, fakeDb(db))).toEqual(['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-02'])
  })

  it('reads a requested trading day, or the nearest trading day before a holiday', async () => {
    expect((await fetchJpMovers(cfg, 'gain', types, fakeDb(db), new Date(), '2026-11-04')).date).toBe('2026-11-04')
    expect((await fetchJpMovers(cfg, 'gain', types, fakeDb(db), new Date(), '2026-11-03')).date).toBe('2026-11-02')
    await expect(fetchJpMovers(cfg, 'gain', types, fakeDb(db), new Date(), '2026/11/04')).rejects.toThrow('YYYY-MM-DD')
  })

  it('keeps a ranking day newer than the latest daily bar (prices not imported yet)', async () => {
    const fresh = { ...db, rankingDates: ['2026-11-09', ...db.rankingDates] }
    expect((await fetchJpMovers(cfg, 'gain', types, fakeDb(fresh), new Date())).date).toBe('2026-11-09')
  })
})
