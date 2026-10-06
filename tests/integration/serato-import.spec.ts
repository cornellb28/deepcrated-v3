import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { makeTempDir } from '../helpers/audio'
import { hasElectron } from '../helpers/paths'
import { buildDatabaseV2, buildCrateFile, buildSessionFile } from '../helpers/seratoBinary'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Covers seratoImport.ts — the "grab existing serato crates" orchestrator
// (commit 6e25b9e), driven against the real db.ts inside a headless main
// process. Deliberately builds its own `_Serato_` folder rather than
// reading the developer's: the assertions below are about what the
// importer does with known input, not about one machine's library.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let seratoDir: string
let musicDir: string
let probe: ProbeSession

test.beforeEach(() => {
  // realpath so /var/... and /private/var/... cannot disagree when
  // isPathUnder compares the import root against a resolved Serato path.
  workDir = realpathSync(makeTempDir('cratecloud-serato-import-'))
  seratoDir = join(workDir, '_Serato_')
  musicDir = join(workDir, 'Music')
  mkdirSync(join(seratoDir, 'Subcrates'), { recursive: true })
  mkdirSync(join(seratoDir, 'History', 'Sessions'), { recursive: true })
  mkdirSync(musicDir, { recursive: true })
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

// The temp dir lives on the boot volume, so Serato's volume-relative paths
// are the absolute path with its leading slash removed — exactly what
// serato.ts's relativeToVolume produces for a boot-volume track.
function volumeRelative(absolutePath: string): string {
  return absolutePath.replace(/^\/+/, '')
}

function trackPath(name: string): string {
  return join(musicDir, name)
}

function bootVolumeLocation(): {
  seratoDir: string
  volume: { root: string; isBootVolume: boolean }
} {
  return { seratoDir, volume: { root: '/', isBootVolume: true } }
}

function seedTrack(filepath: string, overrides: Record<string, unknown> = {}): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [{ filepath, filename: filepath.split('/').pop(), title: '', artist: '', ...overrides }]
  }
}

// ── Detection ─────────────────────────────────────────────────────────────

test('a folder with a Serato library next to it is detected', async () => {
  writeFileSync(join(seratoDir, 'database V2'), buildDatabaseV2([]))
  const [location] = await run<{ seratoDir: string } | null>([
    { fn: 'detectSeratoLibrary', args: [musicDir, seratoDir] }
  ])
  expect(location?.seratoDir).toBe(seratoDir)
})

test('detection returns null when there is no database V2, and creates nothing', async () => {
  const emptyDir = join(workDir, 'no-serato-here')
  const [location] = await run<unknown>([{ fn: 'detectSeratoLibrary', args: [musicDir, emptyDir] }])
  expect(location).toBeNull()
  // detectSeratoLibrary must stay read-only — the writer's mkdir is exactly
  // what it is not allowed to do.
  expect(() => rmSync(emptyDir, { recursive: true })).toThrow()
})

// ── database V2 field fill ────────────────────────────────────────────────

test('Serato fills fields CrateCloud has left empty', async () => {
  const filepath = trackPath('One.mp3')
  writeFileSync(
    join(seratoDir, 'database V2'),
    buildDatabaseV2([
      {
        relativePath: volumeRelative(filepath),
        title: 'Serato Title',
        artist: 'Serato Artist',
        album: 'Serato Album',
        genre: 'Serato Genre',
        bpm: '95.70',
        length: '04:22.74'
      }
    ])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])
  const rootId = rootResult.lastInsertRowid

  const [, tally, row] = await run<Record<string, unknown>>([
    seedTrack(filepath),
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootId, []] },
    { fn: 'getTrackByFilepath', args: [filepath] }
  ])

  expect((tally as Record<string, unknown>).dbEntriesMatched).toBe(1)
  expect(row.title).toBe('Serato Title')
  expect(row.artist).toBe('Serato Artist')
  expect(row.album).toBe('Serato Album')
  expect(row.bpm).toBe(95.7)
  expect(row.duration_sec).toBe(262.74)
})

test('Serato never overwrites a field CrateCloud already has', async () => {
  const filepath = trackPath('One.mp3')
  writeFileSync(
    join(seratoDir, 'database V2'),
    buildDatabaseV2([
      { relativePath: volumeRelative(filepath), title: 'Serato Title', artist: 'Serato Artist' }
    ])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])

  const [, , row] = await run<Record<string, unknown>>([
    seedTrack(filepath, { title: 'Mine', artist: '' }),
    {
      fn: 'seratoImport',
      args: [bootVolumeLocation(), musicDir, rootResult.lastInsertRowid, []]
    },
    { fn: 'getTrackByFilepath', args: [filepath] }
  ])

  expect(row.title).toBe('Mine')
  expect(row.artist).toBe('Serato Artist')
})

test('Serato entries outside the imported folder are ignored', async () => {
  const inside = trackPath('Inside.mp3')
  writeFileSync(
    join(seratoDir, 'database V2'),
    buildDatabaseV2([
      { relativePath: volumeRelative(inside), title: 'Inside Title' },
      {
        relativePath: volumeRelative(join(workDir, 'Elsewhere', 'Outside.mp3')),
        title: 'Outside Title'
      }
    ])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])

  const [, , tally] = await run<Record<string, unknown>>([
    seedTrack(inside),
    seedTrack(join(workDir, 'Elsewhere', 'Outside.mp3')),
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootResult.lastInsertRowid, []] }
  ])

  expect(tally.dbEntriesRead).toBe(2)
  expect(tally.dbEntriesMatched).toBe(1)
})

