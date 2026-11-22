import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  accountFromSection, decodeBrokerCsv, diffHoldings, findHoldingsExports, loadJpHoldings,
  parseCsvLine, parseNumber, parseSbiHoldings,
} from './holdings.js'

// Synthetic SBI「保有証券一覧」export: same layout as the real file, invented holdings.
const sbiCsv = (rows: { taxable: string[]; nisa: string[] }) => [
  '',
  '保有証券一覧',
  '',
  '株式（特定預り）合計',
  '',
  '評価額合計,評価損益合計',
  '1000000,-5000',
  '',
  '株式（特定預り）',
  '',
  '銘柄コード,銘柄名称,保有株数,売却注文中,取得単価,現在値,取得金額,評価額,評価損益',
  ...rows.taxable,
  '',
  '株式（NISA預り（成長投資枠））合計',
  '',
  '評価額合計,評価損益合計',
  '50000.0,+1000.0',
  '',
  '株式（NISA預り（成長投資枠））',
  '',
  '銘柄コード,銘柄名称,保有株数,売却注文中,取得単価,現在値,取得金額,評価額,評価損益',
  ...rows.nisa,
  '',
  '投資信託（金額/NISA預り（つみたて投資枠））',
  '',
  'ファンド名,保有口数,売却注文中,取得単価,基準価額,取得金額,評価額,評価損益,分配金受取方法',
  '"サンプル全世界株式インデックス",100000口,,20000,25000,200000,250000,+50000,再投資',
  '',
].join('\r\n')

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'holdings-')); roots.push(dir); return dir
}

describe('CSV primitives', () => {
  it('parses quoted cells and signed numbers', () => {
    expect(parseCsvLine('"7203","トヨタ ""自動車""",100,,3000,+1,234.5'))
      .toEqual(['7203', 'トヨタ "自動車"', '100', '', '3000', '+1', '234.5'])
    expect(parseNumber('+1,234.5')).toBe(1234.5)
    expect(parseNumber('-12 ')).toBe(-12)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('--')).toBeNull()
    expect(parseNumber('12,345口')).toBe(12345)
  })

  it('maps section titles to account types', () => {
    expect(accountFromSection('株式（特定預り）')).toBe('taxable')
    expect(accountFromSection('株式（NISA預り（成長投資枠））')).toBe('nisa-growth')
    expect(accountFromSection('投資信託（金額/NISA預り（つみたて投資枠））')).toBe('nisa-tsumitate')
    expect(accountFromSection('株式（旧NISA預り）')).toBe('nisa-legacy')
    expect(accountFromSection('株式（一般預り）')).toBe('general')
  })

  it('decodes UTF-8 with BOM and falls back to Shift_JIS', () => {
    expect(decodeBrokerCsv(new TextEncoder().encode('﻿保有証券一覧'))).toBe('保有証券一覧')
    // "保有" in Shift_JIS
    expect(decodeBrokerCsv(new Uint8Array([0x95, 0xdb, 0x97, 0x4c]))).toBe('保有')
  })
})

