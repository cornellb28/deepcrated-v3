import { create } from 'zustand'

const VOLUME_STORAGE_KEY = 'cratecloud_player_volume'

function loadInitialVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY)
    const n = raw != null ? parseFloat(raw) : NaN
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8
  } catch {
    return 0.8
  }
}

interface PlayerState {
  currentTrack: Track | null
  isPlaying: boolean
  volume: number
  currentTime: number
  duration: number

  playTrack: (track: Track) => void
  setIsPlaying: (v: boolean) => void
  togglePlayPause: () => void
  setVolume: (v: number) => void
  setCurrentTime: (t: number) => void
  setDuration: (d: number) => void
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  volume: loadInitialVolume(),
  currentTime: 0,
  duration: 0,

  playTrack: (track) => set({ currentTrack: track, isPlaying: true, currentTime: 0, duration: 0 }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  togglePlayPause: () => set({ isPlaying: !get().isPlaying }),
  setVolume: (v) => {
    const clamped = Math.max(0, Math.min(1, v))
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped))
    } catch {
      // private-browsing/quota failure — volume just won't persist this session
    }
    set({ volume: clamped })
  },
  setCurrentTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d })
}))
