/**
 * Daily / weekly K-lines from the kabu gateway database, adjusted for stock
 * splits and consolidations.
 *
 * The daily table keeps raw OHLC plus `adjusted_close`. Each day's factor
 * `adjusted_close / close` is applied to open/high/low/close (and inversely to
 * volume) so a long history has no cliffs — Toyota's 2021 5:1 split as well as
 * reverse splits such as 6731's 2026 10:1 consolidation. Weekly bars are built
 * from these adjusted days, never from the gateway's raw weekly table.
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

/** Only the daily table is read: weekly bars are aggregated from adjusted days. */
const TABLE = { '1d': 'ohlcv_daily' } as const
export const KABU_MAX_BARS = 5000
const PAGE = 1000
/** ~80 years of trading days — enough for any weekly history in the gateway. */
const MAX_DAILY_ROWS_FOR_WEEKLY = 20_000
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

/** Monday (YYYY-MM-DD) of the calendar week containing a trading date. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/**
 * Weekly bars from already-adjusted daily bars (ascending). The gateway's
 * ohlcv_weekly mixes pre- and post-split raw prices when a split falls
 * mid-week, so weeks are built here from per-day adjusted values instead.
 */
export function aggregateWeekly(daily: readonly KabuBar[]): KabuBar[] {
  const weeks: KabuBar[] = []
  for (const bar of daily) {
    const label = weekStart(bar.date)
    const week = weeks.at(-1)
    if (!week || week.date !== label) {
      weeks.push({ ...bar, date: label })
      continue
    }
    week.high = Math.max(week.high, bar.high)
    week.low = Math.min(week.low, bar.low)
    week.close = bar.close
    week.rawClose = bar.rawClose
    week.volume = week.volume == null || bar.volume == null ? null : week.volume + bar.volume
    week.turnover = week.turnover == null || bar.turnover == null ? null : week.turnover + bar.turnover
  }
  return weeks
}

/** Page newest-first through the daily table, stopping at `maxRows`. */
async function fetchDailyRows(cfg: KabuDbConfig, filters: string[], maxRows: number, fetchImpl?: FetchLike): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const limit = Math.min(PAGE, maxRows - offset)
    const batch = await kabuDbGet<Row>(
      cfg,
      `${TABLE['1d']}?select=ts,open,high,low,close,volume,turnover,adjusted_close&${filters.join('&')}&order=ts.desc&limit=${limit}&offset=${offset}`,
      fetchImpl,
    )
    rows.push(...batch)
    if (batch.length < limit) break
  }
  return rows
}

export async function fetchKabuBars(cfg: KabuDbConfig, symbol: string, opts: KabuBarsOpts, fetchImpl?: FetchLike): Promise<KabuBar[]> {
  if (opts.interval !== '1d' && opts.interval !== '1w') throw new Error(`kabu supplies 1d and 1w bars only (got ${opts.interval})`)
  for (const [k, v] of [['start', opts.start], ['end', opts.end]] as const) {
    if (v != null && !DAY.test(v)) throw new Error(`${k} must be YYYY-MM-DD`)
  }
  const code = normalizeKabuCode(symbol)
  const count = Math.min(opts.count ?? KABU_MAX_BARS, KABU_MAX_BARS)
  const filters = [
    `stock_code=eq.${code}`,
    ...(opts.start ? [`ts=gte.${opts.start}`] : []),
    ...(opts.end ? [`ts=lte.${opts.end}T23:59:59%2B09:00`] : []),
  ]
  // Weekly needs up to five trading days per week plus one spare week, whose
  // oldest (possibly cut) week is dropped below when the window is count-bound.
  const maxRows = opts.interval === '1d' ? count : Math.min((count + 1) * 5, MAX_DAILY_ROWS_FOR_WEEKLY)
  const rows = await fetchDailyRows(cfg, filters, maxRows, fetchImpl)
  const daily = rows.reverse().map(adjustRow).filter((b): b is KabuBar => b != null)
  if (opts.interval === '1d') return daily
  const weeks = aggregateWeekly(daily)
  const cut = rows.length >= maxRows && !opts.start
  return (cut ? weeks.slice(1) : weeks).slice(-count)
}
