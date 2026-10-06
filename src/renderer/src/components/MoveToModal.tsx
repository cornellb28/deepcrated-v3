import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronRight,
  CornerDownRight,
  Folder,
  FolderPlus,
  HardDrive,
  History,
  Search
} from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useLibraryStore } from '../store/useLibraryStore'
import {
  allFolderPaths,
  filterFolderTree,
  findNode,
  flattenFolderTree,
  displayPath,
  formatBytes,
  makeNode,
  parentDirectory,
  setNodeChildren,
  type FolderNode
} from '../lib/folderTree'

const ACCENT = '#7f77dd'
const RECENTS_KEY = 'recent_move_destinations'
const MAX_RECENTS = 5
// How many second-level directories the open reads ahead of being asked.
const PREFETCH_DIR_BUDGET = 80

interface MoveToModalProps {
  trackIds: number[]
  open: boolean
  onClose: () => void
  /** Called once the move job has been dispatched. */
  onMoveStarted?: () => void
}

export function MoveToModal({
  trackIds,
  open,
  onClose,
  onMoveStarted
}: MoveToModalProps): React.JSX.Element {
  const { tracks, upsertJob } = useLibraryStore()

  const [roots, setRoots] = useState<FolderNode[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [namingFolder, setNamingFolder] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [crossDevice, setCrossDevice] = useState<{ path: string; bytes: number } | null>(null)
  const [moving, setMoving] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedTracks = useMemo(
    () => tracks.filter((t) => trackIds.includes(t.id)),
    [tracks, trackIds]
  )

  // How many of the selected tracks already sit in each folder. A folder
  // holding ALL of them is a no-op destination and is refused; one holding
  // only some is still a perfectly good destination for the rest, so it is
  // annotated rather than disabled.
  const alreadyHere = useMemo(() => {
    const counts = new Map<string, number>()
    for (const track of selectedTracks) {
      const dir = parentDirectory(track.filepath)
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
    return counts
  }, [selectedTracks])

  const isNoOpDestination = useCallback(
    (path: string) => (alreadyHere.get(path) ?? 0) === trackIds.length && trackIds.length > 0,
    [alreadyHere, trackIds.length]
  )

  const totalBytes = useMemo(
    () => selectedTracks.reduce((sum, t) => sum + (t.file_size_bytes ?? 0), 0),
    [selectedTracks]
  )

  const loadChildren = useCallback(async (path: string): Promise<FolderNode[]> => {
    const result = await window.api.fs.readFolder(path)
    if (!result.ok || !result.items) return []
    return result.items
      .filter((item) => item.isDirectory)
      .map((item) => makeNode(item.name, item.path))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [])

  // ── Open ─────────────────────────────────────────────────
  // Roots are expanded eagerly: a picker that opens on three collapsed rows
  // gives the filter nothing to search and makes the common case (a folder
  // one level down) two clicks instead of none.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setQuery('')
      setCursor(0)
      setSelectedPath(null)
      setCrossDevice(null)
      setNamingFolder(false)
      setMoving(false)

      const [registered, storedRecents] = await Promise.all([
        window.api.roots.all(),
        window.api.settings.get(RECENTS_KEY)
      ])
      if (cancelled) return

      // Two levels are read up front, not one. The filter can only search
      // folders that have been loaded, and a picker that opens on three
      // collapsed roots gives it nothing — while "the folder I want is one
      // level inside a root" is the ordinary case. The second level is
      // capped so a drive with hundreds of top-level folders cannot turn
      // opening this modal into a full directory walk.
      const rootNodes = registered.map((r) => makeNode(r.name, r.path, true))
      const firstLevel = await Promise.all(
        rootNodes.map(async (node) => ({ ...node, children: await loadChildren(node.path) }))
      )
      if (cancelled) return

      setRoots(firstLevel)
      setExpanded(new Set(firstLevel.map((n) => n.path)))
      setLoading(false)

      const budget: string[] = []
      for (const root of firstLevel) {
        for (const child of root.children ?? []) {
          if (budget.length >= PREFETCH_DIR_BUDGET) break
          budget.push(child.path)
        }
      }
      const secondLevel = await Promise.all(
        budget.map(async (path) => [path, await loadChildren(path)] as const)
      )
      if (cancelled) return
      setRoots((current) =>
        secondLevel.reduce((acc, [path, children]) => setNodeChildren(acc, path, children), current)
      )

      try {
        const parsed = storedRecents ? (JSON.parse(storedRecents) as string[]) : []
        setRecents(Array.isArray(parsed) ? parsed : [])
      } catch {
        setRecents([])
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [open, loadChildren])

  const searching = query.trim().length > 0
  const filtered = useMemo(() => filterFolderTree(roots, query), [roots, query])
  const effectiveExpanded = useMemo(
    () => (searching ? new Set(allFolderPaths(filtered)) : expanded),
    [searching, filtered, expanded]
  )
  const rows = useMemo(
    () => flattenFolderTree(filtered, effectiveExpanded),
    [filtered, effectiveExpanded]
  )

  const safeCursor = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1)

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${safeCursor}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [safeCursor])

  // ── Expansion ────────────────────────────────────────────

  async function expand(path: string): Promise<void> {
    const node = findNode(roots, path)
    if (node && node.children === null) {
      setLoadingPaths((s) => new Set(s).add(path))
      const children = await loadChildren(path)
      setRoots((current) => setNodeChildren(current, path, children))
      setLoadingPaths((s) => {
        const next = new Set(s)
        next.delete(path)
        return next
      })
    }
    setExpanded((s) => new Set(s).add(path))
  }

  function collapse(path: string): void {
    setExpanded((s) => {
      const next = new Set(s)
      next.delete(path)
      return next
    })
  }

  function toggleExpanded(path: string): void {
    if (expanded.has(path)) collapse(path)
    else void expand(path)
  }

  // ── Choosing a destination ───────────────────────────────
  // Hover deliberately does not move the cursor the way it does in the
  // crate picker: this modal commits a change to files on disk, so the
  // destination only ever changes on a click or a key press.
  async function choose(path: string): Promise<void> {
    if (isNoOpDestination(path)) return
    setSelectedPath(path)
    setCrossDevice(null)
    setNamingFolder(false)

    const filepaths = selectedTracks.map((t) => t.filepath)
    if (filepaths.length === 0) return
    const precheck = await window.api.fs.isCrossDevice(filepaths, path)
    // A failed precheck is not worth blocking on — the move job reports any
    // real per-file error itself. It just means no warning is shown.
    if (precheck.ok && precheck.crossDevice) {
      setCrossDevice({ path, bytes: precheck.totalBytes ?? totalBytes })
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(Math.min(safeCursor + 1, rows.length - 1))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(Math.max(safeCursor - 1, 0))
    }
    if (e.key === 'ArrowRight' && !searching) {
      const row = rows[safeCursor]
      if (!row) return
      e.preventDefault()
      if (!row.expanded) void expand(row.node.path)
    }
    if (e.key === 'ArrowLeft' && !searching) {
      const row = rows[safeCursor]
      if (!row) return
      e.preventDefault()
      if (row.expanded) collapse(row.node.path)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[safeCursor]
      if (row) void choose(row.node.path)
    }
  }

  // ── New folder ───────────────────────────────────────────

  // Always creates inside the folder currently chosen as the destination,
  // then makes the new folder the destination. Creating a folder here is
  // only ever in service of moving into it.
  async function handleCreateFolder(): Promise<void> {
    const parentPath = selectedPath
    const name = newName.trim()
    if (!parentPath || !name || creating) return
    setCreating(true)
    try {
      const result = await window.api.fs.createFolder(parentPath, name)
      if (!result.ok || !result.path) {
        toast.error('Could not create folder', { description: result.error ?? 'Unknown error' })
        return
      }
      if (result.folderId === null) {
        toast.warning(`Created "${name}"`, { description: result.reason })
      }

      // Re-read the parent so the new folder appears in the tree in place.
      const children = await loadChildren(parentPath)
      setRoots((current) => setNodeChildren(current, parentPath, children))
      setExpanded((s) => new Set(s).add(parentPath))
      setNamingFolder(false)
      setNewName('')
      setQuery('')
      await choose(result.path)
    } finally {
      setCreating(false)
    }
  }

  // ── Committing ───────────────────────────────────────────

  async function rememberDestination(path: string): Promise<void> {
    const next = [path, ...recents.filter((p) => p !== path)].slice(0, MAX_RECENTS)
    setRecents(next)
    await window.api.settings.set(RECENTS_KEY, JSON.stringify(next))
  }

  async function commitMove(): Promise<void> {
    if (!selectedPath || moving || trackIds.length === 0) return
    setMoving(true)
    try {
      const { jobId } = await window.api.fs.moveFiles({
        trackIds,
        destAbsolutePath: selectedPath
      })
      upsertJob({
        type: 'move',
        jobId,
        trackIds,
        phase: 'running',
        done: 0,
        total: trackIds.length,
        currentFile: '',
        bytesCopied: 0,
        totalBytes: 0,
        crossDevice: crossDevice !== null,
        failed: []
      })
      await rememberDestination(selectedPath)
      onMoveStarted?.()
      onClose()
    } catch (err) {
      toast.error('Could not move the files', { description: (err as Error).message })
    } finally {
      setMoving(false)
    }
  }

  const trackLabel =
    trackIds.length === 1
      ? (selectedTracks[0]?.title ?? selectedTracks[0]?.filename ?? '1 track')
      : `${trackIds.length} tracks`
  const sizeLabel = formatBytes(totalBytes)

  const recentNodes = recents.filter((path) => !isNoOpDestination(path)).slice(0, MAX_RECENTS)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          borderRadius: '12px',
          maxWidth: '500px',
          width: '100%',
          maxHeight: '80vh',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: 0,
          gap: 0,
          display: 'flex',
          flexDirection: 'column',
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
          <div style={{ fontSize: '13px', fontWeight: 600 }}>Move to folder</div>
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
            {sizeLabel && ` · ${sizeLabel}`}
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
              value={query}
              placeholder="Filter folders"
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
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
              onFocusCapture={(e) => (e.target.style.borderColor = ACCENT)}
              onBlurCapture={(e) => (e.target.style.borderColor = '#252535')}
            />
          </div>
        </div>

        {/* ── Tree ────────────────────────────────── */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: '160px',
            overflowY: 'auto',
            padding: '0 8px 6px',
            borderBottom: '0.5px solid #24242f'
          }}
        >
          {loading && (
            <div style={{ padding: '24px', fontSize: '11px', color: '#444', textAlign: 'center' }}>
              Reading folders…
            </div>
          )}

          {!loading && roots.length === 0 && (
            <div
              style={{
                padding: '24px 12px',
                fontSize: '11px',
                color: '#4a4a5c',
                textAlign: 'center',
                lineHeight: 1.6
              }}
            >
              No library folders registered yet. Import a folder first.
            </div>
          )}

          {/* Recent destinations — a DJ filing a crate moves track after
              track into the same folder, and finding it again in the tree
              every time is the slow part. */}
          {!loading && !searching && recentNodes.length > 0 && (
            <>
              <SectionLabel icon={<History size={10} />} text="Recent" />
              {recentNodes.map((path) => (
                <Row
                  key={`recent-${path}`}
                  label={path.split('/').pop() ?? path}
                  sublabel={displayPath(path, roots)}
                  depth={0}
                  icon={<Folder size={12} style={{ color: '#6a6a80' }} />}
                  selected={selectedPath === path}
                  onClick={() => void choose(path)}
                />
              ))}
              <div style={{ height: '1px', background: '#24242f', margin: '6px 8px' }} />
            </>
          )}

          {!loading &&
            rows.map((row, index) => {
              const { node, depth, expanded: isExpanded } = row
              const here = alreadyHere.get(node.path) ?? 0
              const noOp = isNoOpDestination(node.path)
              const canExpand = node.children === null || node.children.length > 0

              return (
                  <Row
                    key={node.path}
                    dataRow={index}
                    label={node.name}
                    depth={depth}
                    icon={
                      node.isRoot ? (
                        <HardDrive size={12} style={{ color: '#6a6a80' }} />
                      ) : (
                        <Folder size={12} style={{ color: '#6a6a80' }} />
                      )
                    }
                    selected={selectedPath === node.path}
                    cursored={index === safeCursor}
                    disabled={noOp}
                    badge={
                      here === 0
                        ? undefined
                        : noOp
                          ? 'already here'
                          : `${here} already here`
                    }
                    loading={loadingPaths.has(node.path)}
                    expandable={canExpand && !searching}
                    expanded={isExpanded}
                    onToggleExpand={() => toggleExpanded(node.path)}
                    onClick={() => void choose(node.path)}
                  />
              )
            })}

          {!loading && searching && rows.length === 0 && (
            <div
              style={{
                padding: '24px 12px',
                fontSize: '11px',
                color: '#4a4a5c',
                textAlign: 'center',
                lineHeight: 1.6
              }}
            >
              No folder matches “{query.trim()}”.
              <br />
              <span style={{ color: '#3a3a48' }}>
                Deeply nested folders are only searched once you open them.
              </span>
            </div>
          )}
        </div>

        {/* ── Destination ─────────────────────────── */}
        <div
          style={{
            padding: '10px 16px',
            flexShrink: 0,
            borderBottom: '0.5px solid #24242f',
            minHeight: '46px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '4px'
          }}
        >
          {selectedPath ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  minWidth: 0
                }}
              >
                <CornerDownRight size={12} style={{ color: ACCENT, flexShrink: 0 }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: '11px',
                    color: '#c0c0d8',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={selectedPath}
                >
                  {displayPath(selectedPath, roots)}
                </span>

                {/* Creating a subfolder belongs here, next to the folder it
                    goes inside — in the tree it had to render between a
                    folder and its own children, which read as a sibling. */}
                {!namingFolder && (
                  <button
                    onClick={() => {
                      setNewName('')
                      setNamingFolder(true)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      fontSize: '10px',
                      color: '#6a6a80',
                      cursor: 'pointer',
                      flexShrink: 0
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#a09be8')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#6a6a80')}
                  >
                    <FolderPlus size={11} />
                    New subfolder
                  </button>
                )}
              </div>

              {namingFolder ? (
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginTop: '2px' }}>
                  <input
                    autoFocus
                    value={newName}
                    disabled={creating}
                    placeholder={`New folder inside ${selectedPath.split('/').pop()}`}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleCreateFolder()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setNamingFolder(false)
                        setNewName('')
                      }
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: '#101017',
                      border: `0.5px solid ${ACCENT}`,
                      borderRadius: '5px',
                      color: '#e8e8f0',
                      fontSize: '11px',
                      padding: '4px 7px',
                      fontFamily: 'inherit',
                      outline: 'none'
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={!newName.trim() || creating}
                    onClick={() => void handleCreateFolder()}
                    style={{ borderColor: ACCENT, color: '#a09be8' }}
                  >
                    Create
                  </Button>
                </div>
              ) : (
                <div style={{ fontSize: '10px', color: crossDevice ? '#d8b87a' : '#4a4a5c' }}>
                  {crossDevice
                    ? `Different drive — ${formatBytes(crossDevice.bytes) || 'these files'} will be copied across, which takes time.`
                    : 'Same drive — moves instantly.'}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '11px', color: '#4a4a5c' }}>
              Pick a destination folder. You can add a subfolder once one is picked.
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '6px',
            padding: '10px 16px',
            background: '#13131b',
            flexShrink: 0
          }}
        >
          <Button variant="ghost" size="sm" className="text-xs" onClick={onClose} style={{ color: '#6a6a80' }}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={!selectedPath || moving}
            onClick={() => void commitMove()}
            style={{
              borderColor: selectedPath ? ACCENT : '#252535',
              color: selectedPath ? '#a09be8' : '#3f3f4e'
            }}
          >
            {moving
              ? 'Starting…'
              : `Move ${trackIds.length} ${trackIds.length === 1 ? 'file' : 'files'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Small pieces ─────────────────────────────────────────

function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        padding: '8px 8px 4px',
        fontSize: '9px',
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: '#3f3f4e'
      }}
    >
      {icon}
      {text}
    </div>
  )
}

function Row({
  dataRow,
  label,
  sublabel,
  depth,
  icon,
  selected,
  cursored,
  disabled,
  badge,
  loading,
  expandable,
  expanded,
  onToggleExpand,
  onClick
}: {
  dataRow?: number
  label: string
  sublabel?: string
  depth: number
  icon?: React.ReactNode
  selected: boolean
  cursored?: boolean
  disabled?: boolean
  badge?: string
  loading?: boolean
  expandable?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  onClick: () => void
}): React.JSX.Element {
  const background = selected ? '#2a2740' : cursored ? '#242433' : 'transparent'

  return (
    <div
      data-row={dataRow}
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 14}px`,
        borderRadius: '6px',
        fontSize: '12px',
        color: disabled ? '#4a4a5c' : selected ? '#e8e8f0' : '#c0c0d8',
        cursor: disabled ? 'default' : 'pointer',
        background,
        border: selected ? `0.5px solid ${ACCENT}` : '0.5px solid transparent'
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (expandable) onToggleExpand?.()
        }}
        tabIndex={-1}
        aria-label={expandable ? (expanded ? 'Collapse' : 'Expand') : undefined}
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
          cursor: expandable ? 'pointer' : 'default',
          visibility: expandable ? 'visible' : 'hidden'
        }}
      >
        <ChevronRight
          size={12}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.12s ease'
          }}
        />
      </button>

      {icon && <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>}

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </span>
        {sublabel && (
          <span
            style={{
              display: 'block',
              fontSize: '9px',
              color: '#3f3f4e',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {sublabel}
          </span>
        )}
      </span>

      {loading && <span style={{ fontSize: '9px', color: '#4a4a5c', flexShrink: 0 }}>…</span>}
      {badge && (
        <span style={{ fontSize: '9px', color: '#4a4a5c', flexShrink: 0 }}>{badge}</span>
      )}
    </div>
  )
}
