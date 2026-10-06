import React, { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, FolderPlus, Search, UploadCloud } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useLibraryStore } from '../store/useLibraryStore'
import {
  allCrateIds,
  ancestorsOfMembership,
  buildCrateTree,
  crateMembership,
  filterCrateTree,
  flattenCrateTree,
  type CrateNode,
  type Membership
} from '../lib/crateTree'

const DEFAULT_CRATE_COLOR = '#7f77dd'

interface CratePickerModalProps {
  // Bulk-capable: TrackRowMenu passes a single-id array, BulkBar the whole
  // selection. Membership is per-crate tri-state across this whole set.
  trackIds: number[]
  open: boolean
  onClose: () => void
}

export function CratePickerModal({
  trackIds,
  open,
  onClose
}: CratePickerModalProps): React.JSX.Element {
  const {
    crates,
    crateTrackIds,
    tracks,
    upsertCrateLocally,
    addTracksToCrateLocally,
    removeTracksFromCrateLocally
  } = useLibraryStore()

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [highlight, setHighlight] = useState(0)
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set())
  const [touched, setTouched] = useState<Set<number>>(new Set())
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const tree = useMemo(() => buildCrateTree(crates), [crates])
  const filtered = useMemo(() => filterCrateTree(tree, query), [tree, query])

  const membership = (crateId: number): Membership =>
    crateMembership(crateTrackIds.get(crateId), trackIds)

  // Opening should already show where these tracks live, so every ancestor
  // of a crate they are in starts expanded. Reset per open, not per render.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setQuery('')
      setHighlight(0)
      setTouched(new Set())
      setNewName('')
      setNewParentId(null)
      setCreating(false)

      setExpanded(ancestorsOfMembership(crates, crateTrackIds, trackIds))
    }
  }

  // A search has to reveal its matches, so everything kept by the filter is
  // expanded for as long as the query stands.
  const searching = query.trim().length > 0
  const effectiveExpanded = useMemo(
    () => (searching ? new Set(allCrateIds(filtered)) : expanded),
    [searching, filtered, expanded]
  )
  const rows = useMemo(
    () => flattenCrateTree(filtered, effectiveExpanded),
    [filtered, effectiveExpanded]
  )

  // Clamped as derived state rather than corrected in an effect: the list
  // shrinks whenever the query narrows, and a stale index would otherwise
  // survive a render before being fixed up.
  const cursor = rows.length === 0 ? -1 : Math.min(highlight, rows.length - 1)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const exactMatch = crates.some((c) => c.name.toLowerCase() === query.trim().toLowerCase())
  const offerCreateFromSearch = searching && !exactMatch
  const create = (): void => void createCrate(query, newParentId)

  async function toggle(crate: CrateNode): Promise<void> {
    const state = membership(crate.id)
    setPendingIds((s) => new Set(s).add(crate.id))
    try {
      if (state === 'all') {
        const result = await window.api.crates.removeTracks(crate.id, trackIds)
        if (result.ok) removeTracksFromCrateLocally(crate.id, trackIds)
        else toast.error('Could not remove from crate', { description: result.error })
      } else {
        const result = await window.api.crates.addTracks(crate.id, trackIds)
        if (result.ok) addTracksToCrateLocally(crate.id, trackIds)
        else toast.error('Could not add to crate', { description: result.error })
      }
      setTouched((s) => new Set(s).add(crate.id))
    } finally {
      setPendingIds((s) => {
        const next = new Set(s)
        next.delete(crate.id)
        return next
      })
    }
  }

  function toggleExpanded(crateId: number): void {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(crateId)) next.delete(crateId)
      else next.add(crateId)
      return next
    })
  }

  async function createCrate(rawName: string, parentId: number | null): Promise<void> {
    const trimmed = rawName.trim()
    if (!trimmed || creating) return
    setCreating(true)
    try {
      const result = await window.api.crates.insert(trimmed, parentId, DEFAULT_CRATE_COLOR)
      if (!result.ok || result.id === undefined) {
        toast.error('Could not create crate', { description: result.error })
        return
      }
      const now = Math.floor(Date.now() / 1000)
      upsertCrateLocally({
        id: result.id,
        name: trimmed,
        color: DEFAULT_CRATE_COLOR,
        parent_crate_id: parentId,
        created_at: now,
        updated_at: now,
        last_exported_at: null,
        track_count: 0
      })

      const added = await window.api.crates.addTracks(result.id, trackIds)
      if (added.ok) {
        addTracksToCrateLocally(result.id, trackIds)
        setTouched((s) => new Set(s).add(result.id!))
      } else {
        toast.error('Crate created, but the tracks were not added', { description: added.error })
      }

      // A brand new subcrate is useless if its parent stays collapsed.
      if (parentId !== null) setExpanded((s) => new Set(s).add(parentId))
      setNewName('')
      setQuery('')
      searchRef.current?.focus()
    } finally {
      setCreating(false)
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(Math.min(cursor + 1, rows.length - 1))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(Math.max(cursor - 1, 0))
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const row = rows[cursor]
      if (!row || row.node.children.length === 0 || searching) return
      e.preventDefault()
      const shouldExpand = e.key === 'ArrowRight'
      if (shouldExpand !== row.expanded) toggleExpanded(row.node.id)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[cursor]
      if (row) void toggle(row.node)
      else if (offerCreateFromSearch) void createCrate(query, newParentId)
    }
  }

  const trackLabel =
    trackIds.length === 1
      ? (tracks.find((t) => t.id === trackIds[0])?.title ?? '1 track')
      : `${trackIds.length} tracks`

  // Indented options so the select reads as the same tree as the list.
  const parentOptions = useMemo(
    () => flattenCrateTree(tree, new Set(allCrateIds(tree))),
    [tree]
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          borderRadius: '12px',
          maxWidth: '460px',
          width: '100%',
          maxHeight: '78vh',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          overflow: 'hidden'
        }}
      >
        {/* ── Header ──────────────────────────────── */}
        <div
          style={{
            padding: '14px 16px 12px',
            background: '#13131b',
            borderBottom: '0.5px solid #24242f',
            flexShrink: 0
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '0.2px' }}>
            Add to crate
          </div>
          <div
            style={{
              fontSize: '11px',
              color: '#5a5a70',
              marginTop: '3px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {trackLabel}
          </div>
        </div>

        {/* ── Search ──────────────────────────────── */}
        <div style={{ padding: '10px 16px 8px', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: '9px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#444',
                pointerEvents: 'none'
              }}
            />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              placeholder="Search crates"
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onSearchKeyDown}
              style={{
                boxSizing: 'border-box',
                width: '100%',
                background: '#101017',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                color: '#e8e8f0',
                fontSize: '12px',
                padding: '7px 9px 7px 27px',
                fontFamily: 'inherit',
                outline: 'none'
              }}
              onFocusCapture={(e) => (e.target.style.borderColor = '#7f77dd')}
              onBlurCapture={(e) => (e.target.style.borderColor = '#252535')}
            />
          </div>
        </div>

        {/* ── Crate tree ──────────────────────────── */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: '140px',
            overflowY: 'auto',
            padding: '0 8px 6px',
            borderBottom: '0.5px solid #24242f'
          }}
        >
          {rows.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '10px',
                padding: '26px 12px 20px'
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  color: '#4a4a5c',
                  textAlign: 'center',
                  lineHeight: 1.6,
                  maxWidth: '260px'
                }}
              >
                {crates.length === 0
                  ? 'No crates yet. Make your first one below.'
                  : `No crate matches “${query.trim()}”.`}
              </div>
              {offerCreateFromSearch && <CreateFromSearch name={query.trim()} onClick={create} />}
            </div>
          )}

          {rows.map((row, index) => {
            const { node, depth, expanded: isExpanded } = row
            const state = membership(node.id)
            const pending = pendingIds.has(node.id)
            const highlighted = index === cursor
            const hasChildren = node.children.length > 0

            return (
              <div
                key={node.id}
                data-row={index}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => void toggle(node)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 8px',
                  paddingLeft: `${8 + depth * 14}px`,
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: state === 'none' ? '#c0c0d8' : '#e8e8f0',
                  cursor: pending ? 'default' : 'pointer',
                  opacity: pending ? 0.45 : 1,
                  background: highlighted ? '#242433' : 'transparent'
                }}
              >
                {/* Expander, or a spacer so every name still lines up */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (hasChildren && !searching) toggleExpanded(node.id)
                  }}
                  tabIndex={-1}
                  aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
                  style={{
                    width: '14px',
                    height: '14px',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: '#4a4a60',
                    cursor: hasChildren && !searching ? 'pointer' : 'default',
                    visibility: hasChildren ? 'visible' : 'hidden'
                  }}
                >
                  <ChevronRight
                    size={12}
                    style={{
                      transform: isExpanded ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.12s ease'
                    }}
                  />
                </button>

                <TriStateBox state={state} />

                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: node.color,
                    flexShrink: 0
                  }}
                />

                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {node.name}
                </span>

                {touched.has(node.id) && (
                  <span style={{ fontSize: '9px', color: '#7f77dd', flexShrink: 0 }}>changed</span>
                )}

                {node.last_exported_at !== null && (
                  <UploadCloud
                    size={11}
                    style={{ color: '#3a3a48', flexShrink: 0 }}
                    aria-label="Exported to Serato"
                  />
                )}

                <span
                  style={{
                    fontSize: '10px',
                    color: '#4a4a5c',
                    flexShrink: 0,
                    minWidth: '18px',
                    textAlign: 'right'
                  }}
                >
                  {node.track_count ?? 0}
                </span>
              </div>
            )
          })}

          {rows.length > 0 && offerCreateFromSearch && (
            <CreateFromSearch name={query.trim()} onClick={create} inline />
          )}
        </div>

        {/* ── New crate ───────────────────────────── */}
        <div style={{ padding: '10px 16px', flexShrink: 0, display: 'flex', gap: '6px' }}>
          <input
            value={newName}
            placeholder="New crate name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void createCrate(newName, newParentId)
              }
            }}
            style={{
              boxSizing: 'border-box',
              flex: 1,
              minWidth: 0,
              background: '#101017',
              border: '0.5px solid #252535',
              borderRadius: '6px',
              color: '#e8e8f0',
              fontSize: '12px',
              padding: '7px 9px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
            onFocusCapture={(e) => (e.target.style.borderColor = '#7f77dd')}
            onBlurCapture={(e) => (e.target.style.borderColor = '#252535')}
          />
          <select
            value={newParentId === null ? '' : String(newParentId)}
            onChange={(e) => setNewParentId(e.target.value === '' ? null : Number(e.target.value))}
            aria-label="Parent crate"
            style={{
              maxWidth: '130px',
              background: '#101017',
              border: '0.5px solid #252535',
              borderRadius: '6px',
              color: '#c0c0d8',
              fontSize: '11px',
              padding: '7px 6px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          >
            <option value="">Top level</option>
            {parentOptions.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {' '.repeat(depth * 2)}
                {node.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!newName.trim() || creating}
            onClick={() => void createCrate(newName, newParentId)}
            className="text-xs"
            style={{
              borderColor: newName.trim() ? '#7f77dd' : '#252535',
              color: newName.trim() ? '#a09be8' : '#444',
              flexShrink: 0
            }}
          >
            Create
          </Button>
        </div>

        {/* ── Footer ──────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            background: '#13131b',
            borderTop: '0.5px solid #24242f',
            flexShrink: 0
          }}
        >
          <span style={{ fontSize: '11px', color: '#5a5a70' }}>
            {touched.size === 0
              ? 'Changes save as you pick'
              : `${touched.size} crate${touched.size === 1 ? '' : 's'} updated`}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="text-xs"
            style={{ borderColor: '#7f77dd', color: '#a09be8' }}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Offers the search text as a new crate. Sits inside the list when there
// are also matches to scroll past, and on its own in the empty state.
function CreateFromSearch({
  name,
  onClick,
  inline = false
}: {
  name: string
  onClick: () => void
  inline?: boolean
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#242433')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 10px',
        marginTop: inline ? '2px' : 0,
        borderRadius: '6px',
        border: inline ? 'none' : '0.5px solid #2e2e3e',
        maxWidth: '100%',
        fontSize: '12px',
        color: '#a09be8',
        cursor: 'pointer'
      }}
    >
      <FolderPlus size={13} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Create “{name}”
      </span>
    </div>
  )
}

// Hand-rolled rather than the shared Checkbox: this needs a third visual
// state for "some of the selected tracks are already in here", and the
// shared one is styled from Tailwind theme tokens that don't line up with
// the rest of this modal.
function TriStateBox({ state }: { state: Membership }): React.JSX.Element {
  const filled = state !== 'none'
  return (
    <span
      style={{
        width: '13px',
        height: '13px',
        flexShrink: 0,
        borderRadius: '3px',
        border: `1px solid ${filled ? '#7f77dd' : '#3a3a4a'}`,
        background: state === 'all' ? '#7f77dd' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {state === 'all' && (
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1.5 5.2 L3.8 7.5 L8.5 2.6"
            fill="none"
            stroke="#17171f"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === 'some' && (
        <span style={{ width: '7px', height: '2px', borderRadius: '1px', background: '#7f77dd' }} />
      )}
    </span>
  )
}
