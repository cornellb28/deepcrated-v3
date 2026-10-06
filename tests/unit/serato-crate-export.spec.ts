import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  buildCrateBuffer,
  buildCrateFileBaseName,
  getVolumeInfo,
  exportCrateToSerato
} from '../../src/main/serato'
import { readSubcratesDir } from '../../src/main/serato/seratoCrates'
import { makeTempDir } from '../helpers/audio'

// Covers the "export serato crates" feature (commits 44d96bf, 6e25b9e).

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-crate-')
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// ── Volume detection ──────────────────────────────────────────────────────

test('a path under /Volumes resolves to that mount as a non-boot volume', () => {
  expect(getVolumeInfo('/Volumes/MUSICLITE/House/Track.mp3')).toEqual({
    root: '/Volumes/MUSICLITE',
    isBootVolume: false
  })
})

test('a volume name containing spaces is kept whole', () => {
  expect(getVolumeInfo('/Volumes/DJ Backup Drive/Track.mp3').root).toBe('/Volumes/DJ Backup Drive')
})

test('a path outside /Volumes resolves to the boot volume', () => {
  expect(getVolumeInfo('/Users/dj/Music/Track.mp3')).toEqual({ root: '/', isBootVolume: true })
})

// ── Crate file naming ─────────────────────────────────────────────────────

test("a nested crate joins its ancestors with Serato's %% separator", () => {
  expect(buildCrateFileBaseName(['Hip Hop', '90s'], 'Boom Bap')).toBe('Hip Hop%%90s%%Boom Bap')
})

test('a top-level crate has no separator', () => {
  expect(buildCrateFileBaseName([], 'Warmup')).toBe('Warmup')
})

test('a percent sign in a crate name is stripped so it cannot fake a nesting level', () => {
  // "100% Bangers" must not read back as a child crate "Bangers" under "100".
  const baseName = buildCrateFileBaseName([], '100% Bangers')
  expect(baseName).not.toContain('%')
  expect(baseName.split('%%')).toHaveLength(1)
})

test('path separators and reserved characters are replaced, not dropped', () => {
  expect(buildCrateFileBaseName([], 'AC/DC: Live?')).toBe('AC_DC_ Live_')
})

test('a blank name falls back to Untitled rather than producing a dotfile', () => {
  expect(buildCrateFileBaseName([], '   ')).toBe('Untitled')
  expect(buildCrateFileBaseName([], '')).toBe('Untitled')
})

test('a name of only illegal characters becomes underscores, not Untitled', () => {
  // Documents the actual rule: replacement happens first, and the Untitled
  // fallback only fires when nothing is left after trimming.
  expect(buildCrateFileBaseName([], '///')).toBe('___')
})

// ── Binary crate buffer ───────────────────────────────────────────────────

test('a crate buffer starts with the version chunk Serato expects', () => {
  const buffer = buildCrateBuffer(['Music/A.mp3'])
  expect(buffer.toString('ascii', 0, 4)).toBe('vrsn')
  const versionLength = buffer.readUInt32BE(4)
  const version = buffer
    .subarray(8, 8 + versionLength)
    .swap16()
    .toString('utf16le')
  expect(version).toBe('1.0/Serato ScratchLive Crate')
})

test('every track becomes one otrk chunk wrapping one ptrk chunk', () => {
  const buffer = buildCrateBuffer(['Music/A.mp3', 'Music/B.mp3', 'Music/C.mp3'])
  let offset = 0
  const tags: string[] = []
  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32BE(offset + 4)
    tags.push(tag)
    offset += 8 + length
  }
  expect(tags).toEqual(['vrsn', 'otrk', 'otrk', 'otrk'])
})

test('an empty crate is a valid file with only a version chunk', () => {
  const buffer = buildCrateBuffer([])
  expect(buffer.toString('ascii', 0, 4)).toBe('vrsn')
  expect(buffer.length).toBe(8 + buffer.readUInt32BE(4))
})

