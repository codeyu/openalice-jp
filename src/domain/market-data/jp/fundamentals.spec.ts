import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createDiskCache, createEdinetDbClient, createJQuantsClient, createRateLimiter, type DiskCache, type EdinetDbClient, type JQuantsClient } from './api-clients.js'
import { computeValuation, computeValuationSeries, fetchJpStockFundamentals, mergeValuationSeries, rangeStats, seriesStats } from './fundamentals.js'
import { resolveJpApiKeys } from './service.js'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const memoryCache: DiskCache = { get: (_k, _t, load) => load() }

// Toyota 2Q (2026-11-05 決算短信) as returned by EDINET DB; million yen / yen.
const toyotaEarnings = {
  title: '2027年3月期 第2四半期決算短信', disclosure_date: 'Thu, 05 Nov 2026 00:00:00 GMT', fiscal_year_end: '2027-03-31', quarter: 2, is_consolidated: true,
  revenue: 26962462, revenue_change: 9.5, operating_income: 2191124, operating_income_change: 9.2, net_income: 2236446, net_income_change: 26.1, eps: 185.97,
  owners_equity: 37447031, shares_outstanding_excluding_treasury: 11778247313,
  effective_forecast_revenue: 53500000, effective_forecast_operating_income: 3900000, effective_forecast_net_income: 3570000,
  effective_forecast_eps: 299.95, effective_forecast_dividend_per_share: 100, effective_forecast_eps_as_of_date: '2026-11-05',
}

describe('computeValuation', () => {
  it('matches the published screen values for Toyota at ¥3,338 (PER 11, PBR 1.05, yield 3%)', () => {
    expect(computeValuation(3338, toyotaEarnings)).toMatchObject({
      forwardPer: 11.13, pbr: 1.05, dividendYieldPct: 3, bps: 3179.34, marketCapJpy: 39_315_789_530_794,
    })
  })

  it('leaves a figure empty instead of inventing it', () => {
    expect(computeValuation(100, { effective_forecast_eps: -5 })).toMatchObject({ forwardPer: null, pbr: null, dividendYieldPct: null, marketCapJpy: null })
  })
})

describe('rangeStats', () => {
  it('summarizes positive values only', () => {
    const rows = [{ Date: '2026-08-19', PER: 9 }, { Date: '2026-08-20', PER: -3 }, { Date: '2026-08-21', PER: 7 }, { Date: '2026-08-22', PER: 11 }, { Date: '2026-08-23' }]
    expect(rangeStats(rows, 'PER')).toEqual({ min: 7, median: 9, max: 11, last: 11, from: '2026-08-19', lastDate: '2026-08-22', points: 3, percentile: 100 })
    expect(rangeStats(rows, 'PBR')).toBeNull()
  })
})

describe('computeValuationSeries', () => {
  const disc = (date: string, eps: number | undefined, equity: number | undefined, shares: number) => ({
    disclosure_date: `${date}T00:00:00Z`, effective_forecast_eps: eps, owners_equity: equity, shares_outstanding_excluding_treasury: shares,
  })
  const vals = (ps: Array<{ v: number | null }>) => ps.map((p) => (p.v == null ? null : Math.round(p.v * 100) / 100))

  it('applies each 決算短信 from the next session and keeps a missing figure for a quarter', () => {
    const bars = [
      { date: '2026-05-07', close: 1000, rawClose: 1000 }, // before any disclosure: skipped
      { date: '2026-05-08', close: 1000, rawClose: 1000 }, // disclosure day: not yet applied
      { date: '2026-05-11', close: 1000, rawClose: 1000 },
      { date: '2026-08-06', close: 1500, rawClose: 1500 },
    ]
    const s = computeValuationSeries(bars, [disc('2026-08-05', undefined, 120, 1_000_000), disc('2026-05-08', 100, 100, 1_000_000)])
    expect(s.forwardPer.map((p) => p.date)).toEqual(['2026-05-11', '2026-08-06'])
    expect(vals(s.forwardPer)).toEqual([10, 15])
    expect(vals(s.pbr)).toEqual([10, 12.5])
  })

  it('stops carrying a stale forecast and prefers the published BPS', () => {
    const bars = [{ date: '2026-02-16', close: 1000, rawClose: 1000 }, { date: '2026-07-01', close: 1000, rawClose: 1000 }]
    const s = computeValuationSeries(bars, [{ ...disc('2026-02-13', 50, undefined, 1), bps: 400 }])
    expect(vals(s.forwardPer)).toEqual([20, null]) // > MAX_CARRY_DAYS after the disclosure
    expect(vals(s.pbr)).toEqual([2.5, null])
  })

  it('puts pre-split disclosures on the adjusted basis and blanks PER on a loss forecast', () => {
    // 2:1 split after 2026-06-01: earlier bars carry factor 0.5 (adjusted 500 vs raw 1000).
    const bars = [
      { date: '2026-05-11', close: 500, rawClose: 1000 },
      { date: '2026-06-02', close: 500, rawClose: 500 },
      { date: '2026-08-06', close: 500, rawClose: 500 },
    ]
    const s = computeValuationSeries(bars, [disc('2026-05-08', 100, 100, 1_000_000), disc('2026-08-05', -10, 200, 2_000_000)])
    expect(vals(s.forwardPer)).toEqual([10, 10, null])
    expect(vals(s.pbr)).toEqual([10, 10, 5])
  })
})

