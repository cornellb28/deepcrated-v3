// ── Find combos: what mixes well with a track ─────────────────────────────
// Pure: no React, no database. main/comboService.ts feeds it a candidate set
// the database has already narrowed (BPM window and compatible keys), and it
// ranks them with a short reason per factor.
//
// Factors, each 0..1, combined by COMBO_WEIGHTS:
//   key     Camelot wheel: same key, ±1 and relative major/minor strongest;
//           +2 "energy boost" when allowed; any other key only in "any" mode
//   bpm     within a percentage of the source tempo, half/double time too
//   energy  the DJ's own rating against the chosen goal (keep, build, down)
// A factor either track lacks is left out and the rest re-weighted, and the
// result says it is partial. Small bonuses for a shared genre, shared tags
// and a shared crate; a small penalty for something played recently.
// Reuses Track Match's Camelot parser and half/double-time matcher.

import { parseCamelot, tempoMatch, type Camelot } from './trackMatch'
import { toEnergy } from './energy'

// ── Settings (the panel's controls; persisted by the renderer) ────────────

export type EnergyGoal = 'keep' | 'build' | 'down'
export type KeyStrictness = 'strict' | 'flexible' | 'any'

export interface ComboSettings {
  goal: EnergyGoal
  // ± percent of the source BPM.
  bpmTolerancePct: number
  halfDouble: boolean
  keyStrictness: KeyStrictness
  // Allow the +2 "energy boost" key move (8A → 10A).
  keyBoost: boolean
}

export const DEFAULT_COMBO_SETTINGS: ComboSettings = {
  goal: 'keep',
  bpmTolerancePct: 6,
  halfDouble: true,
  keyStrictness: 'flexible',
  keyBoost: true
}

export const BPM_TOLERANCE_CHOICES = [3, 6, 10] as const

// Every tunable in one place.
export const COMBO_WEIGHTS = {
  key: 0.4,
  bpm: 0.35,
  energy: 0.25,
  // Added after the weighted factors, then capped at 1.
  sharedGenre: 0.05,
  sharedTag: 0.03,
  sharedCrate: 0.04,
  // Subtracted when the candidate was played recently.
  recentlyPlayed: 0.1,
  // Subtracted per missing key or BPM, so a match scored on less evidence
  // cannot outrank a complete one of the same quality.
  partial: 0.15,
  // Subtracted when the source has an energy rating and the candidate does
  // not: it cannot be shown to meet the energy goal. (When the source has no
  // rating, every candidate is equally unknown, so nothing is subtracted.)
  partialEnergy: 0.1
} as const

export const KEY_SCORES = {
  same: 1,
  step: 0.9, // ±1 on the wheel
  relative: 0.85, // same number, other letter
  boost: 0.6, // +2 "energy boost"
  twoSteps: 0.5, // ±2 in flexible mode (the -2 side)
  any: 0.15 // anything else, "any key" mode only
} as const

export function normalizeComboSettings(input: unknown): ComboSettings {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const goal = p.goal === 'build' || p.goal === 'down' ? p.goal : 'keep'
  const tol = Number(p.bpmTolerancePct)
  const strict =
    p.keyStrictness === 'strict' || p.keyStrictness === 'any' ? p.keyStrictness : 'flexible'
  return {
    goal,
    bpmTolerancePct:
      Number.isFinite(tol) && tol > 0 && tol <= 25 ? tol : DEFAULT_COMBO_SETTINGS.bpmTolerancePct,
    halfDouble:
      typeof p.halfDouble === 'boolean' ? p.halfDouble : DEFAULT_COMBO_SETTINGS.halfDouble,
    keyStrictness: strict,
    keyBoost: typeof p.keyBoost === 'boolean' ? p.keyBoost : DEFAULT_COMBO_SETTINGS.keyBoost
  }
}

// ── Tracks ────────────────────────────────────────────────────────────────

export interface ComboTrack {
  id: number
  bpm: number | null
  key: string | null
  energy: number | null
  // Normalized values (tagValueKey) — genre separately, every tag together.
  genres?: readonly string[]
  tags?: readonly string[]
  crateIds?: readonly number[]
  recentlyPlayed?: boolean
}