test('non-ASCII track paths survive the UTF-16BE encoding', async () => {
  // A real library is full of these — JAŸ-Z, Beyoncé, Björk.
  const relativePath = 'Music/Lil’ Kim, JAŸ-Z — Big Momma Thang.m4a'
  const subcrates = join(workDir, '_Serato_', 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(join(subcrates, 'Unicode.crate'), buildCrateBuffer([relativePath]))

  const [crate] = await readSubcratesDir(subcrates)
  expect(crate.relativePaths).toEqual([relativePath])
})

// ── Export, read back through the importer ────────────────────────────────
// The writer and the reader are separate modules that have to agree; a
// round-trip is the only assertion that actually pins that down.

test('an exported crate reads back with its track order intact', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const tracks = ['Music/Third.mp3', 'Music/First.mp3', 'Music/Second.mp3'].map((path, index) => ({
    id: index + 1,
    filepath: `/${path}`,
    missing: false
  }))

  const outcome = await exportCrateToSerato(
    { id: 7, fileBaseName: 'Set%%Openers', tracks },
    { libraryOverridePath: seratoDir, overwriteExisting: true }
  )

  expect(outcome.error).toBeUndefined()
  expect(outcome.paths).toEqual([join(seratoDir, 'Subcrates', 'Set%%Openers.crate')])

  const [crate] = await readSubcratesDir(join(seratoDir, 'Subcrates'))
  expect(crate.nameParts).toEqual(['Set', 'Openers'])
  expect(crate.relativePaths).toEqual(['Music/Third.mp3', 'Music/First.mp3', 'Music/Second.mp3'])
})

test('boot-volume paths are stored relative to the volume root, with no leading slash', async () => {
  const seratoDir = join(workDir, '_Serato_')
  await exportCrateToSerato(
    {
      id: 1,
      fileBaseName: 'Boot',
      tracks: [{ id: 1, filepath: '/Users/dj/Music/Song.mp3', missing: false }]
    },
    { libraryOverridePath: seratoDir, overwriteExisting: true }
  )

  const [crate] = await readSubcratesDir(join(seratoDir, 'Subcrates'))
  expect(crate.relativePaths).toEqual(['Users/dj/Music/Song.mp3'])
})

test('missing tracks are skipped and counted, not written into the crate', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const outcome = await exportCrateToSerato(
    {
      id: 1,
      fileBaseName: 'Partial',
      tracks: [
        { id: 1, filepath: '/Users/dj/Here.mp3', missing: false },
        { id: 2, filepath: '/Users/dj/Gone.mp3', missing: true }
      ]
    },
    { libraryOverridePath: seratoDir, overwriteExisting: true }
  )

  expect(outcome.missingSkipped).toBe(1)
  const [crate] = await readSubcratesDir(join(seratoDir, 'Subcrates'))
  expect(crate.relativePaths).toEqual(['Users/dj/Here.mp3'])
})

test('a crate whose tracks are all missing writes no file and is not an error', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const outcome = await exportCrateToSerato(
    {
      id: 1,
      fileBaseName: 'AllGone',
      tracks: [{ id: 1, filepath: '/Users/dj/Gone.mp3', missing: true }]
    },
    { libraryOverridePath: seratoDir, overwriteExisting: true }
  )

  expect(outcome.error).toBeUndefined()
  expect(outcome.paths).toEqual([])
  expect(outcome.missingSkipped).toBe(1)
})

test('with overwrite off, an existing crate file is left untouched and a suffixed copy is written', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const subcrates = join(seratoDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  const existingPath = join(subcrates, 'Mine.crate')
  writeFileSync(existingPath, 'SERATO ORIGINAL — MUST NOT BE CLOBBERED')

  const outcome = await exportCrateToSerato(
    {
      id: 1,
      fileBaseName: 'Mine',
      tracks: [{ id: 1, filepath: '/Users/dj/Song.mp3', missing: false }]
    },
    { libraryOverridePath: seratoDir, overwriteExisting: false }
  )

  expect(outcome.paths).toEqual([join(subcrates, 'Mine (CrateCloud).crate')])
  expect(readFileSync(existingPath, 'utf8')).toBe('SERATO ORIGINAL — MUST NOT BE CLOBBERED')
})

test('with overwrite on, the existing crate file is replaced in place', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const subcrates = join(seratoDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(join(subcrates, 'Mine.crate'), 'STALE')

  const outcome = await exportCrateToSerato(
    {
      id: 1,
      fileBaseName: 'Mine',
      tracks: [{ id: 1, filepath: '/Users/dj/Song.mp3', missing: false }]
    },
    { libraryOverridePath: seratoDir, overwriteExisting: true }
  )

  expect(outcome.paths).toEqual([join(subcrates, 'Mine.crate')])
  const [crate] = await readSubcratesDir(subcrates)
  expect(crate.relativePaths).toEqual(['Users/dj/Song.mp3'])
})
