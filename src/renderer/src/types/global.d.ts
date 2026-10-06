export {}

declare global {
  interface Window {
    api: {
      openFolder: () => Promise<string | null>
      openFiles: () => Promise<string[]>
      importFile: (filepath: string) => Promise<{ ok: boolean; trackId?: number; error?: string }>
      importFiles: (filepaths: string[]) => Promise<{
        ok: boolean
        count: number
        results: { ok: boolean; trackId?: number; error?: string }[]
      }>
      // Pass trackId to receive analysis:file-progress events for that track
      // (onAnalyzeFileProgress); omit it for a silent analysis.
      analyzeFile: (
        filepath: string,
        trackId?: number
      ) => Promise<{
        ok: boolean
        data?: AnalysisResult
        error?: string
      }>
      writeTags: (
        filepath: string,
        meta: EditTagsMeta
      ) => Promise<{ ok: boolean; results?: unknown[]; error?: string }>
      // Job-based, like fs.moveFiles/crates.export — resolves immediately
      // with a jobId; progress comes over onEditTagsProgress. No DB update
      // happens as part of this yet — see runEditTagsJob in main/index.ts.
      editTagsBatch: (
        items: { filepath: string; meta: EditTagsMeta }[],
        options?: { writeSerato?: boolean }
      ) => Promise<{ jobId: string }>
      onEditTagsProgress: (cb: (p: EditTagsProgressPayload) => void) => void
      offEditTagsProgress: () => void

      importFolder: (
        folderPath: string,
        importSeratoData?: boolean,
        rescan?: boolean
      ) => Promise<{
        ok: boolean
        imported?: number
        failed?: number
        total?: number
        jobId?: string
        cancelled?: boolean
        message?: string
        error?: string
        unchanged?: number
        relinked?: number
        swept?: number
      }>

      auth: {
        state: () => Promise<AuthState>
        signIn: () => Promise<{ ok: boolean; state: AuthState; error?: string }>
        createAccount: () => Promise<{ ok: boolean; state: AuthState; error?: string }>
        cancelSignIn: () => Promise<{ ok: boolean; state: AuthState }>
        reopenBrowser: () => Promise<{ ok: boolean; error?: string }>
        openDestination: (
          destination: 'signIn' | 'createAccount' | 'passwordReset' | 'account' | 'portal'
        ) => Promise<{ ok: boolean; error?: string }>
        signOut: () => Promise<{ ok: boolean; state: AuthState }>
        refresh: () => Promise<{ ok: boolean; state: AuthState; error?: string }>
      }

      onAuthChanged: (
        cb: (state: AuthState & { error?: string; justSignedIn?: boolean }) => void
      ) => void
      offAuthChanged: () => void

      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>

      // Stops the Phase 2 analysis pass after the batch in flight. Safe to
      // call when nothing is running.
      stopAnalysis: () => Promise<{ ok: boolean }>

      // Dev only. `stale` means out/main or out/preload were rebuilt after
      // this Electron process loaded them — the renderer is newer than the
      // code it is talking to, and only a full restart fixes that.
      buildStatus: () => Promise<{ stale: boolean; changed: string[] }>

      rescanLibrary: () => Promise<{
        ok: boolean
        error?: string
        roots?: number
        // Roots whose volume was not mounted — skipped, not failed.
        skippedRoots?: string[]
        imported?: number
        unchanged?: number
        relinked?: number
        // Tracks marked missing. Never a deletion.
        swept?: number
        total?: number
      }>

      cancelImport: (jobId: string) => Promise<{ ok: boolean; error?: string }>
      resumeImport: (jobId: string) => Promise<{
        ok: boolean
        imported?: number
        failed?: number
        total?: number
        jobId?: string
        cancelled?: boolean
        error?: string
      }>

      onImportProgress: (cb: (p: ImportProgressPayload) => void) => void

      onImportBatchCommitted: (cb: (data: { jobId: string }) => void) => void

      offImportProgress: () => void

      // Read-only pre-check before showing the "Import Serato data from this
      // library" checkbox — see detectSeratoLibrary in main/serato/seratoImport.ts.
      detectSeratoForFolder: (folderPath: string) => Promise<{ found: boolean; seratoDir?: string }>
      onSeratoImportProgress: (cb: (p: SeratoImportProgressPayload) => void) => void
      offSeratoImportProgress: () => void

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
      ) => void

      // `stopped` is true when the DJ hit Stop — the run ended early and
      // the tracks it never reached still have analyzed_at null, so the
      // next run resumes from there.
      onAnalysisComplete: (
        cb: (data: { analyzed: number; total: number; stopped?: boolean }) => void
      ) => void

      onAnalyzeFileProgress: (cb: (p: AnalyzeFileProgressPayload) => void) => void

      offAnalysisListeners: () => void

      onTrackAdded: (cb: (data: { trackId: number; filepath: string }) => void) => void
      onTrackMoved: (
        cb: (data: { trackId: number; oldPath: string; newPath: string }) => void
      ) => void
      onTrackDeleted: (cb: (data: { filepath: string; trackId: number | null }) => void) => void
      onRootOffline: (cb: (data: { rootId: number; rootPath: string }) => void) => void
      onRootOnline: (cb: (data: { rootId: number; rootPath: string }) => void) => void
      offWatcherListeners: () => void

      db: {
        allTracks: () => Promise<Track[]>
        trackById: (id: number) => Promise<Track | null>
        insertTrack: (
          track: Partial<Track>
        ) => Promise<{ ok: boolean; id?: number; error?: string }>
        updateTrackMeta: (
          data: Partial<Track> & { id: number }
        ) => Promise<{ ok: boolean; error?: string }>
        updateBoardId: (id: number, boardId: number) => Promise<{ ok: boolean; error?: string }>
        tracksByBoardId: (id: number, boardId: number) => Promise<Track[]>
        markMissing: (filepath: string) => Promise<{ ok: boolean; error?: string }>
        // deleteFile: true also moves the audio file to the OS Trash before
        // the DB row is dropped; false removes only the CrateCloud entry.
        deleteTrack: (id: number, deleteFile: boolean) => Promise<{ ok: boolean; error?: string }>
        markAnalyzed: (id: number) => Promise<{ ok: boolean; error?: string }>
        tracksByFolder: (folderId: number, recursive: boolean) => Promise<Track[]>
        folderTrackCounts: () => Promise<{ folder_id: number; count: number }[]>
        tracksByIds: (ids: number[]) => Promise<Track[]>
      }

      folders: {
        tree: (rootId?: number) => Promise<FolderRow[]>
      }

      onMoveProgress: (cb: (p: MoveProgressPayload) => void) => void
      offMoveProgress: () => void

      watcher: {
        pendingChanges: () => Promise<PendingChange[]>
        acceptChange: (id: number) => Promise<{ ok: boolean; error?: string }>
        ignoreChange: (id: number) => Promise<{ ok: boolean; error?: string }>
        start: (rootId: number, rootPath: string) => Promise<{ ok: boolean }>
        stop: (rootId: number) => Promise<{ ok: boolean }>
      }

      tags: {
        all: () => Promise<Tag[]>
        mostUsed: (limit?: number) => Promise<Tag[]>
        forTrack: (trackId: number) => Promise<Tag[]>
        forTracks: (trackIds: number[]) => Promise<Record<number, Tag[]>>
        tracksByTag: (tagId: number) => Promise<Track[]>
        apply: (trackId: number, tagId: number) => Promise<{ ok: boolean; error?: string }>
        // Replaces this field's tags and recomputes tracks.<field> in one
        // transaction. `derived` is the new column value, ready to write to
        // the file without reading back.
        setForField: (
          trackId: number,
          field: string,
          values: string[]
        ) => Promise<{ ok: boolean; derived?: string | null; error?: string }>
        // Removes the tag from the library entirely and re-derives every
        // track that carried it. `remove` only unlinks a single track.
        delete: (tagId: number) => Promise<{
          ok: boolean
          deleted?: boolean
          field?: string
          value?: string
          tracksUpdated?: number
          error?: string
        }>
        // Renames a tag everywhere and re-derives every track carrying it.
        // Merges into an existing tag of the same field on a collision.
        rename: (
          tagId: number,
          newValue: string
        ) => Promise<{
          ok: boolean
          renamed?: boolean
          mergedInto?: number | null
          tracksUpdated?: number
          error?: string
        }>
        remove: (trackId: number, tagId: number) => Promise<{ ok: boolean; error?: string }>
        checkCandidates: (candidates: string[], field: string) => Promise<TagCandidate[]>
        confirmImport: (
          pendingId: number,
          trackId: number,
          approvedTags: string[],
          field: string
        ) => Promise<{ ok: boolean; error?: string }>
        pending: () => Promise<PendingImport[]>
        findOrCreate: (
          field: string,
          value: string,
          color: string
        ) => Promise<{ ok: boolean; id?: number; error?: string }>
      }

      roots: {
        all: () => Promise<LibraryRoot[]>
        add: (
          folderPath: string,
          importSeratoData?: boolean
        ) => Promise<{ ok: boolean; id?: number; error?: string }>
        remove: (id: number) => Promise<{ ok: boolean; error?: string }>
      }

      crates: {
        all: () => Promise<Crate[]>
        // crate_id -> track_id[] — powers the "which crates already have
        // this track" picker without one query per crate.
        allTrackIds: () => Promise<Record<number, number[]>>
        insert: (
          name: string,
          parentCrateId: number | null,
          color: string
        ) => Promise<{ ok: boolean; id?: number; error?: string }>
        rename: (id: number, name: string) => Promise<{ ok: boolean; error?: string }>
        moveParent: (
          id: number,
          parentCrateId: number | null
        ) => Promise<{ ok: boolean; error?: string }>
        delete: (id: number) => Promise<{ ok: boolean; error?: string }>
        addTracks: (crateId: number, trackIds: number[]) => Promise<{ ok: boolean; error?: string }>
        removeTracks: (
          crateId: number,
          trackIds: number[]
        ) => Promise<{ ok: boolean; error?: string }>
        tracks: (crateId: number) => Promise<Track[]>
        // orderedTrackIds is the FULL new order for the crate — every reorder
        // path (column-sort, drag, keyboard nudge, undo) renumbers the whole
        // crate in one transaction; see reorderCrateTracks in main/db.ts.
        reorder: (
          crateId: number,
          orderedTrackIds: number[]
        ) => Promise<{ ok: boolean; error?: string }>
        isSeratoRunning: () => Promise<boolean>
        export: (crateIds: number[]) => Promise<{ jobId: string }>
      }

      onCrateExportProgress: (cb: (p: ExportProgressPayload) => void) => void
      offCrateExportProgress: () => void

      boards: {
        all: () => Promise<Board[]>
        tracksByColumn: (column: string) => Promise<Track[]>
      }

      settings: {
        get: (key: string) => Promise<string | null>
        set: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
        // Removes the row. Deleting an absent key succeeds.
        delete: (key: string) => Promise<{ ok: boolean; error?: string }>
      }

      fs: {
        // Job-based — see MoveJob/runMoveJob in main/index.ts. Both resolve
        // immediately with a jobId; progress comes over onMoveProgress.
        moveFile: (
          from: string,
          to: string
        ) => Promise<{ ok: boolean; jobId?: string; error?: string }>
        moveFiles: (payload: {
          trackIds: number[]
          destAbsolutePath: string
        }) => Promise<{ jobId: string }>
        cancelMove: (jobId: string) => Promise<{ ok: boolean; error?: string }>
        isCrossDevice: (
          filepaths: string[],
          destPath: string
        ) => Promise<{ ok: boolean; crossDevice?: boolean; totalBytes?: number; error?: string }>
        renameFile: (
          filepath: string,
          newName: string
        ) => Promise<{ ok: boolean; newPath?: string; error?: string }>
        createFolder: (
          parent: string,
          name: string
        ) => Promise<{
          ok: boolean
          path?: string
          folderId?: number | null
          reason?: string
          error?: string
        }>
        // 'library' removes the folder rows only — files untouched, and the
        // tracks survive unfiled (tracks.folder_id is ON DELETE SET NULL).
        // 'trash' sends the directory to the OS Trash and removes the track
        // rows with it. Counts come back so the caller can report them.
        deleteFolder: (
          folderId: number,
          mode: 'library' | 'trash'
        ) => Promise<{
          ok: boolean
          folders?: number
          tracks?: number
          error?: string
        }>
        moveFolderTracksToParent: (folderId: number) => Promise<{
          ok: boolean
          jobId?: string
          trackIds?: number[]
          error?: string
        }>
        renameFolder: (
          folderId: number,
          newName: string
        ) => Promise<{
          ok: boolean
          renamed?: boolean
          newPath?: string
          foldersUpdated?: number
          tracksUpdated?: number
          error?: string
        }>
        // apply:false is a dry run. Every outcome comes back either way, so
        // the modal shows the real result before anything is renamed.
        renameFromTemplate: (payload: {
          trackIds: number[]
          template: string
          apply: boolean
        }) => Promise<{
          ok: boolean
          error?: string
          results?: {
            trackId: number
            from: string
            to?: string
            status: 'renamed' | 'unchanged' | 'skipped' | 'failed'
            reason?: string
          }[]
        }>
        readFolder: (
          folderPath: string
        ) => Promise<{ ok: boolean; items?: FolderItem[]; error?: string }>
        // Drag-and-drop from Finder — see fs:classify-paths/fs:copy-into-folder
        // in main/index.ts. classifyPaths never guesses from a filename; the
        // renderer just routes on the returned kind.
        classifyPaths: (
          paths: string[]
        ) => Promise<{ path: string; kind: 'dir' | 'audio' | 'other' }[]>
        copyIntoFolder: (payload: {
          sourcePaths: string[]
          destAbsolutePath: string
          currentFolderPath: string
          deleteSource?: boolean
        }) => Promise<{ jobId: string }>
        cancelCopy: (jobId: string) => Promise<{ ok: boolean; error?: string }>
        showInFolder: (filepath: string) => Promise<{ ok: boolean; error?: string }>
      }

      onFoldersChanged: (cb: () => void) => void
      offFoldersChanged: () => void

      onCopyProgress: (cb: (p: CopyProgressPayload) => void) => void
      offCopyProgress: () => void

      // Modern Electron removed File.path — resolves a dropped File's real
      // path via the preload's webUtils.getPathForFile bridge. Never read
      // file.path in the renderer; it's undefined.
      getPathForFile: (file: File) => string

      artwork: {
        pathFor: (hash: string | null, size: 'full' | 'thumb') => Promise<string | null>
        // A single track id, or a selection that will all share one stored
        // image. `applied` is how many rows were pointed at it.
        pick: (
          target: number | number[]
        ) => Promise<{ ok: boolean; hash?: string; applied?: number; error?: string }>
        sweepOrphaned: () => Promise<{ removed: number; bytesReclaimed: number }>
      }
    }
  }

  // ─── Shared types ─────────────────────────────────────────

  interface Track {
    id: number
    filepath: string
    filename: string | null
    title: string | null
    artist: string | null
    album: string | null
    genre: string | null
    year: string | null
    remixer: string | null
    composer: string | null
    comment: string | null
    label: string | null
    grouping: string | null
    bpm: number | null
    key_camelot: string | null
    key_full: string | null
    camelot: string | null
    openkey: string | null
    duration_sec: number | null
    duration_str: string | null
    file_size_bytes: number | null
    format: string | null
    waveform: string | null
    artwork_path: string | null
    artwork_hash: string | null
    board_id: number
    board_name?: string // joined from boards table
    board_color?: string // joined from boards table
    energy: number | null
    analyzed_at: string | null
    added_at: string
    updated_at: string
    last_modified: number | null
    missing: number
    needs_sync: number
    pending_changes: string | null
    last_seen_at: string | null
    folder_id: number | null
    client_uuid: string | null
    partial_hash: string | null
  }

  interface FolderRow {
    id: number
    name: string
    path: string | null
    parent_folder_id: number | null
    root_folder_id: number | null
    relative_path: string | null
    created_at: number
    updated_at: number | null
    missing: number
  }

  interface Tag {
    id: number
    field: string
    value: string
    color: string
    created_at: number
    track_count?: number
  }

  interface TagCandidate {
    value: string
    exists: boolean
    trackCount: number
  }

  interface PendingImport {
    id: number
    track_id: number
    raw_comment: string
    candidates: string[]
    created_at: number
  }

  interface Crate {
    id: number
    name: string
    color: string
    parent_crate_id: number | null
    created_at: number
    updated_at: number
    last_exported_at: number | null
    track_count?: number
  }

  interface Board {
    id: number
    name: string
    color: string
    position: number
    created_at: number
  }

  interface AnalysisResult {
    success: boolean
    error?: string
    filepath: string
    title: string | null
    artist: string | null
    album: string | null
    genre: string | null
    year: string | null
    comment: string | null
    label: string | null
    remixer: string | null
    composer: string | null
    grouping: string | null
    bpm: number | null
    key_full: string | null
    key_camelot: string | null
    camelot: string | null
    duration_sec: number | null
    duration_str: string | null
    bpm_tag: string | null
    artwork_base64: string | null
    analyzed: boolean
    // Only read_tags()'s fast Phase 1 path populates these — analyze()'s
    // Phase 2 result (BPM/key only) leaves them undefined.
    file_size_bytes?: number | null
    client_uuid?: string | null
  }

  interface Entitlement {
    // TODO(stripe-webhook): only ever 'free' until the payments website's
    // Stripe webhook exists — it is the sole writer. Nothing in the desktop
    // UI gates on this; the desktop app is free. The paid values are the
    // cloud/mobile subscription sold on the web.
    //
    // PROVISIONAL names (2026-09-23): the tier lineup is not finalised.
    // Branch on "not 'free'", never on a specific paid value.
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
  }

  interface AuthUser {
    id: string
    email: string | null
    displayName: string | null
    avatarUrl: string | null
    provider: string | null
    created_at: string | null
  }

  interface AuthState {
    // False when MAIN_VITE_SUPABASE_* are absent — the login view shows
    // setup instructions instead of a form it knows will fail.
    configured: boolean
    status: 'signedOut' | 'awaitingBrowser' | 'signedIn' | 'expired'
    user: AuthUser | null
    entitlement: Entitlement | null
    // False when safeStorage is unavailable (typically a Linux box with no
    // keyring): this session will not survive a quit.
    persistent: boolean
    offline: boolean
    confirmingPurchase: boolean
    links: Record<'signIn' | 'createAccount' | 'passwordReset' | 'account' | 'portal', boolean>
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
    unchanged: number
    swept: number
    rescan: boolean
  }

  interface FolderItem {
    name: string
    path: string
    isDirectory: boolean
    size: number
    modified: number
    audioCount: number
  }

  // TODO: independently redefined here, in main/index.ts, and in
  // preload/index.ts — see the same TODO on JobState in useLibraryStore.ts.
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

  // TODO: independently redefined here, in main/index.ts, and in
  // preload/index.ts — see the same TODO on JobState in useLibraryStore.ts.
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

  // TODO: independently redefined here, in main/index.ts, and in
  // preload/index.ts — see the same TODO on JobState in useLibraryStore.ts.
  interface EditTagsProgressPayload {
    jobId: string
    phase: 'running' | 'done' | 'error'
    done: number
    total: number
    currentFile: string
    failed: { filepath: string; error: string }[]
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

  // TODO: independently redefined here, in main/index.ts, and in
  // preload/index.ts — see the same TODO on JobState in useLibraryStore.ts.
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

  // What useLibraryStore.trackAnalysis holds for a track being analysed. Same
  // shape as the IPC payload minus the addressing fields, plus 'queued': the
  // renderer sets that the moment the user asks for a re-analysis, so the bar
  // appears on the card immediately instead of only once Python has started
  // and reported its first stage.
  interface TrackAnalysisProgress {
    stage: 'queued' | AnalyzeFileProgressPayload['stage']
    step: number
    steps: number
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

  interface SeratoImportProgressPayload {
    jobId: string
    phase: 'running' | 'done' | 'error'
    stage: 'database' | 'crates' | 'history'
    tally: SeratoImportTally
    error?: string
  }

  interface LibraryRoot {
    id: number
    name: string
    path: string
    created_at: number
    last_scanned_at: number | null
    status: string
  }

  interface PendingChange {
    id: number
    root_id: number
    change_type: 'added' | 'moved' | 'renamed' | 'deleted'
    old_path: string | null
    new_path: string | null
    track_id: number | null
    title: string | null
    artist: string | null
    artwork_hash: string | null
    detected_at: number
    status: 'pending' | 'accepted' | 'ignored'
  }
}
