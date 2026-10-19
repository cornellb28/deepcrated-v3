// ── Track Match: the Mix Profile and the scorer ───────────────────────────
// Pure: no Electron, no database, no Node built-ins — so the mobile app can
// reuse it unchanged (TODO(mobile): import from here rather than copying).
//
//   score = w_key*keyScore + w_bpm*bpmScore + w_energy*energyScore + w_tags*tagScore
//
// Weights, the BPM window and the key mode come from the Mix Profile (the
// survey's answers). A weight whose input is missing is dropped and the rest
// are re-weighted to sum to 1:
//   - energy, when either track has none (no library has it computed yet;
//     it is set by hand in the Inspector — TODO: energy from analysis);
//   - tags, on a cold start (the source track, or the library, has too
//     little tag data) — which falls back to key + BPM only.
//
// Lift / Drop shift the energy target one step up or down. With no energy
// on the source they fall back to BPM: only candidates faster (Lift) or
// slower (Drop) than the source, still inside the window.
//
// TODO(prompt-2): tag roles (a tag that means "peak time" vs one that means
// "Afrobeats") and tag co-occurrence across the library, replacing the flat
// per-type overlap in tagScore — including down-weighting values that are on
// a large share of the library (a real library has one label on ~80 tracks
// from a Serato import), which today count as much as a rare shared tag.
// TODO(history): a history score from what the DJ actually played next.

// ── The profile ───────────────────────────────────────────────────────────

import { ENERGY_MAX, ENERGY_MIN } from './energy'

export type KeyMode = 'strict' | 'flexible' | 'loose'
export type BpmWindow = 3 | 6 | 10 | 'wide'
export type EnergyMovement = 'gradual' | 'swings' | 'manual'
export type Gig = 'club' | 'open' | 'wedding' | 'radio'
export type Variety = 'same_ok' | 'favor_variety'
// Every tag field the library has. "Other tags" was one bucket until the
// survey listed them separately; normalizeTagWeights carries old points over.
export type TagType =
  'genre' | 'grouping' | 'label' | 'remixer' | 'comment' | 'composer' | 'vibe' | 'venue' | 'custom'
export type Direction = 'lift' | 'similar' | 'drop'

export const TAG_TYPES: readonly TagType[] = [
  'genre',
  'grouping',
  'label',
  'remixer',
  'comment',
  'composer',
  'vibe',
  'venue',
  'custom'
]

export interface MixProfile {
  keyMode: KeyMode
  bpmWindow: BpmWindow
  halfDouble: boolean
  energyMovement: EnergyMovement
  gig: Gig | null
  variety: Variety
  // Points per tag type; always sums to 100.
  tagWeights: Record<TagType, number>
}

export const PROFILE_VERSION = 1

export const DEFAULT_TAG_WEIGHTS: Record<TagType, number> = {
  genre: 35,
  grouping: 20,
  label: 10,
  remixer: 5,
  comment: 10,
  composer: 5,
  vibe: 5,
  venue: 5,
  custom: 5
}

// What the scorer uses with no survey taken, and what "Skip" stores.
export const DEFAULT_PROFILE: MixProfile = {
  keyMode: 'flexible',
  bpmWindow: 6,
  halfDouble: true,
  energyMovement: 'gradual',
  gig: 'open',
  variety: 'favor_variety',
  tagWeights: { ...DEFAULT_TAG_WEIGHTS }
}

// Picking a gig fills in the other answers; the DJ can still change them.
export const GIG_PRESETS: Record<Gig, Omit<MixProfile, 'gig' | 'tagWeights'>> = {
  club: {
    keyMode: 'strict',
    bpmWindow: 3,
    halfDouble: false,
    energyMovement: 'gradual',
    variety: 'favor_variety'
  },
  open: {
    keyMode: 'flexible',
    bpmWindow: 10,
    halfDouble: true,
    energyMovement: 'swings',
    variety: 'favor_variety'
  },
  wedding: {
    keyMode: 'loose',
    bpmWindow: 'wide',
    halfDouble: true,
    energyMovement: 'swings',
    variety: 'same_ok'
  },
  radio: {
    keyMode: 'flexible',
    bpmWindow: 6,
    halfDouble: true,
    energyMovement: 'gradual',
    variety: 'favor_variety'
  }
}

export function applyGigPreset(profile: MixProfile, gig: Gig): MixProfile {
  return { ...profile, ...GIG_PRESETS[gig], gig }
}

