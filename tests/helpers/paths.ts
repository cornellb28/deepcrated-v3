import { existsSync } from 'fs'
import { join, resolve } from 'path'

// tests/helpers -> repo root
export const REPO_ROOT = resolve(__dirname, '..', '..')

export const SIDECAR_DIR = join(REPO_ROOT, 'sidecar')
export const SIDECAR_PYTHON = join(SIDECAR_DIR, '.venv', 'bin', 'python3')
export const EDIT_TAGS_SCRIPT = join(SIDECAR_DIR, 'edit_tags.py')
export const READ_TAGS_SCRIPT = join(REPO_ROOT, 'tests', 'helpers', 'read_tags.py')

export const ELECTRON_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'electron')
export const ESBUILD_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'esbuild')

// The sidecar venv is a developer-machine artifact (gitignored, built by
// sidecar/build.sh) — every spec that spawns Python skips rather than fails
// when it hasn't been created yet, so a fresh clone still runs the rest.
export function hasSidecarVenv(): boolean {
  return existsSync(SIDECAR_PYTHON) && existsSync(EDIT_TAGS_SCRIPT)
}

export function hasElectron(): boolean {
  return existsSync(ELECTRON_BIN) && existsSync(ESBUILD_BIN)
}
