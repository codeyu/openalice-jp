/**
 * Read-only holdings from broker CSV exports.
 *
 * Japanese brokers rarely offer an API, but most export a holdings CSV. The
 * user drops those exports into `data/holdings/<broker>/` (or a configured
 * extra folder); this module parses them into one normalized shape, keeps
 * every dated export as history, and enriches the latest one with kabu
 * closes, TSE 33 sectors and kabuyoho signals. Nothing here trades: holdings
 * are research input only, separate from UTA accounts.
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { kabuDbGetAll, type FetchLike, type KabuDbConfig } from './kabu-db.js'

export type HoldingAccount = 'taxable' | 'general' | 'nisa-growth' | 'nisa-tsumitate' | 'nisa-legacy' | 'unknown'

export interface StockHolding {
  broker: string
  account: HoldingAccount
  /** Section title as the broker wrote it, e.g. 株式（NISA預り（成長投資枠）） */
  accountLabel: string
  code: string
  name: string
  quantity: number
  pendingSell: number | null
  /** Per-share acquisition price (yen). */
  avgCost: number | null
  /** Price at export time (yen). */
  exportPrice: number | null
  costJpy: number | null
  exportValueJpy: number | null
  exportPnlJpy: number | null
}

export interface FundHolding {
  broker: string
  account: HoldingAccount
  accountLabel: string
  name: string
  units: number
  pendingSell: number | null
  avgCost: number | null
  nav: number | null
  costJpy: number | null
  valueJpy: number | null
  pnlJpy: number | null
  distribution: string | null
}

export interface ParsedHoldings { stocks: StockHolding[]; funds: FundHolding[]; warnings: string[] }

export interface HoldingsExportFile { broker: string; brokerLabel: string; date: string; path: string }

interface BrokerFormat {
  broker: string
  label: string
  /** Filename → export date (YYYY-MM-DD), or null when the file is not this broker's export. */
  match: (fileName: string) => string | null
  parse: (text: string, broker: string) => ParsedHoldings
}

// ---------- CSV primitives ----------

/** One CSV line → cells (RFC 4180 quotes, doubled quotes inside). */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell.trim()); cell = '' }
    else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

/** "+1,234.5" / "-12" / "12,345口" / "" → number | null (unit suffixes 円/口/株 dropped). */
export function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null
  const s = raw.replace(/[,\s+円口株]/g, '')
  if (s === '' || s === '-' || s === '--') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** UTF-8 (with or without BOM), falling back to Shift_JIS for older exports. */
export function decodeBrokerCsv(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  if (!utf8.includes('�')) return utf8
  try { return new TextDecoder('shift_jis').decode(bytes) } catch { return utf8 }
}

export function accountFromSection(title: string): HoldingAccount {
  if (title.includes('旧NISA') || title.includes('旧ＮＩＳＡ')) return 'nisa-legacy'
  if (/NISA|ＮＩＳＡ/.test(title)) {
    if (title.includes('つみたて')) return 'nisa-tsumitate'
    if (title.includes('成長')) return 'nisa-growth'
    return 'nisa-growth'
  }
  if (title.includes('特定')) return 'taxable'
  if (title.includes('一般')) return 'general'
  return 'unknown'
}

// ---------- SBI証券 保有証券一覧 ----------

/**
 * SBI証券「保有証券一覧」: one file with titled sections (株式（特定預り）,
 * 株式（NISA預り（成長投資枠））, 投資信託（…）…). Each section has an optional
 * 合計 block and a header row (銘柄コード… for stocks, ファンド名… for funds).
 */
