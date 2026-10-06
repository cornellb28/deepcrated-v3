import { useEffect } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'

export type ViewMode = 'list' | 'grid'

function settingsKey(viewKey: string): string {
  return `view_mode:${viewKey}`
}

// Backed by the shared `viewModes` store slice (so a toolbar button and the
// view it controls — separate components, same viewKey — stay in sync) and
// by the settings table (same window.api.settings.get/set mechanism
// skip_move_confirmation uses), so the choice survives a restart. Restored
// once per key, from whichever component asks for it first; a second
// component asking for the same key just re-fetches the same value, which
// is harmless.
export function useViewMode(
  viewKey: string,
  defaultMode: ViewMode = 'list'
): [ViewMode, (mode: ViewMode) => void] {
  const mode = useLibraryStore((s) => s.viewModes[viewKey]) ?? defaultMode
  const setViewModeInStore = useLibraryStore((s) => s.setViewMode)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get(settingsKey(viewKey)).then((stored) => {
      if (cancelled) return
      if (stored === 'list' || stored === 'grid') setViewModeInStore(viewKey, stored)
    })
    return () => {
      cancelled = true
    }
  }, [viewKey, setViewModeInStore])

  function setMode(next: ViewMode): void {
    setViewModeInStore(viewKey, next)
    window.api.settings.set(settingsKey(viewKey), next)
  }

  return [mode, setMode]
}