// 'wide' in BPM.
export const WIDE_BPM_WINDOW = 16

export function bpmWindowSize(window: BpmWindow): number {
  return window === 'wide' ? WIDE_BPM_WINDOW : window
}

// Scales any set of non-negative points to whole numbers summing to 100
// (largest-remainder rounding). All zero → the defaults. A profile saved
// before the tag fields were listed separately has `other` (comment plus
// vibe/venue/custom); its points go to comment, which held nearly all of it.
export function normalizeTagWeights(
  weights: Partial<Record<TagType | 'other', number>> | null | undefined
): Record<TagType, number> {
  const legacyOther = Number(weights?.other)
  const raw = TAG_TYPES.map((t) => {
    let v = Number(weights?.[t])
    if (t === 'comment' && !Number.isFinite(v) && Number.isFinite(legacyOther)) v = legacyOther
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  const total = raw.reduce((a, b) => a + b, 0)
  if (total === 0) return { ...DEFAULT_TAG_WEIGHTS }
  const exact = raw.map((v) => (v * 100) / total)
  const floored = exact.map(Math.floor)
  let left = 100 - floored.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (left <= 0) break
    floored[i]++
    left--
  }
  return Object.fromEntries(TAG_TYPES.map((t, i) => [t, floored[i]])) as Record<TagType, number>
}

const KEY_MODES: readonly KeyMode[] = ['strict', 'flexible', 'loose']
const BPM_WINDOWS: readonly BpmWindow[] = [3, 6, 10, 'wide']
const MOVEMENTS: readonly EnergyMovement[] = ['gradual', 'swings', 'manual']
const GIGS: readonly Gig[] = ['club', 'open', 'wedding', 'radio']
const VARIETIES: readonly Variety[] = ['same_ok', 'favor_variety']

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

// Anything stored or received → a complete, valid profile. Unknown or
// missing answers take the defaults, so a profile from an older or newer
// version never breaks the scorer.
export function normalizeProfile(input: unknown): MixProfile {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    keyMode: pick(p.keyMode, KEY_MODES, DEFAULT_PROFILE.keyMode),
    bpmWindow: pick(p.bpmWindow, BPM_WINDOWS, DEFAULT_PROFILE.bpmWindow),
    halfDouble: typeof p.halfDouble === 'boolean' ? p.halfDouble : DEFAULT_PROFILE.halfDouble,
    energyMovement: pick(p.energyMovement, MOVEMENTS, DEFAULT_PROFILE.energyMovement),
    gig: p.gig === null ? null : pick(p.gig, GIGS, DEFAULT_PROFILE.gig as Gig),
    variety: pick(p.variety, VARIETIES, DEFAULT_PROFILE.variety),
    tagWeights: normalizeTagWeights(p.tagWeights as Partial<Record<TagType, number>>)
  }
}

// ── Keys (Camelot) ────────────────────────────────────────────────────────

export interface Camelot {
  number: number // 1..12
  letter: 'A' | 'B'
}

export function parseCamelot(key: string | null | undefined): Camelot | null {
  const m = /^\s*(\d{1,2})\s*([ABab])\s*$/.exec(key ?? '')
  if (!m) return null
  const number = Number(m[1])
  if (number < 1 || number > 12) return null
  return { number, letter: m[2].toUpperCase() as 'A' | 'B' }
}

function wheel(n: number): number {
  return ((((n - 1) % 12) + 12) % 12) + 1
}

function fmt(k: Camelot): string {
  return `${k.number}${k.letter}`
}

export interface KeyRelation {
  key: string
  score: number
  label: string
}

// Every key a mode accepts from `source`, best first. 'loose' accepts every
// key: compatible ones still score higher, the rest score low but are not
// excluded.
export function compatibleKeys(source: Camelot, mode: KeyMode): KeyRelation[] {
  const same = source.letter
  const other = same === 'A' ? 'B' : 'A'
  const rel: KeyRelation[] = [
    { key: fmt(source), score: 1, label: 'same key' },
    { key: `${wheel(source.number + 1)}${same}`, score: 0.9, label: '+1' },
    { key: `${wheel(source.number - 1)}${same}`, score: 0.9, label: '-1' },
    { key: `${source.number}${other}`, score: 0.85, label: 'relative' }
  ]
  if (mode !== 'strict') {
    rel.push(
      { key: `${wheel(source.number + 2)}${same}`, score: 0.6, label: '+2' },
      { key: `${wheel(source.number - 2)}${same}`, score: 0.6, label: '-2' },
      { key: `${wheel(source.number + 7)}${same}`, score: 0.55, label: 'energy boost' }
    )
  }
  if (mode === 'loose') {
    const seen = new Set(rel.map((r) => r.key))
    for (let n = 1; n <= 12; n++) {
      for (const l of ['A', 'B'] as const) {
        const k = `${n}${l}`
        if (!seen.has(k)) rel.push({ key: k, score: 0.2, label: 'any key' })
      }
    }
  }
  return rel
}

