# DeepCrated v3 - CLAUDE.md

Copy everything below the line into a file named CLAUDE.md at the root of the cratecloud-v3 repo.

---

# DeepCrated v3

## Project overview

DeepCrated (formerly CrateCloud) is a local-first desktop DJ library management app. This repo is v3, a full from-scratch rewrite. The v2 codebase (github.com/cornellb28/cratecloudv2) is reference and spec only. Never assume a v2 table, column, handler, or file exists in v3. If v2 does something, read it for intent, then check what v3 actually has before building.

## Naming

The product name is spelled "DeepCrated" everywhere: UI copy, website, comments, docs, and package metadata. Never "DeepCrate" and never "CrateCloud" in user-facing text. Internal repo and folder names may still say cratecloud.

## Stack

- Electron, React, TypeScript, Vite
- Zustand for state
- SQLite via better-sqlite3, running synchronously on the Electron main process
- Python sidecar for audio analysis, packaged with PyInstaller

## Working rules

1. Inspect first. Before changing anything, read the relevant files and report what you found. Do not start editing until you have summarized the current state.
2. No new dependencies without approval. If you believe one is needed, stop and ask, explaining why existing tools cannot do the job.
3. Confirm before touching the data layer. Any change to the schema, migrations, db.ts, or anything that writes to the database requires an explicit confirmation from me first. Describe the change and wait.
4. Reuse existing infrastructure. Search for an existing component, handler, hook, or utility before creating a new one.
5. Leave explicit TODO comments for anything deferred, with a short note on what is missing.
6. Keep changes small and scoped to what the prompt asks. Mention adjacent problems you notice but do not fix them unprompted.

## Data layer conventions

- The schema is denormalized by design. Use a generic tags table, and cascade renames with direct UPDATE statements rather than foreign-key-joined tables.
- Records use UUIDs and soft-delete, and go through a repository/service layer. Do not call the database directly from UI code.
- Migrations are additive-only. Never drop or rename a column in place.
- better-sqlite3 is synchronous and shares the main process with window and audio-server management, so avoid long-running queries or loops on the main process.
- The app writes metadata back to audio files on edit. Treat any change near write-back as high risk: verify against copies of files, never originals.

## Architecture direction

The desktop app is local-first and free with no feature gating. Cloud sync and mobile will come later as paid subscriptions, tied to real user accounts. Do not build any of that now, but avoid decisions that would make it hard later: keep stable identifiers, track updated-at timestamps, and keep the data layer behind the repository/service boundary.

## UI conventions

- Locked or paid features, when they exist, are visible but locked: never hidden and never dead-disabled. Locked buttons show a lock badge and route to an upgrade prompt.
- The product should feel positive and reward-driven. Prefer encouraging copy and clear progress over warnings.

## When finishing a task

- Summarize what changed, file by file.
- State how it was verified, ideally against real data or real files, and clean up any test artifacts.
- List anything deferred or uncertain.
