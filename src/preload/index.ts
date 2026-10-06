import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface AuthStatePayload {
  configured: boolean
  status: 'signedOut' | 'awaitingBrowser' | 'signedIn' | 'expired'
  user: {
    id: string
    email: string | null
    displayName: string | null
    avatarUrl: string | null
    provider: string | null
    created_at: string | null
  } | null
  // A hand-kept mirror of main/auth.ts's Entitlement, narrowed to what
  // this payload's consumers read. It cannot import that type — preload
  // compiles under tsconfig.node.json, which does not see the renderer's
  // ambient globals — so a plan value added there has to be added here too.
  entitlement: {
    plan: 'free' | 'cloud_mobile' | 'cloud_mobile_plus'
    status:
      | 'active'
      | 'trialing'
      | 'past_due'
      | 'canceled'
      | 'unpaid'
      | 'incomplete'
      | 'incomplete_expired'
      | 'paused'
      | 'revoked'
    current_period_end: string | null
    cancel_at_period_end: boolean
    seats: number
  } | null
  persistent: boolean
  offline: boolean
  confirmingPurchase: boolean
  links: Record<'signIn' | 'createAccount' | 'passwordReset' | 'account' | 'portal', boolean>
  error?: string
  // Set only on the state pushed after the one-time-code exchange succeeds.
  justSignedIn?: boolean
}

interface ImportProgressPayload {
  jobId: string
  phase: 'counting' | 'parsing' | 'sweeping' | 'done' | 'cancelled' | 'error'
  scanned: number
  total: number
  found: number
  skipped: number
  currentFolder: string
  estimateSeconds?: number
  folderPath: string
  relinked: number
}

// TODO: independently redefined here, in main/index.ts, and in global.d.ts
// — see the same TODO on JobState in useLibraryStore.ts.
interface MoveProgressPayload {
  jobId: string
  phase: 'running' | 'done' | 'cancelled' | 'error'
  done: number
  total: number
  currentFile: string
  bytesCopied: number
  totalBytes: number
  crossDevice: boolean
  failed: { trackId: number; filepath: string; error: string }[]
}

// TODO: independently redefined here, in main/index.ts, and in global.d.ts
// — see the same TODO on JobState in useLibraryStore.ts.
interface CopyProgressPayload {
  jobId: string
  phase: 'running' | 'done' | 'cancelled' | 'error'
  done: number
  total: number
  currentFile: string
  bytesCopied: number
  totalBytes: number
  failed: { sourcePath: string; error: string }[]
  deleteSource: boolean
}

// TODO: independently redefined here, in main/index.ts, and in global.d.ts
// — see the same TODO on JobState in useLibraryStore.ts.
interface ExportProgressPayload {
  jobId: string
  phase: 'running' | 'done' | 'error'
  done: number
  total: number
  currentCrateName: string
  volumesWritten: number
  missingSkipped: number
  exportedCrateNames: string[]
  failed: { crateId: number; crateName: string; error: string }[]
}

// TODO: independently redefined here, in main/index.ts, and in global.d.ts
// — see the same TODO on JobState in useLibraryStore.ts.
interface EditTagsProgressPayload {
  jobId: string
  phase: 'running' | 'done' | 'error'
  done: number
  total: number
  currentFile: string
  failed: { filepath: string; error: string }[]
}

// TODO: independently redefined here, in main/index.ts, and in global.d.ts
// — see the same TODO on JobState in useLibraryStore.ts.
interface SeratoImportTally {
  dbEntriesRead: number
  dbEntriesMatched: number
  fieldsFilledByField: Record<string, number>
  addedAtFilled: number
  cratesCreated: number
  crateTracksLinked: number
  crateUnresolvedPaths: number
  playsImported: number
  playsUnresolvedPaths: number
  unresolvedPathSamples: string[]
}

interface SeratoImportProgressPayload {
  jobId: string
  phase: 'running' | 'done' | 'error'
  stage: 'database' | 'crates' | 'history'
  tally: SeratoImportTally
  error?: string
}

interface AnalyzeFileProgressPayload {
  trackId: number
  filepath: string
  // Which of analyze.py's stages is running now, and how many are finished —
  // step / steps is the fraction complete. 'done' arrives with step === steps.
  stage: 'tags' | 'decode' | 'bpm' | 'key' | 'artwork' | 'done'
  step: number
  steps: number
}

