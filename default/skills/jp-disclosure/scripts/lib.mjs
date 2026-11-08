// Pure helpers for the jp-disclosure CLI. No network, no filesystem: every
// function here takes bytes or strings and returns plain data, so it can be
// unit-tested without touching TDnet or EDINET.

import { inflateRawSync } from 'node:zlib'

export const TDNET_BASE = 'https://www.release.tdnet.info/inbs/'
export const EDINET_BASE = 'https://api.edinet-fsa.go.jp/api/v2/'
export const TDNET_PAGE_SIZE = 100
export const TDNET_RETENTION_DAYS = 31

/** EDINET docTypeCode values most useful for equity research. */
export const EDINET_DOC_TYPES = {
  '120': '有価証券報告書',
  '130': '訂正有価証券報告書',
  '140': '四半期報告書',
  '150': '訂正四半期報告書',
  '160': '半期報告書',
  '170': '訂正半期報告書',
  '180': '臨時報告書',
  '190': '訂正臨時報告書',
  '220': '自己株券買付状況報告書',
  '240': '公開買付届出書',
  '350': '大量保有報告書',
  '360': '訂正大量保有報告書',
}

/** EDINET document download `type` parameter. */
export const EDINET_FILE_TYPES = { xbrl: 1, pdf: 2, attach: 3, english: 4, csv: 5 }

/**
 * TSE securities codes are 4 characters ("7203", "130A"); TDnet and EDINET
 * store them with a trailing check digit slot ("72030", "130A0").
 */
export function normalizeCode(code) {
  const c = String(code).trim().toUpperCase()
  if (/^[0-9][0-9A-Z]{3}$/.test(c)) return `${c}0`
  if (/^[0-9][0-9A-Z]{3}0$/.test(c)) return c
  throw new Error(`invalid securities code: ${code} (expected 4 characters such as 7203 or 130A)`)
}

export function displayCode(code5) {
  return code5 && code5.length === 5 && code5.endsWith('0') ? code5.slice(0, 4) : code5
}

/** Today's date in Japan as YYYY-MM-DD. */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
}

/** `count` calendar dates ending at `end` (inclusive), newest first. */
export function recentDates(end, count) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error(`invalid date: ${end} (expected YYYY-MM-DD)`)
  const base = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(base)) throw new Error(`invalid date: ${end}`)
  return Array.from({ length: count }, (_, i) => new Date(base - i * 86400_000).toISOString().slice(0, 10))
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000)
}

export function tdnetListUrl(date, page = 1) {
  return `${TDNET_BASE}I_list_${String(page).padStart(3, '0')}_${date.replaceAll('-', '')}.html`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/[\s　]+/g, ' ').trim()
}

/**
 * Parse one TDnet daily list page (I_list_NNN_YYYYMMDD.html).
 * Returns the day's total count and the rows on this page.
 */
export function parseTdnetList(html, date) {
  const totalMatch = html.match(/全\s*([\d,]+)\s*件/)
  const total = totalMatch ? Number(totalMatch[1].replaceAll(',', '')) : 0
  const rows = []
  const table = html.match(/<table[^>]*id="main-list-table"[^>]*>([\s\S]*?)<\/table>/)
  if (!table) return { total, rows }
  for (const tr of table[1].split(/<tr[^>]*>/).slice(1)) {
    const cell = (cls) => {
      const m = tr.match(new RegExp(`<td[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</td>`))
      return m ? m[1] : ''
    }
    const titleHtml = cell('kjTitle')
    const pdf = titleHtml.match(/href="([^"]+)"/)
    const xbrl = cell('kjXbrl').match(/href="([^"]+)"/)
    const code = cellText(cell('kjCode'))
    if (!code) continue
    rows.push({
      date,
      time: cellText(cell('kjTime')),
      code: displayCode(code),
      company: cellText(cell('kjName')),
      title: cellText(titleHtml),
      pdfUrl: pdf ? new URL(pdf[1], TDNET_BASE).href : null,
      xbrlUrl: xbrl ? new URL(xbrl[1], TDNET_BASE).href : null,
      exchange: cellText(cell('kjPlace')),
      history: cellText(cell('kjHistroy')) || null,
    })
  }
  return { total, rows }
}

