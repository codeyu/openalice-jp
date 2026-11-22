/**
 * Japan movers board — daily rankings (gainers, losers, volume, surges,
 * margin balances, sectors…) stored by the user's kabu gateway in the
 * `rankings` / `ranking_types` tables. Always the latest stored trade date
 * for the requested type.
 */

import { kabuDbGet, type FetchLike, type KabuDbConfig } from './kabu-db.js'

export interface JpRankingType {
  type: string
  title: string
  subject: 'stock' | 'sector' | string
}

export interface JpMoverRow {
  rank: number
  code: string | null
  name: string
  exchange: string | null
  category: string | null
  price: number | null
  /** Change versus the previous close, in price units. */
  change: number | null
  changePct: number | null
  /** kabu ranking units: thousand shares. */
  volume: number | null
  /** kabu ranking units: million yen. */
  turnover: number | null
  asOfTime: string | null
  /** Margin ratio for credit rankings (信用倍率). */
  marginRatio: number | null
}

export interface JpMoversBoard {
  date: string
  type: JpRankingType
  types: JpRankingType[]
  rows: JpMoverRow[]
  meta: { provider: 'kabu-db'; asOf: string; origin: 'local' }
}

interface RankingTypeRow { ranking_type: string; title: string; subject: string }
interface RankingRow {
  trade_date: string
  rank_no: number
  stock_code: string | null
  stock_name: string | null
  exchange_name: string | null
  category_name: string | null
  price: number | null
  change_ratio: number | null
  change_pct: number | null
  volume: number | null
  turnover: number | null
  as_of_time: string | null
  extras: Record<string, unknown> | null
}

const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,40}$/

/** kabu labels TSE 33-industry indices "IS 食料"; the prefix is noise for a reader. */
export function stripIndexPrefix(name: string | null): string | null {
  return name == null ? null : name.replace(/^IS[\s　]+/, '')
}

export function toMoverRow(r: RankingRow): JpMoverRow {
  const ratio = r.extras?.['Ratio']
  const sector = r.stock_code == null
  const name = r.stock_name ?? r.category_name ?? ''
  return {
    rank: r.rank_no,
    code: r.stock_code,
    name: sector ? stripIndexPrefix(name) ?? '' : name,
    exchange: r.exchange_name,
    category: sector ? stripIndexPrefix(r.category_name) : r.category_name,
    price: r.price,
    change: r.change_ratio,
    changePct: r.change_pct,
    volume: r.volume,
    turnover: r.turnover,
    asOfTime: r.as_of_time,
    marginRatio: typeof ratio === 'number' ? ratio : null,
  }
}

export async function fetchJpRankingTypes(cfg: KabuDbConfig, fetchImpl?: FetchLike): Promise<JpRankingType[]> {
  const rows = await kabuDbGet<RankingTypeRow>(cfg, 'ranking_types?select=ranking_type,title,subject', fetchImpl)
  return rows.map((r) => ({ type: r.ranking_type, title: r.title, subject: r.subject }))
}

/**
 * Large caps that trade on every TSE session; a date with daily bars for none of
 * them was not a trading day (holiday), whatever the rankings table says.
 */
const BELLWETHERS = ['7203', '8306', '9984', '6758', '9432', '8058']

/**
 * Keep only real trading days. The rankings importer has stored holiday rows
 * (e.g. 2026-11-03 文化の日 duplicating 11-02); ohlcv_daily is the trading-day
 * truth. Dates newer than the latest daily bar cannot be judged yet and are kept.
 */
export async function filterTradingDates(cfg: KabuDbConfig, dates: readonly string[], fetchImpl?: FetchLike): Promise<string[]> {
  if (dates.length === 0) return []
  const sorted = [...dates].sort()
  const [rows, [latestBar]] = await Promise.all([
    kabuDbGet<{ ts: string }>(
      cfg,
      `ohlcv_daily?select=ts&stock_code=in.(${BELLWETHERS.join(',')})&ts=gte.${sorted[0]}&ts=lte.${sorted.at(-1)}T23:59:59%2B09:00&limit=${dates.length * BELLWETHERS.length + 10}`,
      fetchImpl,
    ),
    kabuDbGet<{ ts: string }>(cfg, 'ohlcv_daily?select=ts&order=ts.desc&limit=1', fetchImpl),
  ])
  const traded = new Set(rows.map((r) => r.ts.slice(0, 10)))
  const lastKnown = latestBar?.ts.slice(0, 10) ?? ''
  return dates.filter((d) => traded.has(d) || d > lastKnown)
}

/** Candidate trade dates stored for a type (newest first), before the trading-day filter. */
async function storedRankingDates(cfg: KabuDbConfig, type: string, maxDates: number, onOrBefore: string | undefined, fetchImpl?: FetchLike): Promise<string[]> {
  // rank_no ≤ 5 keeps the scan small while tolerating rankings with gaps at the top.
  const rows = await kabuDbGet<{ trade_date: string }>(
    cfg,
    `rankings?select=trade_date&ranking_type=eq.${type}&rank_no=lte.5${onOrBefore ? `&trade_date=lte.${onOrBefore}` : ''}&order=trade_date.desc&limit=${Math.min(maxDates * 5 + 20, 2000)}`,
    fetchImpl,
  )
  return [...new Set(rows.map((r) => r.trade_date))].slice(0, maxDates)
}

/** Stored trading days for a ranking type, newest first (holiday rows excluded). */
export async function fetchJpRankingDates(cfg: KabuDbConfig, type: string, limit: number, fetchImpl?: FetchLike): Promise<string[]> {
  if (!TYPE_PATTERN.test(type)) throw new Error(`invalid ranking type: ${type}`)
  // Over-fetch so dropped holidays do not shorten the list.
  const candidates = await storedRankingDates(cfg, type, limit + Math.ceil(limit / 2) + 5, undefined, fetchImpl)
  return (await filterTradingDates(cfg, candidates, fetchImpl)).slice(0, limit)
}

export async function fetchJpMovers(cfg: KabuDbConfig, type: string, types: JpRankingType[], fetchImpl?: FetchLike, now = new Date(), date?: string): Promise<JpMoversBoard> {
  if (!TYPE_PATTERN.test(type)) throw new Error(`invalid ranking type: ${type}`)
  if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD')
  const meta = types.find((t) => t.type === type)
  if (!meta) throw new Error(`unknown ranking type: ${type}`)
  // The latest (or requested) day, else the nearest stored trading day before it.
  const [tradeDate] = await filterTradingDates(cfg, await storedRankingDates(cfg, type, 10, date, fetchImpl), fetchImpl)
  if (!tradeDate) throw new Error(`no stored rankings for ${type} on a trading day${date ? ` on or before ${date}` : ''}`)
  const latest = { trade_date: tradeDate }
  const rows = await kabuDbGet<RankingRow>(
    cfg,
    `rankings?ranking_type=eq.${type}&trade_date=eq.${encodeURIComponent(latest.trade_date)}&order=rank_no&limit=200`,
    fetchImpl,
  )
  return {
    date: latest.trade_date,
    type: meta,
    types,
    rows: rows.map(toMoverRow),
    meta: { provider: 'kabu-db', asOf: now.toISOString(), origin: 'local' },
  }
}