interface EditTagsMeta {
  title?: string
  artist?: string
  album?: string
  genre?: string
  bpm?: number | string
  key?: string
  year?: string
  remixer?: string
  grouping?: string
  composer?: string
  comment?: string
  label?: string
  cratecloud_id?: string
}

// Custom APIs for renderer
const api = {
  // ── Audio analysis ─────────────────────────────────────────────────────
  // TODO: return string[] when multi-folder import is built in Phase 5
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:open-files'),
  importFile: (filepath: string) => ipcRenderer.invoke('library:import-file', filepath),
  importFiles: (filepaths: string[]) => ipcRenderer.invoke('library:import-files', filepaths),
  // trackId is optional — pass it to get analysis:file-progress events for
  // that track (onAnalyzeFileProgress), omit it for a silent analysis.
  analyzeFile: (filepath: string, trackId?: number) =>
    ipcRenderer.invoke('sidecar:analyze', filepath, trackId),
  writeTags: (filepath: string, meta: EditTagsMeta) =>
    ipcRenderer.invoke('sidecar:write-tags', filepath, meta),
  // Job-based, like fs.moveFiles/crates.export — resolves immediately with
  // a jobId; progress comes over onEditTagsProgress. See runEditTagsJob in
  // main/index.ts — no DB update happens as part of this yet.
  editTagsBatch: (
    items: { filepath: string; meta: EditTagsMeta }[],
    options?: { writeSerato?: boolean }
  ) => ipcRenderer.invoke('sidecar:edit-tags-batch', items, options),
  onEditTagsProgress: (cb: (p: EditTagsProgressPayload) => void) =>
    ipcRenderer.on('edit-tags:progress', (_e, p) => cb(p)),
  offEditTagsProgress: () => ipcRenderer.removeAllListeners('edit-tags:progress'),
  importFolder: (folderPath: string, importSeratoData?: boolean, rescan?: boolean) =>
    ipcRenderer.invoke('library:import-folder', folderPath, importSeratoData, rescan),
  // Library-wide rescan: walks every registered root and reconciles the DB
  // against what is actually on disk. Reports on the same import:progress
  // channel as a folder import, one job per root.
  rescanLibrary: () => ipcRenderer.invoke('library:rescan'),
  // Stops the Phase 2 analysis pass after the batch in flight.
  stopAnalysis: () => ipcRenderer.invoke('analysis:stop'),
  // Dev only: whether out/main or out/preload have been rebuilt since this
  // process loaded them. See staleBuild.ts.
  buildStatus: () => ipcRenderer.invoke('app:build-status'),

  // Opens a web page in the system browser. Main validates the scheme.
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  // ── Auth ────────────────────────────────────────────────────────────
  // No token crosses this bridge. Main holds the session and makes every
  // authenticated call; the renderer only ever learns who is signed in and
  // what they are entitled to.
  auth: {
    state: () => ipcRenderer.invoke('auth:state'),
    signIn: () => ipcRenderer.invoke('auth:sign-in'),
    createAccount: () => ipcRenderer.invoke('auth:create-account'),
    cancelSignIn: () => ipcRenderer.invoke('auth:cancel-sign-in'),
    reopenBrowser: () => ipcRenderer.invoke('auth:reopen-browser'),
    openDestination: (destination: 'signIn' | 'createAccount' | 'passwordReset' | 'account' | 'portal') =>
      ipcRenderer.invoke('auth:open-destination', destination),
    signOut: () => ipcRenderer.invoke('auth:sign-out'),
    refresh: () => ipcRenderer.invoke('auth:refresh')
  },

  // Pushed on launch-restore, on the OAuth callback, and on sign-out. The
  // payload carries `error` only for a failed OAuth round trip, which has
  // no invoke() call left waiting to receive it.
  onAuthChanged: (cb: (state: AuthStatePayload) => void) =>
    ipcRenderer.on('auth:changed', (_e, s) => cb(s)),
  offAuthChanged: () => ipcRenderer.removeAllListeners('auth:changed'),
  cancelImport: (jobId: string) => ipcRenderer.invoke('import:cancel', jobId),
  resumeImport: (jobId: string) => ipcRenderer.invoke('import:resume', jobId),
  onImportProgress: (cb: (p: ImportProgressPayload) => void) =>
    ipcRenderer.on('import:progress', (_e, p) => cb(p)),
  onImportBatchCommitted: (cb: (data: { jobId: string }) => void) =>
    ipcRenderer.on('import:batch-committed', (_e, d) => cb(d)),
  offImportProgress: () => {
    ipcRenderer.removeAllListeners('import:progress')
    ipcRenderer.removeAllListeners('import:batch-committed')
  },
  // Serato: detection is a plain invoke (renderer decides whether to show
  // the "Import Serato data" checkbox before an import even starts); the
  // import itself rides along on library:import-folder/roots.add and
  // reports back on its own progress channel like every other job.
  detectSeratoForFolder: (folderPath: string): Promise<{ found: boolean; seratoDir?: string }> =>
    ipcRenderer.invoke('serato:detect-for-folder', folderPath),
  onSeratoImportProgress: (cb: (p: SeratoImportProgressPayload) => void) =>
    ipcRenderer.on('serato-import:progress', (_e, p) => cb(p)),
  offSeratoImportProgress: () => ipcRenderer.removeAllListeners('serato-import:progress'),
  onTrackAnalyzed: (
    cb: (data: {
      trackId: number
      bpm: number | null
      key_camelot: string | null
      key_full: string | null
      duration_sec: number | null
      duration_str: string | null
      done: number
      total: number
    }) => void
  ) => ipcRenderer.on('library:track-analyzed', (_e, d) => cb(d)),
  onAnalysisComplete: (cb: (data: { analyzed: number; total: number }) => void) =>
    ipcRenderer.on('library:analysis-complete', (_e, d) => cb(d)),
  // Per-track stage progress for a single analyzeFile call that was given a
  // trackId — one event per analyze.py stage.
  onAnalyzeFileProgress: (cb: (p: AnalyzeFileProgressPayload) => void) =>
    ipcRenderer.on('analysis:file-progress', (_e, p) => cb(p)),

  onTrackAdded: (cb: (data: { trackId: number; filepath: string }) => void) =>
    ipcRenderer.on('watcher:track-added', (_e, d) => cb(d)),
  onTrackMoved: (cb: (data: { trackId: number; oldPath: string; newPath: string }) => void) =>
    ipcRenderer.on('watcher:track-moved', (_e, d) => cb(d)),
  onTrackDeleted: (cb: (data: { filepath: string; trackId: number | null }) => void) =>
    ipcRenderer.on('watcher:track-deleted', (_e, d) => cb(d)),
  onRootOffline: (cb: (data: { rootId: number; rootPath: string }) => void) =>
    ipcRenderer.on('watcher:root-offline', (_e, d) => cb(d)),
  onRootOnline: (cb: (data: { rootId: number; rootPath: string }) => void) =>
    ipcRenderer.on('watcher:root-online', (_e, d) => cb(d)),
  offWatcherListeners: () => {
    ipcRenderer.removeAllListeners('watcher:track-added')
    ipcRenderer.removeAllListeners('watcher:track-moved')
    ipcRenderer.removeAllListeners('watcher:track-deleted')
    ipcRenderer.removeAllListeners('watcher:root-offline')
    ipcRenderer.removeAllListeners('watcher:root-online')
  },

  offAnalysisListeners: () => {
    ipcRenderer.removeAllListeners('library:track-analyzed')
    ipcRenderer.removeAllListeners('library:analysis-complete')
    ipcRenderer.removeAllListeners('analysis:file-progress')
  },
  // Tracks
  db: {
    allTracks: () => ipcRenderer.invoke('db:all-tracks'),
    trackById: (id: number) => ipcRenderer.invoke('db:track-by-id', id),
    insertTrack: (track: unknown) => ipcRenderer.invoke('db:insert-track', track),
    updateTrackMeta: (data: unknown) => ipcRenderer.invoke('db:update-track-meta', data),
    updateBoardId: (id: number, boardId: number) =>
      ipcRenderer.invoke('db:update-board-id', id, boardId),
    tracksByBoardId: (boardId: number) => ipcRenderer.invoke('db:tracks-by-board-id', boardId),
    markMissing: (filepath: string) => ipcRenderer.invoke('db:mark-missing', filepath),
    deleteTrack: (id: number, deleteFile: boolean) =>
      ipcRenderer.invoke('db:delete-track', id, deleteFile),
    markAnalyzed: (id: number) => ipcRenderer.invoke('db:mark-analyzed', id),
    tracksByFolder: (folderId: number, recursive: boolean) =>
      ipcRenderer.invoke('tracks:by-folder', folderId, recursive),
    folderTrackCounts: () => ipcRenderer.invoke('tracks:folder-counts'),
    tracksByIds: (ids: number[]) => ipcRenderer.invoke('db:tracks-by-ids', ids)
  },

  // Folders
  folders: {
    tree: (rootId?: number) => ipcRenderer.invoke('folders:tree', rootId)
  },

  onFoldersChanged: (cb: () => void) => ipcRenderer.on('folders:changed', () => cb()),
  offFoldersChanged: () => ipcRenderer.removeAllListeners('folders:changed'),

  // Tags
  tags: {
    all: () => ipcRenderer.invoke('tags:all'),
    mostUsed: (limit?: number) => ipcRenderer.invoke('tags:most-used', limit),
    forTrack: (trackId: number) => ipcRenderer.invoke('tags:for-track', trackId),
    forTracks: (trackIds: number[]) => ipcRenderer.invoke('tags:for-tracks', trackIds),
    tracksByTag: (tagId: number) => ipcRenderer.invoke('tags:tracks-by-tag', tagId),
    apply: (trackId: number, tagId: number) => ipcRenderer.invoke('tags:apply', trackId, tagId),
    // One transaction in main: replaces this field's tags and recomputes the
    // derived tracks.<field> column together. Returns the derived value.
    setForField: (trackId: number, field: string, values: string[]) =>
      ipcRenderer.invoke('tags:set-for-field', trackId, field, values),
    rename: (tagId: number, newValue: string) => ipcRenderer.invoke('tags:rename', tagId, newValue),
    // Removes the tag from the library entirely, re-deriving every track
    // that carried it. `remove` above only unlinks one track.
    delete: (tagId: number) => ipcRenderer.invoke('tags:delete', tagId),
    remove: (trackId: number, tagId: number) => ipcRenderer.invoke('tags:remove', trackId, tagId),
    checkCandidates: (candidates: string[], field: string) =>
      ipcRenderer.invoke('tags:check-candidates', candidates, field),
    confirmImport: (pendingId: number, trackId: number, approvedTags: string[], field: string) =>
      ipcRenderer.invoke('tags:confirm-import', pendingId, trackId, approvedTags, field),
    pending: () => ipcRenderer.invoke('tags:pending'),
    findOrCreate: (field: string, value: string, color: string) =>
      ipcRenderer.invoke('tags:find-or-create', field, value, color)
  },

  // Crates
  crates: {
    all: () => ipcRenderer.invoke('crates:all'),
    allTrackIds: () => ipcRenderer.invoke('crates:all-track-ids'),
    insert: (name: string, parentCrateId: number | null, color: string) =>
      ipcRenderer.invoke('crates:insert', name, parentCrateId, color),
    rename: (id: number, name: string) => ipcRenderer.invoke('crates:rename', id, name),
    moveParent: (id: number, parentCrateId: number | null) =>
      ipcRenderer.invoke('crates:move-parent', id, parentCrateId),
    delete: (id: number) => ipcRenderer.invoke('crates:delete', id),
    addTracks: (crateId: number, trackIds: number[]) =>
      ipcRenderer.invoke('crates:add-tracks', crateId, trackIds),
    removeTracks: (crateId: number, trackIds: number[]) =>
      ipcRenderer.invoke('crates:remove-tracks', crateId, trackIds),
    tracks: (crateId: number) => ipcRenderer.invoke('crates:tracks', crateId),
    reorder: (crateId: number, orderedTrackIds: number[]) =>
      ipcRenderer.invoke('crates:reorder', crateId, orderedTrackIds),
    isSeratoRunning: () => ipcRenderer.invoke('crates:is-serato-running'),
    export: (crateIds: number[]) => ipcRenderer.invoke('crates:export', crateIds)
  },
  onCrateExportProgress: (cb: (p: ExportProgressPayload) => void) =>
    ipcRenderer.on('crate-export:progress', (_e, p) => cb(p)),
  offCrateExportProgress: () => ipcRenderer.removeAllListeners('crate-export:progress'),

  // Library roots
  roots: {
    all: () => ipcRenderer.invoke('roots:all'),
    add: (folderPath: string, importSeratoData?: boolean) =>
      ipcRenderer.invoke('roots:add', folderPath, importSeratoData),
    remove: (id: number) => ipcRenderer.invoke('roots:remove', id)
  },

  // Boards
  boards: {
    all: () => ipcRenderer.invoke('boards:all'),
    tracksByColumn: (column: string) => ipcRenderer.invoke('boards:tracks-by-column', column)
  },

  // Settings
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('settings:delete', key)
  },

  // Artwork — the renderer never builds artwork paths itself, only asks for
  // a hash + size and gets back a ready-to-use path (or null if missing).
  artwork: {
    pathFor: (hash: string | null, size: 'full' | 'thumb') =>
      ipcRenderer.invoke('artwork:path-for', hash, size),
    // One track, or a whole selection sharing a single stored image.
    pick: (target: number | number[]) => ipcRenderer.invoke('artwork:pick', target),
    sweepOrphaned: () => ipcRenderer.invoke('artwork:sweep-orphaned')
  },
  fs: {
    // Job-based — see MoveJob/runMoveJob in main/index.ts. Both resolve
    // immediately with a jobId; progress comes over onMoveProgress.
    moveFile: (from: string, to: string) => ipcRenderer.invoke('fs:move-file', from, to),
    moveFiles: (payload: { trackIds: number[]; destAbsolutePath: string }) =>
      ipcRenderer.invoke('fs:move-files', payload),
    cancelMove: (jobId: string) => ipcRenderer.invoke('fs:cancel-move', jobId),
    isCrossDevice: (filepaths: string[], destPath: string) =>
      ipcRenderer.invoke('fs:is-cross-device', filepaths, destPath),
    renameFile: (filepath: string, newName: string) =>
      ipcRenderer.invoke('fs:rename-file', filepath, newName),
    createFolder: (parent: string, name: string) =>
      ipcRenderer.invoke('fs:create-folder', parent, name),
    // mode 'library' removes the rows and leaves every file alone; 'trash'
    // sends the directory to the OS Trash and removes the track rows too.
    deleteFolder: (folderId: number, mode: 'library' | 'trash') =>
      ipcRenderer.invoke('fs:delete-folder', folderId, mode),
    moveFolderTracksToParent: (folderId: number) =>
      ipcRenderer.invoke('fs:move-folder-tracks-to-parent', folderId),
    renameFolder: (folderId: number, newName: string) =>
      ipcRenderer.invoke('fs:rename-folder', folderId, newName),
    // apply:false is a dry run — returns exactly what WOULD happen so the
    // modal can show it before a single file is touched.
    renameFromTemplate: (payload: { trackIds: number[]; template: string; apply: boolean }) =>
      ipcRenderer.invoke('fs:rename-from-template', payload),
    readFolder: (folderPath: string) => ipcRenderer.invoke('fs:read-folder', folderPath),
    // Drag-and-drop from Finder — classify what was dropped (never guess
    // from the filename in the renderer), and copy-then-import a drop into
    // a specific folder. Job-based like move: resolves with a jobId,
    // progress comes over onCopyProgress.
    classifyPaths: (paths: string[]) => ipcRenderer.invoke('fs:classify-paths', paths),
    copyIntoFolder: (payload: {
      sourcePaths: string[]
      destAbsolutePath: string
      currentFolderPath: string
      deleteSource?: boolean
    }) => ipcRenderer.invoke('fs:copy-into-folder', payload),
    cancelCopy: (jobId: string) => ipcRenderer.invoke('fs:cancel-copy', jobId),
    // 'fs:show-in-folder', not 'fs:showInFolder' — the channel main registers,
    // and the kebab-case every other fs: channel uses. They disagreed, so the
    // invoke hit a channel with no handler and the button did nothing at all.
    showInFolder: (filepath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:show-in-folder', filepath)
  },
  onMoveProgress: (cb: (p: MoveProgressPayload) => void) =>
    ipcRenderer.on('move:progress', (_e, p) => cb(p)),
  offMoveProgress: () => ipcRenderer.removeAllListeners('move:progress'),
  onCopyProgress: (cb: (p: CopyProgressPayload) => void) =>
    ipcRenderer.on('copy:progress', (_e, p) => cb(p)),
  offCopyProgress: () => ipcRenderer.removeAllListeners('copy:progress'),
  // Modern Electron removed File.path — the renderer must resolve a
  // dropped File's real path through the preload/main process instead.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  watcher: {
    pendingChanges: () => ipcRenderer.invoke('watcher:pending-changes'),
    acceptChange: (id: number) => ipcRenderer.invoke('watcher:accept-change', id),
    ignoreChange: (id: number) => ipcRenderer.invoke('watcher:ignore-change', id),
    start: (rootId: number, rootPath: string) =>
      ipcRenderer.invoke('watcher:start', rootId, rootPath),
    stop: (rootId: number) => ipcRenderer.invoke('watcher:stop', rootId)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
