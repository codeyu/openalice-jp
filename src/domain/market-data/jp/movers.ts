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

export function toMoverRow(r: RankingRow): JpMoverRow {
  const ratio = r.extras?.['Ratio']
  return {
    rank: r.rank_no,
    code: r.stock_code,
    name: r.stock_name ?? r.category_name ?? '',
    exchange: r.exchange_name,
    category: r.category_name,
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

export async function fetchJpMovers(cfg: KabuDbConfig, type: string, types: JpRankingType[], fetchImpl?: FetchLike, now = new Date()): Promise<JpMoversBoard> {
  if (!TYPE_PATTERN.test(type)) throw new Error(`invalid ranking type: ${type}`)
  const meta = types.find((t) => t.type === type)
  if (!meta) throw new Error(`unknown ranking type: ${type}`)
  const [latest] = await kabuDbGet<{ trade_date: string }>(cfg, `rankings?select=trade_date&ranking_type=eq.${type}&order=trade_date.desc&limit=1`, fetchImpl)
  if (!latest) throw new Error(`no stored rankings for ${type}`)
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
