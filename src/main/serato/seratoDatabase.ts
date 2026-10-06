import { readFile } from 'fs/promises'
import { join } from 'path'
import { readChunks, readContainer, type ChunkContainer } from './chunkReader'

// ── `_Serato_/database V2` reader ─────────────────────────────────────────
// Field tags below were read directly off a real `database V2` file (via
// scripts/serato-dump.ts), not guessed from documentation — see that
// script's output for the byte-level trace. `tadd`/`uadd` is the one
// genuinely redundant pair: Serato writes the same added-at epoch twice,
// once as a decimal-digit string (tadd) and once as a real UInt32 (uadd).
// We prefer uadd and only fall back to parsing tadd if it's ever absent.

export interface SeratoTrackEntry {
  // Raw, volume-relative path exactly as Serato stored it (backslash-free —
  // Serato itself always writes '/' — not yet resolved against a volume root).
  relativePath: string
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  comment: string | null
  label: string | null
  composer: string | null
  remixer: string | null
  grouping: string | null
  year: string | null
  key: string | null
  bpm: number | null
  durationSec: number | null
  fileSizeBytes: number | null
  addedAtEpochSec: number | null
}

function str(container: ChunkContainer, tag: string): string | null {
  const v = container.get(tag)
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(container: ChunkContainer, tag: string): number | null {
  const v = container.get(tag)
  return typeof v === 'number' ? v : null
}

// Serato stores length as "mm:ss.hh" (hundredths) — "04:22.74" -> 262.74s.
function parseDurationStr(s: string | null): number | null {
  if (!s) return null
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const minutes = Number(m[1])
  const seconds = Number(m[2])
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null
  return minutes * 60 + seconds
}

function decodeTrackEntry(container: ChunkContainer): SeratoTrackEntry {
  const bpmStr = str(container, 'tbpm')
  const addedFromString = str(container, 'tadd')

  return {
    relativePath: str(container, 'pfil') ?? '',
    title: str(container, 'tsng'),
    artist: str(container, 'tart'),
    album: str(container, 'talb'),
    genre: str(container, 'tgen'),
    comment: str(container, 'tcom'),
    label: str(container, 'tlbl'),
    composer: str(container, 'tcmp'),
    remixer: str(container, 'trmx'),
    grouping: str(container, 'tgrp'),
    year: str(container, 'ttyr'),
    key: str(container, 'tkey'),
    bpm: bpmStr ? Number(bpmStr) : null,
    durationSec: parseDurationStr(str(container, 'tlen')),
    fileSizeBytes: num(container, 'ufsb'),
    addedAtEpochSec: num(container, 'uadd') ?? (addedFromString ? Number(addedFromString) : null)
  }
}

// Generator, not an array — a real `database V2` runs tens of MB and tens
// of thousands of `otrk` entries; nothing here should hold more than one
// decoded track at a time. The file itself is read into one Buffer (bounded
// by its own size, which comfortably fits in memory even at that scale) —
// the "stream one at a time" property is at the parse level, not the disk-
// read level.
export async function* readSeratoTracks(databaseVPath: string): AsyncIterable<SeratoTrackEntry> {
  const buffer = await readFile(databaseVPath)
  for (const { tag, payload } of readChunks(buffer)) {
    if (tag !== 'otrk') continue // top-level 'vrsn' is the only sibling
    yield decodeTrackEntry(readContainer(payload))
  }
}

export function defaultDatabaseVPath(seratoDir: string): string {
  return join(seratoDir, 'database V2')
}