export function keyScore(
  source: Camelot,
  candidate: Camelot | null,
  mode: KeyMode
): { score: number; reason: string | null } {
  if (!candidate) return { score: 0, reason: null }
  const hit = compatibleKeys(source, mode).find((r) => r.key === fmt(candidate))
  if (!hit) return { score: 0, reason: null }
  return { score: hit.score, reason: `${fmt(source)} → ${fmt(candidate)}` }
}

// ── BPM ───────────────────────────────────────────────────────────────────

// The SQL pre-filter's ranges: the window around the source tempo, plus the
// same window around half and double time when the profile allows it.
export function bpmRanges(sourceBpm: number, profile: MixProfile): [number, number][] {
  const w = bpmWindowSize(profile.bpmWindow)
  const ranges: [number, number][] = [[sourceBpm - w, sourceBpm + w]]
  if (profile.halfDouble) {
    ranges.push([sourceBpm / 2 - w / 2, sourceBpm / 2 + w / 2])
    ranges.push([sourceBpm * 2 - w * 2, sourceBpm * 2 + w * 2])
  }
  return ranges
}

export interface TempoMatch {
  // Candidate BPM expressed at the source's tempo (x2 for half time, /2 for
  // double), and how it got there.
  effective: number
  factor: 1 | 2 | 0.5
  delta: number
}

export function tempoMatch(
  sourceBpm: number,
  candidateBpm: number,
  halfDouble: boolean
): TempoMatch {
  const options: (1 | 2 | 0.5)[] = halfDouble ? [1, 2, 0.5] : [1]
  let best: TempoMatch | null = null
  for (const factor of options) {
    const effective = candidateBpm * factor
    const delta = effective - sourceBpm
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { effective, factor, delta }
  }
  return best!
}

// 1 at the source tempo, 0 at the window's edge. With `towards` (Lift/Drop
// falling back to BPM) only the faster (+1) or slower (-1) side counts —
// the same tempo or the wrong side scores 0 and is left out — and the best
// spot is half a window away from the source.
export function bpmScore(
  sourceBpm: number,
  candidateBpm: number | null,
  profile: MixProfile,
  towards: -1 | 0 | 1 = 0
): { score: number; reason: string | null; match: TempoMatch | null } {
  if (!candidateBpm || candidateBpm <= 0) return { score: 0, reason: null, match: null }
  const w = bpmWindowSize(profile.bpmWindow)
  const m = tempoMatch(sourceBpm, candidateBpm, profile.halfDouble)
  if (Math.abs(m.delta) > w) return { score: 0, reason: null, match: m }
  let score: number
  if (towards === 0) {
    score = 1 - Math.abs(m.delta) / w
  } else {
    if (Math.sign(m.delta) !== towards) return { score: 0, reason: null, match: m }
    const target = (towards * w) / 2
    score = Math.max(0, 1 - Math.abs(m.delta - target) / w)
  }
  const rounded = Math.round(m.delta)
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±'
  const tempoNote = m.factor === 2 ? ' (half time)' : m.factor === 0.5 ? ' (double time)' : ''
  return {
    score,
    reason: `${sign}${Math.abs(rounded)} BPM${tempoNote}`,
    match: m
  }
}

// ── Energy (the DJ's rating; range and "unset" live in energy.ts) ─────────

export { ENERGY_MAX, ENERGY_MIN }

// Lift / Drop move the target one step; Similar keeps it.
export function energyTarget(sourceEnergy: number, direction: Direction): number {
  const shift = direction === 'lift' ? 1 : direction === 'drop' ? -1 : 0
  return Math.min(ENERGY_MAX, Math.max(ENERGY_MIN, sourceEnergy + shift))
}

