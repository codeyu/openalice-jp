import { useTranslation } from 'react-i18next'
import { Construction } from 'lucide-react'

import { PageHeader } from '../PageHeader'
import { SegmentedControl } from '../SegmentedControl'
import { Button } from '../ui/button'
import { MARKET_FOCUSES, useMarketFocus, type MarketFocus } from '../../live/market-focus'

/** Header toggle for market-specific pages. Writes the one global focus. */
export function MarketFocusToggle() {
  const { t } = useTranslation()
  const focus = useMarketFocus((s) => s.focus)
  const setFocus = useMarketFocus((s) => s.setFocus)
  return (
    <SegmentedControl<MarketFocus>
      value={focus}
      onChange={setFocus}
      ariaLabel={t('market.focus.label')}
      options={MARKET_FOCUSES.map((value) => ({ value, label: t(`market.focus.${value}`) }))}
    />
  )
}

/** Inline notice where a Japanese data source is not wired yet. */
export function JpPendingNotice({ subject }: { subject: string }) {
  const { t } = useTranslation()
  const setFocus = useMarketFocus((s) => s.setFocus)
  return (
    <div role="status" className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        <Construction aria-hidden className="size-4 text-muted-foreground" />
        {t('market.focus.pendingTitle', { subject })}
      </div>
      <p className="max-w-xl text-[12px] leading-5 text-muted-foreground">{t('market.focus.pendingBody')}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => setFocus('us')}>
        {t('market.focus.switchToUs')}
      </Button>
    </div>
  )
}

/** Whole-page placeholder for a market-specific board in Japan focus. */
export function JpPendingPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title={title} right={<MarketFocusToggle />} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 md:px-8">
        <JpPendingNotice subject={title} />
      </div>
    </div>
  )
}
