import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { rmSync } from 'fs'
import { join } from 'path'
import { freshAudio, hasFfmpeg, makeTempDir, type AudioExt } from '../helpers/audio'
import { REPO_ROOT, SIDECAR_DIR, SIDECAR_PYTHON, hasSidecarVenv } from '../helpers/paths'

// ISRC and MusicBrainz recording id tags, read by the sidecar (analyze.py)
// from real files in every container format DeepCrated imports.

test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

const ISRC = 'USRC17607839'
const MBID = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const WRITER = join(REPO_ROOT, 'tests', 'helpers', 'write_identity.py')
const ANALYZE = join(SIDECAR_DIR, 'analyze.py')

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('deepcrated-identity-')
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeIdentity(file: string, opts: { isrc?: string; mbid?: string }): void {
  const args = [WRITER, file]
  if (opts.isrc) args.push('--isrc', opts.isrc)
  if (opts.mbid) args.push('--mbid', opts.mbid)
  execFileSync(SIDECAR_PYTHON, args, { stdio: 'pipe' })
}

function fastRead(file: string): {
  isrc: string | null
  musicbrainz_recording_id: string | null
} {
  const out = execFileSync(SIDECAR_PYTHON, [ANALYZE, file, '--fast'], { encoding: 'utf8' })
  return JSON.parse(out)
}

const FORMATS: AudioExt[] = ['mp3', 'flac', 'm4a', 'aiff', 'wav']

for (const ext of FORMATS) {
  test(`${ext}: an ISRC and a MusicBrainz recording id are read from the tags`, () => {
    const file = freshAudio(workDir, ext)
    writeIdentity(file, { isrc: ISRC, mbid: MBID })
    const tags = fastRead(file)
    expect(tags.isrc).toBe(ISRC)
    expect(tags.musicbrainz_recording_id).toBe(MBID)
  })

  test(`${ext}: a file with neither tag reads as null, not an empty string`, () => {
    const tags = fastRead(freshAudio(workDir, ext))
    expect(tags.isrc).toBeNull()
    expect(tags.musicbrainz_recording_id).toBeNull()
  })
}

test('only an ISRC, only a recording id: each is read independently', () => {
  const a = freshAudio(workDir, 'mp3', 'a')
  writeIdentity(a, { isrc: ISRC })
  expect(fastRead(a)).toMatchObject({ isrc: ISRC, musicbrainz_recording_id: null })

  const b = freshAudio(workDir, 'flac', 'b')
  writeIdentity(b, { mbid: MBID })
  expect(fastRead(b)).toMatchObject({ isrc: null, musicbrainz_recording_id: MBID })
})

test('a hyphenated ISRC is passed through raw for main to normalize', () => {
  const file = freshAudio(workDir, 'mp3')
  writeIdentity(file, { isrc: 'US-RC1-76-07839' })
  expect(fastRead(file).isrc).toBe('US-RC1-76-07839')
})

test('the batch mode reads many files in one process, one JSON line each', () => {
  const a = freshAudio(workDir, 'mp3', 'a')
  const b = freshAudio(workDir, 'flac', 'b')
  const c = freshAudio(workDir, 'm4a', 'c')
  writeIdentity(a, { isrc: ISRC })
  writeIdentity(b, { mbid: MBID })
  const missing = join(workDir, 'gone.mp3')

  const out = execFileSync(SIDECAR_PYTHON, [ANALYZE, '--identity-batch'], {
    encoding: 'utf8',
    input: [a, b, c, missing].join('\n') + '\n'
  })
  const lines = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines.map((l) => l.filepath)).toEqual([a, b, c, missing])
  expect(lines[0]).toMatchObject({ ok: true, isrc: ISRC, musicbrainz_recording_id: null })
  expect(lines[1]).toMatchObject({ ok: true, isrc: null, musicbrainz_recording_id: MBID })
  expect(lines[2]).toMatchObject({ ok: true, isrc: null, musicbrainz_recording_id: null })
  expect(lines[3]).toMatchObject({ ok: false, isrc: null, musicbrainz_recording_id: null })
})

test('batch mode copes with unicode paths and blank lines', () => {
  const file = freshAudio(workDir, 'mp3', 'Beyoncé – Déjà Vu')
  writeIdentity(file, { isrc: ISRC })
  const out = execFileSync(SIDECAR_PYTHON, [ANALYZE, '--identity-batch'], {
    encoding: 'utf8',
    input: `\n${file}\n\n`,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  const lines = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ ok: true, isrc: ISRC })
})

test('FLAC: a missing tag early in the list no longer hides the ones after it', () => {
  // Vorbis tags raise on the MP4-style key some lookups end with, which used to
  // abort the whole read the moment a FLAC lacked (say) a genre.
  const file = freshAudio(workDir, 'flac')
  execFileSync(
    SIDECAR_PYTHON,
    [
      '-c',
      `import sys; from mutagen.flac import FLAC; a=FLAC(sys.argv[1]); a['COMPOSER']='Someone'; a.save()`,
      file
    ],
    { stdio: 'pipe' }
  )
  writeIdentity(file, { isrc: ISRC })
  const out = JSON.parse(
    execFileSync(SIDECAR_PYTHON, [ANALYZE, file, '--fast'], { encoding: 'utf8' })
  )
  expect(out.genre).toBeNull()
  expect(out.composer).toBe('Someone')
  expect(out.isrc).toBe(ISRC)
})
