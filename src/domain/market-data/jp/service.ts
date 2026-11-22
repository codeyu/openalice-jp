/**
 * Japan market data from the user's self-hosted kabu gateway — one shared
 * entry point for the Web UI routes and the Agent tools, so both read the same
 * config (hot: re-read per call) and share caches.
 */

import { createHash } from 'node:crypto'

import { readMarketDataConfig } from '@/core/config.js'
import { dataPath } from '@/core/paths.js'
import { createDiskCache, createEdinetDbClient, createJQuantsClient, type DiskCache, type FetchLike } from './api-clients.js'
import { fetchJpStockFinancials, fetchJpStockFundamentals, type JpStockFundamentals } from './fundamentals.js'
import { fetchJpBreadth, type JpBreadthBoard } from './breadth.js'
import { fetchKabuBars, type KabuBar, type KabuBarsOpts } from './kabu-bars.js'
import type { KabuDbConfig } from './kabu-db.js'
import { fetchJpMovers, fetchJpRankingDates, fetchJpRankingTypes, type JpMoversBoard, type JpRankingType } from './movers.js'
import { loadJpHoldings, type JpHoldingsView } from './holdings.js'

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

export interface JpApiKeys {
  jquants?: string
  edinetdb?: string
}

/** Settings keys win; the documented env vars are a fallback for headless installs. */
export function resolveJpApiKeys(providerKeys: { jquants?: string; edinetdb?: string }, env: NodeJS.ProcessEnv = process.env): JpApiKeys {
  const pick = (a?: string, b?: string) => a?.trim() || b?.trim() || undefined
  return {
    jquants: pick(providerKeys.jquants, env['JPX_JQUANTS_API_KEY']),
    edinetdb: pick(providerKeys.edinetdb, env['EDINETDB_API_KEY']),
  }
}

export async function readJpApiKeys(): Promise<JpApiKeys> {
  return resolveJpApiKeys((await readMarketDataConfig()).providerKeys)
}

export interface JpMarketDataDeps {
  readConfig: () => Promise<KabuDbConfig | null>
  readApiKeys?: () => Promise<JpApiKeys>
  /** Disk cache for the quota-limited fundamentals APIs. */
  fundamentalsCache?: DiskCache
  fetchImpl?: FetchLike
  loadBreadth?: typeof fetchJpBreadth
  loadRankingTypes?: typeof fetchJpRankingTypes
  loadMovers?: typeof fetchJpMovers
  loadBars?: typeof fetchKabuBars
  /** Folders scanned for broker holdings exports (default: data/holdings + configured extras). */
  readHoldingsDirs?: () => Promise<string[]>
}

export async function readHoldingsDirs(): Promise<string[]> {
  const md = await readMarketDataConfig()
  return [dataPath('holdings'), ...md.holdings.extraDirs.map((d) => d.trim()).filter(Boolean)]
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
    async movers(type: string, date?: string): Promise<JpMoversBoard> {
      const cfg = await config()
      const types = await rankingTypes()
      if (!types.some((t) => t.type === type)) {
        throw new Error(`unknown ranking type: ${type} (available: ${types.map((t) => t.type).join(', ')})`)
      }
      return moversCache.get(`${configKey(cfg)}|${type}|${date ?? 'latest'}`, () => loadMovers(cfg, type, types, undefined, undefined, date))
    },
    async rankingDates(type: string, limit = 20): Promise<string[]> {
      const cfg = await config()
      return fetchJpRankingDates(cfg, type, Math.max(1, Math.min(250, limit)))
    },
    async bars(symbol: string, opts: KabuBarsOpts): Promise<KabuBar[]> {
      const cfg = await config()
      const key = `${configKey(cfg)}|${symbol}|${opts.interval}|${opts.count ?? ''}|${opts.start ?? ''}|${opts.end ?? ''}`
      return barsCache.get(key, () => loadBars(cfg, symbol, opts))
    },
    async fundamentals(symbol: string): Promise<JpStockFundamentals> {
      return fetchJpStockFundamentals(symbol, {
        ...(await apiDeps()),
        latestPrice: async (code) => {
          if (!(await deps.readConfig())) return null
          const cfg = await config()
          const [bar] = (await barsCache.get(`${configKey(cfg)}|${code}|1d|1||`, () => loadBars(cfg, code, { interval: '1d', count: 1 })))
          return bar ? { date: bar.date, close: bar.close } : null
        },
        dailyBars: async (code, count) => {
          if (!(await deps.readConfig())) return []
          const cfg = await config()
          return barsCache.get(`${configKey(cfg)}|${code}|1d|${count}||`, () => loadBars(cfg, code, { interval: '1d', count }))
        },
      })
    },
    async financials(symbol: string, years: number): Promise<unknown> {
      return fetchJpStockFinancials(symbol, years, await apiDeps())
    },
    /** Holdings from broker CSV exports; kabu enrichment is optional. */
    async holdings(asOf?: string): Promise<JpHoldingsView> {
      const dirs = await (deps.readHoldingsDirs ?? readHoldingsDirs)()
      return loadJpHoldings({ dirs, kabu: await deps.readConfig(), fetchImpl: deps.fetchImpl }, asOf)
    },
  }

  async function apiDeps() {
    const keys = await (deps.readApiKeys ?? readJpApiKeys)()
    return {
      edinet: keys.edinetdb ? createEdinetDbClient(keys.edinetdb, deps.fetchImpl) : null,
      jquants: keys.jquants ? createJQuantsClient(keys.jquants, deps.fetchImpl) : null,
      cache: deps.fundamentalsCache ?? defaultFundamentalsCache(),
    }
  }
}

let sharedFundamentalsCache: DiskCache | null = null
function defaultFundamentalsCache(): DiskCache {
  sharedFundamentalsCache ??= createDiskCache(dataPath('cache', 'jp-fundamentals'))
  return sharedFundamentalsCache
}

export type JpMarketData = ReturnType<typeof createJpMarketData>

/** Process-wide instance reading the live market-data config. */
export const jpMarketData = createJpMarketData({ readConfig: readKabuConfig })
