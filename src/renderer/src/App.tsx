import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLibraryStore } from './store/useLibraryStore'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { LibraryView } from './components/LibraryView'
import { Inspector } from './components/Inpector'
import { FolderView } from './views/FolderView'
import { SettingsView } from './views/SettingsView'
import { EmptyState } from './views/EmptyState'
import { DashboardView } from '@renderer/views/DashboardView'
import type { View } from './components/Sidebar'
import { Breadcrumb } from './components/Breadcrumb'
import { ReconciliationModal } from './components/ReconciliationModal'
import { SeratoImportConfirmDialog } from './components/SeratoImportConfirmDialog'
import { Toaster } from './components/ui/sonner'
import { BackgroundJobsPanel } from './components/BackgroundJobsPanel'
import { PlayerBar } from './components/PlayerBar'
import { TagsCloudView } from './views/TagsCloudView'
import { TagPageView } from './views/TagPageView'
import { CrateView } from './views/CrateView'
import { AccountChip } from './components/AccountChip'
import { LAST_VIEW_KEY, restoreView, isRestorable } from './lib/lastView'
import { StaleBuildBanner } from './components/StaleBuildBanner'
import { useFileDrop } from './hooks/useFileDrop'

const COLLAPSE_THRESHOLD = 900 // px
const FOLDERS_REFETCH_DEBOUNCE_MS = 300

