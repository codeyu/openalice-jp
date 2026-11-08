import { describe, expect, it, vi } from 'vitest'

import { createJapanMarketTools } from './japan-market.js'
import { createJpMarketData, JpNotConfiguredError } from '@/domain/market-data/jp/service.js'

const cfg = { baseUrl: 'https://gw.example.com', token: 'read-only' }
const types = [{ type: 'gain', title: '今日の値上がり率', subject: 'stock' }]
const rows = Array.from({ length: 60 }, (_, i) => ({ rank: i + 1, code: '7203', name: 'トヨタ', exchange: '東証プ', category: null, price: 1, change: 0, changePct: 0, volume: null, turnover: null, asOfTime: null, marginRatio: null }))
const run = (t: { execute?: unknown }, input: unknown) => (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {})

describe('japan market tools', () => {
  it('serves breadth, ranking types and a trimmed ranking from the shared service', async () => {
    const loadMovers = vi.fn(async () => ({ date: '2026-11-06', type: types[0], types, rows, meta: { provider: 'kabu-db' as const, asOf: 'x', origin: 'local' as const } }))
    const jp = createJpMarketData({
      readConfig: async () => cfg,
      loadBreadth: async () => ({ date: '2026-11-06' }) as never,
      loadRankingTypes: async () => types,
      loadMovers,
    })
    const tools = createJapanMarketTools(jp)
    expect(await run(tools.japanMarketBreadth, {})).toEqual({ date: '2026-11-06' })
    expect(await run(tools.japanRankingTypes, {})).toEqual(types)
    const ranking = await run(tools.japanRanking, { type: 'gain', limit: 5 }) as { rows: unknown[]; types?: unknown }
    expect(ranking.rows).toHaveLength(5)
    expect(ranking.types).toBeUndefined()
    expect((await run(tools.japanRanking, { type: 'gain' }) as { rows: unknown[] }).rows).toHaveLength(50)
    await expect(run(tools.japanRanking, { type: 'nope' })).rejects.toThrow('unknown ranking type: nope (available: gain)')
  })

  it('surfaces a missing gateway config as not configured', async () => {
    const tools = createJapanMarketTools(createJpMarketData({ readConfig: async () => null }))
    await expect(run(tools.japanMarketBreadth, {})).rejects.toBeInstanceOf(JpNotConfiguredError)
  })
})
