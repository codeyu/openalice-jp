import { describe, expect, it } from 'vitest'

import { addJpNewsFeeds } from './0045_jp_news_feeds/index.js'
import { JP_FEEDS_0045 } from './0045_jp_news_feeds/feeds.js'

function memoryCtx(initial: Record<string, unknown>) {
  const files = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]))
  let writes = 0
  return {
    files,
    writes: () => writes,
    readJson: async <T>(name: string) => files.get(name) as T | undefined,
    writeJson: async (name: string, data: unknown) => { writes++; files.set(name, structuredClone(data)) },
  }
}

const userFeed = { name: 'My feed', url: 'https://example.com/rss', source: 'mine', enabled: true }

describe('0045_jp_news_feeds', () => {
  it('appends every Japanese feed after the user feeds and keeps other settings', async () => {
    const ctx = memoryCtx({ 'news.json': { enabled: true, intervalMinutes: 15, feeds: [userFeed] } })
    await addJpNewsFeeds(ctx)
    const news = ctx.files.get('news.json') as { intervalMinutes: number; feeds: Array<{ url: string }> }
    expect(news.intervalMinutes).toBe(15)
    expect(news.feeds[0]).toEqual(userFeed)
    expect(news.feeds.slice(1).map((f) => f.url)).toEqual(JP_FEEDS_0045.map((f) => f.url))
  })

  it('leaves feeds the user already has (even edited or disabled) untouched and is idempotent', async () => {
    const edited = { ...JP_FEEDS_0045[0], name: 'NHK (mine)', enabled: false }
    const ctx = memoryCtx({ 'news.json': { feeds: [edited] } })
    await addJpNewsFeeds(ctx)
    await addJpNewsFeeds(ctx)
    const feeds = (ctx.files.get('news.json') as { feeds: Array<{ url: string; name: string }> }).feeds
    expect(feeds).toHaveLength(JP_FEEDS_0045.length)
    expect(feeds[0]).toEqual(edited)
    expect(ctx.writes()).toBe(1)
  })

  it('does nothing for a home without news.json or a malformed one', async () => {
    const empty = memoryCtx({})
    await addJpNewsFeeds(empty)
    expect(empty.writes()).toBe(0)
    const malformed = memoryCtx({ 'news.json': { feeds: 'nope' } })
    await addJpNewsFeeds(malformed)
    expect(malformed.writes()).toBe(0)
  })
})
