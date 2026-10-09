// Delimiter write-back (Phase 2). Rewrites " / " to " | " in the ARTIST tag of
// the files the dry run classed as delimiter_only — nothing else.
//
//   node scripts/delimiter-writeback.mjs --apply
//
// Never writes to the database. Re-runs the dry run first so the plan is
// always fresh, backs up originals and a tag export into backups/, writes via
// scripts/delimiter-writeback.py (mutagen: artist frame only, tag version and
// all other frames preserved), reads every file back, and reports.
// Splitting code is untouched: " / " stays accepted on read.

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv.includes('--apply')) {
  console.error('Refusing to run without --apply. Run delimiter-dry-run.mjs to preview.')
  process.exit(2)
}
const PY = existsSync(join(ROOT, 'sidecar/.venv/bin/python3'))
  ? join(ROOT, 'sidecar/.venv/bin/python3')
  : 'python3'

// Fresh classification, not a possibly stale report from earlier.
execFileSync('node', [join(ROOT, 'scripts/delimiter-dry-run.mjs')], { stdio: 'inherit' })
const report = JSON.parse(readFileSync(join(ROOT, 'delimiter-dry-run.json'), 'utf8'))
const todo = report.rows.filter((r) => r.status === 'delimiter_only')
const skippedByClass = report.rows.length - todo.length

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupsRoot = join(ROOT, 'backups')
const backupDir = join(backupsRoot, `delimiter-${stamp}-files`)
const backupJson = join(backupsRoot, `delimiter-${stamp}.json`)
mkdirSync(backupsRoot, { recursive: true })

// Disk check: the originals are copied whole.
const needed = todo.reduce((n, r) => n + (existsSync(r.path) ? statfsSizeOf(r.path) : 0), 0)
function statfsSizeOf(p) {
  return execFileSync('stat', ['-f', '%z', p], { encoding: 'utf8' }).trim() * 1
}
const fs = statfsSync(backupsRoot)
if (needed * 2 > fs.bavail * fs.bsize) {
  console.error(`Not enough free disk to back up ${needed} bytes. Aborting before any write.`)
  process.exit(1)
}

const plan = todo.map((r) => ({
  id: r.id,
  path: r.path,
  expected_current: r.current_file_value,
  proposed: r.proposed_value
}))
const planPath = join(backupsRoot, `delimiter-${stamp}-plan.json`)
writeFileSync(planPath, JSON.stringify(plan, null, 2))

const out = execFileSync(PY, [join(ROOT, 'scripts/delimiter-writeback.py'), planPath, backupDir, backupJson], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})
const results = JSON.parse(out)

const count = (s) => results.filter((r) => r.status === s).length
console.log('\nResults')
for (const r of results) console.log(`  [${r.status}] #${r.id} ${r.detail}`)
console.log('\nSummary')
console.log(`  written + verified: ${count('verified')}`)
console.log(`  failed:             ${count('failed')}`)
console.log(`  skipped (changed):  ${count('skipped')}`)
console.log(`  not eligible (other_mismatch/unreadable, left alone): ${skippedByClass}`)
console.log(`Backups: ${backupJson}\n         ${backupDir}`)
process.exit(count('failed') > 0 ? 1 : 0)
