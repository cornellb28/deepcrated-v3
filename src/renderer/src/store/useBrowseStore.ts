import { create } from 'zustand'
import {
  INITIAL_NAV,
  navReducer,
  type BrowseNavAction,
  type BrowseNavState
} from '../lib/browse/nav'

// Thin wrapper over the pure reducer in lib/browse/nav.ts. It lives in a
// store, not component state, so the DJ's place in Browse (search text, sort,
// scroll position, how deep they are) survives switching to All Tracks and
// back — the views unmount on every sidebar change.
//
// Deliberately not persisted across launches: a reload lands on the hub.

interface BrowseStore {
  nav: BrowseNavState
  dispatch: (action: BrowseNavAction) => void
}

export const useBrowseStore = create<BrowseStore>((set) => ({
  nav: INITIAL_NAV,
  dispatch: (action) => set((state) => ({ nav: navReducer(state.nav, action) }))
}))
