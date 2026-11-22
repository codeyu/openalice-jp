/**
 * Japan market reads for agents — the same data the Japan market pages show,
 * served from the user's self-hosted kabu gateway database. Read-only.
 */

import { z } from 'zod'
import { tool } from 'ai'

import { jpMarketData as defaultJpMarketData, type JpMarketData } from '@/domain/market-data/jp/service.js'

const SOURCE_NOTE = `Source: the user's own kabu gateway database (TSE data stored after each
session), so values are the latest stored trading day, not intraday. If it
reports "not configured", tell the user to set the kabu gateway URL and
read-only token in Settings → Market Data.`

export function createJapanMarketTools(jp: JpMarketData = defaultJpMarketData) {
  return {
    japanMarketBreadth: tool({
      description: `Japan market breadth for the latest stored trading day versus the previous one:
advancers / decliners / unchanged across TSE stocks, and every TSE 33-industry
sector with its equal-weight average change and up/down counts (sorted best
to worst). Equal-weight differs from the cap-weighted official industry index;
for the official index moves use japanRanking with type sector_gain / sector_loss.

${SOURCE_NOTE}`,
      inputSchema: z.object({}),
      execute: async () => jp.breadth(),
    }),

    japanRankingTypes: tool({
      description: `List the Japan ranking types available in japanRanking: id, Japanese title
and subject (stock or sector). Includes gain/loss, volume, turnover, surges,
limit up/down, weekly moves, margin balances and TSE 33-industry indices.

${SOURCE_NOTE}`,
      inputSchema: z.object({}),
      execute: async () => jp.rankingTypes(),
    }),

    japanRanking: tool({
      description: `Read one Japan ranking (latest stored trading day): rank, code, name, market,
price, change, change %, volume (thousand shares), trading value (million
yen), time, and margin ratio for credit rankings. Sector rankings
(sector_gain / sector_loss) are official TSE 33-industry index moves.
Common types: gain, loss, volume, turnover, volume_surge, turnover_surge,
stop_high, stop_low, weekly_gain, weekly_loss, credit_buy, sector_gain,
sector_loss — call japanRankingTypes for the full list.

${SOURCE_NOTE}`,
      inputSchema: z.object({
        type: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).describe('Ranking type id, e.g. gain, loss, volume_surge, sector_loss'),
        limit: z.number().int().positive().max(200).optional().describe('Rows to return (default 50)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('YYYY-MM-DD: read that trading day (or the nearest stored day before it) instead of the latest — use japanRankingDates to list stored days'),
      }).meta({ examples: [{ type: 'gain' }, { type: 'sector_loss', limit: 33 }, { type: 'sector_gain', limit: 33, date: '2026-11-04' }] }),
      execute: async ({ type, limit, date }) => {
        const board = await jp.movers(type, date)
        return { ...board, types: undefined, rows: board.rows.slice(0, limit ?? 50) }
      },
    }),

    japanRankingDates: tool({
      description: `List the trading days stored for one Japan ranking type, newest first. Use
it to walk sector rotation over several days: read sector_gain and
sector_loss (limit 33 each) for each date and compare how every TSE
33-industry index moved. ${SOURCE_NOTE}`,
      inputSchema: z.object({
        type: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).describe('Ranking type id, e.g. sector_gain'),
        limit: z.number().int().positive().max(250).optional().describe('How many recent days (default 20)'),
      }).meta({ examples: [{ type: 'sector_gain', limit: 10 }] }),
      execute: async ({ type, limit }) => jp.rankingDates(type, limit ?? 20),
    }),

    japanStockFundamentals: tool({
      description: `One-call fundamentals for a Japanese stock (4-character TSE code):
- company: name, EDINET code, TSE 33 sector, market (Prime…), size, margin type
- latestEarnings: the newest 決算短信 (EDINET DB, current) — YTD revenue /
  operating / net income (million yen) with YoY %, EPS, and the company's
  effective full-year forecast (revenue, profits, EPS, DPS) plus progress %
- valuationNow: forward PER, PBR, dividend yield and market cap computed from
  the latest kabu close and that forecast (current, company-forecast basis)
- valuationHistory: 2-year forward PER / PBR ranges (min / median / max /
  last / percentile, 0 = cheapest) computed from daily kabu closes and each
  決算短信's forecast EPS and net assets — current to the last session. If
  source is "jquants" it is a fallback that ends about 12 weeks ago
- annual: last 5 fiscal years of split-adjusted EPS / BPS / DPS, ROE, ROA,
  margins, growth, PER, PBR, yield
Read "warnings" before concluding: a missing key or quota error removes that part.
Quotas are tight (EDINET DB Free: 100 calls/day, ~3 per new stock; J-Quants
Free: 5/minute). Results are cached on disk, so repeat calls are cheap.`,
      inputSchema: z.object({
        code: z.string().describe('TSE code, e.g. 7203 or 130A (".T" suffix accepted)'),
      }).meta({ examples: [{ code: '7203' }] }),
      execute: async ({ code }) => jp.fundamentals(code),
    }),

    japanStockFinancials: tool({
      description: `Full yearly financial statements for a Japanese stock from EDINET DB (有価証券報告書
basis): income statement, balance sheet, cash flow, dividends, employees,
cross-shareholdings and more, one object per fiscal year. Large payload — use
japanStockFundamentals first and call this only when you need line items.
Costs 1 EDINET DB call per stock and window (Free: 100/day), cached 3 days.`,
      inputSchema: z.object({
        code: z.string().describe('TSE code, e.g. 7203'),
        years: z.number().int().min(1).max(10).optional().describe('Fiscal years to return (default 3)'),
      }).meta({ examples: [{ code: '7203', years: 3 }] }),
      execute: async ({ code, years }) => jp.financials(code, years ?? 3),
    }),
  }
}
