/**
 * One-call fundamentals for a Japanese stock, combining:
 *  - EDINET DB (current): company identity, the latest 決算短信 with the
 *    company's effective forecasts, and yearly ratios since 2012.
 *  - J-Quants Free (≈12 weeks delayed, 2 years): stock master and the official
 *    daily valuation series up to its last date.
 *  - The user's kabu gateway: daily closes up to the latest session.
 * Current valuation, and the valuation range after the J-Quants cut-off (or
 * where it has gaps), are computed from kabu closes and each 決算短信's forecast
 * EPS / BPS, so the range reaches the last session. Each source fails
 * independently.
 */

import type { DiskCache, EdinetDbClient, JQuantsClient } from './api-clients.js'
import { normalizeKabuCode } from './kabu-bars.js'

const DAY = 86_400_000
export const FUNDAMENTALS_TTL = {
  company: 7 * DAY,
  earnings: 6 * 3_600_000,
  ratios: 3 * DAY,
  financials: 3 * DAY,
  master: 7 * DAY,
  valuation: DAY,
} as const
/** 決算短信 fetched per stock (≈3 years of quarters) and sessions in the valuation range (≈2 years). */
const DISCLOSURES = 12
const HISTORY_SESSIONS = 490

export interface JpFundamentalsDeps {
  edinet: EdinetDbClient | null
  jquants: JQuantsClient | null
  cache: DiskCache
  latestPrice: (code: string) => Promise<{ date: string; close: number } | null>
  /** Ascending daily bars (split-adjusted close plus the raw close) for the valuation range. */
  dailyBars?: (code: string, count: number) => Promise<readonly DailyClose[]>
  now?: () => Date
}

interface EdCompany { edinet_code: string; name?: string; name_en?: string; industry?: string; accounting_standard?: string; sec_code?: string }
type Num = number | null | undefined
interface EdEarnings {
  title?: string; disclosure_date?: string; fiscal_year_end?: string; quarter?: number; is_consolidated?: boolean; accounting_standard?: string
  revenue?: Num; revenue_change?: Num; operating_income?: Num; operating_income_change?: Num; net_income?: Num; net_income_change?: Num
  eps?: Num; bps?: Num; owners_equity?: Num; equity_ratio?: Num; shares_outstanding_excluding_treasury?: Num
  effective_forecast_revenue?: Num; effective_forecast_operating_income?: Num; effective_forecast_net_income?: Num
  effective_forecast_eps?: Num; effective_forecast_dividend_per_share?: Num; effective_forecast_eps_as_of_date?: string
  forecast_period_note?: string
}
interface EdRatios {
  fiscal_year: number; adjusted_eps?: Num; adjusted_bps?: Num; adjusted_dividend_per_share?: Num
  roe?: Num; roa?: Num; operating_margin?: Num; net_margin?: Num; payout_ratio?: Num; equity_ratio?: Num
  revenue_growth?: Num; eps_growth?: Num; per?: Num; pbr?: Num; dividend_yield?: Num; consecutive_dividend_increase_years?: Num
}
interface JqMaster { CoName?: string; CoNameEn?: string; S33Nm?: string; S17Nm?: string; MktNm?: string; ScaleCat?: string; MrgnNm?: string }
interface JqValuation { Date: string; PER?: Num; FwdPER?: Num; PBR?: Num }

export interface DailyClose { date: string; close: number; rawClose: number }
/**
 * `from`..`lastDate` is the span the series actually covers; `percentile` is the
 * share of points below `last` (0 = cheapest in that span, 100 = richest).
 */
export interface RangeStats { min: number; median: number; max: number; last: number; from: string; lastDate: string; points: number; percentile: number }
export interface ValuationHistory {
  source: 'jquants+kabu' | 'kabu+edinetdb' | 'jquants'
  note: string
  /** Trailing PER: J-Quants only, so its lastDate shows the delay. */
  per: RangeStats | null
  forwardPer: RangeStats | null
  pbr: RangeStats | null
}
type Point = { date: string; v: number | null }

