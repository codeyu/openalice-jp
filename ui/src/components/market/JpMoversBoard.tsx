import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { referenceApi, type JpMoverRow, type JpMoversResult } from '../../api/reference'
import { useWorkspace } from '../../tabs/store'
import { PageHeader } from '../PageHeader'
import { SegmentedControl } from '../SegmentedControl'
import { CenteredLoading } from '../StateViews'
import { Button } from '../ui/button'
import { BoardMeta } from './BoardMeta'
import { MarketFocusToggle } from './MarketFocus'

/** The rankings most people scan first; every stored type stays reachable from the select. */
const QUICK_TYPES = ['gain', 'loss', 'volume', 'turnover', 'volume_surge', 'stop_high', 'stop_low'] as const

type Column = 'rank' | 'code' | 'name' | 'exchange' | 'price' | 'change' | 'changePct' | 'volume' | 'turnover' | 'marginRatio' | 'asOfTime'
const COLUMNS: readonly Column[] = ['rank', 'code', 'name', 'exchange', 'price', 'change', 'changePct', 'volume', 'turnover', 'marginRatio', 'asOfTime']
const ALWAYS: ReadonlySet<Column> = new Set(['rank', 'name'])
const NUMERIC: ReadonlySet<Column> = new Set(['rank', 'price', 'change', 'changePct', 'volume', 'turnover', 'marginRatio'])

/** Show a column only when some row carries a value, so credit and sector rankings stay compact. */
export function visibleColumns(rows: readonly JpMoverRow[]): Column[] {
  return COLUMNS.filter((c) => ALWAYS.has(c) || rows.some((r) => r[c] != null && r[c] !== ''))
}

const num = (v: number, digits = 0) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const signed = (v: number, digits: number, suffix = '') => `${v > 0 ? '+' : ''}${num(v, digits)}${suffix}`
const tone = (v: number | null) => (v == null ? '' : v > 0 ? 'text-success' : v < 0 ? 'text-destructive' : 'text-muted-foreground')

function cell(row: JpMoverRow, column: Column): string {
  const v = row[column]
  if (v == null || v === '') return '—'
  switch (column) {
    case 'price': return num(v as number, Number.isInteger(v) ? 0 : 2)
    case 'change': return signed(v as number, Number.isInteger(v) ? 0 : 2)
    case 'changePct': return signed(v as number, 2, '%')
    case 'volume':
    case 'turnover': return num(v as number, 1)
    case 'marginRatio': return num(v as number, 2)
    default: return String(v)
  }
}

export function JpMoversBoardView() {
  const { t } = useTranslation()
  const openOrFocus = useWorkspace((s) => s.openOrFocus)
  const [type, setType] = useState('gain')
  const [state, setState] = useState<JpMoversResult | null>(null)

  useEffect(() => {
    let alive = true
    setState(null)
    referenceApi.jpMovers(type)
      .then((res) => { if (alive) setState(res) })
      .catch((err) => { if (alive) setState({ ok: false, notConfigured: false, error: err instanceof Error ? err.message : String(err) }) })
    return () => { alive = false }
  }, [type])

  const board = state?.ok ? state.board : null
  const types = board?.types ?? []
  const quick = useMemo(
    () => QUICK_TYPES.flatMap((id) => {
      const found = types.find((x) => x.type === id)
      return found ? [{ value: found.type, label: found.title }] : []
    }),
    [types],
  )
  const columns = board ? visibleColumns(board.rows) : []

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title={t('market.boardMovers')}
        right={<MarketFocusToggle />}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{board ? t('market.jpMovers.subtitle', { title: board.type.title, date: board.date }) : t('market.jpMovers.subtitleLoading')}</span>
            {board && <BoardMeta meta={board.meta} />}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          {quick.length > 0 && (
            <SegmentedControl value={QUICK_TYPES.includes(type as never) ? type : ''} onChange={setType} ariaLabel={t('market.jpMovers.typeLabel')} options={quick} />
          )}
          {types.length > 0 && (
            <select
              aria-label={t('market.jpMovers.moreTypes')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground"
            >
              {types.map((x) => <option key={x.type} value={x.type}>{x.title}</option>)}
            </select>
          )}
        </div>

        {state == null && <CenteredLoading />}

        {state && !state.ok && (
          <div role="status" className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-3">
            <p className="text-[12px] leading-5 text-muted-foreground">
              {state.notConfigured ? t('market.jp.notConfigured') : t('market.jpMovers.loadFailed', { error: state.error })}
            </p>
            {state.notConfigured && (
              <Button type="button" variant="outline" size="sm" onClick={() => openOrFocus({ kind: 'settings', params: { category: 'market-data' } })}>
                {t('market.jp.openSettings')}
              </Button>
            )}
          </div>
        )}

        {board && board.rows.length === 0 && <p className="text-[12px] text-muted-foreground">{t('market.jpMovers.empty')}</p>}

        {board && board.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  {columns.map((c) => (
                    <th key={c} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${NUMERIC.has(c) ? 'text-right' : 'text-left'}`}>
                      {t(`market.jpMovers.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.rows.map((row) => {
                  const open = row.code ? () => openOrFocus({ kind: 'market-detail', params: { assetClass: 'equity', symbol: `${row.code}.T` } }) : undefined
                  return (
                    <tr key={`${row.rank}-${row.code ?? row.name}`} className="border-t border-border/60 hover:bg-accent/40">
                      {columns.map((c) => {
                        const text = cell(row, c)
                        const color = c === 'change' || c === 'changePct' ? tone(row[c]) : ''
                        const align = NUMERIC.has(c) ? 'text-right font-mono' : 'text-left'
                        if (c === 'name' && open) {
                          return (
                            <td key={c} className="min-w-[9rem] whitespace-nowrap px-3 py-1.5">
                              <button type="button" onClick={open} className="whitespace-nowrap text-left text-foreground underline-offset-2 hover:underline focus-visible:underline">
                                {text}
                              </button>
                            </td>
                          )
                        }
                        return <td key={c} className={`whitespace-nowrap px-3 py-1.5 ${align} ${color} ${c === 'code' ? 'font-mono' : ''} ${c === 'name' ? 'min-w-[9rem]' : ''}`}>{text}</td>
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {board && board.rows.some((r) => r.volume != null || r.turnover != null) && (
          <p className="text-[11px] text-muted-foreground">{t('market.jpMovers.unitsNote')}</p>
        )}
      </div>
    </div>
  )
}
