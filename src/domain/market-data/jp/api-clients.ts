/**
 * Clients for the two keyed Japanese fundamentals APIs, sized for free plans:
 *
 *  - J-Quants V2 (JPX): `x-api-key`, 5 requests/minute on Free, data delayed
 *    ~12 weeks with ~2 years of history.
 *  - EDINET DB (edinetdb.jp): `X-API-Key`, 100 requests/day on Free.
 *
 * Responses are cached on disk (keyed by path, never by API key) so dev
 * restarts and repeated questions do not burn the daily quota.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class JpApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'JpApiError'
  }
}

// ==================== disk cache ====================

export interface DiskCache {
  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>
}

/** JSON-on-disk TTL cache. A failed load is never written; I/O errors fall back to a live load. */
export function createDiskCache(dir: string, now: () => number = Date.now): DiskCache {
  const inflight = new Map<string, Promise<unknown>>()
  return {
    async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const file = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
      try {
        const hit = JSON.parse(await readFile(file, 'utf8')) as { at: number; key: string; value: T }
        if (hit.key === key && now() - hit.at < ttlMs) return hit.value
      } catch { /* miss */ }
      const pending = inflight.get(key)
      if (pending) return pending as Promise<T>
      const run = (async () => {
        const value = await load()
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(file, JSON.stringify({ at: now(), key, value }))
        } catch { /* cache is best-effort */ }
        return value
      })()
      inflight.set(key, run)
      try { return await run } finally { inflight.delete(key) }
    },
  }
}

// ==================== rate limiting ====================

/** Sliding-window limiter: at most `max` starts per `windowMs`; callers wait their turn. */
export function createRateLimiter(max: number, windowMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), now: () => number = Date.now) {
  const starts: number[] = []
  let chain: Promise<void> = Promise.resolve()
  return {
    acquire(): Promise<void> {
      const next = chain.then(async () => {
        for (;;) {
          const t = now()
          while (starts.length && t - starts[0] >= windowMs) starts.shift()
          if (starts.length < max) { starts.push(t); return }
          await sleep(windowMs - (t - starts[0]) + 50)
        }
      })
      chain = next.catch(() => undefined)
      return next
    },
  }
}

// ==================== J-Quants ====================

export interface JQuantsClient {
  get<T>(path: string, params: Record<string, string>): Promise<T[]>
}

export function createJQuantsClient(apiKey: string, fetchImpl: FetchLike = fetch, limiter = jquantsLimiter): JQuantsClient {
  return {
    async get<T>(path: string, params: Record<string, string>): Promise<T[]> {
      const rows: T[] = []
      let paginationKey: string | undefined
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ ...params, ...(paginationKey ? { pagination_key: paginationKey } : {}) })
        await limiter.acquire()
        const res = await fetchImpl(`https://api.jquants.com/v2${path}?${qs}`, {
          headers: { 'x-api-key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (res.status === 429) throw new JpApiError('J-Quants rate limit reached (Free plan: 5 requests/minute). Wait about 2 minutes before retrying.', 429)
        if (res.status === 401 || res.status === 403) throw new JpApiError('J-Quants rejected the API key (Settings → Market Data).', res.status)
        const body = await res.json().catch(() => null) as { data?: T[]; pagination_key?: string; message?: string } | null
        if (!res.ok) throw new JpApiError(`J-Quants ${path} returned HTTP ${res.status}${body?.message ? `: ${body.message}` : ''}`, res.status)
        rows.push(...(body?.data ?? []))
        paginationKey = body?.pagination_key
        if (!paginationKey) return rows
      }
      return rows
    },
  }
}

/** One account-wide limiter: J-Quants counts per account, not per key. */
export const jquantsLimiter = createRateLimiter(5, 60_000)

// ==================== EDINET DB ====================

export interface EdinetDbClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>
}

export function createEdinetDbClient(apiKey: string, fetchImpl: FetchLike = fetch): EdinetDbClient {
  return {
    async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
      const qs = new URLSearchParams(params).toString()
      const res = await fetchImpl(`https://edinetdb.jp/v1${path}${qs ? `?${qs}` : ''}`, {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429) {
        const retry = res.headers.get('retry-after')
        throw new JpApiError(`EDINET DB quota reached (Free plan: 100 requests/day)${retry ? `; retry after ${retry}s` : ''}.`, 429)
      }
      if (res.status === 401 || res.status === 403) throw new JpApiError('EDINET DB rejected the API key (Settings → Market Data).', res.status)
      const body = await res.json().catch(() => null) as ({ data?: T; error?: string; message?: string } & Record<string, unknown>) | null
      if (!res.ok) throw new JpApiError(`EDINET DB ${path} returned HTTP ${res.status}${body?.error || body?.message ? `: ${body?.error ?? body?.message}` : ''}`, res.status)
      return (body?.data ?? body) as T
    },
  }
}