export function tdnetPageCount(total) {
  return Math.max(1, Math.ceil(total / TDNET_PAGE_SIZE))
}

/** Accept a bare TDnet file name or a full URL, but only on the TDnet host. */
export function resolveTdnetUrl(input) {
  const url = new URL(input, TDNET_BASE)
  if (url.origin + url.pathname.replace(/[^/]*$/, '') !== TDNET_BASE) {
    throw new Error(`not a TDnet document URL: ${input}`)
  }
  return url.href
}

export function compileQuery(query) {
  if (!query) return null
  try {
    return new RegExp(query, 'i')
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export function filterTdnetRows(rows, { codes, query } = {}) {
  const codeSet = codes?.length ? new Set(codes.map((c) => displayCode(normalizeCode(c)))) : null
  const re = compileQuery(query)
  return rows.filter((r) => (!codeSet || codeSet.has(r.code)) && (!re || re.test(r.title) || re.test(r.company)))
}

export function filterEdinetDocs(results, { codes, docTypes, query } = {}) {
  const codeSet = codes?.length ? new Set(codes.map(normalizeCode)) : null
  const typeSet = docTypes?.length ? new Set(docTypes.map(String)) : null
  const re = compileQuery(query)
  return results.filter((d) =>
    (!codeSet || (d.secCode && codeSet.has(d.secCode)))
    && (!typeSet || typeSet.has(String(d.docTypeCode)))
    && (!re || re.test(d.docDescription ?? '') || re.test(d.filerName ?? '')),
  )
}

export function summarizeEdinetDoc(d) {
  return {
    docID: d.docID,
    submitted: d.submitDateTime,
    code: d.secCode ? displayCode(d.secCode) : null,
    filer: d.filerName,
    docType: d.docTypeCode,
    docTypeName: EDINET_DOC_TYPES[d.docTypeCode] ?? null,
    description: d.docDescription,
    periodStart: d.periodStart ?? null,
    periodEnd: d.periodEnd ?? null,
    files: Object.entries({ xbrl: d.xbrlFlag, pdf: d.pdfFlag, csv: d.csvFlag, english: d.englishDocFlag })
      .filter(([, flag]) => flag === '1')
      .map(([k]) => k),
    withdrawn: d.withdrawalStatus && d.withdrawalStatus !== '0' ? true : undefined,
  }
}

function decodeEntryName(bytes, flags) {
  // Bit 11 marks UTF-8 names; Japanese archives without it are usually Shift_JIS.
  if (flags & 0x800 || bytes.every((b) => b < 0x80)) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Minimal ZIP reader (stored + deflate), enough for TDnet and EDINET archives. */
export function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen)
    const name = decodeEntryName(nameBytes, flags)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry: ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`unsupported zip compression method ${method} for ${name}`)
    entries.push({ name, data })
  }
  return entries
}

/** Reject absolute paths and `..` so archive entries cannot escape the output directory. */
export function safeEntryPath(name) {
  const parts = name.replaceAll('\\', '/').split('/').filter((s) => s && s !== '.')
  if (parts.length === 0 || parts.some((s) => s === '..') || /^[a-z]:$/i.test(parts[0])) {
    throw new Error(`unsafe archive entry: ${name}`)
  }
  return parts.join('/')
}

/** EDINET XBRL-to-CSV files are UTF-16LE with a BOM; fall back to UTF-8. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3))
  return new TextDecoder('utf-8').decode(buf)
}

function attrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2])
  return out
}

/**
 * Extract numeric facts from an inline-XBRL document (TDnet 決算短信 summary).
 * `value` is fully scaled: JPY amounts are in yen, ratios are fractions
 * (12.9% → 0.129). Nil facts keep `value: null`.
 */
