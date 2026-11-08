import { describe, expect, it, vi } from 'vitest'

import { computeBreadth, fetchJpBreadth } from './breadth.js'
import { kabuDbGet, kabuDbGetAll, kabuDbUrl } from './kabu-db.js'
import { createJpMarketData, JpNotConfiguredError, kabuReadToken } from './service.js'

describe('kabuReadToken', () => {
  it('prefers a dedicated DB token, else falls back to the read-only gateway token', () => {
    expect(kabuReadToken({ kabuDb: ' db ', kabuGateway: 'gw' })).toBe('db')
    expect(kabuReadToken({ kabuGateway: ' gw ' })).toBe('gw')
    expect(kabuReadToken({ kabuDb: '  ' })).toBeUndefined()
  })
})

const cfg = { baseUrl: 'https://gw.example.com/', token: 'secret-db-token' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('computeBreadth', () => {
  it('counts advancers/decliners on split-adjusted prices and averages TSE 33 industries', () => {
    const stocks = [
      { stock_code: '7203', sector_33_name: '輸送用機器' },
      { stock_code: '7267', sector_33_name: '輸送用機器' },
      { stock_code: '8306', sector_33_name: '銀行業' },
      { stock_code: '9984', sector_33_name: '情報・通信業' },
    ]
    const prev = [
      { stock_code: '7203', close: 3000, adjusted_close: 3000 },
      { stock_code: '7267', close: 2000, adjusted_close: 1000 }, // 2:1 split before the latest day
      { stock_code: '8306', close: 1500, adjusted_close: 1500 },
      { stock_code: '9984', close: 9000, adjusted_close: 9000 },
      { stock_code: '1306', close: 380, adjusted_close: 380 },
    ]
    const latest = [
      { stock_code: '7203', close: 3300, adjusted_close: 3300 }, // +10%
      { stock_code: '7267', close: 1000, adjusted_close: 1000 }, // flat after split adjustment
      { stock_code: '8306', close: 1350, adjusted_close: 1350 }, // -10%
      { stock_code: '9984', close: 9000, adjusted_close: null }, // falls back to close: flat
      { stock_code: '1306', close: 390, adjusted_close: 390 }, // ETF: no sector, excluded
      { stock_code: '1234', close: 100, adjusted_close: 100 }, // no previous bar
    ]
    const { breadth, sectors } = computeBreadth(latest, prev, stocks)
    expect(breadth).toEqual({ advancers: 1, decliners: 1, unchanged: 2, total: 4 })
    expect(sectors).toEqual([
      { name: '輸送用機器', avgChangePct: 5, advancers: 1, decliners: 0, count: 2 },
      { name: '情報・通信業', avgChangePct: 0, advancers: 0, decliners: 0, count: 1 },
      { name: '銀行業', avgChangePct: -10, advancers: 0, decliners: 1, count: 1 },
    ])
  })
})

describe('kabu DB client', () => {
  it('sends the bearer token and pages until a short page', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      return jsonResponse(offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ i })) : [{ i: 1000 }])
    })
    const rows = await kabuDbGetAll(cfg, 'stocks?select=stock_code', fetchImpl)
    expect(rows).toHaveLength(1001)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gw.example.com/rest/v1/stocks?select=stock_code&limit=1000&offset=0')
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer secret-db-token')
  })

  it('reports a rejected token without echoing it', async () => {
    const err = await kabuDbGet(cfg, 'stocks', async () => jsonResponse({ error: 'no' }, 401)).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/rejected the token/)
    expect(err?.message).not.toContain(cfg.token)
    expect(kabuDbUrl('https://x/', '/rest-ish')).toBe('https://x/rest/v1/rest-ish')
  })
})

describe('fetchJpBreadth', () => {
  it('compares the two latest trading days with encoded timestamps', async () => {
    const latestTs = '2026-11-06T00:00:00+09:00'
    const prevTs = '2026-11-05T00:00:00+09:00'
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url)
      if (u.pathname.endsWith('/stocks')) return jsonResponse([{ stock_code: '7203', sector_33_name: '輸送用機器' }])
      if (u.searchParams.get('select') === 'ts') return jsonResponse(u.searchParams.get('ts') ? [{ ts: prevTs }] : [{ ts: latestTs }])
      const close = u.searchParams.get('ts') === `eq.${latestTs}` ? 110 : 100
      return jsonResponse([{ stock_code: '7203', close, adjusted_close: close }])
    })
    const board = await fetchJpBreadth(cfg, fetchImpl, new Date('2026-11-08T00:00:00Z'))
    expect(board).toMatchObject({ date: '2026-11-06', prevDate: '2026-11-05', breadth: { advancers: 1, total: 1 }, meta: { provider: 'kabu-db', origin: 'local' } })
    expect(fetchImpl.mock.calls.some(([url]) => (url as string).includes(`ts=lt.${encodeURIComponent(latestTs)}`))).toBe(true)
  })
})

describe('jp market data service', () => {
  it('reuses breadth for the same config and reloads when the token changes or a load fails', async () => {
    const board = { date: 'd' } as never
    const loadBreadth = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(board)
    let current = cfg
    const service = createJpMarketData({ readConfig: async () => current, loadBreadth })
    await expect(service.breadth()).rejects.toThrow('down')
    await expect(service.breadth()).resolves.toBe(board)
    await service.breadth()
    expect(loadBreadth).toHaveBeenCalledTimes(2)
    current = { ...cfg, token: 'other' }
    await service.breadth()
    expect(loadBreadth).toHaveBeenCalledTimes(3)
  })

  it('reports a missing config as a typed not-configured error', async () => {
    const service = createJpMarketData({ readConfig: async () => null })
    expect(await service.isConfigured()).toBe(false)
    await expect(service.breadth()).rejects.toBeInstanceOf(JpNotConfiguredError)
  })
})
