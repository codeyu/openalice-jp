/**
 * Reference-data routes — `/api/reference/*`.
 *
 * Thin HTTP adapters over the reference-data contract
 * (`domain/market-data/reference/`). This namespace is OpenAlice's own
 * low-frequency data standard — new frontend surfaces consume THIS, never
 * the OpenBB-compatible `/api/market-data-v1` passthrough (which is on its
 * way out).
 */

import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { EngineContext } from '../../core/types.js'
import { readMarketDataConfig } from '../../core/config.js'
import { fetchJpBreadth, type JpBreadthBoard } from '../../domain/market-data/jp/breadth.js'
import type { KabuDbConfig } from '../../domain/market-data/jp/kabu-db.js'
import { fetchJpMovers, fetchJpRankingTypes, type JpMoversBoard, type JpRankingType } from '../../domain/market-data/jp/movers.js'

const JP_BREADTH_TTL_MS = 10 * 60_000
const JP_MOVERS_TTL_MS = 5 * 60_000
const JP_RANKING_TYPES_TTL_MS = 60 * 60_000

/** Cache identity for one gateway config; hashes the token so a new token never reuses old data. */
function configKey(cfg: KabuDbConfig): string {
  return `${cfg.baseUrl}#${createHash('sha256').update(cfg.token).digest('hex')}`
}

/** Small TTL cache of in-flight/settled loads; a failed load is evicted so the next call retries. */
export function createKeyedCache<T>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>()
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key)
      if (hit && Date.now() - hit.at < ttlMs) return hit.value
      const value = load()
      entries.set(key, { at: Date.now(), value })
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key) })
      return value
    },
  }
}

/** Per-config breadth cache. */
export function createJpBreadthCache(load: (cfg: KabuDbConfig) => Promise<JpBreadthBoard> = fetchJpBreadth, ttlMs = JP_BREADTH_TTL_MS) {
  const cache = createKeyedCache<JpBreadthBoard>(ttlMs)
  return { get: (cfg: KabuDbConfig) => cache.get(configKey(cfg), () => load(cfg)) }
}

const jpBreadthCache = createJpBreadthCache()
const jpRankingTypesCache = createKeyedCache<JpRankingType[]>(JP_RANKING_TYPES_TTL_MS)
const jpMoversCache = createKeyedCache<JpMoversBoard>(JP_MOVERS_TTL_MS)

/** Token for read-only kabu calls: a dedicated DB token wins, else the read-only gateway token. */
export function kabuReadToken(keys: { kabuDb?: string; kabuGateway?: string }): string | undefined {
  return keys.kabuDb?.trim() || keys.kabuGateway?.trim() || undefined
}

const NOT_CONFIGURED = { error: 'kabu gateway URL and read-only token are not configured (Settings → Market Data).', code: 'not_configured' } as const

async function kabuConfig(): Promise<KabuDbConfig | null> {
  const md = await readMarketDataConfig()
  const baseUrl = md.kabu.baseUrl.trim()
  const token = kabuReadToken(md.providerKeys)
  return baseUrl && token ? { baseUrl, token } : null
}

export function createReferenceRoutes(ctx: EngineContext): Hono {
  const app = new Hono()

  // GET /api/reference/jp-breadth → Japan advancers/decliners + TOPIX-17 sectors
  // from the user's self-hosted kabu gateway database (read-only DB token).
  app.get('/jp-breadth', async (c) => {
    const cfg = await kabuConfig()
    if (!cfg) return c.json(NOT_CONFIGURED, 409)
    try {
      return c.json(await jpBreadthCache.get(cfg))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/jp-movers?type=gain → latest stored kabu ranking of that type
  app.get('/jp-movers', async (c) => {
    const cfg = await kabuConfig()
    if (!cfg) return c.json(NOT_CONFIGURED, 409)
    const type = (c.req.query('type') ?? 'gain').trim()
    try {
      const key = configKey(cfg)
      const types = await jpRankingTypesCache.get(key, () => fetchJpRankingTypes(cfg))
      if (!types.some((t) => t.type === type)) return c.json({ error: `unknown ranking type: ${type}`, types }, 400)
      return c.json(await jpMoversCache.get(`${key}|${type}`, () => fetchJpMovers(cfg, type, types)))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/movers → gainers / losers / active board
  app.get('/movers', async (c) => {
    try {
      return c.json(await ctx.reference.movers())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/calendar?days= → earnings / IPO / ex-dividend board
  app.get('/calendar', async (c) => {
    const daysRaw = c.req.query('days')
    const days = daysRaw ? Math.max(1, Math.min(60, Number(daysRaw) || 14)) : undefined
    try {
      return c.json(await ctx.reference.calendar(days ? { days } : undefined))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/term-structure → BTC/ETH futures curve (Deribit)
  app.get('/term-structure', async (c) => {
    try {
      return c.json(await ctx.reference.termStructure())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/fed → balance sheet + dealer positions + FOMC docs
  app.get('/fed', async (c) => {
    try {
      return c.json(await ctx.reference.fed())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/shipping → chokepoint transit volumes (IMF PortWatch)
  app.get('/shipping', async (c) => {
    try {
      return c.json(await ctx.reference.shipping())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/global-macro → cross-country CPI / rates / CLI (OECD)
  app.get('/global-macro', async (c) => {
    try {
      return c.json(await ctx.reference.globalMacro())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/valuation → S&P 500 valuation strip (multpl)
  app.get('/valuation', async (c) => {
    try {
      return c.json(await ctx.reference.valuation())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  // GET /api/reference/macro → curated FRED regime dashboard
  app.get('/macro', async (c) => {
    try {
      return c.json(await ctx.reference.macro())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  return app
}
