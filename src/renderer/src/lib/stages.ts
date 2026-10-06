// ── Stages ────────────────────────────────────────────────────────────────
// A "stage" is where a track sits in the DJ's workflow: Untagged → Tagged →
// Crate ready → Gig ready. Four of them, seeded on first launch.
//
// ⚠ NAMING. The DJ reads "stage" everywhere. The CODE and the DATABASE still
// say "board" — the `boards` table, `tracks.board_id`, the `Board` type —
// because the kanban board these started life as is gone but its schema is
// load-bearing: tabs.ts generates one status tab per row, and tracks.board_id
// is NOT NULL with a foreign key plus a legacy board_column migration behind
// it (db.ts:279). Renaming the column is a deliberate, separate job.
//
// Settled 2026-09-24: UI wording only. Everything below translates between
// the two vocabularies, and this comment is the reason the mismatch exists.

// The word itself, in one place, so a later rename is one edit.
export const STAGE_NOUN = 'Stage'

// Pure and React-free so the cycle arithmetic can be unit-tested without a
// DOM — the same split as lib/selection.ts and lib/authCallback.ts.

export function stageById(stages: readonly Board[], id: number | null): Board | undefined {
  if (id === null) return undefined
  return stages.find((s) => s.id === id)
}

// The next stage in workflow order, wrapping past the last one back to the
// first. `stages` arrives already ordered by position (db.ts orders by
// position ASC and the store keeps that order), so index order IS workflow
// order and no re-sort is needed.
//
// Returns null only when there are no stages at all, which would mean the
// seed never ran. An unknown current id starts the cycle at the first stage
// rather than refusing to move: a track pointing at a deleted stage should
// still be fixable by clicking it.
export function nextStageId(stages: readonly Board[], currentId: number | null): number | null {
  if (stages.length === 0) return null
  const index = stages.findIndex((s) => s.id === currentId)
  if (index === -1) return stages[0].id
  return stages[(index + 1) % stages.length].id
}

// For the pill's tooltip and its accessible name. Saying where the click
// goes is the whole reason a DJ would risk the first one.
export function cycleHint(stages: readonly Board[], currentId: number | null): string {
  const current = stageById(stages, currentId)
  const next = stageById(stages, nextStageId(stages, currentId))
  if (!next) return STAGE_NOUN
  if (!current) return `Set ${STAGE_NOUN.toLowerCase()} to ${next.name}`
  return `${STAGE_NOUN}: ${current.name} — click for ${next.name}`
}
