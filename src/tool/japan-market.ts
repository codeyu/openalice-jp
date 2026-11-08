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
      }).meta({ examples: [{ type: 'gain' }, { type: 'sector_loss', limit: 33 }] }),
      execute: async ({ type, limit }) => {
        const board = await jp.movers(type)
        return { ...board, types: undefined, rows: board.rows.slice(0, limit ?? 50) }
      },
    }),
  }
}
