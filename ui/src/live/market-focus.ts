import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { reloadOnHotUpdate } from '../lib/hmr'

reloadOnHotUpdate('live/market-focus')

/**
 * Which equity market the Market pages show: Japan (default) or the US.
 *
 * One value for the whole UI. Settings and the toggle in every market page
 * header write the same store, so all boards switch together and never mix a
 * Japanese overview with US movers. It only changes what the human sees; Agent
 * research focus comes from Workspace instructions, not from this toggle.
 */
export type MarketFocus = 'jp' | 'us'

export const MARKET_FOCUSES: readonly MarketFocus[] = ['jp', 'us']

interface MarketFocusState {
  focus: MarketFocus
  setFocus: (focus: MarketFocus) => void
}

export const useMarketFocus = create<MarketFocusState>()(
  persist(
    (set) => ({
      focus: 'jp',
      setFocus: (focus) => set({ focus }),
    }),
    { name: 'openalice.market-focus.v1', version: 1 },
  ),
)
