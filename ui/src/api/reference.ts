/**
 * Reference-data API — `/api/reference/*`.
 *
 * OpenAlice's own low-frequency data contract (boards: movers, macro,
 * calendar, …). New market surfaces consume THIS namespace — never the
 * legacy OpenBB-compatible `/api/market-data-v1` passthrough.
 */

import { fetchJson } from './client'

/** Envelope on every reference payload — provider is an explicit label,
 *  shown in the UI (same disambiguation philosophy as bar sources). */
export interface ReferenceMeta {
  provider: string
  asOf: string
  cachedAt?: string
  /** Which path served: the hosted hub or a local build with your keys. */
  origin?: 'hub' | 'local'
  /** Upstream refresh failed; this is the last good payload. */
  stale?: boolean
}

/** One row of a movers list (gainers / losers / active). */
export interface MoverRow {
  symbol: string
  name: string | null
  price: number | null
  change: number | null
  percent_change: number | null
  volume: number | null
  avg_volume: number | null
  /** Today's volume / 3-month average — the "unusual for itself?" read. */
  relative_volume: number | null
  turnover: number | null
  /** Price × volume — the cross-ticker-comparable "where is the money" read. */
  dollar_volume: number | null
}

export interface MoversBoard {
  gainers: MoverRow[]
  losers: MoverRow[]
  active: MoverRow[]
  /** Yahoo screeners — value/growth/size lenses, same row shape. */
  undervaluedGrowth: MoverRow[]
  growthTech: MoverRow[]
  smallCaps: MoverRow[]
  undervaluedLarge: MoverRow[]
  meta: ReferenceMeta
}

/** One earnings-calendar row (FMP). */
export interface EarningsEvent {
  report_date: string
  symbol: string
  name: string | null
  eps_previous: number | null
  eps_consensus: number | null
}

export interface IpoEvent {
  symbol: string | null
  ipo_date: string | null
  [k: string]: unknown
}

export interface DividendEvent {
  ex_dividend_date: string
  symbol: string
  amount: number | null
  name: string | null
  record_date: string | null
  payment_date: string | null
}

export interface CalendarBoard {
  earnings: EarningsEvent[]
  ipos: IpoEvent[]
  dividends: DividendEvent[]
  window: { start: string; end: string }
  /** Per-list upstream failures (e.g. FMP tier rejects one endpoint). */
  errors?: Partial<Record<'earnings' | 'ipos' | 'dividends', string>>
  meta: ReferenceMeta
}

export type MacroUnit = 'percent' | 'usd' | 'index' | 'count'

export interface MacroPoint {
  date: string
  value: number
}

export interface MacroSeriesCard {
  id: string
  label: string
  unit: MacroUnit
  points: MacroPoint[]
  latest: number | null
  latestDate: string | null
  change: number | null
}

export interface MacroBoard {
  cards: MacroSeriesCard[]
  meta: ReferenceMeta
}

export interface TermPoint {
  expiration: string
  price: number | null
  daysToExpiry: number | null
  /** Annualized basis vs the perpetual, percent. */
  annualizedBasis: number | null
}

export interface TermCurve {
  symbol: string
  spot: number | null
  points: TermPoint[]
}

export interface TermStructureBoard {
  curves: TermCurve[]
  errors?: Record<string, string>
  meta: ReferenceMeta
}

export interface ValuationStrip {
  cards: MacroSeriesCard[]
  meta: ReferenceMeta
}

export interface GlobalMacroCell {
  value: number | null
  date: string | null
  error?: string
}

export interface GlobalMacroRow {
  country: string
  label: string
  cpiYoy: GlobalMacroCell
  shortRate: GlobalMacroCell
  cli: GlobalMacroCell
  /** Real house price index, 2015 = 100. */
  housePrice: GlobalMacroCell
  /** Share price index, 2015 = 100. */
  sharePrice: GlobalMacroCell
}

export interface GlobalMacroBoard {
  rows: GlobalMacroRow[]
  meta: ReferenceMeta
}

export interface ShippingPoint {
  date: string
  tons: number | null
  vessels: number | null
}

export interface ShippingCurve {
  key: string
  name: string
  points: ShippingPoint[]
  latest: ShippingPoint | null
}

export interface ShippingBoard {
  curves: ShippingCurve[]
  errors?: Record<string, string>
  meta: ReferenceMeta
}

export interface FedDocument {
  date: string
  title: string
  type: string
  url: string
}

export interface FedBoard {
  cards: MacroSeriesCard[]
  documents: FedDocument[]
  errors?: Partial<Record<'balanceSheet' | 'dealers' | 'documents', string>>
  meta: ReferenceMeta
}

export interface JpSectorMove {
  name: string
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
  meta: ReferenceMeta
}

export type JpBreadthResult =
  | { ok: true; board: JpBreadthBoard }
  | { ok: false; notConfigured: boolean; error: string }

/** Distinguishes "not configured yet" (409) from a real failure, without throwing. */
async function fetchJpBreadth(): Promise<JpBreadthResult> {
  const res = await fetch('/api/reference/jp-breadth')
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
    throw new Error('Unauthorized')
  }
  const body = await res.json().catch(() => ({})) as { code?: string; error?: string }
  if (res.ok) return { ok: true, board: body as unknown as JpBreadthBoard }
  return { ok: false, notConfigured: body.code === 'not_configured', error: body.error ?? res.statusText }
}

export interface JpRankingType {
  type: string
  title: string
  subject: string
}

export interface JpMoverRow {
  rank: number
  code: string | null
  name: string
  exchange: string | null
  category: string | null
  price: number | null
  change: number | null
  changePct: number | null
  /** Thousand shares. */
  volume: number | null
  /** Million yen. */
  turnover: number | null
  asOfTime: string | null
  marginRatio: number | null
}

export interface JpMoversBoard {
  date: string
  type: JpRankingType
  types: JpRankingType[]
  rows: JpMoverRow[]
  meta: ReferenceMeta
}

export type JpMoversResult =
  | { ok: true; board: JpMoversBoard }
  | { ok: false; notConfigured: boolean; error: string }

async function fetchJpMovers(type: string): Promise<JpMoversResult> {
  const res = await fetch(`/api/reference/jp-movers?type=${encodeURIComponent(type)}`)
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
    throw new Error('Unauthorized')
  }
  const body = await res.json().catch(() => ({})) as { code?: string; error?: string }
  if (res.ok) return { ok: true, board: body as unknown as JpMoversBoard }
  return { ok: false, notConfigured: body.code === 'not_configured', error: body.error ?? res.statusText }
}

export const referenceApi = {
  jpBreadth: fetchJpBreadth,
  jpMovers: fetchJpMovers,
  movers: () => fetchJson<MoversBoard>('/api/reference/movers'),
  calendar: () => fetchJson<CalendarBoard>('/api/reference/calendar'),
  macro: () => fetchJson<MacroBoard>('/api/reference/macro'),
  termStructure: () => fetchJson<TermStructureBoard>('/api/reference/term-structure'),
  valuation: () => fetchJson<ValuationStrip>('/api/reference/valuation'),
  globalMacro: () => fetchJson<GlobalMacroBoard>('/api/reference/global-macro'),
  shipping: () => fetchJson<ShippingBoard>('/api/reference/shipping'),
  fed: () => fetchJson<FedBoard>('/api/reference/fed'),
}
