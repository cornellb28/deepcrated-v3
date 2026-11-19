#!/usr/bin/env node
// Plain JavaScript run directly by Node: return types cannot be declared.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// ── Fetch the pinned Chromaprint fpcalc builds ────────────────────────────
// Downloads the official fpcalc release builds listed in
// scripts/fpcalc-<version>.sha256, rejects any whose SHA-256 does not match,
// and places each binary in resources/fpcalc/<platform>-<arch>/ (Node's
// process.platform / process.arch names, which is what the app and
// electron-builder's ${platform}-${arch} use).
//
// The release archives contain only the binary — no licence files — so the
// notices are tracked in the repo instead: resources/licenses/chromaprint/
// (LGPL 2.1 text, Chromaprint's LICENSE.md, and NOTICE.md with the source
// links). Update NOTICE.md when bumping the pinned version.
//
// The binaries are gitignored; this script and the checksum file are not.
// Run it before packaging: `node scripts/fetch-fpcalc.mjs` (all targets) or
// `node scripts/fetch-fpcalc.mjs darwin-arm64` (just one).
//
// No npm dependencies: Node built-ins plus the system `tar` (bsdtar on
// macOS/Windows also reads .zip; on Linux, unzip is used for the zip).

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FPCALC_VERSION = '1.6.1'
const RELEASE_BASE = `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}`

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checksumFile = join(root, 'scripts', `fpcalc-${FPCALC_VERSION}.sha256`)
const outRoot = join(root, 'resources', 'fpcalc')
const noticeFile = join(root, 'resources', 'licenses', 'chromaprint', 'NOTICE.md')

function readPins() {
  return readFileSync(checksumFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [sha256, asset, target] = l.split(/\s+/)
      return { sha256, asset, target }
    })
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function extract(archive, dest) {
  if (archive.endsWith('.zip') && process.platform === 'linux') {
    execFileSync('unzip', ['-q', archive, '-d', dest])
  } else {
    execFileSync('tar', ['-xf', archive, '-C', dest])
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

async function fetchOne({ sha256, asset, target }) {
  const exe = target.startsWith('win32') ? 'fpcalc.exe' : 'fpcalc'
  const url = `${RELEASE_BASE}/${asset}`
  process.stdout.write(`${target}: ${asset} … `)

  const data = await download(url)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== sha256) {
    throw new Error(`checksum mismatch for ${asset}: expected ${sha256}, got ${actual}`)
  }

  const work = mkdtempSync(join(tmpdir(), 'fpcalc-'))
  try {
    const archive = join(work, asset)
    writeFileSync(archive, data)
    const unpacked = join(work, 'x')
    mkdirSync(unpacked)
    extract(archive, unpacked)
    const files = walk(unpacked)

    const binary = files.find((f) => basename(f) === exe)
    if (!binary) throw new Error(`${exe} not found inside ${asset}`)
    const dest = join(outRoot, target)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    copyFileSync(binary, join(dest, exe))
    if (!exe.endsWith('.exe')) chmodSync(join(dest, exe), 0o755)

    // A record of exactly what was fetched, next to the binary.
    writeFileSync(
      join(dest, 'SOURCE.txt'),
      `Chromaprint fpcalc ${FPCALC_VERSION}\n${url}\nsha256 ${sha256}\n`
    )
    console.log('ok')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  const only = process.argv.slice(2)
  const pins = readPins().filter((p) => only.length === 0 || only.includes(p.target))
  if (pins.length === 0) {
    console.error(`No pinned target matches ${only.join(', ')}. See ${checksumFile}.`)
    process.exit(1)
  }
  for (const pin of pins) {
    try {
      await fetchOne(pin)
    } catch (err) {
      console.error(`\nFailed: ${err.message}`)
      console.error(
        `Download it by hand from ${RELEASE_BASE}/${pin.asset}, check its SHA-256 is ` +
          `${pin.sha256}, and put the fpcalc binary in ${join(outRoot, pin.target)}.`
      )
      process.exit(1)
    }
  }
  if (!existsSync(noticeFile) || !readFileSync(noticeFile, 'utf8').includes(FPCALC_VERSION)) {
    console.warn(`Warning: ${noticeFile} does not mention ${FPCALC_VERSION}; update it.`)
  }
}

await main()
