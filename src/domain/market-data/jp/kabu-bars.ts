/**
 * Daily / weekly K-lines from the kabu gateway database, split-adjusted.
 *
 * The tables keep raw OHLC plus `adjusted_close`. Each row's factor
 * `adjusted_close / close` is applied to open/high/low/close (and inversely to
 * volume) so a long history has no split cliffs, e.g. Toyota's 2021 5:1 split.
 */

import { kabuDbGet, type FetchLike, type KabuDbConfig } from './kabu-db.js'

export type KabuBarInterval = '1d' | '1w'

export interface KabuBarsOpts {
  interval: KabuBarInterval
  /** Most recent N bars (anchored to `end`). */
  count?: number
  /** Inclusive YYYY-MM-DD bounds. */
  start?: string
  end?: string
}

export interface KabuBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  /** Unadjusted close as stored, for reference. */
  rawClose: number
  /** Turnover in yen, unadjusted. */
  turnover: number | null
  [key: string]: unknown
}

interface Row {
  ts: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  turnover: number | null
  adjusted_close: number | null
}

const TABLE: Record<KabuBarInterval, string> = { '1d': 'ohlcv_daily', '1w': 'ohlcv_weekly' }
export const KABU_MAX_BARS = 5000
const CODE = /^[0-9][0-9A-Z]{3}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** "7203", "7203.T" or "130A" → "7203" / "130A". */
export function normalizeKabuCode(symbol: string): string {
  const code = symbol.trim().toUpperCase().replace(/\.T$/, '')
  if (!CODE.test(code)) throw new Error(`kabu bars need a 4-character TSE code such as 7203 or 130A (got "${symbol}")`)
  return code
}

export function adjustRow(r: Row): KabuBar | null {
  if (r.open == null || r.high == null || r.low == null || r.close == null || !(r.close > 0)) return null
  const factor = r.adjusted_close != null && r.adjusted_close > 0 ? r.adjusted_close / r.close : 1
  const round = (v: number) => Math.round(v * 10_000) / 10_000
  return {
    date: r.ts.slice(0, 10),
    open: round(r.open * factor),
    high: round(r.high * factor),
    low: round(r.low * factor),
    close: round(r.close * factor),
    volume: r.volume == null ? null : Math.round(r.volume / factor),
    rawClose: r.close,
    turnover: r.turnover,
  }
}

export async function fetchKabuBars(cfg: KabuDbConfig, symbol: string, opts: KabuBarsOpts, fetchImpl?: FetchLike): Promise<KabuBar[]> {
  const table = TABLE[opts.interval]
  if (!table) throw new Error(`kabu supplies 1d and 1w bars only (got ${opts.interval})`)
  for (const [k, v] of [['start', opts.start], ['end', opts.end]] as const) {
    if (v != null && !DAY.test(v)) throw new Error(`${k} must be YYYY-MM-DD`)
  }
  const code = normalizeKabuCode(symbol)
  const limit = Math.min(opts.count ?? KABU_MAX_BARS, KABU_MAX_BARS)
  const filters = [
    `stock_code=eq.${code}`,
    ...(opts.start ? [`ts=gte.${opts.start}`] : []),
    ...(opts.end ? [`ts=lte.${opts.end}T23:59:59%2B09:00`] : []),
  ]
  const rows = await kabuDbGet<Row>(
    cfg,
    `${table}?select=ts,open,high,low,close,volume,turnover,adjusted_close&${filters.join('&')}&order=ts.desc&limit=${limit}`,
    fetchImpl,
  )
  return rows.reverse().map(adjustRow).filter((b): b is KabuBar => b != null)
}