export function parseSbiHoldings(text: string, broker = 'sbi'): ParsedHoldings {
  const stocks: StockHolding[] = []
  const funds: FundHolding[] = []
  const warnings: string[] = []
  let section = ''
  let mode: 'stock' | 'fund' | null = null
  let col: Record<string, number> = {}

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const cells = parseCsvLine(rawLine)
    if (cells.filter(Boolean).length === 1 && cells[0] && !/^[+-]?[\d,.]+$/.test(cells[0])) {
      section = cells[0]
      mode = null
      continue
    }
    if (cells[0] === '銘柄コード' || cells[0] === 'ファンド名') {
      mode = cells[0] === '銘柄コード' ? 'stock' : 'fund'
      col = Object.fromEntries(cells.map((name, i) => [name, i]))
      continue
    }
    if (cells[0] === '評価額合計') { mode = null; continue }
    if (!mode || section.endsWith('合計')) continue

    const get = (name: string) => (col[name] == null ? undefined : cells[col[name]])
    const account = accountFromSection(section)
    if (mode === 'stock') {
      const code = (get('銘柄コード') ?? '').toUpperCase()
      const quantity = parseNumber(get('保有株数'))
      if (!/^[0-9][0-9A-Z]{3}$/.test(code) || quantity == null) {
        warnings.push(`skipped an unreadable stock row in ${section}`)
        continue
      }
      stocks.push({
        broker, account, accountLabel: section, code, name: get('銘柄名称') ?? '', quantity,
        pendingSell: parseNumber(get('売却注文中')),
        avgCost: parseNumber(get('取得単価')), exportPrice: parseNumber(get('現在値')),
        costJpy: parseNumber(get('取得金額')), exportValueJpy: parseNumber(get('評価額')), exportPnlJpy: parseNumber(get('評価損益')),
      })
    } else {
      const name = get('ファンド名') ?? ''
      const units = parseNumber(get('保有口数'))
      if (!name || units == null) {
        warnings.push(`skipped an unreadable fund row in ${section}`)
        continue
      }
      funds.push({
        broker, account, accountLabel: section, name, units,
        pendingSell: parseNumber(get('売却注文中')),
        avgCost: parseNumber(get('取得単価')), nav: parseNumber(get('基準価額')),
        costJpy: parseNumber(get('取得金額')), valueJpy: parseNumber(get('評価額')), pnlJpy: parseNumber(get('評価損益')),
        distribution: get('分配金受取方法') || null,
      })
    }
  }
  if (!stocks.length && !funds.length) warnings.push('no holdings rows recognised — is this an SBI 保有証券一覧 export?')
  return { stocks, funds, warnings }
}

const ymd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

export const BROKER_FORMATS: readonly BrokerFormat[] = [
  {
    broker: 'sbi',
    label: 'SBI証券',
    match: (name) => {
      const m = /^SBI保有証券一覧_(\d{8})(?:[_ (（].*)?\.csv$/i.exec(name.normalize('NFC'))
      return m ? ymd(m[1]) : null
    },
    parse: parseSbiHoldings,
  },
]

// ---------- discovery ----------

/**
 * Find broker exports in the given folders (each scanned one level deep, so
 * both `holdings/` and `holdings/sbi/` work). Missing folders are ignored.
 */
export async function findHoldingsExports(dirs: readonly string[]): Promise<HoldingsExportFile[]> {
  const found = new Map<string, HoldingsExportFile>()
  const visit = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (depth > 0 && !entry.name.startsWith('.')) await visit(path, depth - 1); continue }
      if (!entry.isFile()) continue
      for (const format of BROKER_FORMATS) {
        const date = format.match(entry.name)
        if (date) { found.set(`${format.broker}|${date}|${entry.name}`, { broker: format.broker, brokerLabel: format.label, date, path }); break }
      }
    }
  }
  for (const dir of dirs) await visit(dir, 1)
  return [...found.values()].sort((a, b) => a.broker.localeCompare(b.broker) || a.date.localeCompare(b.date) || a.path.localeCompare(b.path))
}

export async function readHoldingsExport(file: HoldingsExportFile): Promise<ParsedHoldings> {
  const format = BROKER_FORMATS.find((f) => f.broker === file.broker)
  if (!format) throw new Error(`no parser for broker ${file.broker}`)
  return format.parse(decodeBrokerCsv(await readFile(file.path)), file.broker)
}

// ---------- view ----------

export interface HoldingsChange {
  broker: string; account: HoldingAccount; code: string; name: string
  kind: 'added' | 'removed' | 'increased' | 'decreased'
  previousQuantity: number; quantity: number
}

export interface EnrichedStockHolding extends StockHolding {
  /** Latest kabu close (raw, the price a share trades at) and its date. */
  price: number | null
  priceDate: string | null
  valueJpy: number | null
  pnlJpy: number | null
  pnlPct: number | null
  /** Share of the stock portfolio's current value, %. */
  weightPct: number | null
  sector33: string | null
  signal: { date: string; signal: string; level: string | null } | null
}

export interface JpHoldingsView {
  asOf: string | null
  sources: Array<{ broker: string; brokerLabel: string; file: string; date: string; previousDate: string | null; history: string[] }>
  stocks: EnrichedStockHolding[]
  funds: FundHolding[]
  totals: {
    stocks: { costJpy: number; valueJpy: number; pnlJpy: number; pnlPct: number | null; positions: number }
    funds: { costJpy: number; valueJpy: number; pnlJpy: number; positions: number; valuedAt: 'export' }
    byAccount: Array<{ account: HoldingAccount; valueJpy: number; pnlJpy: number; positions: number }>
    bySector: Array<{ sector33: string; valueJpy: number; weightPct: number; codes: string[] }>
  }
  changes: HoldingsChange[]
  notes: string[]
  warnings: string[]
}