export interface JpStockFundamentals {
  code: string
  asOf: string
  company: { name: string | null; nameEn: string | null; edinetCode: string | null; industry: string | null; sector33: string | null; market: string | null; scale: string | null; margin: string | null; accountingStandard: string | null }
  price: { date: string; close: number; source: 'kabu' } | null
  latestEarnings: {
    title: string | null; disclosureDate: string | null; fiscalYearEnd: string | null; quarter: number | null; consolidated: boolean | null
    /** Revenue / profit figures are in million yen; per-share figures in yen; changes in %. */
    units: 'million JPY'
    revenue: Num; revenueChangePct: Num; operatingIncome: Num; operatingIncomeChangePct: Num; netIncome: Num; netIncomeChangePct: Num; eps: Num
    forecast: { revenue: Num; operatingIncome: Num; netIncome: Num; eps: Num; dividendPerShare: Num; asOf: string | null }
    /** Year-to-date actual ÷ full-year forecast (progress, not a beat/miss). */
    progressPct: { revenue: number | null; operatingIncome: number | null; netIncome: number | null }
    note: string | null
  } | null
  valuationNow: { forwardPer: number | null; pbr: number | null; dividendYieldPct: number | null; marketCapJpy: number | null; bps: number | null; basis: string } | null
  valuationHistory: ValuationHistory | null
  annual: Array<{ fiscalYear: number; eps: Num; bps: Num; dividendPerShare: Num; roePct: number | null; roaPct: number | null; operatingMarginPct: number | null; payoutRatioPct: number | null; revenueGrowthPct: number | null; epsGrowthPct: number | null; per: Num; pbr: Num; dividendYieldPct: number | null }>
  warnings: string[]
}

const pct = (v: Num) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10_000) / 100)
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const ratio = (a: Num, b: Num) => (a == null || b == null || !(b > 0) || !Number.isFinite(a) ? null : a / b)
const isoDate = (s: string | undefined) => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? s : new Date(t).toISOString().slice(0, 10)
}

/** Range summary of a dated series (ascending); non-positive values are skipped. */
export function seriesStats(points: ReadonlyArray<{ date: string; v: Num }>): RangeStats | null {
  const series = points.filter((p): p is { date: string; v: number } => typeof p.v === 'number' && Number.isFinite(p.v) && p.v > 0)
  if (series.length === 0) return null
  const sorted = series.map((s) => s.v).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const last = series.at(-1)!
  const below = sorted.filter((v) => v < last.v).length
  return {
    min: round(sorted[0]), median: round(median), max: round(sorted.at(-1)!), last: round(last.v), from: series[0].date, lastDate: last.date, points: series.length,
    percentile: Math.round((below / Math.max(1, series.length - 1)) * 100),
  }
}

export function rangeStats(rows: readonly JqValuation[], field: 'PER' | 'FwdPER' | 'PBR'): RangeStats | null {
  return seriesStats(rows.map((r) => ({ date: r.Date, v: r[field] })))
}

/** A forecast / BPS older than this (≈ one missed quarter) is not carried forward. */
export const MAX_CARRY_DAYS = 120
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000

/**
 * Daily forward PER and PBR from closes and the 決算短信 history: each session
 * uses the forecast EPS and BPS of the latest disclosure dated before it
 * (disclosures land after the close). Prices and per-share figures are put on
 * the same split basis through the bar's `close / rawClose` factor. A missing
 * figure keeps the previous one for up to MAX_CARRY_DAYS; a loss forecast
 * leaves PER empty.
 */
