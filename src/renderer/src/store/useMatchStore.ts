import { create } from 'zustand'

// Inspector > Related: the last-used direction. In memory only, so it lasts
// the session and is deliberately not part of the Mix Profile.
interface MatchState {
  direction: MatchDirection
  setDirection: (direction: MatchDirection) => void
}

export const useMatchStore = create<MatchState>((set) => ({
  direction: 'similar',
  setDirection: (direction) => set({ direction })
}))
