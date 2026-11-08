/**
 * Read-only client for a self-hosted kabu gateway database (PostgREST at
 * `<baseUrl>/rest/v1/`). Uses only the read-only DB token; the gateway's
 * order-capable token is never handled here.
 */

export interface KabuDbConfig {
  baseUrl: string
  token: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const PAGE_SIZE = 1000
const MAX_PAGES = 20

export class KabuDbError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'KabuDbError'
  }
}

export function kabuDbUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/rest/v1/${path.replace(/^\/+/, '')}`
}

export async function kabuDbGet<T>(cfg: KabuDbConfig, path: string, fetchImpl: FetchLike = fetch): Promise<T[]> {
  let res: Response
  try {
    res = await fetchImpl(kabuDbUrl(cfg.baseUrl, path), {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new KabuDbError(`kabu DB unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 401 || res.status === 403) throw new KabuDbError('kabu DB rejected the token (check the read-only token in Settings → Market Data)', res.status)
  if (res.status !== 200 && res.status !== 206) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    throw new KabuDbError(`kabu DB returned HTTP ${res.status}${body ? `: ${body}` : ''}`, res.status)
  }
  const data = await res.json()
  if (!Array.isArray(data)) throw new KabuDbError('kabu DB returned a non-array payload')
  return data as T[]
}

/** Page through a PostgREST query with limit/offset (servers often cap rows per response). */
export async function kabuDbGetAll<T>(cfg: KabuDbConfig, path: string, fetchImpl: FetchLike = fetch): Promise<T[]> {
  const sep = path.includes('?') ? '&' : '?'
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await kabuDbGet<T>(cfg, `${path}${sep}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, fetchImpl)
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
  throw new KabuDbError(`kabu DB query exceeded ${MAX_PAGES * PAGE_SIZE} rows: ${path.split('?')[0]}`)
}