export function computeValuationSeries(bars: readonly DailyClose[], disclosures: readonly EdEarnings[]): { forwardPer: Point[]; pbr: Point[] } {
  const per: Point[] = []
  const pbr: Point[] = []
  if (!bars.length) return { forwardPer: per, pbr }
  const factorOn = (date: string) => {
    let hit = bars[0]
    for (const b of bars) { if (b.date <= date) hit = b; else break }
    return hit.rawClose > 0 ? hit.close / hit.rawClose : 1
  }
  const events = disclosures
    .flatMap((e) => { const date = isoDate(e.disclosure_date); return date ? [{ date, e }] : [] })
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, e }) => {
      const f = factorOn(date)
      const rawBps = e.bps ?? bookValuePerShare(e)
      const fcEps = e.effective_forecast_eps
      return {
        date,
        eps: fcEps == null ? undefined : fcEps > 0 ? fcEps * f : null,
        bps: rawBps != null && rawBps > 0 ? rawBps * f : undefined,
      }
    })
  let i = 0
  let eps: { v: number | null; date: string } | undefined
  let bps: { v: number; date: string } | undefined
  const fresh = <T extends { date: string }>(x: T | undefined, day: string) => (x && daysBetween(x.date, day) <= MAX_CARRY_DAYS ? x : undefined)
  for (const bar of bars) {
    while (i < events.length && events[i].date < bar.date) {
      const ev = events[i]
      if (ev.eps !== undefined) eps = { v: ev.eps, date: ev.date }
      if (ev.bps !== undefined) bps = { v: ev.bps, date: ev.date }
      i++
    }
    if (i === 0) continue
    const e = fresh(eps, bar.date)?.v
    const b = fresh(bps, bar.date)?.v
    per.push({ date: bar.date, v: e ? bar.close / e : null })
    pbr.push({ date: bar.date, v: b ? bar.close / b : null })
  }
  return { forwardPer: per, pbr }
}

/**
 * One series per metric: J-Quants (complete, official, but ≈12 weeks late)
 * up to its last date, the computed kabu series after it and wherever
 * J-Quants has no value.
 */