export interface HoldingsDeps {
  dirs: readonly string[]
  kabu: KabuDbConfig | null
  fetchImpl?: FetchLike
  now?: () => Date
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((s, v) => s + (v ?? 0), 0)

export function diffHoldings(previous: readonly StockHolding[], latest: readonly StockHolding[]): HoldingsChange[] {
  const key = (h: StockHolding) => `${h.broker}|${h.account}|${h.code}`
  const prev = new Map(previous.map((h) => [key(h), h]))
  const next = new Map(latest.map((h) => [key(h), h]))
  const changes: HoldingsChange[] = []
  for (const [k, h] of next) {
    const p = prev.get(k)
    const base = { broker: h.broker, account: h.account, code: h.code, name: h.name, quantity: h.quantity }
    if (!p) changes.push({ ...base, kind: 'added', previousQuantity: 0 })
    else if (h.quantity > p.quantity) changes.push({ ...base, kind: 'increased', previousQuantity: p.quantity })
    else if (h.quantity < p.quantity) changes.push({ ...base, kind: 'decreased', previousQuantity: p.quantity })
  }
  for (const [k, p] of prev) {
    if (!next.has(k)) changes.push({ broker: p.broker, account: p.account, code: p.code, name: p.name, kind: 'removed', previousQuantity: p.quantity, quantity: 0 })
  }
  const order = { added: 0, increased: 1, decreased: 2, removed: 3 }
  return changes.sort((a, b) => order[a.kind] - order[b.kind] || a.code.localeCompare(b.code))
}

interface CloseRow { stock_code: string; ts: string; close: number | null }
interface SectorRow { stock_code: string; sector_33_name: string | null }
interface SignalRow { kabu_code: string; create_date: string; signal: string; level: string | null }

async function enrichFromKabu(codes: string[], deps: HoldingsDeps, warnings: string[]) {
  const prices = new Map<string, { price: number; date: string }>()
  const sectors = new Map<string, string>()
  const signals = new Map<string, { date: string; signal: string; level: string | null }>()
  if (!deps.kabu || !codes.length) return { prices, sectors, signals }
  const now = deps.now?.() ?? new Date()
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const list = codes.join(',')
  const [closes, stocks, sigs] = await Promise.all([
    kabuDbGetAll<CloseRow>(deps.kabu, `ohlcv_daily?stock_code=in.(${list})&ts=gte.${since(21)}&select=stock_code,ts,close&order=ts.desc`, deps.fetchImpl)
      .catch((err) => { warnings.push(`kabu closes unavailable: ${(err as Error).message}`); return [] as CloseRow[] }),
    kabuDbGetAll<SectorRow>(deps.kabu, `stocks?stock_code=in.(${list})&select=stock_code,sector_33_name`, deps.fetchImpl)
      .catch((err) => { warnings.push(`kabu sectors unavailable: ${(err as Error).message}`); return [] as SectorRow[] }),
    kabuDbGetAll<SignalRow>(deps.kabu, `kabuyoho_signal?kabu_code=in.(${list})&create_date=gte.${since(14)}&select=kabu_code,create_date,signal,level&order=create_date.desc`, deps.fetchImpl)
      .catch((err) => { warnings.push(`kabuyoho signals unavailable: ${(err as Error).message}`); return [] as SignalRow[] }),
  ])
  for (const r of closes) if (r.close != null && r.close > 0 && !prices.has(r.stock_code)) prices.set(r.stock_code, { price: r.close, date: r.ts.slice(0, 10) })
  for (const r of stocks) if (r.sector_33_name) sectors.set(r.stock_code, r.sector_33_name)
  for (const r of sigs) if (!signals.has(r.kabu_code)) signals.set(r.kabu_code, { date: r.create_date, signal: r.signal, level: r.level?.trim() || null })
  return { prices, sectors, signals }
}

/**
 * The latest export per broker (on or before `asOf`), enriched and diffed
 * against that broker's previous export.
 */
export async function loadJpHoldings(deps: HoldingsDeps, asOf?: string): Promise<JpHoldingsView> {
  const warnings: string[] = []
  const notes: string[] = []
  const files = (await findHoldingsExports(deps.dirs)).filter((f) => !asOf || f.date <= asOf)
  const byBroker = new Map<string, HoldingsExportFile[]>()
  for (const f of files) byBroker.set(f.broker, [...(byBroker.get(f.broker) ?? []), f])

  const sources: JpHoldingsView['sources'] = []
  const latestStocks: StockHolding[] = []
  const funds: FundHolding[] = []
  const changes: HoldingsChange[] = []
  for (const [broker, list] of byBroker) {
    const latest = list.at(-1)!
    const previous = list.length > 1 ? list.at(-2)! : null
    const parsed = await readHoldingsExport(latest)
    warnings.push(...parsed.warnings.map((w) => `${basename(latest.path)}: ${w}`))
    latestStocks.push(...parsed.stocks)
    funds.push(...parsed.funds)
    if (previous) changes.push(...diffHoldings((await readHoldingsExport(previous)).stocks, parsed.stocks))
    sources.push({ broker, brokerLabel: latest.brokerLabel, file: basename(latest.path), date: latest.date, previousDate: previous?.date ?? null, history: list.map((f) => f.date) })
  }
  if (!sources.length) {
    notes.push(`No broker exports found. Put CSV exports in ${deps.dirs[0] ?? 'data/holdings'}/<broker>/ (e.g. sbi/SBI保有証券一覧_YYYYMMDD.csv).`)
  }

  const codes = [...new Set(latestStocks.map((s) => s.code))]
  const { prices, sectors, signals } = await enrichFromKabu(codes, deps, warnings)
  if (!deps.kabu && codes.length) notes.push('kabu gateway not configured: values use the export-time prices, without sectors or signals.')

  const enriched: EnrichedStockHolding[] = latestStocks.map((h) => {
    const live = prices.get(h.code)
    const price = live?.price ?? h.exportPrice
    const valueJpy = price != null ? round(price * h.quantity, 0) : h.exportValueJpy
    const costJpy = h.costJpy ?? (h.avgCost != null ? round(h.avgCost * h.quantity, 0) : null)
    const pnlJpy = valueJpy != null && costJpy != null ? round(valueJpy - costJpy, 0) : null
    return {
      ...h,
      price,
      priceDate: live?.date ?? null,
      valueJpy,
      pnlJpy,
      pnlPct: pnlJpy != null && costJpy ? round((pnlJpy / costJpy) * 100) : null,
      weightPct: null,
      sector33: sectors.get(h.code) ?? null,
      signal: signals.get(h.code) ?? null,
    }
  })
  const missingPrices = enriched.filter((h) => deps.kabu && h.priceDate == null).map((h) => h.code)
  if (missingPrices.length) warnings.push(`no recent kabu close for ${missingPrices.join(', ')}: export-time price used`)

  const totalValue = sum(enriched.map((h) => h.valueJpy))
  for (const h of enriched) h.weightPct = h.valueJpy != null && totalValue > 0 ? round((h.valueJpy / totalValue) * 100) : null
  enriched.sort((a, b) => (b.valueJpy ?? 0) - (a.valueJpy ?? 0))

  const totalCost = sum(enriched.map((h) => h.costJpy))
  const accounts = new Map<HoldingAccount, { valueJpy: number; pnlJpy: number; positions: number }>()
  for (const h of enriched) {
    const a = accounts.get(h.account) ?? { valueJpy: 0, pnlJpy: 0, positions: 0 }
    a.valueJpy += h.valueJpy ?? 0; a.pnlJpy += h.pnlJpy ?? 0; a.positions++
    accounts.set(h.account, a)
  }
  const sectorsAgg = new Map<string, { valueJpy: number; codes: string[] }>()
  for (const h of enriched) {
    const name = h.sector33 ?? '(unknown)'
    const s = sectorsAgg.get(name) ?? { valueJpy: 0, codes: [] }
    s.valueJpy += h.valueJpy ?? 0
    if (!s.codes.includes(h.code)) s.codes.push(h.code)
    sectorsAgg.set(name, s)
  }

  return {
    asOf: sources.map((s) => s.date).sort().at(-1) ?? null,
    sources,
    stocks: enriched,
    funds,
    totals: {
      stocks: { costJpy: round(totalCost, 0), valueJpy: round(totalValue, 0), pnlJpy: round(totalValue - totalCost, 0), pnlPct: totalCost > 0 ? round(((totalValue - totalCost) / totalCost) * 100) : null, positions: enriched.length },
      funds: { costJpy: round(sum(funds.map((f) => f.costJpy)), 0), valueJpy: round(sum(funds.map((f) => f.valueJpy)), 0), pnlJpy: round(sum(funds.map((f) => f.pnlJpy)), 0), positions: funds.length, valuedAt: 'export' },
      byAccount: [...accounts].map(([account, a]) => ({ account, valueJpy: round(a.valueJpy, 0), pnlJpy: round(a.pnlJpy, 0), positions: a.positions })),
      bySector: [...sectorsAgg]
        .map(([sector33, s]) => ({ sector33, valueJpy: round(s.valueJpy, 0), weightPct: totalValue > 0 ? round((s.valueJpy / totalValue) * 100) : 0, codes: s.codes }))
        .sort((a, b) => b.valueJpy - a.valueJpy),
    },
    changes,
    notes,
    warnings,
  }
}
