#!/usr/bin/env node
// Plain JavaScript run directly by Node: return types cannot be declared.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// ── Publish a macOS release to Backblaze B2 ───────────────────────────────
// Uploads the built DMG(s) to the public releases bucket, then writes
// mac/latest.json LAST, so the website never points at a file that is not
// there yet:
//
//   mac/DeepCrated-{version}-{arch}.dmg      one per arch found in --dir
//   mac/latest.json                          { version, files, released_at, notes }
//
// It refuses to overwrite: if any DMG for this version already exists in
// the bucket, nothing is uploaded. Bump the version instead.
//
// Credentials: read from .env.release (gitignored), or from the shell when
// a variable is already set there (the shell wins). Never from .env or
// .env.local — the script refuses to run if either holds a B2_ line, or if
// .env.release is not gitignored. Key values are never printed.
//
//   node scripts/publish-release.mjs --dir <electron-builder output dir>
//        [--notes "text" | --notes-file path] [--dry-run]
//
// This bucket is public and separate from the private audio buckets: it
// only ever receives the DMGs and latest.json. B2 keys never go into the
// app or any build (electron-vite only inlines MAIN_VITE_*-style names).

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VARS = [
  'B2_RELEASES_KEY_ID',
  'B2_RELEASES_KEY',
  'B2_RELEASES_BUCKET',
  'B2_ENDPOINT',
  'B2_REGION'
]
const PREFIX = 'mac/'
const LATEST_KEY = `${PREFIX}latest.json`
const PRODUCT = 'DeepCrated'
const ARCHES = ['arm64', 'x64', 'universal']

function fail(message) {
  console.error(`\npublish-release: ${message}`)
  process.exit(1)
}

// ── arguments ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dir: null, notes: null, notesFile: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--dir') args.dir = argv[++i]
    else if (a === '--notes') args.notes = argv[++i]
    else if (a === '--notes-file') args.notesFile = argv[++i]
    else fail(`unknown argument "${a}"`)
  }
  if (!args.dir) fail('--dir <electron-builder output folder> is required')
  if (args.notes !== null && args.notesFile !== null) fail('use --notes or --notes-file, not both')
  return args
}

// ── safety checks on where credentials can live ───────────────────────────

function checkSecretsPlacement() {
  for (const name of ['.env', '.env.local']) {
    const path = join(root, name)
    if (existsSync(path) && /^\s*(export\s+)?B2_/m.test(readFileSync(path, 'utf8'))) {
      fail(`${name} contains a B2_ variable. Move it to .env.release and remove it from ${name}.`)
    }
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '.env.release'], { cwd: root, stdio: 'ignore' })
  } catch {
    fail('.env.release is not gitignored. Add it to .gitignore before publishing.')
  }
}

