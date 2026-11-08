/**
 * Japan market breadth board — advancers/decliners and TOPIX-17 sector moves
 * for the latest trading day, computed from the kabu gateway's daily bars.
 *
 * Daily changes use `adjusted_close` (falling back to `close`) for both days so
 * a stock split between them does not read as a crash.
 */

import { kabuDbGet, kabuDbGetAll, type FetchLike, type KabuDbConfig } from './kabu-db.js'

export interface JpSectorMove {
  name: string
  /** Equal-weight mean daily change, percent. */
  avgChangePct: number
  advancers: number
  decliners: number
  count: number
}

export interface JpBreadthBoard {
  date: string
  prevDate: string
  breadth: { advancers: number; decliners: number; unchanged: number; total: number }
  sectors: JpSectorMove[]
  meta: { provider: 'kabu-db'; asOf: string; origin: 'local' }
}

interface DailyRow { stock_code: string; close: number | null; adjusted_close: number | null }
interface StockRow { stock_code: string; sector_17_name: string | null }

const day = (ts: string) => ts.slice(0, 10)
const price = (r: DailyRow) => r.adjusted_close ?? r.close

/** Pure aggregation, separated from I/O for tests. */
export function computeBreadth(latest: DailyRow[], prev: DailyRow[], stocks: StockRow[]): Pick<JpBreadthBoard, 'breadth' | 'sectors'> {
  const sectorOf = new Map(stocks.map((s) => [s.stock_code, s.sector_17_name]))
  const prevPrice = new Map(prev.map((r) => [r.stock_code, price(r)]))
  const breadth = { advancers: 0, decliners: 0, unchanged: 0, total: 0 }
  const sectors = new Map<string, { sum: number; advancers: number; decliners: number; count: number }>()

  for (const row of latest) {
    const sector = sectorOf.get(row.stock_code)
    if (!sector) continue // ETFs, REITs and codes without a TOPIX-17 sector are not equities here
    const now = price(row)
    const before = prevPrice.get(row.stock_code)
    if (now == null || before == null || !(now > 0) || !(before > 0)) continue
    const pct = (now / before - 1) * 100
    breadth.total++
    if (pct > 0) breadth.advancers++
    else if (pct < 0) breadth.decliners++
    else breadth.unchanged++
    const s = sectors.get(sector) ?? { sum: 0, advancers: 0, decliners: 0, count: 0 }
    s.sum += pct
    s.count++
    if (pct > 0) s.advancers++
    else if (pct < 0) s.decliners++
    sectors.set(sector, s)
  }

  return {
    breadth,
    sectors: [...sectors.entries()]
      .map(([name, s]) => ({ name, avgChangePct: Math.round((s.sum / s.count) * 100) / 100, advancers: s.advancers, decliners: s.decliners, count: s.count }))
      .sort((a, b) => b.avgChangePct - a.avgChangePct),
  }
}

export async function fetchJpBreadth(cfg: KabuDbConfig, fetchImpl?: FetchLike, now = new Date()): Promise<JpBreadthBoard> {
  const [latestTs] = await kabuDbGet<{ ts: string }>(cfg, 'ohlcv_daily?select=ts&order=ts.desc&limit=1', fetchImpl)
  if (!latestTs) throw new Error('kabu DB has no daily bars')
  const [prevTs] = await kabuDbGet<{ ts: string }>(cfg, `ohlcv_daily?select=ts&ts=lt.${encodeURIComponent(latestTs.ts)}&order=ts.desc&limit=1`, fetchImpl)
  if (!prevTs) throw new Error('kabu DB has only one trading day of daily bars')

  const cols = 'select=stock_code,close,adjusted_close'
  const [latest, prev, stocks] = await Promise.all([
    kabuDbGetAll<DailyRow>(cfg, `ohlcv_daily?${cols}&ts=eq.${encodeURIComponent(latestTs.ts)}&order=stock_code`, fetchImpl),
    kabuDbGetAll<DailyRow>(cfg, `ohlcv_daily?${cols}&ts=eq.${encodeURIComponent(prevTs.ts)}&order=stock_code`, fetchImpl),
    kabuDbGetAll<StockRow>(cfg, 'stocks?select=stock_code,sector_17_name&sector_17_name=not.is.null&order=stock_code', fetchImpl),
  ])

  return {
    date: day(latestTs.ts),
    prevDate: day(prevTs.ts),
    ...computeBreadth(latest, prev, stocks),
    meta: { provider: 'kabu-db', asOf: now.toISOString(), origin: 'local' },
  }
}