export function mergeValuationSeries(official: readonly Point[], computed: readonly Point[]): Point[] {
  const ok = (p: Point) => typeof p.v === 'number' && Number.isFinite(p.v) && p.v > 0
  const byDate = new Map<string, Point>()
  for (const p of computed) if (ok(p)) byDate.set(p.date, p)
  for (const p of official) if (ok(p)) byDate.set(p.date, p)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function bookValuePerShare(e: EdEarnings): number | null {
  const shares = e.shares_outstanding_excluding_treasury
  return e.owners_equity != null && shares != null && shares > 0 ? (e.owners_equity * 1e6) / shares : null
}

/** Current valuation from a fresh price and the latest 決算短信 (company forecast basis). */
export function computeValuation(price: number, e: EdEarnings) {
  const shares = e.shares_outstanding_excluding_treasury
  const bps = e.owners_equity != null && shares != null && shares > 0 ? (e.owners_equity * 1e6) / shares : null
  const fwdPer = ratio(price, e.effective_forecast_eps)
  const pbr = ratio(price, bps)
  const yieldRatio = e.effective_forecast_dividend_per_share != null && price > 0 ? e.effective_forecast_dividend_per_share / price : null
  return {
    forwardPer: fwdPer == null ? null : round(fwdPer),
    pbr: pbr == null ? null : round(pbr),
    dividendYieldPct: yieldRatio == null ? null : round(yieldRatio * 100),
    marketCapJpy: shares != null && shares > 0 ? Math.round(price * shares) : null,
    bps: bps == null ? null : round(bps),
    basis: 'price ÷ company forecast EPS; price ÷ (owners equity ÷ shares excl. treasury); forecast DPS ÷ price; price × shares excl. treasury',
  }
}

export async function fetchJpStockFundamentals(symbol: string, deps: JpFundamentalsDeps): Promise<JpStockFundamentals> {
  const code = normalizeKabuCode(symbol)
  const now = deps.now?.() ?? new Date()
  const warnings: string[] = []
  const settle = async <T>(label: string, run: (() => Promise<T>) | null, missing: string): Promise<T | null> => {
    if (!run) { warnings.push(missing); return null }
    try { return await run() } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  const { edinet, jquants, cache } = deps
  const noEdinet = 'EDINET DB key not configured: no current earnings, forecasts or yearly ratios (Settings → Market Data).'
  const noJquants = 'J-Quants key not configured: no stock master or valuation history (Settings → Market Data).'

  const [company, master, valuation, price, bars] = await Promise.all([
    settle('EDINET DB company', edinet && (async () => {
      const rows = await cache.get(`edinetdb:companies:${code}`, FUNDAMENTALS_TTL.company,
        () => edinet.get<EdCompany[]>('/companies', { sec_code: code }))
      const hit = (Array.isArray(rows) ? rows : []).find((c) => c.edinet_code)
      if (!hit) throw new Error(`no EDINET company for ${code}`)
      return hit
    }), noEdinet),
    settle('J-Quants master', jquants && (async () => {
      const rows = await cache.get(`jquants:master:${code}`, FUNDAMENTALS_TTL.master, () => jquants.get<JqMaster>('/equities/master', { code }))
      return rows.at(-1) ?? null
    }), noJquants),
    settle('J-Quants valuation', jquants && (() => cache.get(`jquants:valuation:${code}`, FUNDAMENTALS_TTL.valuation,
      () => jquants.get<JqValuation>('/equities/valuation', { code }))), noJquants),
    settle('kabu price', () => deps.latestPrice(code), ''),
    settle('kabu bars', deps.dailyBars ? () => deps.dailyBars!(code, HISTORY_SESSIONS) : null, ''),
  ])

  const edinetCode = company?.edinet_code ?? null
  const [disclosures, ratios] = edinetCode && edinet
    ? await Promise.all([
      settle('EDINET DB earnings', async () => {
        const body = await cache.get(`edinetdb:earnings:${edinetCode}:${DISCLOSURES}`, FUNDAMENTALS_TTL.earnings,
          () => edinet.get<{ earnings?: EdEarnings[] }>(`/companies/${edinetCode}/earnings`, { limit: String(DISCLOSURES) }))
        return body?.earnings ?? []
      }, noEdinet),
      settle('EDINET DB ratios', () => cache.get(`edinetdb:ratios:${edinetCode}`, FUNDAMENTALS_TTL.ratios,
        () => edinet.get<EdRatios[]>(`/companies/${edinetCode}/ratios`)), noEdinet),
    ])
    : [null, null]

  if (!price) warnings.push('No current kabu price (configure the kabu gateway): current valuation is not computed.')

  const fc = disclosures?.[0] ?? null
  const computed = bars?.length && disclosures?.length ? computeValuationSeries(bars, disclosures) : { forwardPer: [], pbr: [] }
  const jq = (valuation ?? []).map((r) => ({ date: r.Date, fwd: r.FwdPER, pbr: r.PBR }))
  const forwardPer = seriesStats(mergeValuationSeries(jq.map((r) => ({ date: r.date, v: r.fwd ?? null })), computed.forwardPer))
  const pbr = seriesStats(mergeValuationSeries(jq.map((r) => ({ date: r.date, v: r.pbr ?? null })), computed.pbr))
  const hasComputed = computed.forwardPer.some((p) => p.v) || computed.pbr.some((p) => p.v)
  const valuationHistory: ValuationHistory | null = forwardPer || pbr ? {
    source: jq.length && hasComputed ? 'jquants+kabu' : hasComputed ? 'kabu+edinetdb' : 'jquants',
    note: [
      jq.length ? `J-Quants daily values through ${jq.at(-1)!.date}` : null,
      hasComputed ? 'kabu close ÷ the forecast EPS / BPS of the latest 決算短信 for later sessions and J-Quants gaps' : null,
    ].filter(Boolean).join('; ') + '. Forward PER is on the company-forecast basis. Check each range\'s from..lastDate for its coverage.',
    per: rangeStats(valuation ?? [], 'PER'),
    forwardPer,
    pbr,
  } : null
  if (valuationHistory?.source === 'jquants') warnings.push('Valuation history comes from J-Quants Free only and ends about 12 weeks ago; do not quote it as the current level.')
  return {
    code,
    asOf: now.toISOString(),
    company: {
      name: company?.name ?? master?.CoName ?? null,
      nameEn: company?.name_en ?? master?.CoNameEn ?? null,
      edinetCode,
      industry: company?.industry ?? null,
      sector33: master?.S33Nm ?? null,
      market: master?.MktNm ?? null,
      scale: master?.ScaleCat ?? null,
      margin: master?.MrgnNm ?? null,
      accountingStandard: company?.accounting_standard ?? fc?.accounting_standard ?? null,
    },
    price: price ? { ...price, source: 'kabu' } : null,
    latestEarnings: fc ? {
      title: fc.title ?? null,
      disclosureDate: isoDate(fc.disclosure_date),
      fiscalYearEnd: fc.fiscal_year_end ?? null,
      quarter: fc.quarter ?? null,
      consolidated: fc.is_consolidated ?? null,
      units: 'million JPY',
      revenue: fc.revenue, revenueChangePct: fc.revenue_change,
      operatingIncome: fc.operating_income, operatingIncomeChangePct: fc.operating_income_change,
      netIncome: fc.net_income, netIncomeChangePct: fc.net_income_change,
      eps: fc.eps,
      forecast: {
        revenue: fc.effective_forecast_revenue, operatingIncome: fc.effective_forecast_operating_income,
        netIncome: fc.effective_forecast_net_income, eps: fc.effective_forecast_eps,
        dividendPerShare: fc.effective_forecast_dividend_per_share, asOf: fc.effective_forecast_eps_as_of_date ?? null,
      },
      progressPct: {
        revenue: pct(ratio(fc.revenue, fc.effective_forecast_revenue)),
        operatingIncome: pct(ratio(fc.operating_income, fc.effective_forecast_operating_income)),
        netIncome: pct(ratio(fc.net_income, fc.effective_forecast_net_income)),
      },
      note: fc.forecast_period_note ?? null,
    } : null,
    valuationNow: price && fc ? computeValuation(price.close, fc) : null,
    valuationHistory,
    annual: (ratios ?? []).slice(-5).map((r) => ({
      fiscalYear: r.fiscal_year,
      eps: r.adjusted_eps, bps: r.adjusted_bps, dividendPerShare: r.adjusted_dividend_per_share,
      roePct: pct(r.roe), roaPct: pct(r.roa), operatingMarginPct: pct(r.operating_margin), payoutRatioPct: pct(r.payout_ratio),
      revenueGrowthPct: pct(r.revenue_growth), epsGrowthPct: pct(r.eps_growth),
      per: r.per == null ? r.per : round(r.per), pbr: r.pbr == null ? r.pbr : round(r.pbr), dividendYieldPct: pct(r.dividend_yield),
    })),
    warnings: warnings.filter(Boolean),
  }
}

/** Yearly financial statements from EDINET DB (large payload; years capped). */
export async function fetchJpStockFinancials(symbol: string, years: number, deps: Pick<JpFundamentalsDeps, 'edinet' | 'cache'>): Promise<unknown> {
  const code = normalizeKabuCode(symbol)
  const { edinet, cache } = deps
  if (!edinet) throw new Error('EDINET DB key not configured (Settings → Market Data).')
  const rows = await cache.get(`edinetdb:companies:${code}`, FUNDAMENTALS_TTL.company, () => edinet.get<EdCompany[]>('/companies', { sec_code: code }))
  const edinetCode = (Array.isArray(rows) ? rows : []).find((c) => c.edinet_code)?.edinet_code
  if (!edinetCode) throw new Error(`no EDINET company for ${code}`)
  const n = Math.max(1, Math.min(10, Math.floor(years)))
  return cache.get(`edinetdb:financials:${edinetCode}:${n}`, FUNDAMENTALS_TTL.financials,
    () => edinet.get(`/companies/${edinetCode}/financials`, { years: String(n) }))
}
