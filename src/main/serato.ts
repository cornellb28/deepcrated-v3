import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

// ── Binary .crate writer ──────────────────────────────────────────────────
// Ported verbatim from v2 (src/main/index.ts's buildSeratoCrate) — the tag
// format itself (4-byte ASCII tag + 4-byte BE length + data, UTF-16BE
// strings, 'vrsn'/'otrk'/'ptrk') was already correct and Serato reads it
// fine. Everything else in this file (volume grouping, relative paths,
// Subcrates lookup, running-check, missing/overwrite handling) is new — v2
// wrote one absolute-path file into a hardcoded, dev-machine-specific
// "Crates" folder with none of that.

function toUtf16BE(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le')
  const be = Buffer.allocUnsafe(le.length)
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]
    be[i + 1] = le[i]
  }
  return be
}

function field(tag: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([Buffer.from(tag, 'ascii'), len, data])
}

// relativePaths must already be relative to the volume that owns the
// Subcrates folder this buffer gets written into — see relativeToVolume.
export function buildCrateBuffer(relativePaths: string[]): Buffer {
  const chunks: Buffer[] = [field('vrsn', toUtf16BE('1.0/Serato ScratchLive Crate'))]
  for (const p of relativePaths) {
    chunks.push(field('otrk', field('ptrk', toUtf16BE(p))))
  }
  return Buffer.concat(chunks)
}

// ── Volume detection ──────────────────────────────────────────────────────
// TODO: Windows drive-letter volumes (D:\, E:\, ...) — this only handles the
// macOS /Volumes/<name> mount convention plus the boot volume. Deferred
// since the real-hardware verification pass (per the build spec) is on a
// Mac; a Windows build would need an equivalent here before Serato export
// works there.

export interface VolumeInfo {
  root: string
  isBootVolume: boolean
}

export function getVolumeInfo(filepath: string): VolumeInfo {
  const match = filepath.match(/^\/Volumes\/([^/]+)/)
  if (match) return { root: `/Volumes/${match[1]}`, isBootVolume: false }
  return { root: '/', isBootVolume: true }
}

// Real Serato behavior: ptrk stores the path relative to the root of
// whichever volume owns the _Serato_ folder it lives in — not the absolute
// path, and not relative to the _Serato_ folder itself. A boot-volume track
// at /Users/dj/Music/Artist/Song.mp3 is stored as "Users/dj/Music/Artist/
// Song.mp3"; a track at /Volumes/USB/Music/Song.mp3 is stored relative to
// /Volumes/USB, i.e. "Music/Song.mp3".
function relativeToVolume(filepath: string, volume: VolumeInfo): string {
  return volume.isBootVolume ? filepath.replace(/^\/+/, '') : filepath.slice(volume.root.length + 1)
}

interface VolumeGroup {
  volume: VolumeInfo
  relativePaths: string[]
}

function groupByVolume(tracks: { filepath: string }[]): VolumeGroup[] {
  const byRoot = new Map<string, VolumeGroup>()
  for (const t of tracks) {
    const volume = getVolumeInfo(t.filepath)
    let group = byRoot.get(volume.root)
    if (!group) {
      group = { volume, relativePaths: [] }
      byRoot.set(volume.root, group)
    }
    group.relativePaths.push(relativeToVolume(t.filepath, volume))
  }
  return Array.from(byRoot.values())
}

// ── Locating _Serato_/Subcrates ───────────────────────────────────────────
// libraryOverridePath only applies to the boot volume — an external drive's
// Serato library always lives at that drive's own root; the override exists
// for DJs who keep their *primary* _Serato_ folder somewhere other than
// ~/Music (v2 had no concept of this at all — it guessed from a short list
// of hardcoded dev-machine paths).

async function findSubcratesDir(
  volume: VolumeInfo,
  libraryOverridePath: string | null
): Promise<string> {
  const seratoDir =
    volume.isBootVolume && libraryOverridePath
      ? libraryOverridePath
      : volume.isBootVolume
        ? join(homedir(), 'Music', '_Serato_')
        : join(volume.root, '_Serato_')
  const subcratesDir = join(seratoDir, 'Subcrates')
  await mkdir(subcratesDir, { recursive: true })
  return subcratesDir
}

// ── Naming ─────────────────────────────────────────────────────────────────
// Nested crates use Serato's "Parent%%Child" flat-file convention — '%' is
// stripped from user-entered names so it can't be mistaken for that
// separator (v2's sanitizeCrateName tried this too, via a redundant
// character-class entry that had no actual effect beyond stripping '%' once).

function sanitizeCrateNamePart(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|%]/g, '_').trim()
  return cleaned || 'Untitled'
}

export function buildCrateFileBaseName(ancestorNames: string[], name: string): string {
  return [...ancestorNames, name].map(sanitizeCrateNamePart).join('%%')
}

async function resolveOutputPath(
  dir: string,
  baseName: string,
  overwriteExisting: boolean
): Promise<string> {
  const primary = join(dir, `${baseName}.crate`)
  if (overwriteExisting || !existsSync(primary)) return primary
  return join(dir, `${baseName} (CrateCloud).crate`)
}

// ── Is Serato running? ────────────────────────────────────────────────────
// v2 had no equivalent check at all. Best-effort: if the check itself fails
// for any reason, don't let that block export — treat it as "not running."

const execFileAsync = promisify(execFile)

export async function isSeratoRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false // TODO: Windows process check
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='])
    return stdout.split('\n').some((line) => line.includes('Serato'))
  } catch {
    return false
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

export interface CrateExportInput {
  id: number
  fileBaseName: string
  tracks: { id: number; filepath: string; missing: boolean }[] // in crate order
}

export interface CrateExportSettings {
  libraryOverridePath: string | null
  overwriteExisting: boolean
}

export interface CrateExportOutcome {
  crateId: number
  paths: string[]
  missingSkipped: number
  error?: string
}

// One crate in, one .crate file per volume its (present) tracks span. A
// crate with no tracks on any volume (all missing, or empty) writes nothing
// and reports 0 paths — not an error.
export async function exportCrateToSerato(
  input: CrateExportInput,
  settings: CrateExportSettings
): Promise<CrateExportOutcome> {
  const present = input.tracks.filter((t) => !t.missing)
  const missingSkipped = input.tracks.length - present.length
  try {
    const groups = groupByVolume(present)
    const paths: string[] = []
    for (const group of groups) {
      const subcratesDir = await findSubcratesDir(group.volume, settings.libraryOverridePath)
      const outPath = await resolveOutputPath(
        subcratesDir,
        input.fileBaseName,
        settings.overwriteExisting
      )
      await writeFile(outPath, buildCrateBuffer(group.relativePaths))
      paths.push(outPath)
    }
    return { crateId: input.id, paths, missingSkipped }
  } catch (err) {
    return { crateId: input.id, paths: [], missingSkipped, error: (err as Error).message }
  }
}