describe('mergeValuationSeries', () => {
  it('keeps J-Quants values and fills later sessions and gaps from the computed series', () => {
    const merged = mergeValuationSeries(
      [{ date: '2026-08-27', v: 20 }, { date: '2026-08-28', v: null }],
      [{ date: '2026-08-27', v: 99 }, { date: '2026-08-28', v: 21 }, { date: '2026-11-20', v: 15 }],
    )
    expect(merged).toEqual([{ date: '2026-08-27', v: 20 }, { date: '2026-08-28', v: 21 }, { date: '2026-11-20', v: 15 }])
    expect(seriesStats(merged)).toMatchObject({ from: '2026-08-27', lastDate: '2026-11-20', last: 15, percentile: 0 })
  })
})

describe('fetchJpStockFundamentals', () => {
  it('combines EDINET DB, J-Quants and the kabu price, with delay warnings', async () => {
    const edinet = { get: vi.fn(async (path: string) => {
      if (path === '/companies') return [{ edinet_code: 'E02144', name: 'トヨタ自動車株式会社', industry: '輸送用機器', accounting_standard: 'IFRS' }]
      if (path.endsWith('/earnings')) return { count: 1, earnings: [toyotaEarnings] }
      if (path.endsWith('/ratios')) return Array.from({ length: 7 }, (_, i) => ({ fiscal_year: 2020 + i, adjusted_eps: 100 + i, roe: 0.1, dividend_yield: 0.03, per: 10.456 }))
      throw new Error(path)
    }) }
    const jquants = { get: vi.fn(async (path: string) => path === '/equities/master'
      ? [{ CoName: 'トヨタ自動車', S33Nm: '輸送用機器', MktNm: 'プライム', ScaleCat: 'TOPIX Core30', MrgnNm: '貸借' }]
      : [{ Date: '2026-08-20', PER: 9, FwdPER: 11, PBR: 1 }, { Date: '2026-08-21', PER: 8.97, FwdPER: 11.41, PBR: 0.99 }]) }
    const result = await fetchJpStockFundamentals('7203.T', {
      edinet: edinet as unknown as EdinetDbClient, jquants: jquants as unknown as JQuantsClient, cache: memoryCache,
      latestPrice: async () => ({ date: '2026-11-06', close: 3338 }),
      now: () => new Date('2026-11-15T00:00:00Z'),
    })
    expect(result.company).toMatchObject({ name: 'トヨタ自動車株式会社', edinetCode: 'E02144', sector33: '輸送用機器', market: 'プライム', scale: 'TOPIX Core30' })
    expect(result.latestEarnings).toMatchObject({ disclosureDate: '2026-11-05', quarter: 2, forecast: { eps: 299.95, dividendPerShare: 100 }, progressPct: { revenue: 50.4, netIncome: 62.65 } })
    expect(result.valuationNow).toMatchObject({ forwardPer: 11.13, pbr: 1.05, dividendYieldPct: 3 })
    expect(result.valuationHistory?.pbr).toMatchObject({ min: 0.99, max: 1, last: 0.99, lastDate: '2026-08-21' })
    expect(result.annual).toHaveLength(5)
    expect(result.annual[0]).toMatchObject({ fiscalYear: 2022, roePct: 10, dividendYieldPct: 3, per: 10.46 })
    expect(result.warnings.join(' ')).toMatch(/12 weeks/)
    expect(edinet.get).toHaveBeenCalledWith('/companies', { sec_code: '7203' })
  })

  it('extends the J-Quants range to the last kabu session', async () => {
    const edinet = { get: vi.fn(async (path: string, params?: Record<string, string>) => {
      if (path === '/companies') return [{ edinet_code: 'E02144' }]
      if (path.endsWith('/earnings')) { expect(params).toEqual({ limit: '12' }); return { earnings: [toyotaEarnings] } }
      return []
    }) }
    const jquants = { get: vi.fn(async (path: string) => path === '/equities/valuation' ? [{ Date: '2026-08-28', PER: 9, FwdPER: 12, PBR: 1 }] : []) }
    const result = await fetchJpStockFundamentals('7203', {
      edinet: edinet as unknown as EdinetDbClient, jquants: jquants as unknown as JQuantsClient, cache: memoryCache,
      latestPrice: async () => ({ date: '2026-11-20', close: 3338 }),
      dailyBars: async () => [{ date: '2026-11-06', close: 3100, rawClose: 3100 }, { date: '2026-11-20', close: 3338, rawClose: 3338 }],
    })
    expect(result.valuationHistory).toMatchObject({
      source: 'jquants+kabu',
      forwardPer: { from: '2026-08-28', lastDate: '2026-11-20', last: 11.13, points: 3 },
      per: { lastDate: '2026-08-28' },
    })
    expect(result.warnings.join(' ')).not.toMatch(/12 weeks/)
  })

  it('degrades per source and explains what is missing', async () => {
    const result = await fetchJpStockFundamentals('7203', { edinet: null, jquants: null, cache: memoryCache, latestPrice: async () => null })
    expect(result.latestEarnings).toBeNull()
    expect(result.valuationNow).toBeNull()
    expect(result.warnings.join('\n')).toMatch(/EDINET DB key not configured[\s\S]*J-Quants key not configured[\s\S]*No current kabu price/)
  })
})

