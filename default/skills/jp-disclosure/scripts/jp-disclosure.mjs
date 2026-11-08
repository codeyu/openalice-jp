#!/usr/bin/env node
// jp-disclosure — read-only access to Japanese corporate disclosures.
//   TDnet  (適時開示): public viewing pages, last 31 days, no key.
//   EDINET (法定開示): official API v2, needs a free Subscription-Key.
// Zero dependencies; requires Node 18+.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  EDINET_BASE, EDINET_DOC_TYPES, EDINET_FILE_TYPES, TDNET_RETENTION_DAYS,
  daysBetween, decodeText, filterEdinetDocs, filterTdnetRows, formatFactValue, isKeySummaryItem, parseIxbrlFacts,
  parseIxbrlHeader, parseTdnetList, readZip, recentDates, redactKey, resolveTdnetUrl, safeEntryPath,
  summarizeEdinetDoc, tdnetListUrl, tdnetPageCount, todayJst,
} from './lib.mjs'

const USER_AGENT = 'jp-disclosure-skill/1.0'
const DEFAULT_OUT = '.jp-disclosure'
const TDNET_DELAY_MS = 400
const EDINET_DELAY_MS = 300
const CACHE_DIR = join(tmpdir(), 'jp-disclosure-cache')
const CACHE_TTL_MS = 6 * 3600_000

const HELP = `jp-disclosure — Japanese corporate disclosures (TDnet / EDINET), read-only

TDnet (適時開示, last ${TDNET_RETENTION_DAYS} days, no key):
  tdnet list [--code 7203,6976] [--query 決算|承認] [--date YYYY-MM-DD] [--days N] [--limit N] [--json]
  tdnet download <pdf-or-zip URL | file name> [--out DIR]
  tdnet summary <XBRL zip URL | local .zip> [--all] [--json]

EDINET (有価証券報告書 etc., needs EDINET_API_KEY):
  edinet list [--code 6976] [--type 120,160,180] [--query Q] [--date YYYY-MM-DD] [--days N] [--json]
  edinet download <docID> [--type csv|pdf|xbrl|english|attach] [--out DIR]

Defaults: --date = today in JST, --days 1, --out ${DEFAULT_OUT}/ (self-gitignored).
Codes are 4-character TSE codes (7203, 130A). --query is a case-insensitive regex.
EDINET doc types: ${Object.entries(EDINET_DOC_TYPES).map(([k, v]) => `${k}=${v}`).join(', ')}`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2)
      if (inline !== undefined) flags[k] = inline
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const warn = (msg) => process.stderr.write(`${msg}\n`)

function intFlag(v, fallback, name) {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
  return n
}

async function httpGet(url, { secret } = {}) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  } catch (err) {
    throw new Error(redactKey(`request failed: ${url}: ${err.message}`, secret))
  }
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body }
}

async function cachedGet(url, cacheable) {
  const file = join(CACHE_DIR, basename(new URL(url).pathname))
  if (cacheable) {
    try {
      if (Date.now() - (await stat(file)).mtimeMs < CACHE_TTL_MS) return { status: 200, body: await readFile(file), cached: true }
    } catch { /* cache miss */ }
  }
  const res = await httpGet(url)
  if (cacheable && res.status === 200) {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(file, res.body)
  }
  return res
}

async function ensureOutDir(out) {
  const dir = resolve(out)
  await mkdir(dir, { recursive: true })
  if (basename(dir) === DEFAULT_OUT) {
    // Raw filings are large and reproducible: keep them out of the Workspace's Git history.
    await writeFile(join(dir, '.gitignore'), '*\n').catch(() => {})
  }
  return dir
}

async function writeEntries(entries, dir, transform = (e) => e.data) {
  const written = []
  for (const e of entries) {
    const rel = safeEntryPath(e.name)
    const target = join(dir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, transform(e))
    written.push(target)
  }
  return written
}

// ---------------- TDnet ----------------