export type ComboFactor = 'key' | 'bpm' | 'energy'

export interface ComboResult {
  id: number
  score: number // 0..1
  reasons: string[]
  // Factors that could not be scored (missing on either track).
  missing: ComboFactor[]
  partial: boolean
}

// ── Key ───────────────────────────────────────────────────────────────────

const fmt = (k: Camelot): string => `${k.number}${k.letter}`

export function comboKeyScore(
  source: Camelot,
  candidate: Camelot,
  settings: Pick<ComboSettings, 'keyStrictness' | 'keyBoost'>
): { score: number; label: string } | null {
  const sameLetter = candidate.letter === source.letter
  const step = (((candidate.number - source.number + 12) % 12) + 12) % 12 // 0..11 clockwise
  if (sameLetter && step === 0) return { score: KEY_SCORES.same, label: 'same key' }
  if (sameLetter && (step === 1 || step === 11)) {
    return { score: KEY_SCORES.step, label: step === 1 ? '+1' : '−1' }
  }
  if (!sameLetter && step === 0) return { score: KEY_SCORES.relative, label: 'relative' }
  if (sameLetter && step === 2 && settings.keyBoost) {
    return { score: KEY_SCORES.boost, label: '+2 energy boost' }
  }
  if (settings.keyStrictness !== 'strict' && sameLetter && (step === 2 || step === 10)) {
    return { score: KEY_SCORES.twoSteps, label: step === 2 ? '+2' : '−2' }
  }
  if (settings.keyStrictness === 'any') return { score: KEY_SCORES.any, label: 'clashing key' }
  return null
}

// The keys the database pre-filter should accept (null: no key filter).
export function comboKeyFilter(sourceKey: string | null, settings: ComboSettings): string[] | null {
  const k = parseCamelot(sourceKey)
  if (!k || settings.keyStrictness === 'any') return null
  const out: string[] = []
  for (let n = 1; n <= 12; n++) {
    for (const letter of ['A', 'B'] as const) {
      if (comboKeyScore(k, { number: n, letter }, settings)) out.push(`${n}${letter}`)
    }
  }
  return out
}

// ── BPM ───────────────────────────────────────────────────────────────────

// The database pre-filter's BPM ranges for a source tempo.
export function comboBpmRanges(sourceBpm: number, settings: ComboSettings): [number, number][] {
  const f = settings.bpmTolerancePct / 100
  const around = (b: number): [number, number] => [b * (1 - f), b * (1 + f)]
  const ranges = [around(sourceBpm)]
  if (settings.halfDouble) ranges.push(around(sourceBpm / 2), around(sourceBpm * 2))
  return ranges
}

export function comboBpmScore(
  sourceBpm: number,
  candidateBpm: number,
  settings: Pick<ComboSettings, 'bpmTolerancePct' | 'halfDouble'>
): { score: number; label: string } | null {
  const m = tempoMatch(sourceBpm, candidateBpm, settings.halfDouble)
  const pct = (m.delta / sourceBpm) * 100
  if (Math.abs(pct) > settings.bpmTolerancePct) return null
  const sign = pct > 0.05 ? '+' : pct < -0.05 ? '−' : '±'
  const note = m.factor === 2 ? ' (half time)' : m.factor === 0.5 ? ' (double time)' : ''
  return {
    score: 1 - Math.abs(pct) / settings.bpmTolerancePct,
    label: `${sign}${Math.abs(pct).toFixed(1)}%${note}`
  }
}

// ── Energy ────────────────────────────────────────────────────────────────

// Score by step (candidate − source) for each goal.
//   keep   within ±1 is ideal (0 best)
//   build  +1 or +2
//   down   −1 or −2
export function comboEnergyScore(source: number, candidate: number, goal: EnergyGoal): number {
  const d = candidate - source
  if (goal === 'keep') {
    const a = Math.abs(d)
    return a === 0 ? 1 : a === 1 ? 0.85 : a === 2 ? 0.35 : 0
  }
  const s = goal === 'build' ? d : -d
  if (s === 1 || s === 2) return 1
  if (s === 3) return 0.5
  if (s === 0) return 0.4
  return 0 // the wrong way
}

