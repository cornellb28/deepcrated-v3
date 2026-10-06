import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { readChunks, readContainer } from '../../src/main/serato/chunkReader'
import { readSeratoTracks, defaultDatabaseVPath } from '../../src/main/serato/seratoDatabase'
import { readSubcratesDir } from '../../src/main/serato/seratoCrates'
import { readSessionPlays, listSessionFiles } from '../../src/main/serato/seratoHistory'
import {
  buildDatabaseV2,
  buildCrateFile,
  buildSessionFile,
  chunk,
  stringChunk,
  uint32Chunk,
  utf16be
} from '../helpers/seratoBinary'
import { makeTempDir } from '../helpers/audio'

// Covers the "grab existing serato crates" import readers (commit 6e25b9e):
// chunkReader, seratoDatabase, seratoCrates, seratoHistory.

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-serato-read-')
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

// ── chunkReader ───────────────────────────────────────────────────────────

test("chunk payloads are typed by the tag's first letter", () => {
  const buffer = Buffer.concat([
    stringChunk('tsng', 'Title'),
    stringChunk('pfil', 'Music/Track.mp3'),
    stringChunk('vrsn', '2.0'),
    uint32Chunk('uadd', 1_700_000_000),
    chunk('bmis', Buffer.from([1])),
    chunk('sbav', Buffer.from([0xde, 0xad]))
  ])

  const container = readContainer(buffer)
  expect(container.get('tsng')).toBe('Title')
  expect(container.get('pfil')).toBe('Music/Track.mp3')
  expect(container.get('vrsn')).toBe('2.0')
  expect(container.get('uadd')).toBe(1_700_000_000)
  expect(container.get('bmis')).toBe(true)
  // Undocumented 's' fields stay opaque bytes rather than being guessed at.
  expect(container.get('sbav')).toEqual(Buffer.from([0xde, 0xad]))
})

test('an o-tagged chunk decodes recursively into a nested container', () => {
  const buffer = chunk('otrk', stringChunk('ptrk', 'Music/Nested.mp3'))
  const nested = readContainer(buffer).get('otrk') as Map<string, unknown>
  expect(nested.get('ptrk')).toBe('Music/Nested.mp3')
})

test('a truncated trailing chunk stops the walk instead of throwing', () => {
  const whole = Buffer.concat([stringChunk('tsng', 'Good'), stringChunk('tart', 'Also good')])
  // Lop off the last two bytes so the final chunk's declared length overruns.
  const truncated = whole.subarray(0, whole.length - 2)
  const tags = Array.from(readChunks(truncated)).map((c) => c.tag)
  expect(tags).toEqual(['tsng'])
})

test('a stray byte shorter than a chunk header is ignored', () => {
  const buffer = Buffer.concat([stringChunk('tsng', 'Only'), Buffer.from([0x00, 0x01])])
  expect(Array.from(readChunks(buffer)).map((c) => c.tag)).toEqual(['tsng'])
})

test('an empty buffer yields no chunks', () => {
  expect(Array.from(readChunks(Buffer.alloc(0)))).toEqual([])
})

test('a zero-length payload is a valid chunk, not a terminator', () => {
  const buffer = Buffer.concat([chunk('tsng', Buffer.alloc(0)), stringChunk('tart', 'After')])
  expect(Array.from(readChunks(buffer)).map((c) => c.tag)).toEqual(['tsng', 'tart'])
})

// ── database V2 ───────────────────────────────────────────────────────────

test('every documented database V2 field decodes onto the track entry', async () => {
  const databaseVPath = join(workDir, 'database V2')
  writeFileSync(
    databaseVPath,
    buildDatabaseV2([
      {
        relativePath: 'Music/Track.mp3',
        title: 'Big Momma Thang',
        artist: 'Lil’ Kim',
        album: 'Hard Core',
        genre: 'Hip Hop',
        comment: 'CLASSIC',
        label: 'Undeas',
        composer: 'Composer',
        remixer: 'Remixer',
        grouping: 'Grouping',
        year: '1996',
        key: '11A',
        bpm: '95.70',
        length: '04:22.74',
        fileSizeBytes: 8_446_522,
        addedAtEpochSec: 1_700_000_000
      }
    ])
  )

  const [entry] = await collect(readSeratoTracks(databaseVPath))
  expect(entry).toEqual({
    relativePath: 'Music/Track.mp3',
    title: 'Big Momma Thang',
    artist: 'Lil’ Kim',
    album: 'Hard Core',
    genre: 'Hip Hop',
    comment: 'CLASSIC',
    label: 'Undeas',
    composer: 'Composer',
    remixer: 'Remixer',
    grouping: 'Grouping',
    year: '1996',
    key: '11A',
    bpm: 95.7,
    durationSec: 262.74,
    fileSizeBytes: 8_446_522,
    addedAtEpochSec: 1_700_000_000
  })
})

