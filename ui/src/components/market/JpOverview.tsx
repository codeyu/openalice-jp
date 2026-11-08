import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { barsApi, type AssetClass } from '../../api/market'
import { referenceApi, type JpBreadthResult, type MacroSeriesCard } from '../../api/reference'
import { useWorkspace } from '../../tabs/store'
import { SeriesCard } from './SeriesCard'
import { BoardMeta } from './BoardMeta'
import { Skeleton } from '../StateViews'
import { Button } from '../ui/button'

type IndexKey = 'nikkei' | 'topixEtf' | 'usdjpy'

/** Free vendor bars (no token). TOPIX itself is not on Yahoo, so its tracking ETF stands in. */
const INDEX_SOURCES: ReadonlyArray<{ key: IndexKey; barId: string; assetClass: AssetClass }> = [
  { key: 'nikkei', barId: 'yfinance|^N225', assetClass: 'equity' },
  { key: 'topixEtf', barId: 'yfinance|1306.T', assetClass: 'equity' },
  { key: 'usdjpy', barId: 'yfinance|USDJPY', assetClass: 'currency' },
]

type IndexState = { key: IndexKey; card: MacroSeriesCard | null; error?: string }

export function toSeriesCard(id: string, label: string, bars: ReadonlyArray<{ date: string; close: number }>): MacroSeriesCard {
  const points = bars.filter((b) => Number.isFinite(b.close)).map((b) => ({ date: b.date.slice(0, 10), value: b.close }))
  const last = points.at(-1)
  const prev = points.at(-2)
  return {
    id,
    label,
    unit: 'index',
    points,
    latest: last?.value ?? null,
    latestDate: last?.date ?? null,
    change: last && prev ? last.value - prev.value : null,
  }
}

function IndexStrip() {
  const { t } = useTranslation()
  const [cards, setCards] = useState<IndexState[] | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all(INDEX_SOURCES.map(async ({ key, barId, assetClass }): Promise<IndexState> => {
      try {
        const res = await barsApi.bars({ barId, assetClass, interval: '1d', count: 120 })
        if (!res.results?.length) return { key, card: null, error: res.error ?? 'no data' }
        return { key, card: toSeriesCard(barId, key, res.results) }
      } catch (err) {
        return { key, card: null, error: err instanceof Error ? err.message : String(err) }
      }
    })).then((next) => { if (alive) setCards(next) })
    return () => { alive = false }
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-caption font-semibold text-foreground">
        {t('market.jp.indicesTitle')}
        <span className="ml-2 font-normal text-muted-foreground">{t('market.jp.indicesSource')}</span>
      </h3>
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(210px,1fr))]">
        {cards == null
          ? INDEX_SOURCES.map(({ key }) => (
            <div key={key} aria-hidden className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-6 w-24 rounded" />
            </div>
          ))
          : cards.map(({ key, card, error }) => card
            ? <SeriesCard key={key} card={card} label={t(`market.jp.${key}`)} emptyText={t('market.noMatches')} />
            : (
              <div key={key} className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] text-muted-foreground">
                {t(`market.jp.${key}`)} · {error}
              </div>
            ))}
      </div>
    </div>
  )
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
const tone = (v: number) => (v > 0 ? 'text-success' : v < 0 ? 'text-destructive' : 'text-muted-foreground')

function BreadthPanel() {
  const { t } = useTranslation()
  const openOrFocus = useWorkspace((s) => s.openOrFocus)
  const [state, setState] = useState<JpBreadthResult | null>(null)

  useEffect(() => {
    let alive = true
    referenceApi.jpBreadth()
      .then((res) => { if (alive) setState(res) })
      .catch((err) => { if (alive) setState({ ok: false, notConfigured: false, error: err instanceof Error ? err.message : String(err) }) })
    return () => { alive = false }
  }, [])

  const header = <h3 className="text-caption font-semibold text-foreground">{t('market.jp.breadthTitle')}</h3>

  if (state == null) {
    return <div className="flex flex-col gap-2">{header}<Skeleton className="h-24 w-full rounded-lg" /></div>
  }
  if (!state.ok) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <div role="status" className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-3">
          <p className="text-[12px] leading-5 text-muted-foreground">
            {state.notConfigured ? t('market.jp.notConfigured') : t('market.jp.loadFailed', { error: state.error })}
          </p>
          {state.notConfigured && (
            <Button type="button" variant="outline" size="sm" onClick={() => openOrFocus({ kind: 'settings', params: { category: 'market-data' } })}>
              {t('market.jp.openSettings')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const { board } = state
  const { advancers, decliners, unchanged, total } = board.breadth
  const share = (n: number) => (total ? `${(n / total) * 100}%` : '0%')
  const maxAbs = Math.max(0.01, ...board.sectors.map((s) => Math.abs(s.avgChangePct)))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {header}
        <span className="text-[11px] text-muted-foreground">{t('market.jp.breadthDate', { date: board.date, prev: board.prevDate })}</span>
        <BoardMeta meta={board.meta} />
      </div>

      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
          <span className="text-success">{t('market.jp.advancers')} <b className="font-mono">{advancers}</b></span>
          <span className="text-destructive">{t('market.jp.decliners')} <b className="font-mono">{decliners}</b></span>
          <span className="text-muted-foreground">{t('market.jp.unchanged')} <b className="font-mono">{unchanged}</b></span>
          <span className="text-muted-foreground">{t('market.jp.total', { total })}</span>
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="bg-success" style={{ width: share(advancers) }} />
          <div className="bg-muted-foreground/30" style={{ width: share(unchanged) }} />
          <div className="bg-destructive" style={{ width: share(decliners) }} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <h4 className="mb-2 text-[12px] font-semibold text-foreground">{t('market.jp.sectorsTitle')}</h4>
        <ul className="flex flex-col gap-1">
          {board.sectors.map((s) => (
            <li key={s.name} className="grid grid-cols-[minmax(7rem,10rem)_4.5rem_1fr_auto] items-center gap-2 text-[12px]">
              <span className="truncate text-foreground" title={s.name}>{s.name}</span>
              <span className={`text-right font-mono ${tone(s.avgChangePct)}`}>{pct(s.avgChangePct)}</span>
              <span className="relative h-1.5 rounded-full bg-muted" aria-hidden>
                <span
                  className={`absolute top-0 h-1.5 rounded-full ${s.avgChangePct >= 0 ? 'left-1/2 bg-success' : 'right-1/2 bg-destructive'}`}
                  style={{ width: `${(Math.abs(s.avgChangePct) / maxAbs) * 50}%` }}
                />
              </span>
              <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                <span className="text-success">{s.advancers}</span>/<span className="text-destructive">{s.decliners}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Japan focus overview: free index bars plus kabu-DB breadth when configured. */
export function JpOverview() {
  return (
    <>
      <IndexStrip />
      <BreadthPanel />
    </>
  )
}
