import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { readChunks, readContainer } from './chunkReader'

// ── `_Serato_/Subcrates/*.crate` reader ───────────────────────────────────
// Verified against real .crate files: top level is `vrsn`, then Serato's own
// UI config chunks (`osrt` sort order, `ovct` view columns — irrelevant to
// us), then the actual track list as a run of `otrk` chunks, each holding
// exactly one `ptrk` child (a volume-relative path, same convention as our
// own writer in serato.ts's buildCrateBuffer/relativeToVolume). We only ever
// look for `otrk`/`ptrk` — everything else is skipped, never parsed.

export interface SeratoCrateFile {
  // Ancestor names first, this crate's own name last — "Parent%%Child.crate"
  // -> ["Parent", "Child"]. Mirrors buildCrateFileBaseName's own convention
  // in serato.ts, so the two stay symmetric.
  nameParts: string[]
  // Serato's own display order for this crate.
  relativePaths: string[]
}

function crateNameFromFilename(filename: string): string[] {
  return filename.replace(/\.crate$/i, '').split('%%')
}

function extractOrderedPaths(buffer: Buffer): string[] {
  const paths: string[] = []
  for (const { tag, payload } of readChunks(buffer)) {
    if (tag !== 'otrk') continue
    const track = readContainer(payload)
    const ptrk = track.get('ptrk')
    if (typeof ptrk === 'string' && ptrk.length > 0) paths.push(ptrk)
  }
  return paths
}

export async function readSubcratesDir(subcratesDir: string): Promise<SeratoCrateFile[]> {
  let entries: string[]
  try {
    entries = (await readdir(subcratesDir)).filter((f) => f.toLowerCase().endsWith('.crate'))
  } catch {
    return [] // no Subcrates dir — not an error, just nothing to import
  }

  const crates: SeratoCrateFile[] = []
  for (const filename of entries) {
    const buffer = await readFile(join(subcratesDir, filename))
    crates.push({
      nameParts: crateNameFromFilename(filename),
      relativePaths: extractOrderedPaths(buffer)
    })
  }
  return crates
}
