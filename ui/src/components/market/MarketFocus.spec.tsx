import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../../i18n'
import { useMarketFocus } from '../../live/market-focus'

const mocks = vi.hoisted(() => ({
  openOrFocus: vi.fn(),
  valuation: vi.fn(() => new Promise(() => {})),
  sectorRotation: vi.fn(() => new Promise(() => {})),
  jpBreadth: vi.fn(async () => ({ ok: false, notConfigured: true, error: 'not configured' })),
  bars: vi.fn(async () => ({ results: [{ date: '2026-11-05', close: 61077.9 }, { date: '2026-11-06', close: 57434.77 }], meta: null })),
}))

vi.mock('../../tabs/store', () => ({
  useWorkspace: (selector: (state: { openOrFocus: typeof mocks.openOrFocus }) => unknown) =>
    selector({ openOrFocus: mocks.openOrFocus }),
}))
vi.mock('../../api/reference', () => ({ referenceApi: { valuation: mocks.valuation, jpBreadth: mocks.jpBreadth } }))
vi.mock('../../api/market', () => ({ marketApi: { sectorRotation: mocks.sectorRotation }, barsApi: { bars: mocks.bars } }))
vi.mock('./SearchBox', () => ({ SearchBox: () => <div>search box</div> }))

import { MarketPage } from '../../pages/MarketPage'
import { MarketBoardPage } from '../../pages/MarketBoardPage'
import { MarketRotationPage } from '../../pages/MarketRotationPage'
import { MarketFocusToggle } from './MarketFocus'

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  useMarketFocus.setState({ focus: 'jp' })
  await i18n.changeLanguage('zh')
})

afterEach(cleanup)
afterAll(async () => { await i18n.changeLanguage('en') })

describe('market focus', () => {
  it('defaults to Japan and persists the choice', () => {
    expect(useMarketFocus.getInitialState().focus).toBe('jp')
    render(<MarketFocusToggle />)
    expect(screen.getByRole('button', { name: '日股' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '美股' }))
    expect(useMarketFocus.getState().focus).toBe('us')
    expect(localStorage.getItem('openalice.market-focus.v1')).toContain('"us"')
  })

  it('shows a Japan placeholder on market-specific boards and switches back to US on request', () => {
    render(<MarketBoardPage visible spec={{ kind: 'market-board', params: { board: 'fed' } }} />)
    expect(screen.getByRole('status').textContent).toContain('日本银行：日本数据准备中')
    fireEvent.click(screen.getByRole('button', { name: '查看美股数据' }))
    expect(useMarketFocus.getState().focus).toBe('us')
  })

  it('leaves market-neutral boards alone in Japan focus', () => {
    render(<MarketBoardPage visible spec={{ kind: 'market-board', params: { board: 'shipping' } }} />)
    expect(screen.queryByRole('status', { name: /准备中/ })).toBeNull()
    expect(screen.queryByText(/日本数据准备中/)).toBeNull()
  })

  it('gates sector rotation without fetching US data', () => {
    render(<MarketRotationPage />)
    expect(screen.getByText('板块轮动：日本数据准备中')).toBeTruthy()
    expect(mocks.sectorRotation).not.toHaveBeenCalled()
  })

  it('shows the Japan overview instead of the US valuation strip', async () => {
    render(<MarketPage />)
    expect(await screen.findByText('日经 225')).toBeTruthy()
    expect(screen.getAllByText('57434.8')).toHaveLength(3)
    expect(await screen.findByText(/配置 kabu 网关/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开行情数据设置' }))
    expect(mocks.openOrFocus).toHaveBeenCalledWith({ kind: 'settings', params: { category: 'market-data' } })
    expect(mocks.bars).toHaveBeenCalledWith(expect.objectContaining({ barId: 'yfinance|^N225', interval: '1d' }))
    expect(mocks.valuation).not.toHaveBeenCalled()
  })

  it('renders breadth and sector moves when the kabu DB is configured', async () => {
    mocks.jpBreadth.mockResolvedValueOnce({
      ok: true,
      board: {
        date: '2026-11-06', prevDate: '2026-11-05',
        breadth: { advancers: 120, decliners: 3500, unchanged: 30, total: 3650 },
        sectors: [{ name: '銀行', avgChangePct: -4.21, advancers: 2, decliners: 80, count: 82 }],
        meta: { provider: 'kabu-db', asOf: '2026-11-08T00:00:00Z', origin: 'local' },
      },
    } as never)
    render(<MarketPage />)
    expect(await screen.findByText('2026-11-06 对比 2026-11-05')).toBeTruthy()
    expect(screen.getByText('3500')).toBeTruthy()
    expect(screen.getByText('-4.21%')).toBeTruthy()
  })
})