// ── Crates ────────────────────────────────────────────────────────────────

test('a nested Serato crate becomes a real parent chain with its order kept', async () => {
  const first = trackPath('First.mp3')
  const second = trackPath('Second.mp3')
  const third = trackPath('Third.mp3')
  writeFileSync(join(seratoDir, 'database V2'), buildDatabaseV2([]))
  writeFileSync(
    join(seratoDir, 'Subcrates', 'Hip Hop%%90s.crate'),
    buildCrateFile([third, first, second].map(volumeRelative))
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])

  const [, , , tally, crates] = await run<Record<string, unknown>>([
    seedTrack(first),
    seedTrack(second),
    seedTrack(third),
    {
      fn: 'seratoImport',
      args: [bootVolumeLocation(), musicDir, rootResult.lastInsertRowid, []]
    },
    { fn: 'getAllCrates' }
  ])

  expect((tally as Record<string, unknown>).cratesCreated).toBe(2)
  const list = crates as unknown as { id: number; name: string; parent_crate_id: number | null }[]
  const parent = list.find((c) => c.name === 'Hip Hop')!
  const child = list.find((c) => c.name === '90s')!
  expect(parent.parent_crate_id).toBeNull()
  expect(child.parent_crate_id).toBe(parent.id)

  const [crateTracks] = await run<{ filepath: string }[]>([
    { fn: 'getCrateTracks', args: [child.id] }
  ])
  expect((crateTracks as unknown as { filepath: string }[]).map((t) => t.filepath)).toEqual([
    third,
    first,
    second
  ])
})

test('re-running the import reuses crates instead of duplicating them', async () => {
  const filepath = trackPath('One.mp3')
  writeFileSync(join(seratoDir, 'database V2'), buildDatabaseV2([]))
  writeFileSync(
    join(seratoDir, 'Subcrates', 'Warmup.crate'),
    buildCrateFile([volumeRelative(filepath)])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])
  const rootId = rootResult.lastInsertRowid

  await run([
    seedTrack(filepath),
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootId, []] }
  ])
  const [, crates] = await run<unknown>([
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootId, []] },
    { fn: 'getAllCrates' }
  ])

  expect((crates as { name: string }[]).filter((c) => c.name === 'Warmup')).toHaveLength(1)
})

test('crate paths with no matching track are counted and sampled, not dropped silently', async () => {
  writeFileSync(join(seratoDir, 'database V2'), buildDatabaseV2([]))
  const known = trackPath('Known.mp3')
  const unknown = trackPath('Never Imported.mp3')
  writeFileSync(
    join(seratoDir, 'Subcrates', 'Mixed.crate'),
    buildCrateFile([known, unknown].map(volumeRelative))
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])

  const [, tally] = await run<Record<string, unknown>>([
    seedTrack(known),
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootResult.lastInsertRowid, []] }
  ])

  expect(tally.crateTracksLinked).toBe(1)
  expect(tally.crateUnresolvedPaths).toBe(1)
  expect(tally.unresolvedPathSamples).toContain(unknown)
})

// ── History ───────────────────────────────────────────────────────────────

test('session plays import once and re-importing does not duplicate them', async () => {
  const filepath = trackPath('Played.mp3')
  writeFileSync(join(seratoDir, 'database V2'), buildDatabaseV2([]))
  writeFileSync(
    join(seratoDir, 'History', 'Sessions', '1.session'),
    buildSessionFile([
      {
        absolutePath: filepath,
        title: 'Played',
        playedAtEpochSec: 1_700_000_000,
        durationPlayedSec: 210
      },
      {
        absolutePath: filepath,
        title: 'Played',
        playedAtEpochSec: 1_700_000_600,
        durationPlayedSec: 180
      }
    ])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])
  const rootId = rootResult.lastInsertRowid

  const [, first] = await run<Record<string, unknown>>([
    seedTrack(filepath),
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootId, []] }
  ])
  expect(first.playsImported).toBe(2)

  const [second] = await run<Record<string, unknown>>([
    { fn: 'seratoImport', args: [bootVolumeLocation(), musicDir, rootId, []] }
  ])
  expect(second.playsImported).toBe(0)
})

// ── added_at ──────────────────────────────────────────────────────────────

test("Serato's added date is applied only to tracks this import just inserted", async () => {
  const fresh = trackPath('Fresh.mp3')
  const older = trackPath('Older.mp3')
  writeFileSync(
    join(seratoDir, 'database V2'),
    buildDatabaseV2([
      { relativePath: volumeRelative(fresh), addedAtEpochSec: 1_600_000_000 },
      { relativePath: volumeRelative(older), addedAtEpochSec: 1_600_000_000 }
    ])
  )

  const [rootResult] = await run<{ lastInsertRowid: number }>([
    { fn: 'addRoot', args: ['Test Root', musicDir] }
  ])

  const [freshInsert, , , freshRow, olderRow] = await run<Record<string, unknown>>([
    seedTrack(fresh),
    seedTrack(older),
    {
      fn: 'seratoImport',
      args: [bootVolumeLocation(), musicDir, rootResult.lastInsertRowid, [1]]
    },
    { fn: 'getTrackByFilepath', args: [fresh] },
    { fn: 'getTrackByFilepath', args: [older] }
  ])

  expect((freshInsert as Record<string, unknown>).lastInsertRowid).toBe(1)
  expect(String(freshRow.added_at)).toContain('2020-09-13')
  expect(String(olderRow.added_at)).not.toContain('2020-09-13')
})