describe('API clients', () => {
  it('J-Quants: sends x-api-key, follows pagination, explains 429', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => new URL(url).searchParams.get('pagination_key')
      ? json({ data: [{ n: 2 }] })
      : json({ data: [{ n: 1 }], pagination_key: 'next' }))
    const limiter = { acquire: async () => undefined }
    const rows = await createJQuantsClient('jq-key', fetchImpl, limiter).get('/equities/valuation', { code: '7203' })
    expect(rows).toEqual([{ n: 1 }, { n: 2 }])
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)['x-api-key']).toBe('jq-key')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.jquants.com/v2/equities/valuation?code=7203')
    await expect(createJQuantsClient('k', async () => json({}, 429), limiter).get('/x', {})).rejects.toThrow('5 requests/minute')
  })

  it('EDINET DB: unwraps data, reports quota with Retry-After, never echoes the key', async () => {
    const ok = await createEdinetDbClient('ed-key', async () => json({ data: [{ edinet_code: 'E1' }] })).get('/companies', { sec_code: '7203' })
    expect(ok).toEqual([{ edinet_code: 'E1' }])
    const err = await createEdinetDbClient('ed-key', async () => json({}, 429, { 'Retry-After': '3600' })).get('/x').then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/100 requests\/day.*3600s/)
    expect(err?.message).not.toContain('ed-key')
  })

  it('disk cache: serves fresh hits, reloads stale ones, never stores failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jp-cache-'))
    let t = 0
    const cache = createDiskCache(dir, () => t)
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 })
    await expect(cache.get('k', 1000, load)).rejects.toThrow('down')
    expect(await readdir(dir).catch(() => [])).toEqual([])
    expect(await cache.get('k', 1000, load)).toEqual({ v: 1 })
    t = 500
    expect(await cache.get('k', 1000, load)).toEqual({ v: 1 })
    t = 2000
    expect(await cache.get('k', 1000, load)).toEqual({ v: 2 })
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('rate limiter: the sixth call within a minute waits for the window', async () => {
    let t = 0
    const sleeps: number[] = []
    const limiter = createRateLimiter(5, 60_000, async (ms) => { sleeps.push(ms); t += ms }, () => t)
    for (let i = 0; i < 6; i++) await limiter.acquire()
    expect(sleeps).toEqual([60_050])
  })
})

describe('resolveJpApiKeys', () => {
  it('prefers Settings keys, falls back to the documented env vars', () => {
    expect(resolveJpApiKeys({ jquants: ' s ' }, { JPX_JQUANTS_API_KEY: 'e', EDINETDB_API_KEY: 'd' })).toEqual({ jquants: 's', edinetdb: 'd' })
    expect(resolveJpApiKeys({}, {})).toEqual({ jquants: undefined, edinetdb: undefined })
  })
})
