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

const JP_BREADTH_TTL_MS = 10 * 60_000

/** Per-config cache; the key hashes the token so a new token never reuses old data. */
export function createJpBreadthCache(load: (cfg: KabuDbConfig) => Promise<JpBreadthBoard> = fetchJpBreadth, ttlMs = JP_BREADTH_TTL_MS) {
  let entry: { key: string; at: number; value: Promise<JpBreadthBoard> } | null = null
  return {
    get(cfg: KabuDbConfig): Promise<JpBreadthBoard> {
      const key = `${cfg.baseUrl}#${createHash('sha256').update(cfg.token).digest('hex')}`
      if (entry && entry.key === key && Date.now() - entry.at < ttlMs) return entry.value
      const value = load(cfg)
      entry = { key, at: Date.now(), value }
      value.catch(() => { if (entry?.value === value) entry = null })
      return value
    },
  }
}

const jpBreadthCache = createJpBreadthCache()

/** Token for read-only kabu calls: a dedicated DB token wins, else the read-only gateway token. */
export function kabuReadToken(keys: { kabuDb?: string; kabuGateway?: string }): string | undefined {
  return keys.kabuDb?.trim() || keys.kabuGateway?.trim() || undefined
}

export function createReferenceRoutes(ctx: EngineContext): Hono {
  const app = new Hono()

  // GET /api/reference/jp-breadth → Japan advancers/decliners + TOPIX-17 sectors
  // from the user's self-hosted kabu gateway database (read-only DB token).
  app.get('/jp-breadth', async (c) => {
    const md = await readMarketDataConfig()
    const baseUrl = md.kabu.baseUrl.trim()
    const token = kabuReadToken(md.providerKeys)
    if (!baseUrl || !token) {
      return c.json({ error: 'kabu gateway URL and read-only token are not configured (Settings → Market Data).', code: 'not_configured' }, 409)
    }
    try {
      return c.json(await jpBreadthCache.get({ baseUrl, token }))
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
