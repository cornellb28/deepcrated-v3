import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { readChunks } from './chunkReader'

// ── `_Serato_/History/**` reader ──────────────────────────────────────────
// `adat` is NOT decoded by chunkReader's normal ASCII-tag dispatch — verified
// by hand-parsing a real `.session` file (no public spec for this part; the
// outer `oent`/`vrsn` framing matches the documented format, but everything
// inside `adat` uses a DIFFERENT sub-scheme: a 4-byte big-endian NUMERIC
// field id instead of a 4-character tag, in front of the same 4-byte BE
// length + payload shape). readChunks still walks it correctly byte-for-byte
// (it never interprets the tag bytes itself) — only the type dispatch
// differs, so this file does its own small decode instead of reusing
// chunkReader's decodeChunkPayload.
//
// Field ids below came from decoding
// ~/Music/_Serato_/History/Sessions/1.session directly:
//   1  u32    row/position within the session
//   2  string absolute file path (NOT volume-relative like pfil/ptrk —
//             confirmed: starts with "/Users/..." or "/Volumes/...", already
//             a full path) — null-terminated, unlike pfil/ptrk.
//   6  string title
//   7  string artist
//   8  string album
//   9  string genre
//   15 u32    bpm (rounded integer, unlike database V2's decimal tbpm string)
//   19 string label
//   23 string year
//   28 u32    played-at, unix epoch seconds
//   29 u32    epoch seconds this play ended (next track's field 28 in the
//             common case) — redundant with 28+45, not used
//   45 u32    duration played, seconds
// Every field is optional except 1, 2, and 28 — a track played for a few
// seconds before the DJ pulled it may be missing 45 entirely.

interface AdatField {
  id: number
  payload: Buffer
}

function* readAdatFields(buffer: Buffer): Iterable<AdatField> {
  for (const { tag, payload } of readChunks(buffer)) {
    // chunkReader read the same 4 bytes as an ASCII string; recover the
    // numeric id Serato actually encoded there.
    const id = Buffer.from(tag, 'ascii').readUInt32BE(0)
    yield { id, payload }
  }
}

function decodeUtf16BE(buf: Buffer): string {
  const le = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    le[i] = buf[i + 1]
    le[i + 1] = buf[i]
  }
  return le.toString('utf16le').replace(/\0+$/, '')
}

export interface SeratoPlayEntry {
  absolutePath: string
  title: string | null
  artist: string | null
  playedAtEpochSec: number
  durationPlayedSec: number | null
}

function decodeOent(adatPayload: Buffer): SeratoPlayEntry | null {
  let absolutePath: string | null = null
  let title: string | null = null
  let artist: string | null = null
  let playedAtEpochSec: number | null = null
  let durationPlayedSec: number | null = null

  for (const { id, payload } of readAdatFields(adatPayload)) {
    switch (id) {
      case 2:
        absolutePath = decodeUtf16BE(payload)
        break
      case 6:
        title = decodeUtf16BE(payload)
        break
      case 7:
        artist = decodeUtf16BE(payload)
        break
      case 28:
        if (payload.length >= 4) playedAtEpochSec = payload.readUInt32BE(0)
        break
      case 45:
        if (payload.length >= 4) durationPlayedSec = payload.readUInt32BE(0)
        break
      default:
        break
    }
  }

  // Both are required to make a meaningful play row — a session entry
  // missing either is skipped by the caller, not defaulted to 0/''.
  if (!absolutePath || playedAtEpochSec === null) return null
  return { absolutePath, title, artist, playedAtEpochSec, durationPlayedSec }
}

// One session file at a time, one oent at a time — a busy night's session
// can hold hundreds of plays, but never more than one decoded in memory here.
export async function* readSessionPlays(sessionFilePath: string): AsyncIterable<SeratoPlayEntry> {
  const buffer = await readFile(sessionFilePath)
  for (const { tag, payload: oentPayload } of readChunks(buffer)) {
    if (tag !== 'oent') continue
    // oent's only child is a single 'adat' — read its ASCII tag/length
    // normally (this outer layer DOES follow the documented format), then
    // hand its payload to the numeric-id decoder above.
    for (const { tag: innerTag, payload: adatPayload } of readChunks(oentPayload)) {
      if (innerTag !== 'adat') continue
      const entry = decodeOent(adatPayload)
      if (entry) yield entry
    }
  }
}

// Takes the `_Serato_` dir itself (same convention as seratoDatabase.ts's
// defaultDatabaseVPath) — not History/ directly — so callers never have to
// remember the extra path segment.
export async function listSessionFiles(seratoDir: string): Promise<string[]> {
  const sessionsDir = join(seratoDir, 'History', 'Sessions')
  try {
    const entries = await readdir(sessionsDir)
    return entries
      .filter((f) => f.toLowerCase().endsWith('.session'))
      .map((f) => join(sessionsDir, f))
  } catch {
    return []
  }
}