// ── Scoring ───────────────────────────────────────────────────────────────

function overlap(a: readonly string[] | undefined, b: readonly string[] | undefined): number {
  if (!a?.length || !b?.length) return 0
  const set = new Set(a)
  return b.filter((x) => set.has(x)).length
}

// null: not a combo (outside the BPM tolerance, or a key the strictness does
// not allow), or nothing at all to score it on.
export function scoreCombo(
  source: ComboTrack,
  candidate: ComboTrack,
  settings: ComboSettings
): ComboResult | null {
  if (candidate.id === source.id) return null
  const reasons: string[] = []
  const missing: ComboFactor[] = []
  let sum = 0
  let weight = 0

  const sk = parseCamelot(source.key)
  const ck = parseCamelot(candidate.key)
  if (sk && ck) {
    const k = comboKeyScore(sk, ck, settings)
    if (!k) return null
    sum += COMBO_WEIGHTS.key * k.score
    weight += COMBO_WEIGHTS.key
    reasons.push(`Key ${fmt(sk)} → ${fmt(ck)} (${k.label})`)
  } else missing.push('key')

  const sb = source.bpm && source.bpm > 0 ? source.bpm : null
  const cb = candidate.bpm && candidate.bpm > 0 ? candidate.bpm : null
  if (sb && cb) {
    const b = comboBpmScore(sb, cb, settings)
    if (!b) return null
    sum += COMBO_WEIGHTS.bpm * b.score
    weight += COMBO_WEIGHTS.bpm
    reasons.push(`BPM ${b.label}`)
  } else missing.push('bpm')

  // Key and BPM are what make two tracks mixable at all: with neither there
  // is nothing to go on, energy and genre alone are not a combo.
  if (missing.includes('key') && missing.includes('bpm')) return null

  const se = toEnergy(source.energy)
  const ce = toEnergy(candidate.energy)
  if (se !== null && ce !== null) {
    const e = comboEnergyScore(se, ce, settings.goal)
    sum += COMBO_WEIGHTS.energy * e
    weight += COMBO_WEIGHTS.energy
    reasons.push(`Energy ${se} → ${ce}`)
  } else missing.push('energy')

  let score = weight > 0 ? sum / weight : 0
  score -= COMBO_WEIGHTS.partial * missing.filter((m) => m !== 'energy').length
  if (se !== null && ce === null) score -= COMBO_WEIGHTS.partialEnergy
  if (overlap(source.genres, candidate.genres) > 0) {
    score += COMBO_WEIGHTS.sharedGenre
    reasons.push('Same genre')
  }
  const sharedTags = overlap(source.tags, candidate.tags)
  if (sharedTags > 0) {
    score += COMBO_WEIGHTS.sharedTag
    reasons.push(sharedTags === 1 ? '1 shared tag' : `${sharedTags} shared tags`)
  }
  if (overlap(source.crateIds?.map(String), candidate.crateIds?.map(String)) > 0) {
    score += COMBO_WEIGHTS.sharedCrate
    reasons.push('Shared crate')
  }
  if (candidate.recentlyPlayed) {
    score -= COMBO_WEIGHTS.recentlyPlayed
    reasons.push('Played recently')
  }
  if (missing.length > 0) {
    const names = { key: 'key', bpm: 'BPM', energy: 'energy' }
    reasons.push(`Partial: no ${missing.map((m) => names[m]).join(' or ')}`)
  }
  return {
    id: candidate.id,
    score: Math.max(0, Math.min(1, score)),
    reasons,
    missing,
    partial: missing.length > 0
  }
}

// Best first; ties go to the more complete match, then the lower id, so the
// order is stable.
export function rankCombos(
  source: ComboTrack,
  candidates: readonly ComboTrack[],
  settings: ComboSettings,
  limit = 30
): ComboResult[] {
  const out: ComboResult[] = []
  for (const c of candidates) {
    const r = scoreCombo(source, c, settings)
    if (r) out.push(r)
  }
  out.sort((a, b) => b.score - a.score || a.missing.length - b.missing.length || a.id - b.id)
  return out.slice(0, limit)
}
