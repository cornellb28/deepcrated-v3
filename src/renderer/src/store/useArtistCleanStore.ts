import { create } from 'zustand'

// Progress of the artist-name cleanup's background work (preview, apply,
// undo). Fed by one subscription in App.tsx, read by the jobs-panel row and
// the dialog.
interface ArtistCleanState {
  progress: ArtistCleanProgress | null
  setProgress: (p: ArtistCleanProgress | null) => void
}

export const useArtistCleanStore = create<ArtistCleanState>((set) => ({
  progress: null,
  setProgress: (progress) => set({ progress })
}))
