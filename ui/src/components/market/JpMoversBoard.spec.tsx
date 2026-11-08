import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../../i18n'
import type { JpMoverRow, JpMoversResult } from '../../api/reference'

const types = [
  { type: 'gain', title: '今日の値上がり率', subject: 'stock' },
  { type: 'loss', title: '今日の値下がり率', subject: 'stock' },
  { type: 'credit_buy', title: '信用買残増', subject: 'stock' },
]
const row = (over: Partial<JpMoverRow>): JpMoverRow => ({
  rank: 1, code: '4475', name: 'ＨＥＮＮＧＥ', exchange: '東証プ', category: '情報・通信業', price: 2211, change: 400,
  changePct: 22.08, volume: 2099.6, turnover: 4471.08, asOfTime: '15:30', marginRatio: null, ...over,
})
const board = (type: string, rows: JpMoverRow[]): JpMoversResult => ({
  ok: true,
  board: { date: '2026-11-06', type: types.find((t) => t.type === type)!, types, rows, meta: { provider: 'kabu-db', asOf: '2026-11-08T00:00:00Z', origin: 'local' } },
})

const mocks = vi.hoisted(() => ({ openOrFocus: vi.fn(), jpMovers: vi.fn() }))
vi.mock('../../tabs/store', () => ({
  useWorkspace: (selector: (state: { openOrFocus: typeof mocks.openOrFocus }) => unknown) => selector({ openOrFocus: mocks.openOrFocus }),
}))
vi.mock('../../api/reference', () => ({ referenceApi: { jpMovers: mocks.jpMovers } }))

import { JpMoversBoardView, visibleColumns } from './JpMoversBoard'

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('zh')
})
afterEach(cleanup)
afterAll(async () => { await i18n.changeLanguage('en') })

describe('JpMoversBoardView', () => {
  it('hides columns no row fills, so credit rankings stay compact', () => {
    expect(visibleColumns([row({})])).toEqual(['rank', 'code', 'name', 'exchange', 'price', 'change', 'changePct', 'volume', 'turnover', 'asOfTime'])
    expect(visibleColumns([row({ price: null, change: null, changePct: null, volume: null, turnover: null, asOfTime: null, marginRatio: 1.96 })]))
      .toEqual(['rank', 'code', 'name', 'exchange', 'marginRatio'])
  })

  it('shows the latest ranking, switches type, and opens a stock', async () => {
    mocks.jpMovers.mockImplementation(async (type: string) => type === 'gain'
      ? board('gain', [row({})])
      : board(type, [row({ rank: 1, code: '1360', name: '日経ベア２', price: null, change: null, changePct: null, volume: null, turnover: null, asOfTime: null, marginRatio: 1.96 })]))
    render(<JpMoversBoardView />)
    expect(await screen.findByText('ＨＥＮＮＧＥ')).toBeTruthy()
    expect(screen.getByText('+22.08%')).toBeTruthy()
    expect(screen.getByText('今日の値上がり率 · 2026-11-06（已存储的最新交易日）')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: '全部排行' }), { target: { value: 'credit_buy' } })
    expect(await screen.findByText('日経ベア２')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '信用倍率' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: '涨跌幅' })).toBeNull()
    await waitFor(() => expect(mocks.jpMovers).toHaveBeenLastCalledWith('credit_buy'))

    fireEvent.click(screen.getByRole('button', { name: '日経ベア２' }))
    expect(mocks.openOrFocus).toHaveBeenCalledWith({ kind: 'market-detail', params: { assetClass: 'equity', symbol: '1360.T' } })
  })

  it('points to settings when the gateway is not configured', async () => {
    mocks.jpMovers.mockResolvedValue({ ok: false, notConfigured: true, error: 'not configured' })
    render(<JpMoversBoardView />)
    fireEvent.click(await screen.findByRole('button', { name: '打开行情数据设置' }))
    expect(mocks.openOrFocus).toHaveBeenCalledWith({ kind: 'settings', params: { category: 'market-data' } })
  })
})
