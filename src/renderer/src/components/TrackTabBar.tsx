import React, { useEffect, useRef, useState } from 'react'
import { ViewModeToggle } from './ViewModeToggle'
import type { TabDefinition, TabViewMode } from '../lib/tabs'

interface TrackTabBarProps {
  tabs: readonly TabDefinition[]
  activeTabId: string
  onSelectTab: (id: string) => void
  // Per-tab track counts, keyed by tab id — see tabCounts. Computed over
  // the same search/BPM-filtered array the active tab draws from, so the
  // number on a tab is what clicking it will actually show.
  counts: Record<string, number>
  // The *active* tab's mode. Each tab keeps its own (view_mode:tab:<id>),
  // so this changes on its own when the DJ switches tabs.
  mode: TabViewMode
  onModeChange: (mode: TabViewMode) => void
}

// The top of the tracks area: one tab per saved view, plus the active tab's
// list/grid toggle on the right of the same row.
//
// TODO: the custom "+" tab goes at the end of this strip. TabDefinition is
// already serializable enough to carry one — what is missing is where a
// DJ-authored tab is stored and the editor that writes it, both out of
// scope here. Nothing is rendered for it yet.
export function TrackTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  counts,
  mode,
  onModeChange
}: TrackTabBarProps): React.JSX.Element {
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeTabId)
  )
  // Roving tabindex: exactly one tab is in the tab order at a time, and the
  // arrow keys move focus between them. Focus is allowed to sit on a tab
  // that is not the active one — that is the "manual activation" pattern,
  // and it is what gives Enter something to do.
  //
  // Held as an id rather than an index, and resolved back to an index each
  // render: a tab that disappears (its board deleted) falls back to the
  // active tab on its own, with no effect needed to repair the state.
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null)
  const focusedFromId = focusedTabId ? tabs.findIndex((t) => t.id === focusedTabId) : -1
  const focusedIndex = focusedFromId === -1 ? activeIndex : focusedFromId

  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])
  // Only pull DOM focus when the arrow keys moved it, never on the first
  // paint or when the active tab changes by mouse — otherwise mounting the
  // library would steal focus from whatever the DJ was typing in.
  const focusRequested = useRef(false)

  useEffect(() => {
    if (!focusRequested.current) return
    focusRequested.current = false
    buttonsRef.current[focusedIndex]?.focus()
  }, [focusedIndex])

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const delta = e.key === 'ArrowRight' ? 1 : -1
      // Wraps at both ends — a tab strip is a ring, not a dead end.
      const next = tabs[(focusedIndex + delta + tabs.length) % tabs.length]
      if (!next) return
      focusRequested.current = true
      setFocusedTabId(next.id)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const tab = tabs[focusedIndex]
      if (tab) onSelectTab(tab.id)
    }
  }

  return (
    <div
      data-testid="track-tab-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '0 16px',
        background: '#0e0e12',
        borderBottom: '0.5px solid #1e1e2a',
        flexShrink: 0
      }}
    >
      <div
        role="tablist"
        aria-label="Track views"
        onKeyDown={handleKeyDown}
        style={{ display: 'flex', alignItems: 'stretch', gap: '2px', flex: 1, overflowX: 'auto' }}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId
          const count = counts[tab.id]
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttonsRef.current[index] = el
              }}
              role="tab"
              id={`track-tab-${tab.id}`}
              data-testid={`track-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls="track-tab-panel"
              tabIndex={index === focusedIndex ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              // Covers the mouse too: clicking a tab focuses its button,
              // so the roving tabindex follows the click without a second
              // handler for it.
              onFocus={() => setFocusedTabId(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: 'none',
                border: 'none',
                // The active tab is underlined rather than filled — it sits
                // directly above the list it describes, so the line reads
                // as a join between the two.
                borderBottom: `2px solid ${isActive ? '#7f77dd' : 'transparent'}`,
                color: isActive ? '#e0e0f0' : '#555',
                fontSize: '12px',
                fontFamily: 'inherit',
                fontWeight: isActive ? 500 : 400,
                padding: '8px 10px 6px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              {/* Status tabs carry their board's colour, the same dot the
                  board column header shows, so a renamed column is still
                  recognisable here. */}
              {tab.color && (
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: tab.color,
                    flexShrink: 0
                  }}
                />
              )}
              {tab.label}
              {count !== undefined && (
                <span
                  style={{
                    fontSize: '10px',
                    background: isActive ? '#1e1b3a' : '#16161e',
                    color: isActive ? '#a09be8' : '#444',
                    padding: '1px 6px',
                    borderRadius: '9px',
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* The active tab's own list/grid choice */}
      <div style={{ flexShrink: 0 }}>
        <ViewModeToggle mode={mode} onChange={onModeChange} />
      </div>
    </div>
  )
}