// Quadratic falloff around the target. "Big swings" falls off more slowly.
export function energyScore(
  sourceEnergy: number,
  candidateEnergy: number,
  direction: Direction,
  movement: EnergyMovement
): { score: number; reason: string } {
  const target = energyTarget(sourceEnergy, direction)
  const scale = movement === 'swings' ? 6 : 3
  const d = (candidateEnergy - target) / scale
  return {
    score: Math.max(0, 1 - d * d),
    reason: `E${sourceEnergy} → E${candidateEnergy}`
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────

export type TrackTags = Partial<Record<TagType, readonly string[]>>

// Weighted overlap: per tag type, the share of the source's values the
// candidate also has; types weighted by the profile's points. Types the
// source has nothing for do not count either way.
export function tagScore(
  source: TrackTags,
  candidate: TrackTags,
  weights: Record<TagType, number>
): { score: number; shared: string[] } {
  let total = 0
  let sum = 0
  const shared: string[] = []
  for (const type of TAG_TYPES) {
    const mine = source[type] ?? []
    const w = weights[type] ?? 0
    if (mine.length === 0 || w <= 0) continue
    const theirs = new Set((candidate[type] ?? []).map((v) => v.toLowerCase()))
    const common = mine.filter((v) => theirs.has(v.toLowerCase()))
    shared.push(...common)
    sum += w * (common.length / mine.length)
    total += w
  }
  return { score: total === 0 ? 0 : sum / total, shared }
}

export function hasAnyTags(tags: TrackTags): boolean {
  return TAG_TYPES.some((t) => (tags[t]?.length ?? 0) > 0)
}

// ── Weights ───────────────────────────────────────────────────────────────

export interface Weights {
  key: number
  bpm: number
  energy: number
  tags: number
}

const BASE_WEIGHTS: Record<KeyMode, Weights> = {
  strict: { key: 0.45, bpm: 0.3, energy: 0.1, tags: 0.15 },
  flexible: { key: 0.35, bpm: 0.3, energy: 0.15, tags: 0.2 },
  loose: { key: 0.1, bpm: 0.4, energy: 0.2, tags: 0.3 }
}

// Base weights for the profile, minus whatever cannot be scored, re-weighted
// to sum to 1.
export function effectiveWeights(
  profile: MixProfile,
  opts: { energy: boolean; tags: boolean }
): Weights {
  const w = { ...BASE_WEIGHTS[profile.keyMode] }
  if (!opts.energy || profile.energyMovement === 'manual') w.energy = 0
  if (!opts.tags) w.tags = 0
  const total = w.key + w.bpm + w.energy + w.tags
  return {
    key: w.key / total,
    bpm: w.bpm / total,
    energy: w.energy / total,
    tags: w.tags / total
  }
}

// ── Variety ───────────────────────────────────────────────────────────────

export const SAME_ARTIST_PENALTY = 0.2

function artistSet(artist: string | null | undefined): Set<string> {
  return new Set(
    (artist ?? '')
      .split(/ \| | \/ /)
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
  )
}

export function sharesArtist(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = artistSet(a)
  for (const x of artistSet(b)) if (left.has(x)) return true
  return false
}

// ── Scoring and ranking ───────────────────────────────────────────────────

export interface MatchTrack {
  id: number
  artist?: string | null
  bpm?: number | null
  key?: string | null // Camelot
  energy?: number | null
  tags?: TrackTags
}

export interface MatchResult {
  id: number
  score: number
  reasons: string[]
}

export interface RankOptions {
  direction?: Direction
  // True when too little of the library is tagged: key + BPM only.
  coldStart?: boolean
  limit?: number
}

export type RankOutcome =
  | { status: 'ok'; results: MatchResult[]; usedEnergy: boolean; usedTags: boolean }
  // The source has no usable key or BPM: nothing to rank against.
  | { status: 'needs-key-bpm' }

export function rankCandidates(
  source: MatchTrack,
  candidates: readonly MatchTrack[],
  profile: MixProfile,
  opts: RankOptions = {}
): RankOutcome {
  const sourceKey = parseCamelot(source.key)
  if (!sourceKey || !source.bpm || source.bpm <= 0) return { status: 'needs-key-bpm' }

  const direction = opts.direction ?? 'similar'
  const coldStart = opts.coldStart === true || !hasAnyTags(source.tags ?? {})
  const sourceEnergy = typeof source.energy === 'number' ? source.energy : null
  // Lift/Drop with no energy on the source fall back to BPM.
  const bpmTowards: -1 | 0 | 1 =
    sourceEnergy === null && direction !== 'similar' ? (direction === 'lift' ? 1 : -1) : 0

  const results: MatchResult[] = []
  for (const c of candidates) {
    if (c.id === source.id) continue
    const k = keyScore(sourceKey, parseCamelot(c.key), profile.keyMode)
    if (k.score === 0 && profile.keyMode !== 'loose') continue
    const b = bpmScore(source.bpm, c.bpm ?? null, profile, bpmTowards)
    if (b.score === 0 && b.match === null) continue
    // Lift/Drop by BPM: the same tempo or the wrong side is not a candidate.
    if (bpmTowards !== 0 && b.score === 0) continue
    if (b.match && Math.abs(b.match.delta) > bpmWindowSize(profile.bpmWindow)) continue

    const candEnergy = typeof c.energy === 'number' ? c.energy : null
    const useEnergy = sourceEnergy !== null && candEnergy !== null && !coldStart
    const useTags = !coldStart
    const w = effectiveWeights(profile, { energy: useEnergy, tags: useTags })

    const reasons: string[] = []
    if (k.reason) reasons.push(k.reason)
    if (b.reason) reasons.push(b.reason)

    let score = w.key * k.score + w.bpm * b.score
    if (useEnergy && w.energy > 0) {
      const e = energyScore(sourceEnergy!, candEnergy!, direction, profile.energyMovement)
      score += w.energy * e.score
      reasons.push(e.reason)
    }
    if (useTags && w.tags > 0) {
      const t = tagScore(source.tags ?? {}, c.tags ?? {}, profile.tagWeights)
      score += w.tags * t.score
      if (t.shared.length > 0) reasons.push(`shares: ${t.shared.slice(0, 3).join(', ')}`)
    }
    if (profile.variety === 'favor_variety' && sharesArtist(source.artist, c.artist)) {
      score *= 1 - SAME_ARTIST_PENALTY
      reasons.push('same artist')
    }
    results.push({ id: c.id, score, reasons })
  }

  results.sort((a, b) => b.score - a.score || a.id - b.id)
  return {
    status: 'ok',
    results: results.slice(0, opts.limit ?? 20),
    usedEnergy: results.length > 0 && sourceEnergy !== null && !coldStart,
    usedTags: !coldStart
  }
}

// The key strings the SQL pre-filter accepts (null = no key filter).
export function preFilterKeys(
  sourceKey: string | null | undefined,
  profile: MixProfile
): string[] | null {
  const k = parseCamelot(sourceKey)
  if (!k || profile.keyMode === 'loose') return null
  return compatibleKeys(k, profile.keyMode).map((r) => r.key)
}

// The survey's tag sliders: set one type's points and spread the rest over
// the others in proportion to what they had (evenly if they had nothing),
// so the total is always exactly 100. `adjustable` limits which others may
// move (the survey passes the fields shown as sliders, so folded-away fields
// keep their points); the changed slider is capped so the total still fits.
export function rebalanceTagWeights(
  weights: Record<TagType, number>,
  changed: TagType,
  value: number,
  adjustable: readonly TagType[] = TAG_TYPES
): Record<TagType, number> {
  const others = TAG_TYPES.filter((t) => t !== changed && adjustable.includes(t))
  const held = TAG_TYPES.filter((t) => t !== changed && !adjustable.includes(t))
  const heldTotal = held.reduce((a, t) => a + Math.max(0, weights[t] ?? 0), 0)
  const ceiling = Math.max(0, 100 - heldTotal)
  // With nothing else free to move, this slider holds whatever is left.
  const fixed = others.length === 0 ? ceiling : Math.max(0, Math.min(ceiling, Math.round(value)))
  const remaining = 100 - heldTotal - fixed
  const current = others.map((t) => Math.max(0, weights[t] ?? 0))
  const total = current.reduce((a, b) => a + b, 0)
  const exact = others.map((_, i) =>
    total === 0 ? remaining / others.length : (current[i] * remaining) / total
  )
  const floored = exact.map(Math.floor)
  let left = remaining - floored.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    floored[i]++
    left--
  }
  const out = { [changed]: fixed } as Record<TagType, number>
  others.forEach((t, i) => (out[t] = floored[i]))
  held.forEach((t) => (out[t] = Math.max(0, weights[t] ?? 0)))
  return out
}
