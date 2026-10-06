import React, { useState, useMemo, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useLibraryStore } from '../store/useLibraryStore'
import { FolderCard } from '../components/FolderCard'
import { MosaicArtwork } from '../components/MosaicArtwork'
import { TrackRow } from '../components/TrackRow'
import { TrackCard } from '../components/TrackCard'
import { TRACK_GRID_GAP, trackGridColumns } from '../lib/trackCard'
import { BulkBar } from '../components/BulkBar'
import { useFileDrop } from '../hooks/useFileDrop'
import { MoveConfirmDialog } from '../components/MoveConfirmDialog'
import { NewFolderModal } from '../components/NewFolderModal'
import { DeleteFolderDialog, type DeleteFolderChoice } from '../components/DeleteFolderDialog'
import { RenameFolderDialog } from '../components/RenameFolderDialog'
import { RenameFilesDialog } from '../components/RenameFilesDialog'
import { ChevronLeft, ChevronRight, FilePen, FolderPen, Library, Plus, RotateCw, Trash2 } from 'lucide-react'

// Shared with MoveFileButton's single-track "Move to..." confirmation —
// dismissing one dismisses both, they're the same underlying concern.
const MOVE_CONFIRM_SETTING_KEY = 'skip_move_confirmation'
const HIGHLIGHT_DURATION_MS = 1800

interface FolderViewProps {
  libraryRoots: LibraryRoot[] // all registered library roots
  onRootsChanged: () => Promise<void>
}