async function tdnetList(flags) {
  const today = todayJst()
  const end = typeof flags.date === 'string' ? flags.date : today
  const dates = recentDates(end, intFlag(flags.days, 1, 'days'))
  const codes = list(flags.code)
  const query = typeof flags.query === 'string' ? flags.query : undefined
  const limit = intFlag(flags.limit, 200, 'limit')
  const matches = []
  let requests = 0

  for (const date of dates) {
    if (daysBetween(date, today) >= TDNET_RETENTION_DAYS) {
      warn(`skip ${date}: TDnet only keeps the last ${TDNET_RETENTION_DAYS} days (use edinet for older filings)`)
      continue
    }
    if (daysBetween(date, today) < 0) continue
    let pages = 1
    for (let page = 1; page <= pages; page++) {
      if (requests++ > 0) await sleep(TDNET_DELAY_MS)
      const res = await cachedGet(tdnetListUrl(date, page), date < today && flags['no-cache'] !== true)
      if (res.status === 404) break
      if (res.status !== 200) throw new Error(`TDnet returned HTTP ${res.status} for ${date} page ${page}`)
      const parsed = parseTdnetList(res.body.toString('utf8'), date)
      pages = tdnetPageCount(parsed.total)
      matches.push(...filterTdnetRows(parsed.rows, { codes, query }))
    }
  }

  const rows = matches.slice(0, limit)
  if (flags.json) {
    console.log(JSON.stringify({ source: 'tdnet', dates, matched: matches.length, shown: rows.length, rows }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log(`No TDnet disclosures matched (${dates.at(-1)} … ${dates[0]}).`)
    return
  }
  for (const r of rows) {
    console.log(`${r.date} ${r.time}  ${r.code} ${r.company}  ${r.title}`)
    console.log(`    pdf: ${r.pdfUrl ?? '-'}${r.xbrlUrl ? `\n    xbrl: ${r.xbrlUrl}` : ''}${r.history ? `\n    更新: ${r.history}` : ''}`)
  }
  if (matches.length > rows.length) console.log(`… ${matches.length - rows.length} more (raise --limit or narrow --code/--query)`)
}

async function tdnetDownload(target, flags) {
  if (!target) throw new Error('usage: tdnet download <pdf-or-zip URL | file name> [--out DIR]')
  const url = resolveTdnetUrl(target)
  const res = await httpGet(url)
  if (res.status !== 200) throw new Error(`TDnet returned HTTP ${res.status} for ${url}`)
  const dir = await ensureOutDir(typeof flags.out === 'string' ? flags.out : DEFAULT_OUT)
  const name = basename(new URL(url).pathname)
  if (name.endsWith('.zip')) {
    const written = await writeEntries(readZip(res.body), join(dir, 'tdnet', name.replace(/\.zip$/, '')))
    console.log(`Extracted ${written.length} files:\n${written.map((f) => `  ${f}`).join('\n')}`)
  } else {
    const file = join(dir, 'tdnet', name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, res.body)
    console.log(`Saved ${file} (${res.body.length.toLocaleString('en-US')} bytes)`)
  }
}

async function tdnetSummary(target, flags) {
  if (!target) throw new Error('usage: tdnet summary <XBRL zip URL | local .zip> [--all] [--json]')
  let buf
  if (/^https?:|^[0-9]+\.zip$/i.test(target)) {
    const res = await httpGet(resolveTdnetUrl(target))
    if (res.status !== 200) throw new Error(`TDnet returned HTTP ${res.status} for ${target}`)
    buf = res.body
  } else {
    buf = await readFile(target)
  }
  const docs = readZip(buf).filter((e) => /-ixbrl\.htm$/i.test(e.name) && (flags.all || /\/Summary\//i.test(`/${e.name}`)))
  if (docs.length === 0) throw new Error('no inline XBRL summary found in this archive (not a 決算短信 XBRL zip?)')

  const result = docs.map((d) => {
    const html = decodeText(d.data)
    const facts = parseIxbrlFacts(html)
    return {
      file: d.name,
      header: parseIxbrlHeader(html),
      facts: flags.all ? facts : facts.filter((f) => isKeySummaryItem(f.name)),
    }
  })
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const doc of result) {
    const h = doc.header
    console.log(`${h.CompanyName ?? ''} ${h.SecuritiesCode ?? ''}  ${h.DocumentName ?? doc.file}  提出日 ${h.FilingDate ?? '?'}`)
    const byContext = new Map()
    for (const f of doc.facts) {
      if (f.value === null) continue // nil cells (―) are noise in the text view; --json keeps them
      if (!byContext.has(f.context)) byContext.set(f.context, [])
      byContext.get(f.context).push(f)
    }
    for (const [context, facts] of byContext) {
      console.log(`  [${context}]`)
      for (const f of facts) console.log(`    ${f.name}: ${formatFactValue(f)}`)
    }
  }
}

// ---------------- EDINET ----------------

async function edinetKey() {
  if (process.env.EDINET_API_KEY) return process.env.EDINET_API_KEY.trim()
  const home = process.env.OPENALICE_HOME || join(homedir(), '.openalice')
  const file = process.env.JP_DISCLOSURE_CONFIG || join(home, 'data', 'config', 'jp-disclosure.json')
  try {
    const key = JSON.parse(await readFile(file, 'utf8')).edinetApiKey
    if (typeof key === 'string' && key.trim()) return key.trim()
  } catch { /* fall through */ }
  throw new Error(
    'EDINET API key not configured. Ask the user to register at https://api.edinet-fsa.go.jp/ '
    + `and set EDINET_API_KEY, or put {"edinetApiKey": "..."} in ${file}. Never write the key into Workspace files.`,
  )
}

function edinetError(body, status) {
  try {
    const j = JSON.parse(decodeText(body))
    const s = j.StatusCode ?? j.metadata?.status
    const m = j.message ?? j.metadata?.message
    if (s || m) return `EDINET error ${s ?? status}: ${m ?? ''}`.trim()
  } catch { /* not JSON */ }
  return `EDINET returned HTTP ${status}`
}

async function edinetList(flags) {
  const key = await edinetKey()
  const end = typeof flags.date === 'string' ? flags.date : todayJst()
  const dates = recentDates(end, intFlag(flags.days, 1, 'days'))
  const filters = { codes: list(flags.code), docTypes: list(flags.type), query: typeof flags.query === 'string' ? flags.query : undefined }
  const docs = []
  for (const [i, date] of dates.entries()) {
    if (i > 0) await sleep(EDINET_DELAY_MS)
    const url = `${EDINET_BASE}documents.json?date=${date}&type=2&Subscription-Key=${encodeURIComponent(key)}`
    const res = await httpGet(url, { secret: key })
    const text = decodeText(res.body)
    let json
    try { json = JSON.parse(text) } catch { throw new Error(edinetError(res.body, res.status)) }
    // EDINET can answer HTTP 200 with an error body ({StatusCode: 401} or metadata.status "4xx").
    const apiStatus = String(json.StatusCode ?? json.metadata?.status ?? res.status)
    if (res.status !== 200 || apiStatus !== '200' || !Array.isArray(json.results)) throw new Error(edinetError(res.body, res.status))
    docs.push(...filterEdinetDocs(json.results ?? [], filters).map(summarizeEdinetDoc))
  }
  if (flags.json) {
    console.log(JSON.stringify({ source: 'edinet', dates, matched: docs.length, docs }, null, 2))
    return
  }
  if (docs.length === 0) {
    console.log(`No EDINET filings matched (${dates.at(-1)} … ${dates[0]}).`)
    return
  }
  for (const d of docs) {
    console.log(`${d.submitted}  ${d.docID}  ${d.code ?? '----'} ${d.filer}  ${d.description}`)
    console.log(`    type ${d.docType}${d.docTypeName ? ` ${d.docTypeName}` : ''}  period ${d.periodStart ?? '?'}…${d.periodEnd ?? '?'}  files: ${d.files.join(', ') || '-'}${d.withdrawn ? '  (withdrawn)' : ''}`)
  }
}

async function edinetDownload(docId, flags) {
  if (!docId || !/^[A-Z0-9]{8}$/i.test(docId)) throw new Error('usage: edinet download <docID like S100ABCD> [--type csv|pdf|xbrl|english|attach] [--out DIR]')
  const kind = typeof flags.type === 'string' ? flags.type : 'csv'
  const type = EDINET_FILE_TYPES[kind]
  if (!type) throw new Error(`--type must be one of ${Object.keys(EDINET_FILE_TYPES).join(', ')}`)
  const key = await edinetKey()
  const url = `${EDINET_BASE}documents/${docId}?type=${type}&Subscription-Key=${encodeURIComponent(key)}`
  const res = await httpGet(url, { secret: key })
  if (res.status !== 200 || res.contentType.includes('json')) throw new Error(edinetError(res.body, res.status))

  const dir = join(await ensureOutDir(typeof flags.out === 'string' ? flags.out : DEFAULT_OUT), 'edinet', docId)
  await mkdir(dir, { recursive: true })
  if (kind === 'pdf') {
    const file = join(dir, `${docId}.pdf`)
    await writeFile(file, res.body)
    console.log(`Saved ${file} (${res.body.length.toLocaleString('en-US')} bytes)`)
    return
  }
  // CSV files arrive as UTF-16LE TSV; rewrite them as UTF-8 so grep and agents can read them.
  const written = await writeEntries(readZip(res.body), dir, (e) =>
    /\.(csv|tsv|txt)$/i.test(e.name) ? Buffer.from(decodeText(e.data), 'utf8') : e.data)
  console.log(`Extracted ${written.length} files${kind === 'csv' ? ' (CSV converted to UTF-8, tab-separated)' : ''}:\n${written.map((f) => `  ${f}`).join('\n')}`)
}

// ---------------- main ----------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [source, command, target] = positional
  if (!source || flags.help || source === 'help') {
    console.log(HELP)
    return
  }
  if (source === 'tdnet' && command === 'list') return tdnetList(flags)
  if (source === 'tdnet' && command === 'download') return tdnetDownload(target, flags)
  if (source === 'tdnet' && command === 'summary') return tdnetSummary(target, flags)
  if (source === 'edinet' && command === 'list') return edinetList(flags)
  if (source === 'edinet' && command === 'download') return edinetDownload(target, flags)
  throw new Error(`unknown command: ${positional.join(' ')}\n\n${HELP}`)
}

main().catch((err) => {
  warn(`jp-disclosure: ${err.message}`)
  process.exitCode = 1
})
