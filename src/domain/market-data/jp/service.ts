/**
 * Japan market data from the user's self-hosted kabu gateway — one shared
 * entry point for the Web UI routes and the Agent tools, so both read the same
 * config (hot: re-read per call) and share caches.
 */

import { createHash } from 'node:crypto'

import { readMarketDataConfig } from '@/core/config.js'
import { fetchJpBreadth, type JpBreadthBoard } from './breadth.js'
import { fetchKabuBars, type KabuBar, type KabuBarsOpts } from './kabu-bars.js'
import type { KabuDbConfig } from './kabu-db.js'
import { fetchJpMovers, fetchJpRankingTypes, type JpMoversBoard, type JpRankingType } from './movers.js'

const TTL = { breadth: 10 * 60_000, movers: 5 * 60_000, rankingTypes: 60 * 60_000, bars: 10 * 60_000 } as const

export class JpNotConfiguredError extends Error {
  readonly code = 'not_configured'
  constructor() {
    super('kabu gateway URL and read-only token are not configured (Settings → Market Data).')
    this.name = 'JpNotConfiguredError'
  }
}

/** Token for read-only kabu calls: a dedicated DB token wins, else the read-only gateway token. */
export function kabuReadToken(keys: { kabuDb?: string; kabuGateway?: string }): string | undefined {
  return keys.kabuDb?.trim() || keys.kabuGateway?.trim() || undefined
}

/** Cache identity for one gateway config; hashes the token so a new token never reuses old data. */
export function configKey(cfg: KabuDbConfig): string {
  return `${cfg.baseUrl}#${createHash('sha256').update(cfg.token).digest('hex')}`
}

/** Small TTL cache of in-flight/settled loads; a failed load is evicted so the next call retries. */
export function createKeyedCache<T>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>()
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key)
      if (hit && Date.now() - hit.at < ttlMs) return hit.value
      if (entries.size > 500) entries.clear() // bounded: bar keys vary per symbol/window
      const value = load()
      entries.set(key, { at: Date.now(), value })
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key) })
      return value
    },
  }
}

export interface JpMarketDataDeps {
  readConfig: () => Promise<KabuDbConfig | null>
  loadBreadth?: typeof fetchJpBreadth
  loadRankingTypes?: typeof fetchJpRankingTypes
  loadMovers?: typeof fetchJpMovers
  loadBars?: typeof fetchKabuBars
}

export async function readKabuConfig(): Promise<KabuDbConfig | null> {
  const md = await readMarketDataConfig()
  const baseUrl = md.kabu.baseUrl.trim()
  const token = kabuReadToken(md.providerKeys)
  return baseUrl && token ? { baseUrl, token } : null
}

export function createJpMarketData(deps: JpMarketDataDeps) {
  const breadthCache = createKeyedCache<JpBreadthBoard>(TTL.breadth)
  const typesCache = createKeyedCache<JpRankingType[]>(TTL.rankingTypes)
  const moversCache = createKeyedCache<JpMoversBoard>(TTL.movers)
  const barsCache = createKeyedCache<KabuBar[]>(TTL.bars)
  const loadBreadth = deps.loadBreadth ?? fetchJpBreadth
  const loadRankingTypes = deps.loadRankingTypes ?? fetchJpRankingTypes
  const loadMovers = deps.loadMovers ?? fetchJpMovers
  const loadBars = deps.loadBars ?? fetchKabuBars

  async function config(): Promise<KabuDbConfig> {
    const cfg = await deps.readConfig()
    if (!cfg) throw new JpNotConfiguredError()
    return cfg
  }

  async function rankingTypes(): Promise<JpRankingType[]> {
    const cfg = await config()
    return typesCache.get(configKey(cfg), () => loadRankingTypes(cfg))
  }

  return {
    async isConfigured(): Promise<boolean> {
      return (await deps.readConfig()) != null
    },
    async breadth(): Promise<JpBreadthBoard> {
      const cfg = await config()
      return breadthCache.get(configKey(cfg), () => loadBreadth(cfg))
    },
    rankingTypes,
    async movers(type: string): Promise<JpMoversBoard> {
      const cfg = await config()
      const types = await rankingTypes()
      if (!types.some((t) => t.type === type)) {
        throw new Error(`unknown ranking type: ${type} (available: ${types.map((t) => t.type).join(', ')})`)
      }
      return moversCache.get(`${configKey(cfg)}|${type}`, () => loadMovers(cfg, type, types))
    },
    async bars(symbol: string, opts: KabuBarsOpts): Promise<KabuBar[]> {
      const cfg = await config()
      const key = `${configKey(cfg)}|${symbol}|${opts.interval}|${opts.count ?? ''}|${opts.start ?? ''}|${opts.end ?? ''}`
      return barsCache.get(key, () => loadBars(cfg, symbol, opts))
    },
  }
}

export type JpMarketData = ReturnType<typeof createJpMarketData>

/** Process-wide instance reading the live market-data config. */
export const jpMarketData = createJpMarketData({ readConfig: readKabuConfig })
