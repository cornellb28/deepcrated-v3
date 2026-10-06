import { useEffect, useState } from 'react'
import { CUSTOM_TABS_SETTINGS_KEY, parseCustomTabs, type TabDefinition } from '../lib/tabs'

// The DJ's own saved views, read back from app_settings on mount — same
// window.api.settings.get mechanism useViewMode uses, so no schema change
// and no new IPC handler.
//
// Read-only for now: nothing in the app writes this key yet, because the
// "+" button and the editor behind it are not built (see lib/tabs.ts). The
// loader exists so that the moment something does write one — an editor, or
// a hand-edited row — it appears in the tab bar without any further wiring.
// Fetched once per mount rather than subscribed: a key nothing writes
// cannot change underneath the view.
export function useCustomTabs(): TabDefinition[] {
  const [tabs, setTabs] = useState<TabDefinition[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get(CUSTOM_TABS_SETTINGS_KEY)
      .then((raw) => {
        if (!cancelled) setTabs(parseCustomTabs(raw))
      })
      // parseCustomTabs already swallows malformed data; this is only the
      // IPC call itself failing, and a library that paints without the
      // custom tabs beats one that does not paint.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return tabs
}
