import { describe, expect, it } from 'vitest'

import { parseHtmlList } from './html-list-parser.js'
import { newsCollectorSchema } from '../config.js'
import { JP_NEWS_FEEDS } from '../jp-feeds.js'

const KABUTAN = `
<ul>
  <li><a href="/disclosures/" target="_top">会社開示情報</a></li>
  <li><time datetime="2026-11-08T08:00+09:00">08:00</time>
    <a href="/news/marketnews/?b=n202611080046" target="_top">【明日の好悪材料】を開示情報でチェック！ (11月6日発表分)</a></li>
  <li><a href="/news/marketnews/?b=n202611070243" target="_top">脱「マイクロプラスチック」で浮上する妙味株6選 ＜株探トップ特集＞</a></li>
  <li><a href="/news/marketnews/?b=n202611070243#comments">脱「マイクロプラスチック」</a></li>
  <li><a href="/news/marketnews/?b=n202611080046&amp;page=2">2ページ目</a></li>
  <li><a href="https://evil.example.com/news/marketnews/?b=n202611080099">外部サイトの記事タイトルです</a></li>
</ul>`

const MONEX = `
<a href="/articles/-/30392" class="top-pickup-article__ttl">本の輪廻について考える</a>
<a href="/articles/-/30392">もっと読む</a>
<a href="/articles/-/30450" class="ttl"><span>【日本株】</span>注目15銘柄はどれ？</a>
<a href='/articles/-/30451'>【米国株：銘柄発掘】業績上振れ5銘柄</a>
<a href="/list/authors">著者一覧ページへのリンク</a>`

describe('parseHtmlList', () => {
  it('collects same-origin article links that match the pattern, dated from the URL', () => {
    const items = parseHtmlList(KABUTAN, 'https://kabutan.jp/news/marketnews/', {
      linkPattern: '^/news/marketnews/\\?b=n\\d{12}$',
      linkDatePattern: 'b=n(?<y>\\d{4})(?<m>\\d{2})(?<d>\\d{2})',
    })
    expect(items.map((i) => [i.link, i.title])).toEqual([
      ['https://kabutan.jp/news/marketnews/?b=n202611080046', '【明日の好悪材料】を開示情報でチェック！ (11月6日発表分)'],
      ['https://kabutan.jp/news/marketnews/?b=n202611070243', '脱「マイクロプラスチック」で浮上する妙味株6選 ＜株探トップ特集＞'],
    ])
    expect(items[0].pubDate?.toISOString()).toBe('2026-11-07T15:00:00.000Z')
    expect(items[0]).toMatchObject({ content: '', guid: items[0].link })
  })

  it('keeps the headline over a short "read more" link and strips inner markup', () => {
    const items = parseHtmlList(MONEX, 'https://media.monex.co.jp/', { linkPattern: '^/articles/-/\\d+$' })
    expect(items.map((i) => i.title)).toEqual([
      '本の輪廻について考える',
      '【日本株】 注目15銘柄はどれ？',
      '【米国株：銘柄発掘】業績上振れ5銘柄',
    ])
    expect(items.every((i) => i.pubDate === null)).toBe(true)
  })

  it('honours maxItems and minTitleLength', () => {
    const items = parseHtmlList(MONEX, 'https://media.monex.co.jp/', { linkPattern: '^/articles/-/\\d+$', maxItems: 1 })
    expect(items).toHaveLength(1)
    const strict = parseHtmlList(MONEX, 'https://media.monex.co.jp/', { linkPattern: '^/articles/-/\\d+$', minTitleLength: 17 })
    expect(strict.map((i) => i.title)).toEqual(['【米国株：銘柄発掘】業績上振れ5銘柄'])
  })
})

describe('news config — html feeds', () => {
  it('accepts the shipped Japanese defaults', () => {
    const parsed = newsCollectorSchema.parse({})
    const jp = parsed.feeds.filter((feed) => feed.categories?.includes('jp'))
    expect(jp).toHaveLength(JP_NEWS_FEEDS.length)
    expect(new Set(parsed.feeds.map((feed) => feed.url)).size).toBe(parsed.feeds.length)
    expect(jp.filter((feed) => feed.kind === 'html').every((feed) => feed.html?.linkPattern)).toBe(true)
  })

  it('rejects an html feed without a link pattern or with an invalid regex', () => {
    const base = { name: 'x', url: 'https://example.com/', source: 'x', kind: 'html' }
    expect(newsCollectorSchema.safeParse({ feeds: [base] }).success).toBe(false)
    expect(newsCollectorSchema.safeParse({ feeds: [{ ...base, html: { linkPattern: '([' } }] }).success).toBe(false)
    expect(newsCollectorSchema.safeParse({ feeds: [{ ...base, html: { linkPattern: '^/a/\\d+$' } }] }).success).toBe(true)
  })
})
