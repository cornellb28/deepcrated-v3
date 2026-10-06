# CrateCloud tests

```bash
npm test              # unit + integration (the default suite)
npm run test:unit     # pure Node, no Electron, no Python — always runnable
npm run test:integration
npm run test:e2e      # currently broken, see "e2e" below
```

## Layout

| Project | Directory | What it runs against | Needs |
| --- | --- | --- | --- |
| `unit` | `tests/unit` | main-process modules imported directly | nothing |
| `integration` | `tests/integration` | the Python sidecar and a headless Electron main process | `sidecar/.venv`, `ffmpeg`, `electron` |
| `e2e` | `tests/e2e` | the built app through Playwright's Electron driver | see below |

`integration` runs with one worker: several specs drive a single SQLite
database across consecutive Electron launches, which is how "persisted"
gets distinguished from "still in memory".

Specs skip rather than fail when a tool they need is absent, so a fresh
clone without the Python virtualenv still runs everything else.

## The Electron probe

`tests/probe/main.ts` boots Electron with no window, points `userData` at a
throwaway directory, and runs a list of `{fn, args}` operations against the
real `src/main/db.ts`, `src/main/sidecar.ts`, `src/main/serato.ts` and
`src/main/serato/seratoImport.ts`. `tests/helpers/probe.ts` bundles it with
esbuild and spawns it.

This exists because Playwright's own `electron.launch()` cannot start this
project: it passes `--remote-debugging-port=0`, which Electron 39 rejects
with "bad option". The probe needs no debugging port and no window — only a
real `app` object, so that `app.getPath('userData')` and `app.isPackaged`
resolve the way they do in production.

Two environment details the probe handles, and any new Electron-spawning
code has to handle as well:

- `ELECTRON_RUN_AS_NODE` is set globally in this project's shell. Left in
  place, Electron runs the entry file as plain Node and `app` is undefined.
  The probe deletes it from the child environment.
- Electron must be pointed at a **directory** containing a `package.json`
  with a `main` field. Given a bare `.js` path it falls back to the app name
  "Electron" and resolves `userData` somewhere else entirely.

## Serato fixtures, not the developer's library

`tests/helpers/seratoBinary.ts` writes `database V2`, `.crate` and
`.session` buffers from the format description, independently of
`src/main/serato/chunkReader.ts`'s decoder. Reading the real `_Serato_`
folder instead would make the suite machine-dependent, and would only ever
prove the reader agrees with itself.

## What the metadata specs pin down

`tests/integration/metadata-sync.spec.ts` and `tests/integration/tag-writes.spec.ts`
exist because a CrateCloud edit has to land in two places to be worth
anything: the SQLite row, so the app still shows it next launch, and the
audio file's own tags, so Serato, Rekordbox or Finder can ever see it. A
write that reaches only one of them looks completely fine inside CrateCloud
and is invisible everywhere else.

Four failure modes they guard against, each of which was a live bug:

- `updateTrackMeta` dropping a column. Its statement is now built from
  `UPDATABLE_TRACK_FIELDS` rather than a fixed list of clauses, because
  better-sqlite3 ignores a named parameter its statement does not bind, so
  a missing clause discards the value and still reports success.
- An edit reaching the database but never the file. Every save path is
  asserted to do both.
- `CRATECLOUD_ID` never getting onto a file, which is what lets a track
  survive a rename or a move.
- Two writes to one file racing and losing an edit. Disable the queue in
  `src/main/tagWrites.ts` and the first spec in `tag-writes.spec.ts` fails,
  which is the point of it.

## Still not covered

The renderer is not exercised anywhere: every spec drives the main process
directly. Component behaviour needs the `e2e` project working first.
