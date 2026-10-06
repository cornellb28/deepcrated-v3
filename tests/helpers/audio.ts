import { execFileSync, execFile } from 'child_process'
import { mkdtempSync, existsSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { SIDECAR_PYTHON, EDIT_TAGS_SCRIPT, READ_TAGS_SCRIPT } from './paths'

const execFileAsync = promisify(execFile)

export type AudioExt = 'mp3' | 'flac' | 'm4a' | 'aiff' | 'wav'

// Every format edit_tags.py claims to support. OGG is deliberately absent:
// SUPPORTED in edit_tags.py excludes it on purpose (see its comment), and
// the unsupported-format spec asserts that rejection separately.
export const ALL_EXTS: AudioExt[] = ['mp3', 'flac', 'm4a', 'aiff', 'wav']

// Serato Autotags are an ID3 GEOB frame, so only the ID3-carrying formats
// can hold one. FLAC and M4A use encodings serato-tools has no writer for
// — edit_tags.py reports those as an explicit serato_error rather than
// pretending it wrote something.
export const SERATO_AUTOTAG_EXTS: AudioExt[] = ['mp3', 'aiff', 'wav']

export function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function makeTempDir(prefix = 'cratecloud-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// A real, decodable 2-second tone — not a zero-byte stub. mutagen refuses to
// add tags to a file it can't parse as audio, so a fake file would make every
// write spec fail for the wrong reason.
export function makeSilentAudio(dir: string, ext: AudioExt, name = 'track'): string {
  const filepath = join(dir, `${name}.${ext}`)
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-ac',
      '2',
      '-ar',
      '44100',
      filepath
    ],
    { stdio: 'ignore' }
  )
  return filepath
}

// Caches one generated file per extension for the whole run and copies it
// per test — ffmpeg costs ~150ms a call, and every spec needs a pristine
// file rather than one a previous assertion already tagged.
const templates = new Map<AudioExt, string>()
let templateDir: string | null = null

export function freshAudio(dir: string, ext: AudioExt, name = 'track'): string {
  if (!templateDir) templateDir = makeTempDir('cratecloud-templates-')
  let template = templates.get(ext)
  if (!template || !existsSync(template)) {
    template = makeSilentAudio(templateDir, ext, `template-${ext}`)
    templates.set(ext, template)
  }
  const filepath = join(dir, `${name}.${ext}`)
  copyFileSync(template, filepath)
  return filepath
}

// ── Talking to the sidecar the way main/sidecar.ts does ───────────────────

export interface EditTagsResult {
  success: boolean
  filepath: string | null
  serato_written?: boolean
  serato_error?: string
  error?: string
  existing?: string
}

export async function editTagsSingle(
  filepath: string,
  meta: Record<string, unknown>,
  options: { noSerato?: boolean } = {}
): Promise<EditTagsResult> {
  const args = [EDIT_TAGS_SCRIPT, filepath, '--meta', JSON.stringify(meta)]
  if (options.noSerato) args.push('--no-serato')
  const { stdout } = await execFileAsync(SIDECAR_PYTHON, args)
  return JSON.parse(stdout.trim()) as EditTagsResult
}

// Mirrors main/sidecar.ts's editTagsBatch: one process for the whole batch,
// NDJSON in, one result line out per item, in order.
export function editTagsBatch(
  items: { filepath: string; meta: Record<string, unknown> }[],
  options: { noSerato?: boolean } = {}
): Promise<EditTagsResult[]> {
  return new Promise((resolve, reject) => {
    const args = [EDIT_TAGS_SCRIPT, '--batch']
    if (options.noSerato) args.push('--no-serato')
    const child = execFile(SIDECAR_PYTHON, args, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(
        stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as EditTagsResult)
      )
    })
    for (const item of items) child.stdin!.write(JSON.stringify(item) + '\n')
    child.stdin!.end()
  })
}

export interface FileTags {
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  year: string | null
  bpm: string | null
  key: string | null
  remixer: string | null
  label: string | null
  grouping: string | null
  composer: string | null
  comment: string | null
  cratecloud_id: string | null
  geob: string[]
}

export async function readFileTags(filepath: string): Promise<FileTags> {
  const { stdout } = await execFileAsync(SIDECAR_PYTHON, [READ_TAGS_SCRIPT, filepath])
  const parsed = JSON.parse(stdout.trim()) as
    { ok: true; tags: FileTags } | { ok: false; error: string }
  if (!parsed.ok) throw new Error(`read_tags.py failed for ${filepath}: ${parsed.error}`)
  return parsed.tags
}