export function FolderView({ libraryRoots, onRootsChanged }: FolderViewProps): React.JSX.Element {
  // `folders`/`folderCounts` live in the shared store, populated once at
  // startup and kept fresh by App.tsx's single debounced onFoldersChanged
  // subscription — this view just reads them, it doesn't fetch its own copy.
  const {
    tracks,
    displayMode,
    isAnalyzing,
    setAnalyzing,
    setTracks,
    folders,
    folderCounts,
    upsertJob,
    setPendingFolderNav
  } = useLibraryStore()

  // Navigation stack — array of folder ids (from the `folders` table). Empty
  // = top-level root picker.
  const [navStack, setNavStack] = useState<number[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // Opens NewFolderModal, which owns the name, the track search and the
  // create-plus-move. Scoped to the folder currently being browsed.
  const [creatingFolder, setCreatingFolder] = useState(false)
  // Folder selected for the shared remove/trash confirmation dialog.
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  // Which folder the rename dialog is for. The header button passes the
  // folder being browsed; a card passes itself, so a subfolder can be
  // renamed without opening it first.
  const [renameTargetId, setRenameTargetId] = useState<number | null>(null)
  const [renamingFiles, setRenamingFiles] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // Surfaced inside the dialog, not only as a toast. A failure here leaves
  // the dialog open, and an open dialog with no stated reason reads as
  // "the button does nothing".
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const subfoldersSliderRef = useRef<HTMLDivElement>(null)

  // Folders currently flashing (see armHighlight) — a folder id lives here
  // for HIGHLIGHT_DURATION_MS after being created, imported, or moved in.
  const [highlightedFolderIds, setHighlightedFolderIds] = useState<Set<number>>(new Set())
  // Destination paths waiting for their folder row to exist — a dropped
  // directory's post-move re-scan creates it asynchronously, so there's no
  // id to highlight yet at drop time, only the path it'll land at.
  const [pendingHighlightPaths, setPendingHighlightPaths] = useState<string[]>([])
  // Armed when a Finder drop needs the "move, not copy" confirmation —
  // holds everything performMove needs once the DJ confirms.
  const [moveConfirm, setMoveConfirm] = useState<{
    accepted: { path: string; kind: 'dir' | 'audio' }[]
    folder: FolderRow
  } | null>(null)

  const currentFolderId = navStack.length > 0 ? navStack[navStack.length - 1] : null

  // `folders` mirrors the real directory tree (populated at import time) and
  // `folderCounts` is one GROUP BY query — everything else (recursive counts,
  // "hide empty folders", artwork sampling) is rolled up from these plus the
  // already-loaded `tracks` array, in memory, instead of a query per folder
  // card.
  const foldersById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])

  const childrenByParent = useMemo(() => {
    const map = new Map<number | null, FolderRow[]>()
    for (const f of folders) {
      const key = f.parent_folder_id
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(f)
    }
    return map
  }, [folders])

  const directCountByFolder = useMemo(
    () => new Map(folderCounts.map((c) => [c.folder_id, c.count])),
    [folderCounts]
  )

  // Recursive track count per folder — own direct count plus every
  // descendant's, memoized per folders/counts change so a grid of N folder
  // cards costs one pass over `folders`, not N queries.
  const recursiveCountByFolder = useMemo(() => {
    const cache = new Map<number, number>()
    function compute(id: number): number {
      const cached = cache.get(id)
      if (cached !== undefined) return cached
      let total = directCountByFolder.get(id) ?? 0
      for (const child of childrenByParent.get(id) ?? []) {
        total += compute(child.id)
      }
      cache.set(id, total)
      return total
    }
    for (const f of folders) compute(f.id)
    return cache
  }, [folders, directCountByFolder, childrenByParent])

  // Every folder id in a folder's own subtree (including itself) — used to
  // sample artwork recursively without a per-card query.
  const descendantIdsByFolder = useMemo(() => {
    const cache = new Map<number, Set<number>>()
    function compute(id: number): Set<number> {
      const cached = cache.get(id)
      if (cached) return cached
      const set = new Set<number>([id])
      for (const child of childrenByParent.get(id) ?? []) {
        for (const d of compute(child.id)) set.add(d)
      }
      cache.set(id, set)
      return set
    }
    for (const f of folders) compute(f.id)
    return cache
  }, [folders, childrenByParent])

  // A library root's own folder row (parent_folder_id NULL, relative_path
  // "") — created by ensureFolderTree the first time that root is imported.
  const rootFolderIdByLibraryRootId = useMemo(() => {
    const map = new Map<number, number>()
    for (const f of folders) {
      if (f.parent_folder_id === null && f.root_folder_id !== null) {
        map.set(f.root_folder_id, f.id)
      }
    }
    return map
  }, [folders])

  // Every track under the folder being browsed, subfolders included — the
  // set both rename dialogs and the "move out" branch operate on. Reuses the
  // descendant map rather than walking the tree a second time.
  const tracksUnderCurrent = useMemo(() => {
    if (currentFolderId === null) return []
    const under = descendantIdsByFolder.get(currentFolderId) ?? new Set([currentFolderId])
    return tracks.filter((t) => t.folder_id !== null && under.has(t.folder_id))
  }, [tracks, currentFolderId, descendantIdsByFolder])

  // Both renames change filepaths under this folder, so the shared slice has
  // to be refetched — the rows the store holds still point at the old paths.
  async function reloadTracks(): Promise<void> {
    setTracks(await window.api.db.allTracks())
  }

  function getTrackCount(folderId: number): number {
    return recursiveCountByFolder.get(folderId) ?? 0
  }

  function getArtworkForFolder(folderId: number): (string | null)[] {
    const ids = descendantIdsByFolder.get(folderId) ?? new Set([folderId])
    return tracks
      .filter((t) => t.folder_id !== null && ids.has(t.folder_id))
      .filter((t) => t.artwork_hash)
      .slice(0, 4)
      .map((t) => t.artwork_hash)
  }

  // Navigate into a subfolder
  function navigateInto(folderId: number): void {
    setNavStack((prev) => [...prev, folderId])
    setSelectedIds(new Set())
  }

  // Jump to an arbitrary folder id regardless of where the view currently
  // is — walks parent_folder_id up to build the full ancestor chain, since
  // navStack has to hold every id from the root down, not just the target.
  // Used by the Home shortcut and by the pendingFolderNav effect below
  // (App.tsx/BackgroundJobsPanel's "Open folder" action) — navigateInto
  // above stays as the simple push for the common case of clicking a card
  // that's already a child of wherever you are.
  function navigateToFolder(folderId: number): void {
    const chain: number[] = []
    let current: number | undefined = folderId
    while (current !== undefined) {
      chain.unshift(current)
      current = foldersById.get(current)?.parent_folder_id ?? undefined
    }
    setNavStack(chain)
    setSelectedIds(new Set())
  }

  // Flashes one folder card for HIGHLIGHT_DURATION_MS, then clears itself.
  function armHighlight(folderId: number): void {
    setHighlightedFolderIds((prev) => new Set(prev).add(folderId))
    setTimeout(() => {
      setHighlightedFolderIds((prev) => {
        const next = new Set(prev)
        next.delete(folderId)
        return next
      })
    }, HIGHLIGHT_DURATION_MS)
  }

  function joinPath(dir: string, name: string): string {
    return `${dir.replace(/\/+$/, '')}/${name}`
  }

  // Import everything under the folder currently being browsed — recurses into
  // every subfolder, same scanner the Toolbar's "+ Import folder" button uses
  // rescan = true: this button is a re-scan of a folder already in the
  // library, so it sweeps as well as imports — tracks under this folder
  // whose files are no longer on disk get marked missing (never deleted).
  // The two genuine first-import paths (the folder dialog and the Finder
  // drop in App.tsx) leave the flag off, since walking one folder says
  // nothing about what should still exist outside it.
  async function handleImportThisFolder(folderPath: string): Promise<void> {
    setAnalyzing(true)
    const result = await window.api.importFolder(folderPath, undefined, true)
    if (result.ok) {
      const all = await window.api.db.allTracks()
      setTracks(all)
    }
    setAnalyzing(false)
  }

  // A parent move is a job, not a deletion: the source folder stays in place
  // so failed/colliding files are never stranded. The folder can be removed
  // separately once its contents and child folders are dealt with.
  async function handleDeleteFolder(folderId: number, choice: DeleteFolderChoice): Promise<void> {
    const target = foldersById.get(folderId)
    if (!target) return

    if (choice === 'move') {
      const descendants = descendantIdsByFolder.get(folderId) ?? new Set([folderId])
      const ids = tracks
        .filter((track) => track.folder_id !== null && descendants.has(track.folder_id))
        .map((track) => track.id)
      if (ids.length === 0) {
        setDeleteTargetId(null)
        toast.info('Nothing to move', { description: 'This folder has no tracks in it.' })
        return
      }

      setDeleteBusy(true)
      setDeleteError(null)
      try {
        const result = await window.api.fs.moveFolderTracksToParent(folderId)
        if (!result.ok || !result.jobId) {
          setDeleteError(result.error ?? 'Could not move tracks to the parent folder')
          return
        }
        upsertJob({
          type: 'move',
          jobId: result.jobId,
          trackIds: result.trackIds ?? ids,
          phase: 'running',
          done: 0,
          total: result.trackIds?.length ?? ids.length,
          currentFile: '',
          bytesCopied: 0,
          totalBytes: 0,
          crossDevice: false,
          failed: []
        })
        setDeleteTargetId(null)
        toast.info('Moving tracks into the parent folder', {
          description: 'The folder and its subfolders remain until you remove them.'
        })
      } catch (err) {
        setDeleteError((err as Error).message)
      } finally {
        setDeleteBusy(false)
      }
      return
    }

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const isWatchedRoot = target.parent_folder_id === null
      const result = await window.api.fs.deleteFolder(folderId, choice)
      if (!result.ok) {
        setDeleteError(result.error ?? 'Unknown error')
        toast.error('Could not remove the folder', { description: result.error ?? 'Unknown error' })
        return
      }

      const targetIndex = navStack.indexOf(folderId)
      if (targetIndex >= 0) setNavStack(navStack.slice(0, targetIndex))
      setSelectedIds(new Set())
      setDeleteTargetId(null)

      if (choice === 'trash') {
        toast.success(`Moved “${target.name}” to the Trash`, {
          description: `${result.tracks ?? 0} track${result.tracks === 1 ? '' : 's'} removed from CrateCloud. Recoverable from Finder.`
        })
        // Track rows went with it, so the shared slice is stale.
        setTracks(await window.api.db.allTracks())
      } else {
        toast.success(`Removed “${target.name}” from CrateCloud`, {
          description: 'Your files are untouched. The tracks are still in your library.'
        })
        setTracks(await window.api.db.allTracks())
      }
      if (isWatchedRoot) await onRootsChanged()
    } catch (err) {
      setDeleteError((err as Error).message)
      toast.error('Could not remove the folder', { description: (err as Error).message })
    } finally {
      setDeleteBusy(false)
    }
  }

  // Actually runs the move — either straight from handleDropIntoFolder (the
  // "don't ask again" setting is on) or from the confirm dialog's onConfirm.
  // deleteSource: true is the only difference from the old copy-in-place
  // behavior — same job, same never-overwrite/skip-and-report semantics,
  // just relocating instead of duplicating (see copyOneFileIntoFolder).
  async function performMove(
    accepted: { path: string; kind: 'dir' | 'audio' }[],
    folder: FolderRow
  ): Promise<void> {
    if (!folder.path) return
    const sourcePaths = accepted.map((c) => c.path)

    // A dropped directory's folder row doesn't exist yet — it's created by
    // the post-move re-scan below, asynchronously — so all we can arm right
    // now is the path it'll land at; the effect watching `folders` resolves
    // it to an id (and flashes it) once that row actually appears.
    const newDirPaths = accepted
      .filter((c) => c.kind === 'dir')
      .map((c) => joinPath(folder.path as string, c.path.split('/').pop() ?? c.path))
    if (newDirPaths.length > 0) {
      setPendingHighlightPaths((prev) => [...prev, ...newDirPaths])
    }

    const { jobId } = await window.api.fs.copyIntoFolder({
      sourcePaths,
      destAbsolutePath: folder.path,
      currentFolderPath: folder.path,
      deleteSource: true
    })
    upsertJob({
      type: 'copy',
      jobId,
      phase: 'running',
      done: 0,
      total: sourcePaths.length,
      currentFile: '',
      bytesCopied: 0,
      totalBytes: 0,
      failed: [],
      deleteSource: true
    })
  }

  // Drag-and-drop from Finder into the folder currently being browsed
  // relocates the dropped paths — see performMove. Looks up the folder by
  // id rather than closing over `currentFolder` (defined further down,
  // after this function — but this hook has to be called before either
  // early return below, so it can't depend on anything defined after them).
  async function handleDropIntoFolder(paths: string[]): Promise<void> {
    const folder = currentFolderId !== null ? foldersById.get(currentFolderId) : undefined
    if (!folder?.path) return

    const classified = await window.api.fs.classifyPaths(paths)
    const accepted = classified.filter(
      (c): c is { path: string; kind: 'dir' | 'audio' } => c.kind === 'dir' || c.kind === 'audio'
    )
    const skipped = classified.filter((c) => c.kind === 'other').map((c) => c.path)

    if (skipped.length > 0) {
      toast.warning(
        `Skipped ${skipped.length} unsupported file${skipped.length !== 1 ? 's' : ''}`,
        { description: skipped.map((p) => p.split('/').pop()).join(', ') }
      )
    }
    if (accepted.length === 0) return

    const dismissed = await window.api.settings.get(MOVE_CONFIRM_SETTING_KEY)
    if (dismissed === 'true') {
      await performMove(accepted, folder)
    } else {
      setMoveConfirm({ accepted, folder })
    }
  }

  // MoveConfirmDialog's onConfirm — persists the shared skip-confirmation
  // setting first (if checked) so a page reload isn't needed for it to
  // take effect on the very next drop, then runs the move that was pending.
  async function confirmMove(dontAskAgain: boolean): Promise<void> {
    const pending = moveConfirm
    setMoveConfirm(null)
    if (!pending) return
    if (dontAskAgain) {
      await window.api.settings.set(MOVE_CONFIRM_SETTING_KEY, 'true')
    }
    await performMove(pending.accepted, pending.folder)
  }

  const currentFolderForDrop = currentFolderId !== null ? foldersById.get(currentFolderId) : undefined
  const { isDragging: isDraggingFiles, dropHandlers: folderDropHandlers } = useFileDrop({
    onDrop: handleDropIntoFolder,
    accept: !!currentFolderForDrop?.path
  })

  // Cross-component navigation signal (App.tsx's import-completion toast
  // action, or BackgroundJobsPanel's "Open folder" button) — consumed once,
  // then cleared. Subscribed rather than watched via a dependency effect so
  // the state update happens in a subscription callback (an external-system
  // event, same as onCopyProgress etc.) instead of synchronously in an
  // effect body, which react-hooks/set-state-in-effect flags as a
  // cascading-render risk. The subscription itself is set up once, but
  // navigateToFolder closes over foldersById, which changes whenever
  // `folders` does — including "a brand-new root just got imported and the
  // DJ clicked Open folder," the exact case this exists for — so it's
  // called through a ref kept fresh every render, not the closure a `[]`
  // effect would otherwise freeze at mount.
  const navigateToFolderRef = useRef(navigateToFolder)
  useEffect(() => {
    navigateToFolderRef.current = navigateToFolder
  })

  useEffect(() => {
    return useLibraryStore.subscribe((state, prev) => {
      if (state.pendingFolderNav != null && state.pendingFolderNav !== prev.pendingFolderNav) {
        navigateToFolderRef.current(state.pendingFolderNav)
        setPendingFolderNav(null)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resolves armed highlight paths (see performMove) to folder ids once
  // their row actually exists in `folders` — a dropped directory's row is
  // created asynchronously by the post-move re-scan, so there's nothing to
  // highlight yet at drop time. Same subscribe-based shape as above, reading
  // the latest pending list from a ref so the one-time subscription doesn't
  // close over a stale array from mount.
  const pendingHighlightPathsRef = useRef(pendingHighlightPaths)
  useEffect(() => {
    pendingHighlightPathsRef.current = pendingHighlightPaths
  }, [pendingHighlightPaths])

  useEffect(() => {
    function resolvePending(currentFolders: FolderRow[]): void {
      const pending = pendingHighlightPathsRef.current
      if (pending.length === 0) return
      const stillPending: string[] = []
      for (const path of pending) {
        const match = currentFolders.find((f) => f.path === path)
        if (match) armHighlight(match.id)
        else stillPending.push(path)
      }
      if (stillPending.length !== pending.length) setPendingHighlightPaths(stillPending)
    }
    return useLibraryStore.subscribe((state, prev) => {
      if (state.folders !== prev.folders) resolvePending(state.folders)
    })
  }, [])

  // Top level — no folder selected yet — show all registered library roots
  // Built once and rendered in BOTH branches below.
  //
  // It used to be mounted only in the single-folder tree, which returns
  // AFTER the root-picker early return — so clicking rename on a watched
  // folder's card set the state and rendered nothing, and the dialog only
  // appeared once you navigated into a folder and crossed the early return.
  // Any dialog reachable from the picker has to live above it.
  const renameDialog =
    renameTargetId !== null
      ? (() => {
          const target = foldersById.get(renameTargetId)
          if (!target) return null
          const childCount = (childrenByParent.get(renameTargetId) ?? []).length
          return (
            <RenameFolderDialog
              open
              folderId={renameTargetId}
              currentName={target.name}
              trackCount={getTrackCount(renameTargetId)}
              subfolderCount={childCount}
              isWatchedFolder={target.parent_folder_id == null}
              onClose={() => setRenameTargetId(null)}
              onRenamed={() => {
                setSelectedIds(new Set())
                void reloadTracks()
              }}
            />
          )
        })()
      : null

  const deleteTarget = deleteTargetId === null ? undefined : foldersById.get(deleteTargetId)
  const deleteDialog = deleteTarget ? (
    <DeleteFolderDialog
      open
      folderName={deleteTarget.name}
      trackCount={getTrackCount(deleteTarget.id)}
      subfolderCount={(childrenByParent.get(deleteTarget.id) ?? []).length}
      isWatchedFolder={deleteTarget.parent_folder_id === null}
      busy={deleteBusy}
      error={deleteError}
      onChoose={(choice) => void handleDeleteFolder(deleteTarget.id, choice)}
      onCancel={() => {
        setDeleteTargetId(null)
        setDeleteError(null)
      }}
    />
  ) : null

  if (currentFolderId === null) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {renameDialog}
        {deleteDialog}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <h2
            style={{
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: '#444',
              marginBottom: '14px'
            }}
          >
            Folders
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: '16px'
            }}
          >
            {libraryRoots.map((root) => {
              const rootFolderId = rootFolderIdByLibraryRootId.get(root.id)
              // Briefly undefined right after a root is registered — its
              // own folder row is created as soon as the scan starts, but
              // there's a moment before that where the renderer already
              // has the root but folders:tree doesn't yet. Dim + non-click
              // instead of a silent no-op.
              const pending = rootFolderId === undefined
              return (
                <div
                  key={root.id}
                  style={pending ? { opacity: 0.5, cursor: 'default' } : undefined}
                  title={pending ? 'Scanning…' : undefined}
                >
                  {/* Watched folders rename too. It is a heavier operation
                      than a subfolder — library_roots.path follows, and the
                      watcher is stopped and restarted on the new path — but
                      it is the same gesture, so it is offered the same way.
                      Not while pending: there is no folder row yet. */}
                  <FolderCard
                    name={root.name}
                    path={root.path}
                    trackCount={pending ? 0 : getTrackCount(rootFolderId)}
                    artworkHashes={pending ? [] : getArtworkForFolder(rootFolderId)}
                    highlighted={!pending && highlightedFolderIds.has(rootFolderId)}
                    onClick={() => {
                      if (!pending) navigateInto(rootFolderId)
                    }}
                    onRename={pending ? undefined : () => setRenameTargetId(rootFolderId)}
                    onDelete={pending ? undefined : () => {
                      setDeleteError(null)
                      setDeleteTargetId(rootFolderId)
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const currentFolder = foldersById.get(currentFolderId)

  if (!currentFolder) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#333'
        }}
      >
        Loading...
      </div>
    )
  }

  // Tracks directly in the current folder
  const folderTracks = tracks.filter((t) => t.folder_id === currentFolderId)

  // Subfolders — every non-missing child of this folder, empty or not.
  // `folders` already excludes missing = 1 rows (getFolderTree filters at
  // the DB layer), so a folder the watcher saw disappear drops out here on
  // its own; nothing extra to check for that. Empty ones still render,
  // dimmed, rather than hiding — a folder that was just created (or a
  // directory-only rename target that hasn't gotten tracks re-linked yet)
  // should be visible, not silently absent.
  const subfolders = childrenByParent.get(currentFolderId) ?? []

  function toggleSelect(id: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Breadcrumb segments
  const breadcrumbs = navStack.map((id) => ({
    id,
    name: foldersById.get(id)?.name ?? '?'
  }))

  // The current folder's own library root's top-level folder id — a fixed
  // shortcut alongside breadcrumbs, not a replacement for them. With
  // multiple roots this resolves to whichever root the current folder
  // actually belongs to, not just "the first one."
  const homeFolderId =
    currentFolder.root_folder_id != null
      ? rootFolderIdByLibraryRootId.get(currentFolder.root_folder_id)
      : undefined

  // Hero artwork — 4 from current folder recursively
  const heroArtwork = getArtworkForFolder(currentFolderId)
  const folderName = currentFolder.name
  const totalTracks = getTrackCount(currentFolderId)

  return (
    <div
      {...folderDropHandlers}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* ── Breadcrumb bar ──────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: '#13131b',
          padding: '8px 24px',
          borderBottom: '0.5px solid #1e1e2a',
          flexShrink: 0
        }}
      >
        {/* Home — fixed, always-visible shortcut to this root's top level,
            regardless of depth. Breadcrumbs still do their own job; this
            doesn't replace them, it's just faster than clicking the first
            crumb from three levels down. Hidden once already there. */}
        {homeFolderId !== undefined && homeFolderId !== currentFolderId && (
          <button
            onClick={() => navigateToFolder(homeFolderId)}
            title="Jump to root"
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: '13px',
              cursor: 'pointer',
              padding: '2px 4px',
              marginRight: '4px',
              lineHeight: 1,
              fontFamily: 'inherit'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#e8e8f0')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
          >
            ⌂
          </button>
        )}

        {/* Back button — one level up, hidden at the root of this library folder */}
        {navStack.length > 1 && (
          <button
            onClick={() => setNavStack(navStack.slice(0, -1))}
            title="Back"
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: '13px',
              cursor: 'pointer',
              padding: '2px 4px',
              marginRight: '4px',
              lineHeight: 1,
              fontFamily: 'inherit'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#e8e8f0')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
          >
            ←
          </button>
        )}

        {/* Back to the full watched-folder list. Nothing else reached it:
            ⌂ jumps to the CURRENT root's top level and ← goes one level up,
            so from inside a root the picker was unreachable without leaving
            the Folders view entirely.

            Rendered as the first crumb rather than another icon, because
            that is what it is — the level above every root. */}
        <button
          onClick={() => {
            setNavStack([])
            setSelectedIds(new Set())
          }}
          title="All watched folders"
          style={{
            background: 'none',
            border: 'none',
            color: '#555',
            fontSize: '12px',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            flexShrink: 0
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#a09be8')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#555')}
        >
          <Library size={12} />
          All folders
        </button>
        <span style={{ color: '#333', fontSize: '11px', flexShrink: 0 }}>/</span>

        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1
          return (
            <React.Fragment key={crumb.id}>
              {isLast ? (
                <span style={{ color: '#e8e8f0', fontSize: '12px', fontWeight: 500 }}>
                  {crumb.name}
                </span>
              ) : (
                <button
                  onClick={() => setNavStack(navStack.slice(0, i + 1))}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#555',
                    fontSize: '12px',
                    cursor: 'pointer',
                    padding: 0,
                    fontFamily: 'inherit',
                    fontWeight: 400,
                    textDecoration: 'none'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {crumb.name}
                </button>
              )}
              {!isLast && <span style={{ color: '#333', fontSize: '11px' }}>›</span>}
            </React.Fragment>
          )
        })}
      </div>

      {/* ── Hero section ──────────────────────────── */}
      <div
        style={{
          padding: '24px 24px 20px',
          background: isDraggingFiles
            ? 'linear-gradient(180deg, #241f3d 0%, #1a1626 100%)'
            : 'linear-gradient(180deg, #1a1a26 0%, #13131b 100%)',
          borderBottom: isDraggingFiles ? '2px dashed #7f77dd' : '2px dashed transparent',
          flexShrink: 0,
          transition: 'background 0.15s, border-color 0.15s'
        }}
      >
        {/* Hero content */}
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-end' }}>
          {/* Mosaic artwork — large */}
          <MosaicArtwork
            artworkHashes={heroArtwork}
            folderName={folderName}
            size={140}
            borderRadius={8}
          />

          {/* Folder info */}
          <div>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: isDraggingFiles ? '#a09be8' : '#555',
                marginBottom: '6px'
              }}
            >
              {isDraggingFiles ? `Move to ${folderName}` : 'Folder'}
            </div>
            <h1
              style={{
                fontSize: '28px',
                fontWeight: 500,
                color: '#e8e8f0',
                marginBottom: '8px',
                lineHeight: 1.2
              }}
            >
              {folderName}
            </h1>
            <div style={{ fontSize: '12px', color: '#555', marginBottom: '10px' }}>
              {totalTracks} track{totalTracks !== 1 ? 's' : ''}
              {subfolders.length > 0 && (
                <span>
                  {' '}
                  · {subfolders.length} folder{subfolders.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {currentFolder.path && (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Both actions are icon buttons now. The label lives in the
                    tooltip and the accessible name, not in the chrome —
                    this header already carries the folder name, the counts
                    and a breadcrumb above it. */}
                <IconButton
                  onClick={() => handleImportThisFolder(currentFolder.path as string)}
                  disabled={isAnalyzing}
                  label={isAnalyzing ? 'Scanning…' : 'Re-scan this folder'}
                  spinning={isAnalyzing}
                >
                  <RotateCw size={15} />
                </IconButton>

                <IconButton
                  onClick={() => setCreatingFolder(true)}
                  disabled={isAnalyzing}
                  label="New subfolder"
                >
                  <Plus size={16} />
                </IconButton>

                {/* Offered at every level, including a watched folder —
                    unlike delete, which stays off roots because removing one
                    is an un-registration, not a rename. */}
                <IconButton
                  onClick={() => setRenameTargetId(currentFolderId)}
                  disabled={isAnalyzing}
                  label={navStack.length > 1 ? 'Rename this folder' : 'Rename this watched folder'}
                >
                  <FolderPen size={15} />
                </IconButton>

                <IconButton
                  onClick={() => setRenamingFiles(true)}
                  disabled={isAnalyzing || totalTracks === 0}
                  label={
                    totalTracks === 0
                      ? 'No tracks in this folder to rename'
                      : 'Rename files from the template'
                  }
                >
                  <FilePen size={15} />
                </IconButton>

                <IconButton
                  onClick={() => {
                    setDeleteError(null)
                    setDeleteTargetId(currentFolderId)
                  }}
                  disabled={isAnalyzing}
                  label={currentFolder.parent_folder_id === null ? 'Remove this watched folder' : 'Remove this folder'}
                  danger
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            )}
          </div>
        </div>
      </div>

      {currentFolder.path && (
        <NewFolderModal
          parentPath={currentFolder.path}
          parentName={folderName}
          open={creatingFolder}
          onClose={() => setCreatingFolder(false)}
          // Stays on the parent rather than navigating into the new folder:
          // it should appear alongside the subfolders already here, not whisk
          // the DJ away to an empty one. Flashed once its row shows up.
          onCreated={(folderId) => {
            if (folderId != null) armHighlight(folderId)
          }}
        />
      )}

      {renameDialog}
      {deleteDialog}

      <RenameFilesDialog
        open={renamingFiles}
        trackIds={tracksUnderCurrent.map((t) => t.id)}
        scopeLabel={`${totalTracks} track${totalTracks === 1 ? '' : 's'} in ${folderName}`}
        onClose={() => setRenamingFiles(false)}
        onRenamed={() => void reloadTracks()}
      />

      {/* ── Scrollable content ─────────────────────── */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          outline: isDraggingFiles ? '2px dashed #7f77dd' : 'none',
          outlineOffset: '-2px'
        }}
      >
        {/* Subfolders grid or horizontal slider for larger collections */}
        {subfolders.length > 0 && (
          <div style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <h2
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  color: '#444',
                  margin: 0
                }}
              >
                Subfolders
              </h2>
              {subfolders.length > 5 && (
                <div style={{ display: 'flex', gap: '5px' }}>
                  <IconButton
                    label="Scroll subfolders left"
                    onClick={() => subfoldersSliderRef.current?.scrollBy({ left: -360, behavior: 'smooth' })}
                  >
                    <ChevronLeft size={14} />
                  </IconButton>
                  <IconButton
                    label="Scroll subfolders right"
                    onClick={() => subfoldersSliderRef.current?.scrollBy({ left: 360, behavior: 'smooth' })}
                  >
                    <ChevronRight size={14} />
                  </IconButton>
                </div>
              )}
            </div>
            <div
              ref={subfolders.length > 5 ? subfoldersSliderRef : undefined}
              role={subfolders.length > 5 ? 'region' : undefined}
              aria-label={subfolders.length > 5 ? 'Subfolders' : undefined}
              tabIndex={subfolders.length > 5 ? 0 : undefined}
              style={{
                display: subfolders.length > 5 ? 'flex' : 'grid',
                gridTemplateColumns: subfolders.length > 5 ? undefined : 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: '16px',
                minWidth: 0,
                maxWidth: '100%',
                overflowX: subfolders.length > 5 ? 'auto' : undefined,
                overflowY: 'hidden',
                scrollBehavior: 'smooth',
                scrollSnapType: subfolders.length > 5 ? 'x proximity' : undefined,
                padding: subfolders.length > 5 ? '8px' : 0,
                margin: subfolders.length > 5 ? '-8px' : 0
              }}
            >
              {subfolders.map((folder) => (
                <div key={folder.id} style={subfolders.length > 5 ? { flex: '0 0 176px', minWidth: 0, scrollSnapAlign: 'start' } : undefined}>
                  <FolderCard
                    name={folder.name}
                    path={folder.path ?? folder.name}
                    trackCount={getTrackCount(folder.id)}
                    artworkHashes={getArtworkForFolder(folder.id)}
                    highlighted={highlightedFolderIds.has(folder.id)}
                    onClick={() => navigateInto(folder.id)}
                    onRename={() => setRenameTargetId(folder.id)}
                    onDelete={() => {
                      setDeleteError(null)
                      setDeleteTargetId(folder.id)
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tracks in this folder */}
        {folderTracks.length > 0 && (
          <div style={{ padding: subfolders.length > 0 ? '0 24px 24px' : '20px 24px 24px' }}>
            {subfolders.length > 0 && (
              <h2
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  color: '#444',
                  marginBottom: '14px'
                }}
              >
                Tracks in this folder
              </h2>
            )}

            {/* BulkBar */}
            <BulkBar
              selectedIds={selectedIds}
              onClearSelect={() => setSelectedIds(new Set())}
              onSelectAll={() => setSelectedIds(new Set(folderTracks.map((t) => t.id)))}
              totalCount={folderTracks.length}
            />

            {/* Track list or grid */}
            {displayMode === 'list' ? (
              <div>
                {folderTracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    isSelected={selectedIds.has(track.id)}
                    onSelected={toggleSelect}
                  />
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: trackGridColumns,
                  gap: `${TRACK_GRID_GAP}px`
                }}
              >
                {folderTracks.map((track) => (
                  <TrackCard
                    key={track.id}
                    track={track}
                    isSelected={selectedIds.has(track.id)}
                    onSelect={toggleSelect}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Empty folder */}
        {subfolders.length === 0 && folderTracks.length === 0 && (
          <div
            style={{
              padding: '48px 24px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              color: '#333'
            }}
          >
            <span style={{ fontSize: '32px' }}>⊟</span>
            <div style={{ fontSize: '14px' }}>This folder is empty</div>
            <div style={{ fontSize: '12px', color: '#2a2a2a' }}>
              Import audio files to see them here
            </div>
          </div>
        )}
      </div>

      {moveConfirm && (
        <MoveConfirmDialog
          open
          title={`Move ${moveConfirm.accepted.length} file${
            moveConfirm.accepted.length !== 1 ? 's' : ''
          } into ${moveConfirm.folder.name}?`}
          description="The originals will be moved, not copied."
          onConfirm={(dontAskAgain) => void confirmMove(dontAskAgain)}
          onCancel={() => setMoveConfirm(null)}
        />
      )}
    </div>
  )
}

// ─── IconButton ───────────────────────────────────────────
// A square icon-only action. `label` is the tooltip AND the accessible name,
// so dropping the visible text does not drop the meaning — an icon with
// neither is a guess for a sighted DJ and silence for a screen reader.
function IconButton({
  onClick,
  disabled,
  label,
  spinning = false,
  danger = false,
  children
}: {
  onClick: () => void
  disabled?: boolean
  label: string
  spinning?: boolean
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  // Destructive actions read red on hover, not at rest: a permanently red
  // button in a toolbar is noise, and noise is what gets mis-clicked.
  const hoverColor = danger ? '#d8695d' : '#a09be8'
  const hoverBorder = danger ? '#d8695d55' : '#3a3060'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '30px',
        height: '30px',
        borderRadius: '6px',
        background: 'none',
        border: '0.5px solid #252535',
        color: disabled ? '#333' : '#777',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        transition: 'color 0.12s ease, border-color 0.12s ease'
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.color = hoverColor
        e.currentTarget.style.borderColor = hoverBorder
      }}
      onMouseLeave={(e) => {
        if (disabled) return
        e.currentTarget.style.color = '#777'
        e.currentTarget.style.borderColor = '#252535'
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          // Only the glyph spins; a rotating border would be a different,
          // worse animation.
          animation: spinning ? 'spin 1s linear infinite' : undefined
        }}
      >
        {children}
      </span>
    </button>
  )
}
