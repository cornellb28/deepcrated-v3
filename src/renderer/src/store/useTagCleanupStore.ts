import { create } from 'zustand'

// Opens the Metadata Cleanup dialog from anywhere: Settings › Library, or the
// "new imports match your cleanup rules" notice. The dialog lives in App.tsx.
// `version` bumps whenever cleanup history or file state changes (fed by the
// tag-cleanup:files-done subscription in App.tsx too), so views reload.
interface TagCleanupState {
  open: boolean
  source: 'library' | 'import'
  version: number
  // The canary files written for a batch, to list for checking in Serato.
  canaryPaths: Record<string, string[]>
  show: (source?: 'library' | 'import') => void
  hide: () => void
  changed: () => void
  setCanaryPaths: (batchId: string, paths: string[]) => void
}

export const useTagCleanupStore = create<TagCleanupState>((set) => ({
  open: false,
  source: 'library',
  version: 0,
  canaryPaths: {},
  show: (source = 'library') => set({ open: true, source }),
  hide: () => set({ open: false }),
  changed: () => set((s) => ({ version: s.version + 1 })),
  setCanaryPaths: (batchId, paths) =>
    set((s) => ({ canaryPaths: { ...s.canaryPaths, [batchId]: paths } }))
}))
