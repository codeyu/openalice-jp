import type { Migration, MigrationContext } from '../types.js'
import { JP_FEEDS_0045 } from './feeds.js'

/**
 * Append the Japanese news sources to an existing news.json. Add-only: a feed
 * whose URL is already present (enabled, disabled, or edited) is left alone,
 * and nothing is removed, so a user's own feed choices survive.
 */
export async function addJpNewsFeeds(ctx: Pick<MigrationContext, 'readJson' | 'writeJson'>): Promise<void> {
  const config = await ctx.readJson<Record<string, unknown>>('news.json')
  // A fresh home is seeded from current defaults, which already include these feeds.
  if (!config || !Array.isArray(config.feeds)) return
  const feeds = config.feeds as Array<{ url?: unknown }>
  const known = new Set(feeds.map((feed) => (typeof feed?.url === 'string' ? feed.url : '')))
  const missing = JP_FEEDS_0045.filter((feed) => !known.has(feed.url))
  if (missing.length === 0) return
  await ctx.writeJson('news.json', { ...config, feeds: [...feeds, ...missing.map((feed) => structuredClone(feed))] })
}

export const migration: Migration = {
  id: '0045_jp_news_feeds', appVersion: '0.95.0-beta', introducedAt: '2026-11-08',
  affects: ['news.json'],
  summary: 'Append Japanese news sources (official RSS plus robots-permitted headline list pages) to existing news.json without touching user feeds.',
  up: async (ctx) => addJpNewsFeeds(ctx),
}