function App(): React.JSX.Element {
  const {
    tracks,
    setTracks,
    setAnalyzing,
    activeTrackId,
    setBoards,
    updateTrack,
    sidebarCollapsed,
    setSidebarCollapsed,
    setTags,
    setQuickTags,
    setAllTrackTags,
    setFolderData,
    upsertJob,
    removeJob,
    mergeTracks,
    setPendingFolderNav,
    setPendingTagNav,
    setAnalysisProgress,
    setCrates,
    setCrateTrackIds
  } = useLibraryStore()
  const [activeView, setActiveViewState] = useState<View>('dashboard')
  // Restored from app_settings on mount (below), so a reload puts the DJ
  // back where they were. Same mechanism useViewMode uses for list/grid.
  const setActiveView = useCallback((next: View): void => {
    setActiveViewState(next)
    // Only persist what can actually be restored. Writing 'tags' here would
    // store a view that restoreView then discards on the way back — the DJ
    // would land on the dashboard having been told nothing, instead of on
    // the last view that genuinely survives.
    if (isRestorable(next)) void window.api.settings.set(LAST_VIEW_KEY, next)
  }, [])
  // null = still checking. Main restores any stored session off the critical
  // path of window creation and pushes the answer over auth:changed, so
  // there is a real moment where we do not yet know — rendering the login
  // form during it would flash a form at a DJ who is already signed in.
  const [auth, setAuth] = useState<AuthState | null>(null)
  // Add library roots to app state
  const [libraryRoots, setLibraryRoots] = useState<LibraryRoot[]>([])
  const [reconcileOpen, setReconcileOpen] = useState(false)
  // A stack, not one tag: the Tags page narrows by adding tags on top of
  // each other. Empty means the tag cloud is showing instead.
  const [selectedTags, setSelectedTags] = useState<Tag[]>([])
  const [selectedCrateId, setSelectedCrateId] = useState<number | null>(null)
  // Lives in the store now: Settings > Library shows the same run and the
  // same Stop button, and two copies of this would drift.
  const analysisProgress = useLibraryStore((s) => s.analysisProgress)
  const [seratoImportPrompt, setSeratoImportPrompt] = useState<{
    folderPath: string
    seratoDir: string
  } | null>(null)
  // Batch-committed events fire once per ~200-row transaction — debounce the
  // resulting track-list refetch so a burst of fast batches collapses into one.
  const batchRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // folders:changed can fire many times during one import (once per
  // ensureFolderTree call) — debounce so a large import doesn't hammer
  // folders:tree/tracks:folder-counts with a refetch per directory.
  const foldersRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Auto-collapse on narrow window ────────────────────
  useEffect(() => {
    function handleResize(): void {
      if (window.innerWidth < COLLAPSE_THRESHOLD) {
        setSidebarCollapsed(true)
      }
    }

    window.addEventListener('resize', handleResize)
    handleResize() // check on mount
    return () => window.removeEventListener('resize', handleResize)
  }, [setSidebarCollapsed])

  // ── Drop anywhere to import ──────────────────────────────────────────
  // The whole window is a drop target. A more specific one — a folder card,
  // the empty state — claims the drop first (useFileDrop stops propagation
  // once it accepts), so this only ever sees drops that landed on nothing in
  // particular.
  //
  // Lands the DJ in All Tracks afterwards: they dropped files to get them
  // into the library, and the library is what they want to be looking at.
  const handleShellDrop = useCallback(
    async (paths: string[]): Promise<void> => {
      await handleImportPaths(paths)
      setActiveView('library')
    },
    // handleImportPaths is redeclared every render; depending on it would
    // rebuild the handler constantly for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setActiveView]
  )

  const { isDragging: isDraggingOverShell, dropHandlers: shellDropHandlers } = useFileDrop({
    onDrop: (paths) => void handleShellDrop(paths)
  })

  // Belt and braces against Electron navigating the window to a dropped
  // file. The shell's own React handler above covers the app's surface; this
  // catches anything outside it and any drag that never reaches React at
  // all. It never calls into import logic itself.
  useEffect(() => {
    function preventDefault(e: DragEvent): void {
      e.preventDefault()
    }
    window.addEventListener('dragover', preventDefault)
    window.addEventListener('drop', preventDefault)
    return () => {
      window.removeEventListener('dragover', preventDefault)
      window.removeEventListener('drop', preventDefault)
    }
  }, [])

  // Restore the last view. Written straight to the state setter rather than
  // through setActiveView, so restoring does not immediately re-persist what
  // it just read.
  useEffect(() => {
    let cancelled = false
    window.api.settings.get(LAST_VIEW_KEY).then((stored) => {
      if (cancelled) return
      setActiveViewState(restoreView(stored))
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Auth ────────────────────────
  // One initial pull (covers the case where main finished restoring before
  // this effect ran and the push was missed) plus the subscription for
  // everything after: launch restore, the Google callback, and sign-out.
  useEffect(() => {
    let cancelled = false
    window.api.auth.state().then((state) => {
      if (!cancelled) setAuth(state)
    })

    window.api.onAuthChanged((state) => {
      setAuth(state)
      // Only a failed sign-in handoff carries `error` — it has no invoke()
      // call left waiting, so this is the only place it can be shown.
      if (state.error) toast.error(state.error)
      if (state.justSignedIn) {
        toast.success(`Signed in as ${state.user?.email ?? 'your account'}`)
      }
    })

    return () => {
      cancelled = true
      window.api.offAuthChanged()
    }
  }, [])

  // ── Follow a tag clicked anywhere in the app ────────────
  // Any TagBadge — on a row, a card, the dashboard — sets pendingTagNav.
  // Consumed once here and cleared, the same shape as pendingFolderNav.
  //
  // A store subscription rather than an effect on the value: reading it as a
  // dependency and calling setState in the effect body is a cascading render
  // (react-hooks/set-state-in-effect), whereas a subscription callback is an
  // external-system update, which is what effects are actually for. Same
  // pattern FolderView uses for pendingFolderNav.
  //
  // It REPLACES the filter rather than adding to it: clicking a tag on some
  // track in the library means "show me this tag", not "narrow what I was
  // already looking at". Stacking is what the Narrow further row is for.
  useEffect(() => {
    return useLibraryStore.subscribe((state, prev) => {
      if (state.pendingTagNav != null && state.pendingTagNav !== prev.pendingTagNav) {
        setActiveView('tags')
        setSelectedTags([state.pendingTagNav])
        setPendingTagNav(null)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Watchers ────────────────────
  useEffect(() => {
    // New file added by Finder - add to store
    window.api.onTrackAdded(async () => {
      const all = await window.api.db.allTracks()
      setTracks(all)
    })

    // File moved — folder_id changes with the path (it mirrors disk
    // location), so refetch rather than patch just filepath in place.
    window.api.onTrackMoved(async () => {
      const all = await window.api.db.allTracks()
      setTracks(all)
    })

    // File deleted — reload store
    window.api.onTrackDeleted(async () => {
      const all = await window.api.db.allTracks()
      setTracks(all)
    })

    window.api.onRootOnline(() => {
      setReconcileOpen(true)
    })

    // Root went offline
    window.api.onRootOffline(({ rootPath }) => {
      console.log('Root offline:', rootPath)
      // Show notification — we will add this UI next
    })

    return () => window.api.offWatcherListeners()
  })

  // Load existing tracks from SQLite on startup
  // ── Load data on startup ──────────────────────────────
  useEffect(() => {
    async function load(): Promise<void> {
      const [
        tracks,
        boards,
        tags,
        quickTags,
        roots,
        folderTree,
        folderCounts,
        crates,
        crateTrackIds
      ] = await Promise.all([
        window.api.db.allTracks(),
        window.api.boards.all(),
        window.api.tags.all(),
        window.api.tags.mostUsed(),
        window.api.roots.all(),
        window.api.folders.tree(),
        window.api.db.folderTrackCounts(),
        window.api.crates.all(),
        window.api.crates.allTrackIds()
      ])
      setTracks(tracks)
      setBoards(boards)
      setTags(tags)
      setQuickTags(quickTags)
      setLibraryRoots(roots)
      setCrates(crates)
      setCrateTrackIds(crateTrackIds)
      // Initial snapshot — folders:changed (subscribed below) keeps it fresh
      // from here on, but that event only fires on a subsequent change, so
      // a library that's already fully imported needs this or the slice
      // would stay empty until the next folder gets created.
      setFolderData(folderTree, folderCounts)

      // Hydrate trackTags for every track up front — one bulk query instead
      // of one tags.forTrack round trip per track — so badges show without
      // clicking a row first.
      const tagsByTrack = await window.api.tags.forTracks(tracks.map((t) => t.id))
      setAllTrackTags(tagsByTrack)
    }
    load()
  }, [])

  // Listen for progress events from the import handler
  // ── Import progress listeners ─────────────────────────
  useEffect(() => {
    window.api.onImportProgress((p) => {
      upsertJob({ ...p, type: 'import' })

      if (p.phase === 'done') {
        // Long enough for the new "Open folder" action to actually be
        // clickable — 1.5s (the old delay) barely gave time to notice the
        // row before it vanished.
        setTimeout(() => removeJob(p.jobId), 6000)
      }
    })

    // A ~200-row batch just committed — debounce the refetch so a burst of
    // fast batches (small files, warm cache) collapses into one reload
    // instead of hammering the store on every commit.
    window.api.onImportBatchCommitted(() => {
      if (batchRefreshTimer.current) clearTimeout(batchRefreshTimer.current)
      batchRefreshTimer.current = setTimeout(() => {
        window.api.db.allTracks().then(setTracks)
      }, 500)
    })

    // A folders row was inserted somewhere (import, watcher, create-folder,
    // move) — debounced since one import can trigger this many times over
    // (once per ensureFolderTree call), and FolderView reads this slice
    // instead of fetching its own copy.
    window.api.onFoldersChanged(() => {
      if (foldersRefreshTimer.current) clearTimeout(foldersRefreshTimer.current)
      foldersRefreshTimer.current = setTimeout(async () => {
        const [tree, counts] = await Promise.all([
          window.api.folders.tree(),
          window.api.db.folderTrackCounts()
        ])
        setFolderData(tree, counts)
      }, FOLDERS_REFETCH_DEBOUNCE_MS)
    })

    // Move job progress — trackIds isn't part of the wire payload (it never
    // changes mid-job, so there's no point re-sending it every tick); the
    // dispatcher (MoveFileButton/BulkBar) seeds it into the store when the
    // job is created, and this just carries it forward on every update.
    window.api.onMoveProgress((p) => {
      const existing = useLibraryStore.getState().jobs[p.jobId]
      const trackIds = existing && existing.type === 'move' ? existing.trackIds : []
      upsertJob({ ...p, type: 'move', trackIds })

      if (p.phase === 'done' || p.phase === 'cancelled') {
        if (p.phase === 'done') {
          const failedCount = p.failed.length
          const succeededCount = p.done - failedCount
          if (failedCount > 0) {
            toast.error(`${succeededCount} moved, ${failedCount} failed`, {
              description: p.failed
                .map((f) => `${f.filepath.split('/').pop()}: ${f.error}`)
                .join('\n')
              // TODO: retry failed — surface a "Retry" action here once that
              // flow exists; out of scope for this task.
            })
          } else {
            toast.success(`${succeededCount} moved`)
          }
        }

        if (trackIds.length > 0) {
          window.api.db.tracksByIds(trackIds).then(mergeTracks)
        }
        setTimeout(() => removeJob(p.jobId), 1500)
      }
    })

    // Copy job progress (drag-and-drop into a specific folder) — the copy
    // job holds its 'done'/'cancelled' event until the import step that
    // follows (importSingleFile or a folder re-scan) also finishes, so
    // it's safe to refetch tracks right here once either fires.
    window.api.onCopyProgress((p) => {
      upsertJob({ ...p, type: 'copy' })

      if (p.phase === 'done' || p.phase === 'cancelled') {
        if (p.phase === 'done') {
          const failedCount = p.failed.length
          const succeededCount = p.done - failedCount
          const verbed = p.deleteSource ? 'moved' : 'copied'
          if (failedCount > 0) {
            toast.error(`${succeededCount} ${verbed}, ${failedCount} failed`, {
              description: p.failed
                .map((f) => `${f.sourcePath.split('/').pop()}: ${f.error}`)
                .join('\n')
            })
          } else if (succeededCount > 0) {
            toast.success(
              p.deleteSource
                ? `${succeededCount} file${succeededCount !== 1 ? 's' : ''} moved`
                : `${succeededCount} file${succeededCount !== 1 ? 's' : ''} added`
            )
          }
        }
        window.api.db.allTracks().then(setTracks)
        setTimeout(() => removeJob(p.jobId), 1500)
      }
    })

    // Crate export progress — coarse-grained (per-crate, not per-track), see
    // ExportJob in main/index.ts. Failures surface inline in the panel label
    // rather than a toast — a partial "Export all crates" failure isn't
    // urgent enough to interrupt, and the per-crate error detail is already
    // in the payload if that's ever surfaced in the UI.
    window.api.onCrateExportProgress((p) => {
      upsertJob({ ...p, type: 'export' })
      if (p.phase === 'done' || p.phase === 'error') {
        setTimeout(() => removeJob(p.jobId), 4000)
      }
    })

    // Serato import progress — chained after a folder import that had
    // "Import Serato data" checked (see maybeRunSeratoImport in
    // main/index.ts). Refetch tracks once it's done since it can fill
    // previously-empty fields and set added_at on freshly-imported rows.
    window.api.onSeratoImportProgress((p) => {
      upsertJob({ ...p, type: 'seratoImport' })
      if (p.phase === 'done') {
        window.api.db.allTracks().then(setTracks)
        const t = p.tally
        if (t.dbEntriesMatched > 0 || t.cratesCreated > 0 || t.playsImported > 0) {
          toast.success(
            `Serato import: ${t.dbEntriesMatched} tracks matched, ${t.cratesCreated} crates, ${t.playsImported} plays`
          )
        }
        setTimeout(() => removeJob(p.jobId), 4000)
      } else if (p.phase === 'error') {
        toast.error('Serato import failed', { description: p.error })
        setTimeout(() => removeJob(p.jobId), 4000)
      }
    })

    // Batch tag-edit progress (see editTagsBatch/runEditTagsJob in
    // main/index.ts). This only reflects sidecar progress — no DB update is
    // wired up yet, so track rows are never refetched here (there's nothing
    // to refetch; see the TODO on runEditTagsJob).
    window.api.onEditTagsProgress((p) => {
      upsertJob({ ...p, type: 'editTags' })
      if (p.phase === 'done' || p.phase === 'error') {
        if (p.phase === 'done') {
          const failedCount = p.failed.length
          const succeededCount = p.done - failedCount
          if (failedCount > 0) {
            toast.error(`${succeededCount} updated, ${failedCount} failed`, {
              description: p.failed
                .map((f) => `${f.filepath.split('/').pop()}: ${f.error}`)
                .join('\n')
            })
          } else if (succeededCount > 0) {
            toast.success(`${succeededCount} track${succeededCount !== 1 ? 's' : ''} updated`)
          }
        }
        setTimeout(() => removeJob(p.jobId), 1500)
      }
    })

    // Phase 2 — update individual tracks as BPM/key comes in
    window.api.onTrackAnalyzed((data) => {
      updateTrack(data.trackId, {
        bpm: data.bpm,
        key_camelot: data.key_camelot,
        key_full: data.key_full,
        duration_sec: data.duration_sec,
        duration_str: data.duration_str
      })
      setAnalysisProgress({
        done: data.done,
        total: data.total
      })
    })

    // Per-track re-analysis — drives the bar on that track's card. Only the
    // stage moves here; the entry is added and removed by whoever started the
    // analysis (TrackRowMenu), so an event for a track that has already
    // finished cannot resurrect a bar.
    window.api.onAnalyzeFileProgress((p) => {
      const { trackAnalysis, setTrackAnalysis } = useLibraryStore.getState()
      if (!trackAnalysis.has(p.trackId)) return
      setTrackAnalysis(p.trackId, { stage: p.stage, step: p.step, steps: p.steps })
    })

    // Phase 2 complete — hide the analysis bar
    window.api.onAnalysisComplete((data) => {
      if (data?.stopped) {
        toast.info('Analysis stopped', {
          description: `${data.analyzed} of ${data.total} analyzed. The rest stay queued for next time.`
        })
        // Cleared at once rather than after the usual 3s hold: the bar is
        // showing a run that is over, and leaving it up reads as still working.
        setAnalysisProgress(null)
        return
      }
      setTimeout(() => setAnalysisProgress(null), 3000)
    })

    return () => {
      window.api.offAnalysisListeners()
      window.api.offImportProgress()
      window.api.offFoldersChanged()
      // offMoveProgress was missing here before — a pre-existing gap this
      // touches the same block for, not something new to this task.
      window.api.offMoveProgress()
      window.api.offCopyProgress()
      window.api.offCrateExportProgress()
      window.api.offEditTagsProgress()
      window.api.offSeratoImportProgress()
      if (batchRefreshTimer.current) clearTimeout(batchRefreshTimer.current)
      if (foldersRefreshTimer.current) clearTimeout(foldersRefreshTimer.current)
    }
  }, [setTracks, updateTrack, upsertJob, removeJob, setFolderData, mergeTracks])

  // ── Import handlers ───────────────────────────────────
  // Shared by the dialog flow (handleImport, below) and ImportDropzone's
  // onImportFolder (dialog button or a dropped folder — it resolves the
  // path itself either way and hands it here already resolved).
  async function performImportFolder(folderPath: string, importSeratoData: boolean): Promise<void> {
    setAnalyzing(true)

    const result = await window.api.importFolder(folderPath, importSeratoData)

    if (result.ok) {
      // Final reload to make sure everything is in sync
      const all = await window.api.db.allTracks()
      setTracks(all)
      // A brand-new root may have just been registered (library:import-folder
      // does that server-side) — without this, libraryRoots stays stale for
      // the rest of the session and the Folders view shows "No library
      // folders registered" even though the DB row and watcher are both
      // already correct, until the app is relaunched.
      await reloadRoots()

      toast.success(`Imported ${result.imported ?? 0} track${result.imported !== 1 ? 's' : ''}`, {
        action: { label: 'Open folder', onClick: () => void navigateToFolderPath(folderPath) }
      })
    } else if (result.error) {
      toast.error(result.error)
    }

    setAnalyzing(false)
    // Progress bar is cleared by the 'done' phase of onImportProgress
  }

  // Offers "Import Serato data from this library" before the import starts
  // whenever the folder's volume has a `_Serato_` — see detectSeratoLibrary
  // in main/serato/seratoImport.ts. No Serato library found just imports
  // immediately, same as before this existed.
  async function handleImportFolder(folderPath: string): Promise<void> {
    const detection = await window.api.detectSeratoForFolder(folderPath)
    if (detection.found && detection.seratoDir) {
      setSeratoImportPrompt({ folderPath, seratoDir: detection.seratoDir })
      return
    }
    await performImportFolder(folderPath, false)
  }

  async function handleImport(): Promise<void> {
    const folderPath = await window.api.openFolder()
    if (!folderPath) return
    await handleImportFolder(folderPath)
  }

  async function handleCancelImport(jobId: string): Promise<void> {
    await window.api.cancelImport(jobId)
  }

  async function handleResumeImport(jobId: string): Promise<void> {
    setAnalyzing(true)
    const result = await window.api.resumeImport(jobId)
    if (result.ok) {
      const all = await window.api.db.allTracks()
      setTracks(all)
    }
    setAnalyzing(false)
  }

  async function handleCancelMove(jobId: string): Promise<void> {
    await window.api.fs.cancelMove(jobId)
  }

  function handleViewChange(view: View): void {
    setActiveView(view)
    if (view !== 'tags') setSelectedTags([])
  }

  async function handleCancelCopy(jobId: string): Promise<void> {
    await window.api.fs.cancelCopy(jobId)
  }

  // Add import files handler — shared by ImportDropzone's onImportFiles
  // (dialog button or dropped loose files, already-resolved paths either way).
  async function handleImportFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return

    setAnalyzing(true)
    for (const filepath of filepaths) {
      await window.api.importFile(filepath)
      window.api.db.allTracks().then(setTracks)
    }
    setAnalyzing(false)
  }

  // Drag-and-drop from Finder onto EmptyView — same import handlers the
  // dialogs call (importFolder/importFile), just routed by fs:classify-paths
  // instead of a dialog selection. Folders each become their own sequential
  // import (and get registered as a root, exactly like handleImport's
  // dialog flow, since library:import-folder does both); audio files import
  // individually, matching handleImportFiles.
  async function handleImportPaths(paths: string[]): Promise<void> {
    const classified = await window.api.fs.classifyPaths(paths)
    const dirs = classified.filter((c) => c.kind === 'dir').map((c) => c.path)
    const audioFiles = classified.filter((c) => c.kind === 'audio').map((c) => c.path)
    const skipped = classified.filter((c) => c.kind === 'other').map((c) => c.path)

    setAnalyzing(true)
    for (const dir of dirs) {
      const result = await window.api.importFolder(dir)
      if (!result.ok && result.error) {
        toast.error(result.error)
      } else if (result.ok) {
        toast.success(`Imported ${result.imported ?? 0} track${result.imported !== 1 ? 's' : ''}`, {
          action: { label: 'Open folder', onClick: () => void navigateToFolderPath(dir) }
        })
      }
    }
    for (const filepath of audioFiles) {
      await window.api.importFile(filepath)
    }
    const all = await window.api.db.allTracks()
    setTracks(all)
    // Same staleness gap as handleImport — a dropped folder can register a
    // brand-new root, and libraryRoots only otherwise refreshes at launch.
    if (dirs.length > 0) await reloadRoots()

    // Folders and their counts, unconditionally. main emits folders:changed
    // when it CREATES a folder row, which covers a new subtree — but a
    // re-import into folders that already exist changes only the counts, and
    // those come from the same slice. Refetching here is one query and
    // removes the "why do I have to reload to see it" case entirely.
    const [tree, counts] = await Promise.all([
      window.api.folders.tree(),
      window.api.db.folderTrackCounts()
    ])
    setFolderData(tree, counts)

    setAnalyzing(false)

    if (skipped.length > 0) {
      toast.warning(
        `Skipped ${skipped.length} unsupported file${skipped.length !== 1 ? 's' : ''}`,
        { description: skipped.map((p) => p.split('/').pop()).join(', ') }
      )
    }
  }

  // ── Roots reload ──────────────────────────────────────
  async function reloadRoots(): Promise<void> {
    const roots = await window.api.roots.all()
    setLibraryRoots(roots)
  }

  // Shared by the import-completion toast action and BackgroundJobsPanel's
  // "Open folder" button. Resolves fresh via IPC rather than the store's
  // debounced `folders` snapshot — this only runs on a click, well after
  // the folders:changed debounce would have settled, but a fresh lookup
  // costs nothing and removes that race entirely. The actual navigation
  // still only ever happens inside FolderView (via its own navStack) —
  // this just switches tabs and leaves the folder id for FolderView's
  // pendingFolderNav effect to pick up.
  async function navigateToFolderPath(folderPath: string): Promise<void> {
    const tree = await window.api.folders.tree()
    const folder = tree.find((f) => f.path === folderPath)
    if (!folder) return
    setActiveView('folders')
    setPendingFolderNav(folder.id)
  }

  // No auth gate. The desktop app is free and entirely local, so it opens
  // straight into the library whether or not anyone is signed in — signing
  // in is reached from Settings and only matters for the paid cloud surface.
  // `auth` stays nullable while the stored session is being restored; every
  // consumer below treats null as "not signed in yet", which is also what it
  // means once that settles.
  return (
    <div
      {...shellDropHandlers}
      style={{
        position: 'relative',
        padding: '1rem',
        fontFamily: 'monospace',
        color: '#e8e8f0',
        background: '#0e0e12',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Only shown for a drop that is NOT over a more specific target —
          useFileDrop stops propagation as soon as one accepts, so a folder
          card's own highlight and this never appear at once. Without it,
          dropping onto empty space gives no sign anything will happen. */}
      {isDraggingOverShell && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: '8px',
            background: '#0e0e12e6',
            border: '2px dashed #7f77dd',
            borderRadius: '10px',
            pointerEvents: 'none'
          }}
        >
          <span style={{ fontSize: '30px' }} aria-hidden>
            ⤓
          </span>
          <span style={{ fontSize: '14px', color: '#e8e8f0', fontFamily: 'inherit' }}>
            Drop to add to your library
          </span>
          <span style={{ fontSize: '12px', color: '#6a6a80', fontFamily: 'inherit' }}>
            Files or folders — they will appear in All Tracks
          </span>
        </div>
      )}

      {/* <h2 style={{ marginBottom: '0.5rem' }}>CrateCloud v2</h2> */}

      {/* Hidden track count — for Playwright tests */}
      <div data-testid="track-count" style={{ display: 'none' }}>
        {tracks.length} track{tracks.length !== 1 ? 's' : ''} in library
      </div>

      {/* Toolbar at the top */}
      <Toolbar
        onImportFolder={handleImportFolder}
        activeView={activeView}
        onImportFiles={handleImportFiles}
      />

      {/* Background jobs (import, move, copy) — non-modal, stays visible across navigation */}
      <BackgroundJobsPanel
        onCancelImport={handleCancelImport}
        onResumeImport={handleResumeImport}
        onCancelMove={handleCancelMove}
        onCancelCopy={handleCancelCopy}
        onOpenFolder={(folderPath) => void navigateToFolderPath(folderPath)}
      />

      {/* Dev-only. Sits above every view because a stale main process makes
          any of them behave unpredictably. */}
      <StaleBuildBanner />

      {/* Phase 2 — analysis progress bar */}
      {analysisProgress !== null && analysisProgress.total > 0 && (
        <div
          style={{
            padding: '4px 16px',
            background: '#13131b',
            borderBottom: '0.5px solid #1e1e2a',
            flexShrink: 0
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '4px'
            }}
          >
            <span className="text-xs text-muted-foreground">
              Analyzing BPM + key — {analysisProgress.done} / {analysisProgress.total}
            </span>
            {/* Analysis is minutes of work on a large import — librosa reads
                every file end to end. Quitting the app should not be the
                only way out of it. */}
            <button
              type="button"
              onClick={() => void window.api.stopAnalysis()}
              title="Stop analyzing — tracks already done are kept"
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: '0.5px solid #3a3060',
                borderRadius: '5px',
                color: '#a09be8',
                fontSize: '10px',
                padding: '2px 9px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                flexShrink: 0
              }}
            >
              Stop
            </button>
          </div>
          <div
            style={{
              background: '#1e1e2a',
              borderRadius: '4px',
              height: '3px',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                background: '#1d9e75',
                height: '100%',
                width: `${Math.round((analysisProgress.done / analysisProgress.total) * 100)}%`,
                transition: 'width 0.3s ease',
                borderRadius: '4px'
              }}
            />
          </div>
        </div>
      )}

      {/* Main area — sidebar + content side by side */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          activeView={activeView}
          onViewChange={handleViewChange}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenSettings={() => setActiveView('settings')}
          selectedCrateId={selectedCrateId}
          onSelectCrate={setSelectedCrateId}
        />

        {/* Content area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Persistent account control; it stays visible on every view. */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: '38px',
            paddingRight: '16px',
            background: '#0e0e12',
            borderBottom: '0.5px solid #1e1e2a',
            flexShrink: 0
          }}>
            <Breadcrumb activeView={activeView} onNavigate={setActiveView} />
            <AccountChip auth={auth} onAuthChanged={setAuth} />
          </div>
          {/* Views */}
          {activeView === 'dashboard' &&
            (tracks.length === 0 ? (
              <EmptyState
                onImport={handleImport}
                onImportPaths={handleImportPaths}
              />
            ) : (
              <DashboardView
                onOpenLibrary={() => setActiveView('library')}
              />
            ))}
          {activeView === 'library' && <LibraryView />}
          {activeView === 'folders' &&
            (libraryRoots.length > 0 ? (
              <FolderView libraryRoots={libraryRoots} onRootsChanged={reloadRoots} />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '12px',
                  color: '#333'
                }}
              >
                <span style={{ fontSize: '48px' }}>⊟</span>
                <div style={{ fontSize: '14px' }}>No library folders registered</div>
                <button
                  onClick={() => setActiveView('settings')}
                  style={{
                    fontSize: '12px',
                    color: '#7f77dd',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0
                  }}
                >
                  Open Settings to add a music folder
                </button>
              </div>
            ))}

          {activeView === 'tags' && selectedTags.length === 0 && (
            <TagsCloudView onTagSelect={(tag) => setSelectedTags([tag])} />
          )}

          {activeView === 'tags' && selectedTags.length > 0 && (
            <TagPageView
              tags={selectedTags}
              onChange={setSelectedTags}
              onBack={() => setSelectedTags([])}
            />
          )}

          {activeView === 'settings' && (
            <SettingsView
              libraryRoots={libraryRoots}
              onRootsChanged={reloadRoots}
              auth={auth}
              onAuthChanged={setAuth}
              onBack={() => setActiveView('dashboard')}
            />
          )}

          {activeView === 'crates' &&
            (selectedCrateId !== null ? (
              <CrateView key={selectedCrateId} crateId={selectedCrateId} />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  color: '#333',
                  fontSize: '14px'
                }}
              >
                <span style={{ fontSize: '48px' }}>◫</span>
                <div>Select a crate from the sidebar</div>
              </div>
            ))}
        </div>

        {/* Inspector slides in from the right when a track is selected */}
        <Inspector key={activeTrackId ?? 'none'} />
      </div>

      <PlayerBar />

      <ReconciliationModal open={reconcileOpen} onClose={() => setReconcileOpen(false)} />
      <SeratoImportConfirmDialog
        open={seratoImportPrompt !== null}
        seratoDir={seratoImportPrompt?.seratoDir ?? ''}
        onCancel={() => setSeratoImportPrompt(null)}
        onConfirm={(importSeratoData) => {
          const folderPath = seratoImportPrompt?.folderPath
          setSeratoImportPrompt(null)
          if (folderPath) void performImportFolder(folderPath, importSeratoData)
        }}
      />
      <Toaster />
    </div>
  )
}

export default App
