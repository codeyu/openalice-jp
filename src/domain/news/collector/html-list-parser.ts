/**
 * News Collector — HTML headline-list parser
 *
 * For news sites that publish no RSS, a feed can point at a public list page
 * and describe which links are articles with a URL pattern. Only headlines and
 * links are collected (never article bodies), one page per collection pass, so
 * the load matches a reader opening the list page.
 */

import type { HtmlListConfig } from '../types.js'
import type { ParsedFeedItem } from './rss-parser.js'

const DEFAULT_MAX_ITEMS = 40
const DEFAULT_MIN_TITLE_LENGTH = 6

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/[\s　]+/g, ' ').trim()
}

/** Date encoded in the article URL, e.g. kabutan `?b=n202611080046` → 2026-11-08 (JST). */
function dateFromLink(link: string, pattern: RegExp | null): Date | null {
  const g = pattern?.exec(link)?.groups
  if (!g?.y || !g.m || !g.d) return null
  const date = new Date(`${g.y}-${g.m}-${g.d}T${g.H ?? '00'}:${g.M ?? '00'}:00+09:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Extract article links from a list page. Anchors whose resolved path + query
 * match `linkPattern` become items; the longest anchor text per URL wins, so a
 * "read more" link next to the headline does not replace the headline.
 */
export function parseHtmlList(html: string, pageUrl: string, config: HtmlListConfig): ParsedFeedItem[] {
  const linkRe = new RegExp(config.linkPattern)
  const datePattern = config.linkDatePattern ? new RegExp(config.linkDatePattern) : null
  const minTitle = config.minTitleLength ?? DEFAULT_MIN_TITLE_LENGTH
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS
  const page = new URL(pageUrl)
  const byUrl = new Map<string, string>()

  const anchorRe = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(anchorRe)) {
    let url: URL
    try { url = new URL(decodeEntities(m[2]), page) } catch { continue }
    if (url.origin !== page.origin || !linkRe.test(url.pathname + url.search)) continue
    url.hash = ''
    const title = textOf(m[3])
    if (title.length < minTitle) {
      if (!byUrl.has(url.href)) byUrl.set(url.href, '')
      continue
    }
    if ((byUrl.get(url.href) ?? '').length < title.length) byUrl.set(url.href, title)
  }

  const items: ParsedFeedItem[] = []
  for (const [link, title] of byUrl) {
    if (!title) continue
    items.push({ title, content: '', link, guid: link, pubDate: dateFromLink(link, datePattern) })
    if (items.length >= maxItems) break
  }
  return items
}

/** Fetch a list page and parse it. Retries once after a 2s delay on failure. */
export async function fetchAndParseHtmlList(url: string, config: HtmlListConfig, retries = 1): Promise<ParsedFeedItem[]> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'OpenAlice/1.0 NewsCollector', 'Accept-Language': 'ja,en;q=0.5' },
      })
      if (!res.ok) throw new Error(`HTML list fetch failed: ${res.status} ${res.statusText}`)
      return parseHtmlList(await res.text(), res.url || url, config)
    } catch (err) {
      lastError = err
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastError
}
