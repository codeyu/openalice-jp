/**
 * Reference-data routes — `/api/reference/*`.
 *
 * Thin HTTP adapters over the reference-data contract
 * (`domain/market-data/reference/`). This namespace is OpenAlice's own
 * low-frequency data standard — new frontend surfaces consume THIS, never
 * the OpenBB-compatible `/api/market-data-v1` passthrough (which is on its
 * way out).
 */

import { Hono } from 'hono'
import type { EngineContext } from '../../core/types.js'
import { jpMarketData, JpNotConfiguredError } from '../../domain/market-data/jp/service.js'

/** 409 for a missing kabu config (the UI offers Settings), 502 for upstream failures. */
function jpError(err: unknown): { body: { error: string; code?: string }; status: 409 | 502 } {
  if (err instanceof JpNotConfiguredError) return { body: { error: err.message, code: err.code }, status: 409 }
  return { body: { error: err instanceof Error ? err.message : String(err) }, status: 502 }
}

export function createReferenceRoutes(ctx: EngineContext): Hono {
  const app = new Hono()

  // GET /api/reference/jp-breadth → Japan advancers/decliners + TSE 33-industry sectors
  // from the user's self-hosted kabu gateway database (read-only DB token).
  app.get('/jp-breadth', async (c) => {
    try {
      return c.json(await jpMarketData.breadth())
    } catch (err) {
      const { body, status } = jpError(err)
      return c.json(body, status)
    }
  })

  // GET /api/reference/jp-movers?type=gain → latest stored kabu ranking of that type
  app.get('/jp-movers', async (c) => {
    const type = (c.req.query('type') ?? 'gain').trim()
    try {
      return c.json(await jpMarketData.movers(type))
    } catch (err) {
      const { body, status } = jpError(err)
      return c.json(body, String(body.error).startsWith('unknown ranking type') ? 400 : status)
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
