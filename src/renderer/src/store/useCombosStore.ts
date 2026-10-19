import { create } from 'zustand'

// Which track the Find combos panel (components/CombosDialog.tsx) is open
// for. Opened from a track's ⋮ menu and the Inspector; the panel lives in
// App.tsx.
interface CombosState {
  trackId: number | null
  show: (trackId: number) => void
  hide: () => void
}

export const useCombosStore = create<CombosState>((set) => ({
  trackId: null,
  show: (trackId) => set({ trackId }),
  hide: () => set({ trackId: null })
}))