describe('parseSbiHoldings', () => {
  it('reads stock and fund sections with their accounts, skipping totals', () => {
    const parsed = parseSbiHoldings(sbiCsv({
      taxable: ['"7203","トヨタ自動車",100,,3000,3300,300000,330000,+30000 ', '"130A","サンプル",10,5,1000,900,10000,9000,-1000 '],
      nisa: ['"4661","ＯＬＣ",20,,2500,2550.5,50000,51010,+1010 '],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.stocks).toHaveLength(3)
    expect(parsed.stocks[0]).toMatchObject({ code: '7203', account: 'taxable', quantity: 100, avgCost: 3000, exportPrice: 3300, costJpy: 300000, exportValueJpy: 330000, exportPnlJpy: 30000, pendingSell: null })
    expect(parsed.stocks[1]).toMatchObject({ code: '130A', pendingSell: 5, exportPnlJpy: -1000 })
    expect(parsed.stocks[2]).toMatchObject({ code: '4661', account: 'nisa-growth', exportPrice: 2550.5 })
    expect(parsed.funds).toEqual([expect.objectContaining({ name: 'サンプル全世界株式インデックス', account: 'nisa-tsumitate', units: 100000, valueJpy: 250000, distribution: '再投資' })])
  })

  it('warns instead of guessing when nothing is recognised', () => {
    expect(parseSbiHoldings('a,b\n1,2').warnings.join(' ')).toMatch(/no holdings rows/)
  })
})

describe('diffHoldings', () => {
  it('reports added, increased, decreased and removed positions per account', () => {
    const h = (code: string, quantity: number, account: 'taxable' | 'nisa-growth' = 'taxable') =>
      ({ broker: 'sbi', account, accountLabel: '', code, name: code, quantity, pendingSell: null, avgCost: null, exportPrice: null, costJpy: null, exportValueJpy: null, exportPnlJpy: null })
    const changes = diffHoldings([h('1111', 100), h('2222', 100), h('3333', 100)], [h('1111', 200), h('2222', 50), h('4444', 10), h('1111', 10, 'nisa-growth')])
    expect(changes.map((c) => `${c.kind}:${c.code}:${c.account}`)).toEqual([
      'added:1111:nisa-growth', 'added:4444:taxable', 'increased:1111:taxable', 'decreased:2222:taxable', 'removed:3333:taxable',
    ])
  })
})

describe('loadJpHoldings', () => {
  it('finds dated exports, uses the newest, diffs the previous and revalues with kabu closes', async () => {
    const root = await home()
    const extra = await home()
    await mkdir(join(root, 'sbi'))
    await writeFile(join(root, 'sbi', 'SBI保有証券一覧_20261101.csv'), sbiCsv({ taxable: ['"7203","トヨタ自動車",50,,3000,3100,150000,155000,+5000 '], nisa: [] }))
    await writeFile(join(extra, 'SBI保有証券一覧_20261115.csv'), sbiCsv({
      taxable: ['"7203","トヨタ自動車",100,,3000,3300,300000,330000,+30000 '],
      nisa: ['"4661","ＯＬＣ",20,,2500,2550,50000,51000,+1000 '],
    }))
    await writeFile(join(extra, 'unrelated.csv'), 'x')

    expect((await findHoldingsExports([root, extra])).map((f) => f.date)).toEqual(['2026-11-01', '2026-11-15'])

    const requested: string[] = []
    const fetchImpl = async (url: string) => {
      requested.push(decodeURIComponent(url))
      const body = url.includes('ohlcv_daily') ? [{ stock_code: '7203', ts: '2026-11-20T00:00:00+09:00', close: 3500 }]
        : url.includes('/stocks') ? [{ stock_code: '7203', sector_33_name: '輸送用機器' }, { stock_code: '4661', sector_33_name: 'サービス業' }]
          : [{ kabu_code: '4661', create_date: '2026-11-21', signal: '買い転換', level: ' 底値圏突入 ' }]
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const view = await loadJpHoldings({ dirs: [root, extra], kabu: { baseUrl: 'https://kabu.example', token: 't' }, fetchImpl, now: () => new Date('2026-11-22T00:00:00Z') })

    expect(view.asOf).toBe('2026-11-15')
    expect(view.sources).toEqual([expect.objectContaining({ broker: 'sbi', date: '2026-11-15', previousDate: '2026-11-01', history: ['2026-11-01', '2026-11-15'] })])
    const toyota = view.stocks.find((s) => s.code === '7203')!
    expect(toyota).toMatchObject({ price: 3500, priceDate: '2026-11-20', valueJpy: 350000, pnlJpy: 50000, pnlPct: 16.67, sector33: '輸送用機器' })
    const olc = view.stocks.find((s) => s.code === '4661')!
    expect(olc).toMatchObject({ price: 2550, priceDate: null, valueJpy: 51000, signal: { signal: '買い転換', level: '底値圏突入' } })
    expect(view.totals.stocks).toMatchObject({ costJpy: 350000, valueJpy: 401000, pnlJpy: 51000, positions: 2 })
    expect(view.totals.bySector[0]).toMatchObject({ sector33: '輸送用機器', weightPct: 87.28 })
    expect(view.totals.byAccount.map((a) => a.account).sort()).toEqual(['nisa-growth', 'taxable'])
    expect(view.changes.map((c) => `${c.kind}:${c.code}`)).toEqual(['added:4661', 'increased:7203'])
    expect(view.funds).toHaveLength(1)
    expect(view.warnings.join(' ')).toMatch(/no recent kabu close for 4661/)
    expect(requested.some((u) => u.includes('stock_code=in.(7203,4661)'))).toBe(true)
  })

  it('works without kabu and explains an empty folder', async () => {
    const empty = await loadJpHoldings({ dirs: [await home()], kabu: null })
    expect(empty.stocks).toEqual([])
    expect(empty.notes.join(' ')).toMatch(/No broker exports found/)

    const root = await home()
    await writeFile(join(root, 'SBI保有証券一覧_20261115.csv'), sbiCsv({ taxable: ['"7203","トヨタ自動車",100,,3000,3300,300000,330000,+30000 '], nisa: [] }))
    const view = await loadJpHoldings({ dirs: [root], kabu: null }, '2026-11-30')
    expect(view.stocks[0]).toMatchObject({ price: 3300, valueJpy: 330000, pnlJpy: 30000, weightPct: 100 })
    expect(view.notes.join(' ')).toMatch(/export-time prices/)
    expect((await loadJpHoldings({ dirs: [root], kabu: null }, '2026-11-01')).stocks).toEqual([])
  })
})
