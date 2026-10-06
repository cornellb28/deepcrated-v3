import { app, nativeImage } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile, readdir, rename, stat, unlink } from 'fs/promises'
import {
  getSetting,
  setSetting,
  getTracksWithLegacyArtwork,
  setTrackArtworkHash,
  getArtworkHashesInUse
} from './db'

const artworkDir = join(app.getPath('userData'), 'cratecloud', 'artwork')
const ARTWORK_MIGRATION_SETTING_KEY = 'artwork_migration_v1'

function artworkFullPath(hash: string): string {
  return join(artworkDir, `${hash}.jpg`)
}

function artworkThumbPath(hash: string): string {
  return join(artworkDir, `${hash}_200.jpg`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// nativeImage.resize() stretches to fit when both width and height are given,
// so a true 200x200 cover crop needs the smaller side resized to 200 first
// (preserving aspect ratio) and the result center-cropped.
function makeThumbnailJpeg(image: Electron.NativeImage): Buffer {
  const { width, height } = image.getSize()
  const scale = 200 / Math.min(width, height)
  const resized = image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'good'
  })
  const { width: rw, height: rh } = resized.getSize()
  const cropped = resized.crop({
    x: Math.max(0, Math.floor((rw - 200) / 2)),
    y: Math.max(0, Math.floor((rh - 200) / 2)),
    width: Math.min(200, rw),
    height: Math.min(200, rh)
  })
  return cropped.toJPEG(80)
}

// Hashes the image bytes and writes <hash>.jpg + a <hash>_200.jpg thumbnail
// once; every subsequent track that embeds the same cover just reuses the
// existing files. Returns the hash to store on the track row, or null on
// failure — a bad/corrupt embedded image must never fail the track import.
export async function storeArtwork(imageBytes: Buffer): Promise<string | null> {
  try {
    await mkdir(artworkDir, { recursive: true })
    const hash = createHash('sha1').update(imageBytes).digest('hex')
    const fullPath = artworkFullPath(hash)

    if (await fileExists(fullPath)) return hash // another track already stored this cover

    await writeFile(fullPath, imageBytes)

    try {
      const image = nativeImage.createFromBuffer(imageBytes)
      if (!image.isEmpty()) {
        await writeFile(artworkThumbPath(hash), makeThumbnailJpeg(image))
      }
    } catch (err) {
      // Full-size art is saved and usable — a missing thumbnail just means
      // the renderer's 'thumb' request resolves to null and falls back to
      // its placeholder.
      console.error('[artwork] thumbnail generation failed:', err)
    }

    return hash
  } catch (err) {
    console.error('[artwork] storeArtwork failed:', err)
    return null
  }
}

// Single main-side resolver — the renderer never constructs a <hash>.jpg /
// <hash>_200.jpg path itself, it only ever asks for a hash + size.
export async function artworkPathFor(
  hash: string | null,
  size: 'full' | 'thumb'
): Promise<string | null> {
  if (!hash) return null
  const path = size === 'thumb' ? artworkThumbPath(hash) : artworkFullPath(hash)
  return (await fileExists(path)) ? path : null
}

// One-time migration of legacy per-track artwork onto content-addressed
// storage. Runs once, after the schema migration, off the import/analysis
// paths — throttled with a short pause every 25 files so it never starves
// IPC handlers while walking a large library. Completion is recorded in
// app_settings so it never re-runs; a row whose legacy file is already gone
// by the time this runs is simply left with artwork_hash NULL for good.
export async function migrateArtworkToContentAddressed(): Promise<void> {
  if (getSetting(ARTWORK_MIGRATION_SETTING_KEY) === 'done') return

  const rows = getTracksWithLegacyArtwork()
  let migrated = 0
  let duplicatesRemoved = 0
  let bytesReclaimed = 0
  let failed = 0

  for (const row of rows) {
    try {
      const legacyStat = await stat(row.artwork_path) // throws if the file is gone
      const bytes = await readFile(row.artwork_path)
      const hash = createHash('sha1').update(bytes).digest('hex')
      const fullPath = artworkFullPath(hash)

      if (await fileExists(fullPath)) {
        // Another track already claimed this hash — this legacy file is a duplicate.
        await unlink(row.artwork_path)
        duplicatesRemoved++
        bytesReclaimed += legacyStat.size
      } else {
        await mkdir(artworkDir, { recursive: true })
        await rename(row.artwork_path, fullPath)
      }

      if (!(await fileExists(artworkThumbPath(hash)))) {
        try {
          const image = nativeImage.createFromBuffer(bytes)
          if (!image.isEmpty()) {
            await writeFile(artworkThumbPath(hash), makeThumbnailJpeg(image))
          }
        } catch (err) {
          console.error('[artwork migration] thumbnail generation failed:', err)
        }
      }

      setTrackArtworkHash(row.id, hash)
      migrated++
    } catch (err) {
      failed++
      console.error(`[artwork migration] track ${row.id} failed:`, err)
    }

    if (migrated % 25 === 0) {
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  setSetting(ARTWORK_MIGRATION_SETTING_KEY, 'done')
  console.log(
    `[artwork migration] done — ${migrated} migrated, ${duplicatesRemoved} duplicates removed, ` +
      `${(bytesReclaimed / 1024 / 1024).toFixed(2)} MB reclaimed, ${failed} failed`
  )
}

// Deletes any <hash>.jpg / <hash>_200.jpg under the artwork dir whose hash
// isn't referenced by any track. Never runs automatically — only exposed via
// IPC for a manual cleanup action.
// TODO: surface in Settings
export async function sweepOrphanedArtwork(): Promise<{ removed: number; bytesReclaimed: number }> {
  const inUse = getArtworkHashesInUse()
  let removed = 0
  let bytesReclaimed = 0

  let entries: string[]
  try {
    entries = await readdir(artworkDir)
  } catch {
    return { removed: 0, bytesReclaimed: 0 }
  }

  for (const entry of entries) {
    const match = entry.match(/^([0-9a-f]{40})(?:_200)?\.jpg$/)
    if (!match || inUse.has(match[1])) continue

    const fullPath = join(artworkDir, entry)
    try {
      const s = await stat(fullPath)
      await unlink(fullPath)
      removed++
      bytesReclaimed += s.size
    } catch (err) {
      console.error(`[artwork sweep] failed to remove ${entry}:`, err)
    }
  }

  return { removed, bytesReclaimed }
}
