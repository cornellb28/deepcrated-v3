// ── Track Match: tag roles and co-occurrence — every tunable in one place ──
// Pure data, shared by the scorer, the background recompute and the UI.

export const TAG_MATCH_CONFIG = {
  // Tag weight = the type's Mix Profile points (question 6) x this multiplier.
  roleMultipliers: {
    genre: 1.25,
    vibe_energy: 1.25,
    function: 0.75,
    ignore: 0, // excluded entirely, co-occurrence included
    unassigned: 1 // the default tag weight
  },
  cooccurrence: {
    // A pair counts only if it is on at least this many tracks together...
    minPairCount: 3,
    // ...and each of its tags is on at least this many tracks.
    minTagCount: 5,
    // Lift (observed / expected) is clamped to this.
    liftCap: 8,
    // Bonus added to tagScore: this x the best positive NPMI among
    // (source tag, candidate tag the source lacks) pairs. tagScore is then
    // capped at 1.
    bonusWeight: 0.15,
    // Recompute this long after the last tag change.
    debounceMs: 30_000
  },
  // Question 7 lists this many of the DJ's most-used tags.
  rolesQuestionTagCount: 25
} as const

export type TagRole = 'genre' | 'vibe_energy' | 'function' | 'ignore'