export function parseIxbrlFacts(html) {
  const facts = []
  const re = /<ix:nonFraction\b([^>]*?)(\/>|>([\s\S]*?)<\/ix:nonFraction>)/g
  for (const m of html.matchAll(re)) {
    const a = attrs(m[1])
    const name = (a.name ?? '').replace(/^[^:]+:/, '')
    const text = cellText(m[3] ?? '')
    let value = null
    if (a['xsi:nil'] !== 'true' && text) {
      const commaDecimal = (a.format ?? '').includes('numcommadecimal')
      const digits = commaDecimal ? text.replace(/[.\s]/g, '').replace(',', '.') : text.replace(/[,\s]/g, '')
      const n = Number(digits.replace(/^[△▲]/, ''))
      if (Number.isFinite(n)) {
        const scale = Number(a.scale ?? 0)
        const negative = a.sign === '-' || /^[△▲]/.test(text)
        value = Number((n * 10 ** scale * (negative ? -1 : 1)).toPrecision(15))
      }
    }
    facts.push({ name, context: a.contextRef ?? '', unit: a.unitRef ?? null, value })
  }
  return facts
}

/** Selected text facts (company name, document title, filing date...). */
export function parseIxbrlHeader(html) {
  const wanted = new Set(['CompanyName', 'DocumentName', 'FilingDate', 'SecuritiesCode', 'FiscalYearEnd', 'QuarterlyPeriod', 'AccountingStandard'])
  const out = {}
  for (const m of html.matchAll(/<ix:nonNumeric\b([^>]*?)>([\s\S]*?)<\/ix:nonNumeric>/g)) {
    const name = (attrs(m[1]).name ?? '').replace(/^[^:]+:/, '')
    if (wanted.has(name) && !(name in out)) out[name] = cellText(m[2])
  }
  return out
}

/**
 * Key line items from a 決算短信 summary. J-GAAP names are bare; IFRS and US
 * GAAP filers use the same or parallel names with an `IFRS` / `US` suffix.
 */
export const KEY_SUMMARY_ITEMS = [
  // J-GAAP
  'NetSales', 'OperatingRevenues', 'OrdinaryRevenuesBK', 'OrdinaryRevenuesIN', 'OperatingIncome', 'OrdinaryIncome',
  'ProfitAttributableToOwnersOfParent', 'NetIncome', 'NetIncomePerShare',
  'ChangeInNetSales', 'ChangeInOperatingRevenues', 'ChangeInOperatingIncome', 'ChangeInOrdinaryIncome',
  'ChangeInProfitAttributableToOwnersOfParent', 'ChangeInNetIncome',
  'TotalAssets', 'NetAssets', 'CapitalAdequacyRatio', 'NetAssetsPerShare',
  // IFRS / US GAAP base names (suffix stripped)
  'Sales', 'NetSalesAndOperatingRevenues', 'ProfitBeforeTax', 'IncomeBeforeIncomeTaxes', 'Profit', 'BasicEarningsPerShare',
  'ChangeInSales', 'ChangeInNetSalesAndOperatingRevenues', 'ChangeInProfitBeforeTax', 'ChangeInIncomeBeforeIncomeTaxes', 'ChangeInProfit',
  'TotalEquity', 'EquityAttributableToOwnersOfParent', 'EquityAttributableToOwnersOfParentToTotalAssetsRatio',
  'EquityAttributableToOwnersOfParentPerShare', 'ShareholdersEquity', 'ShareholdersEquityToTotalAssetsRatio',
  // both
  'DividendPerShare',
]

const KEY_SET = new Set(KEY_SUMMARY_ITEMS)

export function isKeySummaryItem(name) {
  return KEY_SET.has(name) || KEY_SET.has(name.replace(/(IFRS|US)$/, ''))
}

export function formatFactValue(f) {
  if (f.value === null) return '—'
  if (f.unit === 'JPY') return `${(f.value / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} 百万円`
  if (f.unit === 'Pure') return `${(f.value * 100).toFixed(1)}%`
  if (f.unit === 'JPYPerShares') return `${f.value} 円/株`
  return `${f.value}${f.unit ? ` ${f.unit}` : ''}`
}

export function redactKey(text, key) {
  return key ? String(text).split(key).join('***') : String(text)
}