// Minimal KEY=VALUE reader for .env.release: comments and blank lines are
// skipped, optional quotes stripped. Values stay in memory only.
function readEnvRelease() {
  const path = join(root, '.env.release')
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function loadConfig() {
  const file = readEnvRelease()
  const config = {}
  const sources = {}
  for (const name of VARS) {
    if (process.env[name]) {
      config[name] = process.env[name]
      sources[name] = 'shell'
    } else if (file[name]) {
      config[name] = file[name]
      sources[name] = '.env.release'
    }
  }
  const missing = VARS.filter((v) => !config[v])
  return { config, sources, missing }
}

// ── the files ─────────────────────────────────────────────────────────────

function sha256Of(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function findDmgs(dir, version) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--dir ${dir} is not a folder`)
  const pattern = new RegExp(
    `^${PRODUCT}-${version.replace(/\./g, '\\.')}-(${ARCHES.join('|')})\\.dmg$`
  )
  const found = []
  for (const name of readdirSync(dir).sort()) {
    const m = pattern.exec(name)
    if (!m) continue
    const path = join(dir, name)
    found.push({
      arch: m[1],
      name,
      path,
      key: `${PREFIX}${name}`,
      size: statSync(path).size,
      sha256: await sha256Of(path)
    })
  }
  if (found.length === 0) fail(`no ${PRODUCT}-${version}-<arch>.dmg in ${dir}`)
  return found
}

// ── bucket ────────────────────────────────────────────────────────────────

function makeClient(config) {
  return new S3Client({
    endpoint: config.B2_ENDPOINT,
    region: config.B2_REGION,
    credentials: {
      accessKeyId: config.B2_RELEASES_KEY_ID,
      secretAccessKey: config.B2_RELEASES_KEY
    },
    // B2's S3 API does not accept the SDK's newer default checksum headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

// null when the object does not exist; its size and metadata when it does.
async function head(client, bucket, key) {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { size: res.ContentLength, metadata: res.Metadata ?? {} }
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null
    throw new Error(`could not check ${key} (${err?.$metadata?.httpStatusCode ?? err?.name})`)
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const notes = args.notesFile ? readFileSync(resolve(args.notesFile), 'utf8').trim() : args.notes

  checkSecretsPlacement()
  const { config, sources, missing } = loadConfig()
  const dmgs = await findDmgs(resolve(args.dir), version)

  console.log(
    `${args.dryRun ? 'DRY RUN — nothing will be uploaded' : 'Publishing'} ${PRODUCT} ${version}`
  )
  console.log(`  bucket:   ${config.B2_RELEASES_BUCKET ?? '(not set)'}`)
  console.log(`  endpoint: ${config.B2_ENDPOINT ?? '(not set)'}`)
  console.log(`  region:   ${config.B2_REGION ?? '(not set)'}`)
  const keyState = (v) => (config[v] ? `set (${sources[v]})` : 'not set')
  console.log(`  key id:   ${keyState('B2_RELEASES_KEY_ID')}; key: ${keyState('B2_RELEASES_KEY')}`)
  console.log('')
  for (const d of dmgs) {
    console.log(`  ${d.path}`)
    console.log(
      `    -> ${d.key}  (${d.arch}, ${d.size.toLocaleString()} bytes, sha256 ${d.sha256})`
    )
  }

  const latest = {
    version,
    files: dmgs.map(({ arch, name, sha256, size }) => ({ arch, name, sha256, size })),
    released_at: new Date().toISOString(),
    notes: notes ?? null
  }
  console.log(`    then ${LATEST_KEY} (written last):`)
  console.log(
    JSON.stringify(latest, null, 2)
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n')
  )
  console.log('')

  if (missing.length > 0) {
    if (args.dryRun) {
      console.log(`Not checked against the bucket: missing ${missing.join(', ')}.`)
      console.log('Put them in .env.release (gitignored) to also check for existing files.')
      return
    }
    fail(`missing ${missing.join(', ')} (set them in .env.release or the shell)`)
  }

  const client = makeClient(config)
  const bucket = config.B2_RELEASES_BUCKET

  // Refuse to overwrite: check every DMG key before uploading any.
  const existing = []
  for (const d of dmgs) if (await head(client, bucket, d.key)) existing.push(d.key)
  if (existing.length > 0) {
    fail(`already in ${bucket}: ${existing.join(', ')}. Nothing uploaded; bump the version.`)
  }
  console.log(`Checked ${bucket}: no file for ${version} exists yet.`)
  if (args.dryRun) return

  for (const d of dmgs) {
    console.log(`Uploading ${d.key} …`)
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: d.key,
        Body: createReadStream(d.path),
        ContentLength: d.size,
        ContentType: 'application/x-apple-diskimage',
        ContentDisposition: `attachment; filename="${basename(d.key)}"`,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { sha256: d.sha256 }
      })
    )
    const after = await head(client, bucket, d.key)
    if (!after || after.size !== d.size || after.metadata.sha256 !== d.sha256) {
      fail(
        `${d.key} did not verify after upload (size ${after?.size ?? 'missing'}). latest.json NOT written.`
      )
    }
    console.log(`  verified ${d.key}: ${after.size.toLocaleString()} bytes`)
  }

  // Last: only now does the website see the new version.
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: LATEST_KEY,
      Body: JSON.stringify(latest, null, 2) + '\n',
      ContentType: 'application/json',
      CacheControl: 'public, max-age=60'
    })
  )
  console.log(`Wrote ${LATEST_KEY} for ${version}. Done.`)
}

main().catch((err) => fail(err?.message ?? String(err)))
