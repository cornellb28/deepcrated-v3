import {
  editTagsBatch,
  type EditTagsBatchItem,
  type EditTagsMeta,
  type EditTagsResult
} from './sidecar'

// ── Per-file write-tags serialization ─────────────────────────────────────
// Each tag write spawns edit_tags.py, which copies the file, edits the copy,
// then atomically replaces the original. Two writes to the same filepath
// running in parallel therefore both branch from the pre-edit file, and
// whichever replace lands last wins outright — silently discarding the
// other edit, because its copy was taken before the first one committed.
// Chaining onto the prior promise for that filepath forces same-file writes
// to run one at a time; unrelated files are unaffected and still write
// concurrently.
const writeTagsQueues = new Map<string, Promise<unknown>>()

// Waits for every filepath's in-flight write to finish, runs task, and
// registers task as the new tail for all of them. Callers that touch one
// file go through queueTagWrite; the batch job passes its whole file list,
// so a bulk edit and a single-field edit that overlap on one track still
// run one after the other. Deadlock isn't reachable: every caller acquires
// all of its filepaths in one go, so nobody holds one key while waiting on
// another.
export function queueTagWrites<T>(filepaths: string[], task: () => Promise<T>): Promise<T> {
  const distinct = Array.from(new Set(filepaths))
  const priors = distinct.map((filepath) => writeTagsQueues.get(filepath) ?? Promise.resolve())
  // allSettled, not all: a prior write that rejected has still finished, and
  // must not stop the next one from starting.
  const run = Promise.allSettled(priors).then(task)
  const tracked = run.then(
    () => undefined,
    () => undefined
  )
  for (const filepath of distinct) writeTagsQueues.set(filepath, tracked)
  tracked.finally(() => {
    for (const filepath of distinct) {
      if (writeTagsQueues.get(filepath) === tracked) writeTagsQueues.delete(filepath)
    }
  })
  return run
}

export function queueTagWrite<T>(filepath: string, task: () => Promise<T>): Promise<T> {
  return queueTagWrites([filepath], task)
}

// ── CRATECLOUD_ID conflicts ───────────────────────────────────────────────
// A file can already carry a CRATECLOUD_ID from a different CrateCloud
// library — a copied track, or a re-import that minted a fresh client_uuid.
// edit_tags.py refuses the whole write in that case, which would throw away
// the metadata edit the user actually asked for over an identity mismatch
// they never asked about. Retry once without the identity field so the edit
// still lands; the file keeps the id it already had.
//
// TODO(cratecloud): decide whether the row should adopt result.existing as
// its client_uuid instead. It cannot just be copied across —
// idx_tracks_client_uuid is unique, so another row may already hold that id.
export function withoutCratecloudId(meta: EditTagsMeta): EditTagsMeta {
  const rest = { ...meta }
  delete rest.cratecloud_id
  return rest
}

export async function editTagsResolvingIdConflicts(
  items: EditTagsBatchItem[],
  onProgress: (result: EditTagsResult) => void,
  options: { writeSerato?: boolean } = {}
): Promise<void> {
  const retries: EditTagsBatchItem[] = []
  const conflicted = new Set<string>()

  await editTagsBatch(
    items,
    (result) => {
      if (result.error === 'cratecloud_id_conflict' && result.filepath) {
        const original = items.find((item) => item.filepath === result.filepath)
        if (original && !conflicted.has(result.filepath)) {
          conflicted.add(result.filepath)
          console.warn(
            `[editTags] ${result.filepath} already carries CRATECLOUD_ID ${result.existing}; ` +
              'writing the metadata edit without touching it'
          )
          retries.push({ filepath: original.filepath, meta: withoutCratecloudId(original.meta) })
          return // hold this file's progress tick until the retry decides it
        }
      }
      onProgress(result)
    },
    options
  )

  if (retries.length > 0) await editTagsBatch(retries, onProgress, options)
}

// One filepath, one write, serialized against anything else touching it.
export function writeTagsForFile(
  filepath: string,
  meta: EditTagsMeta
): Promise<EditTagsResult[]> {
  return queueTagWrite(filepath, async () => {
    const results: EditTagsResult[] = []
    await editTagsResolvingIdConflicts([{ filepath, meta }], (r) => results.push(r), {
      writeSerato: true
    })
    return results
  })
}
