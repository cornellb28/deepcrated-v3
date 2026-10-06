import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { TrackRow } from '../components/TrackRow'
import { BulkBar } from '../components/BulkBar'
import {
  VirtualizedTrackGrid,
  type VirtualizedTrackGridHandle
} from '../components/VirtualizedTrackGrid'
import { TrackTabBar } from '../components/TrackTabBar'
import { useViewMode } from '../hooks/useViewMode'
import { useCustomTabs } from '../hooks/useCustomTabs'
import { buildTabs, filterTracksForTab, tabCounts } from '../lib/tabs'
import { applySelection, selectAll, type SelectModifiers } from '../lib/selection'

interface TabSelection {
  // Which tab this selection was made in. A selection from another tab is
  // ignored rather than cleared, so switching tabs needs no effect.
  tabId: string
  ids: Set<number>
  anchorId: number | null
}

// Shared empty set — a fresh `new Set()` per render would be a new identity
// every time, and BulkBar/TrackRow read this on every render.
const EMPTY_SELECTION: ReadonlySet<number> = new Set()

export function LibraryView(): React.JSX.Element {
  const { tracks, searchQuery, bpmRange, boards, trackTags } = useLibraryStore()

  // One tab per saved view: the three built-ins, then one per board column
  // that does not already name a built-in, then the DJ's own saved views.
  // Boards come from the store, so renaming or reordering a column reshapes
  // the tab strip with it.
  const customTabs = useCustomTabs()
  const tabs = useMemo(() => buildTabs(boards, customTabs), [boards, customTabs])
  const [activeTabId, setActiveTabId] = useState(tabs[0].id)
  // Resolved rather than trusted: if the board behind the active tab is
  // deleted, the id stops matching and this falls back to All Music without
  // needing an effect to repair the state. Everything downstream keys off
  // activeTab.id, so the fallback propagates (selection clears, the view
  // mode switches to All Music's) exactly as a real tab switch would.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]

  // Each tab remembers its own mode, under view_mode:tab:<id> in
  // app_settings — the same mechanism the board columns used, so no
  // schema change and no new IPC. The id is stable across a board rename.
  const [mode, setMode] = useViewMode(`tab:${activeTab.id}`, activeTab.defaultViewMode)

  // The selection carries the tab it was made in, and `anchorId` is where
  // the last plain click landed — the origin a shift-click spans from.
  const [selection, setSelection] = useState<TabSelection>({
    tabId: activeTab.id,
    ids: new Set(),
    anchorId: null
  })
  // Selection belongs to the tab it was made in, and switching tabs throws
  // it away rather than shelving it — coming back to a tab must not
  // resurrect what was selected there before. The reset happens during
  // render, not in an effect: React re-runs this component immediately with
  // the new state and never commits the stale selection, so there is no
  // flash and no cascading render. It covers every way the tab can change,
  // including the board behind it being deleted. Toggling list/grid does
  // not change the tab id, which is exactly why a selection survives that.
  const staleSelection = selection.tabId !== activeTab.id
  if (staleSelection) {
    setSelection({ tabId: activeTab.id, ids: new Set(), anchorId: null })
  }
  // Read through the same guard: on the render that schedules the reset,
  // `selection` still holds the outgoing tab's set.
  const selectedIds = staleSelection ? EMPTY_SELECTION : selection.ids
  const anchorId = staleSelection ? null : selection.anchorId

  const listRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<VirtualizedTrackGridHandle>(null)
  // Last first-visible track index seen in whichever mode is currently
  // mounted — read back when `mode` flips so the other mode can pick up
  // roughly where the DJ left off instead of resetting to the top.
  const lastVisibleIndexRef = useRef(0)
  const prevModeRef = useRef(mode)

  // Search and the BPM range are global (they live in the toolbar), so they
  // narrow the library before the tab filter does. Tab counts are computed
  // over this same array, which is why a tab's number always matches what
  // clicking it shows.
  const query = searchQuery.trim().toLowerCase()
  const baseTracks = useMemo(() => {
    const byBpm = bpmRange
      ? tracks.filter((t) => {
          if (!t.bpm) return false
          const bpm = Number(t.bpm)
          const [min, max] = bpmRange
          return bpm >= min && (max === Infinity ? true : bpm < max)
        })
      : tracks
    if (!query) return byBpm
    return byBpm.filter((t) => {
      const haystack = [t.title, t.artist, t.bpm, t.key_camelot, t.camelot, t.genre, t.comment]
        .filter((v) => v !== null && v !== undefined)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [tracks, bpmRange, query])

  const counts = useMemo(
    () => tabCounts(tabs, baseTracks, trackTags),
    [tabs, baseTracks, trackTags]
  )

  // The one array both modes render, in the one order both modes render it.
  const visibleTracks = useMemo(
    () => filterTracksForTab(baseTracks, activeTab, trackTags),
    [baseTracks, activeTab, trackTags]
  )
  const orderedIds = useMemo(() => visibleTracks.map((t) => t.id), [visibleTracks])

  function handleSelect(id: number, modifiers?: SelectModifiers): void {
    const result = applySelection(selectedIds, orderedIds, id, modifiers, anchorId)
    setSelection({ tabId: activeTab.id, ids: result.selected, anchorId: result.anchorId })
  }

  function setSelectedIds(ids: Set<number>): void {
    setSelection({ tabId: activeTab.id, ids, anchorId: null })
  }

  function handleListScroll(): void {
    const container = listRef.current
    if (!container) return
    const top = container.scrollTop
    for (const child of Array.from(container.children)) {
      const el = child as HTMLElement
      if (el.offsetTop + el.offsetHeight > top) {
        lastVisibleIndexRef.current = Number(el.dataset.index ?? 0)
        return
      }
    }
  }

  // Restore scroll position across a list<->grid switch — maps the last
  // visible track index from whichever mode was active a moment ago onto
  // whichever mode just mounted.
  useEffect(() => {
    if (prevModeRef.current === mode) return
    prevModeRef.current = mode
    const index = lastVisibleIndexRef.current
    requestAnimationFrame(() => {
      if (mode === 'list') {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
          ?.scrollIntoView({ block: 'start' })
      } else {
        gridRef.current?.scrollToTrackIndex(index)
      }
    })
  }, [mode])

  if (tracks.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#333',
          fontSize: '14px'
        }}
      >
        No tracks yet — import a folder to get started
      </div>
    )
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <TrackTabBar
        tabs={tabs}
        activeTabId={activeTab.id}
        onSelectTab={setActiveTabId}
        counts={counts}
        mode={mode}
        onModeChange={setMode}
      />

      {/* BulkBar — renders null when selectedIds is empty. The same
          component and the same props in both modes; list and grid differ
          only in what draws the rows below it. */}
      <BulkBar
        selectedIds={selectedIds}
        onClearSelect={() => setSelectedIds(new Set())}
        // Select all means the tab's whole filtered result, not just what
        // is on screen — which matters in grid mode, where the virtualizer
        // has only mounted a couple of rows of it.
        onSelectAll={() => setSelectedIds(selectAll(orderedIds))}
        totalCount={visibleTracks.length}
      />

      <div
        id="track-tab-panel"
        role="tabpanel"
        aria-labelledby={`track-tab-${activeTab.id}`}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {visibleTracks.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#333',
              fontSize: '14px'
            }}
          >
            {baseTracks.length === 0
              ? 'No tracks match your search'
              : `Nothing in ${activeTab.label}`}
          </div>
        )}

        {/* List view */}
        {mode === 'list' && visibleTracks.length > 0 && (
          <div
            ref={listRef}
            data-testid="track-list"
            onScroll={handleListScroll}
            style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}
          >
            {visibleTracks.map((track, index) => (
              <div key={track.id} data-index={index}>
                <TrackRow
                  track={track}
                  isSelected={selectedIds.has(track.id)}
                  onSelected={handleSelect}
                />
              </div>
            ))}
          </div>
        )}

        {/* Grid view — virtualized, bounded DOM nodes regardless of library size */}
        {mode === 'grid' && visibleTracks.length > 0 && (
          <VirtualizedTrackGrid
            ref={gridRef}
            tracks={visibleTracks}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onVisibleIndexChange={(index) => {
              lastVisibleIndexRef.current = index
            }}
          />
        )}
      </div>
    </div>
  )
}