test('absent optional fields decode as null rather than empty strings', async () => {
  const databaseVPath = join(workDir, 'database V2')
  writeFileSync(databaseVPath, buildDatabaseV2([{ relativePath: 'Music/Bare.mp3' }]))

  const [entry] = await collect(readSeratoTracks(databaseVPath))
  expect(entry.relativePath).toBe('Music/Bare.mp3')
  expect(entry.title).toBeNull()
  expect(entry.artist).toBeNull()
  expect(entry.bpm).toBeNull()
  expect(entry.durationSec).toBeNull()
  expect(entry.fileSizeBytes).toBeNull()
  expect(entry.addedAtEpochSec).toBeNull()
})

test('added-at falls back to parsing the decimal tadd string when uadd is absent', async () => {
  const databaseVPath = join(workDir, 'database V2')
  writeFileSync(
    databaseVPath,
    buildDatabaseV2([
      { relativePath: 'Music/Old.mp3', addedAtEpochSec: 1_650_000_000, addedAtStringOnly: true }
    ])
  )

  const [entry] = await collect(readSeratoTracks(databaseVPath))
  expect(entry.addedAtEpochSec).toBe(1_650_000_000)
})

test('the mm:ss.hh length string becomes seconds with hundredths preserved', async () => {
  const databaseVPath = join(workDir, 'database V2')
  writeFileSync(
    databaseVPath,
    buildDatabaseV2([
      { relativePath: 'a.mp3', length: '00:09.50' },
      { relativePath: 'b.mp3', length: '12:00' },
      { relativePath: 'c.mp3', length: 'not a length' }
    ])
  )

  const entries = await collect(readSeratoTracks(databaseVPath))
  expect(entries.map((e) => e.durationSec)).toEqual([9.5, 720, null])
})

test('the top-level version chunk is not mistaken for a track', async () => {
  const databaseVPath = join(workDir, 'database V2')
  writeFileSync(
    databaseVPath,
    buildDatabaseV2([{ relativePath: 'a.mp3' }, { relativePath: 'b.mp3' }])
  )

  const entries = await collect(readSeratoTracks(databaseVPath))
  expect(entries.map((e) => e.relativePath)).toEqual(['a.mp3', 'b.mp3'])
})

test('defaultDatabaseVPath appends the database file to the _Serato_ directory', () => {
  expect(defaultDatabaseVPath('/Volumes/USB/_Serato_')).toBe('/Volumes/USB/_Serato_/database V2')
})

// ── Subcrates ─────────────────────────────────────────────────────────────

