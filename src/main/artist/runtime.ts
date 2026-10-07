// ── Artist-name cleanup: wiring ───────────────────────────────────────────
// Binds the service to the real database and to the existing sidecar tag
// writer. Everything that reaches the audio file goes through writeTagsForFile
// (serialized per file, the same path every other tag edit takes).

import { randomUUID } from 'crypto'
import { getArtistStore } from '../db'
import { writeTagsForFile } from '../tagWrites'
import { createArtistCleaner, type WriteArtistResult } from './service'
import type { WriteArtistFn } from './types'

type Send = (channel: string, payload: unknown) => void
let send: Send = () => {}

// Called once from index.ts with a function that posts to the main window.
export function setArtistCleanSender(fn: Send): void {
  send = fn
}

const writeArtist: WriteArtistFn = async (filepath, artist): Promise<WriteArtistResult> => {
  try {
    const results = await writeTagsForFile(filepath, { artist })
    const result = results[0]
    if (result?.success) return { ok: true }
    return { ok: false, error: result?.error ?? 'The file could not be written' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export const artistCleaner = createArtistCleaner(getArtistStore(), {
  writeArtist,
  uuid: randomUUID,
  onNotice: (message) => send('artist-clean:notice', { message }),
  onProgress: (p) => send('artist-clean:progress', p)
})

// Import hook. Runs in the background and never throws: cleanup is a courtesy
// and must not be able to fail an import. Tells the renderer which tracks
// changed so its copies can be refreshed.
export function processNewArtists(trackIds: readonly number[]): void {
  if (trackIds.length === 0) return
  void artistCleaner
    .processNewTracks(trackIds)
    .then((report) => {
      if (report.tracks > 0) send('artist-clean:changed', { trackIds: [...trackIds] })
    })
    .catch((err) => console.warn('[artist-clean] import cleanup failed:', (err as Error).message))
}