test("crate track order is preserved and Serato's own UI chunks are skipped", async () => {
  const subcrates = join(workDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(
    join(subcrates, 'Warmup.crate'),
    buildCrateFile(['Music/Third.mp3', 'Music/First.mp3', 'Music/Second.mp3'])
  )

  const [crate] = await readSubcratesDir(subcrates)
  expect(crate.nameParts).toEqual(['Warmup'])
  expect(crate.relativePaths).toEqual(['Music/Third.mp3', 'Music/First.mp3', 'Music/Second.mp3'])
})

test('a %%-separated filename becomes an ancestor chain', async () => {
  const subcrates = join(workDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(join(subcrates, 'Hip Hop%%90s%%Boom Bap.crate'), buildCrateFile(['a.mp3']))

  const [crate] = await readSubcratesDir(subcrates)
  expect(crate.nameParts).toEqual(['Hip Hop', '90s', 'Boom Bap'])
})

test('non-crate files in the Subcrates directory are ignored', async () => {
  const subcrates = join(workDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(join(subcrates, 'Real.crate'), buildCrateFile(['a.mp3']))
  writeFileSync(join(subcrates, '.DS_Store'), 'junk')
  writeFileSync(join(subcrates, 'notes.txt'), 'junk')

  const crates = await readSubcratesDir(subcrates)
  expect(crates.map((c) => c.nameParts)).toEqual([['Real']])
})

test('a missing Subcrates directory reads as no crates, not an error', async () => {
  await expect(readSubcratesDir(join(workDir, 'does-not-exist'))).resolves.toEqual([])
})

test('an empty crate file reads as a crate with no tracks', async () => {
  const subcrates = join(workDir, 'Subcrates')
  mkdirSync(subcrates, { recursive: true })
  writeFileSync(join(subcrates, 'Empty.crate'), buildCrateFile([]))

  const [crate] = await readSubcratesDir(subcrates)
  expect(crate.relativePaths).toEqual([])
})

// ── History sessions ──────────────────────────────────────────────────────
// adat uses numeric field ids, not ASCII tags — see seratoHistory.ts.

test('a session decodes its plays with absolute paths and epoch timestamps', async () => {
  const sessionsDir = join(workDir, '_Serato_', 'History', 'Sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '42.session'),
    buildSessionFile([
      {
        absolutePath: '/Volumes/USB/Music/One.mp3',
        title: 'One',
        artist: 'Artist One',
        playedAtEpochSec: 1_700_000_000,
        durationPlayedSec: 210
      },
      {
        absolutePath: '/Users/dj/Music/Two.mp3',
        title: 'Two',
        artist: 'Artist Two',
        playedAtEpochSec: 1_700_000_300
      }
    ])
  )

  const plays = await collect(readSessionPlays(join(sessionsDir, '42.session')))
  expect(plays).toEqual([
    {
      absolutePath: '/Volumes/USB/Music/One.mp3',
      title: 'One',
      artist: 'Artist One',
      playedAtEpochSec: 1_700_000_000,
      durationPlayedSec: 210
    },
    {
      absolutePath: '/Users/dj/Music/Two.mp3',
      title: 'Two',
      artist: 'Artist Two',
      playedAtEpochSec: 1_700_000_300,
      durationPlayedSec: null
    }
  ])
})

test('the null terminator on a session path is stripped', async () => {
  const sessionsDir = join(workDir, '_Serato_', 'History', 'Sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '1.session'),
    buildSessionFile([{ absolutePath: '/Users/dj/Track.mp3', playedAtEpochSec: 1 }])
  )

  const [play] = await collect(readSessionPlays(join(sessionsDir, '1.session')))
  expect(play.absolutePath).toBe('/Users/dj/Track.mp3')
  expect(play.absolutePath).not.toContain('\u0000')
})

test('an entry missing its path or timestamp is skipped, not defaulted', async () => {
  const sessionsDir = join(workDir, '_Serato_', 'History', 'Sessions')
  mkdirSync(sessionsDir, { recursive: true })

  // Field 1 (row) and 6 (title) only — no path, no played-at.
  const rowOnly = Buffer.concat([
    (() => {
      const header = Buffer.allocUnsafe(8)
      header.writeUInt32BE(1, 0)
      header.writeUInt32BE(4, 4)
      return Buffer.concat([header, Buffer.from([0, 0, 0, 1])])
    })(),
    (() => {
      const payload = Buffer.concat([utf16be('Orphan'), Buffer.from([0, 0])])
      const header = Buffer.allocUnsafe(8)
      header.writeUInt32BE(6, 0)
      header.writeUInt32BE(payload.length, 4)
      return Buffer.concat([header, payload])
    })()
  ])
  const good = buildSessionFile([{ absolutePath: '/Users/dj/Good.mp3', playedAtEpochSec: 99 }])
  writeFileSync(
    join(sessionsDir, '1.session'),
    Buffer.concat([good, chunk('oent', chunk('adat', rowOnly))])
  )

  const plays = await collect(readSessionPlays(join(sessionsDir, '1.session')))
  expect(plays.map((p) => p.absolutePath)).toEqual(['/Users/dj/Good.mp3'])
})

test('listSessionFiles takes the _Serato_ dir and finds only .session files', async () => {
  const sessionsDir = join(workDir, '_Serato_', 'History', 'Sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, '1.session'), buildSessionFile([]))
  writeFileSync(join(sessionsDir, '2.SESSION'), buildSessionFile([]))
  writeFileSync(join(sessionsDir, 'notes.txt'), 'junk')

  const files = await listSessionFiles(join(workDir, '_Serato_'))
  expect(files.map((f) => f.split('/').pop()).sort()).toEqual(['1.session', '2.SESSION'].sort())
})

test('a missing History directory reads as no sessions, not an error', async () => {
  await expect(listSessionFiles(join(workDir, 'nope'))).resolves.toEqual([])
})
