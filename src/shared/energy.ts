// ── Energy: the DJ's own rating ───────────────────────────────────────────
// A whole number the DJ sets by hand (Inspector, edit modal). DeepCrated
// never computes or overwrites it: analysis, re-import and rescans leave the
// stored value alone (see main/analysisUpdate.ts and the upsert in db.ts).
// It is not written to audio files.
//
// "Unset" is null, everywhere. It is never 0 and never a default: a track
// without energy is matched and filtered as "no energy", not as a low one.

export const ENERGY_MIN = 1
export const ENERGY_MAX = 10

export type Energy = number // ENERGY_MIN..ENERGY_MAX, whole

// A stored or typed value → a valid energy, or null for unset / invalid.
export function toEnergy(value: unknown): Energy | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  const r = Math.round(n)
  return r >= ENERGY_MIN && r <= ENERGY_MAX ? r : null
}

export function isEnergySet(value: unknown): boolean {
  return toEnergy(value) !== null
}

// An energy filter: [min, max], both inclusive. null = no filter.
export interface EnergyRange {
  min: Energy
  max: Energy
  // Whether tracks with no energy pass. Off by default: a filter on energy
  // means "tracks rated in this range".
  includeUnset: boolean
}

export const FULL_ENERGY_RANGE: EnergyRange = {
  min: ENERGY_MIN,
  max: ENERGY_MAX,
  includeUnset: false
}

export function clampEnergyRange(range: EnergyRange): EnergyRange {
  const a = toEnergy(range.min) ?? ENERGY_MIN
  const b = toEnergy(range.max) ?? ENERGY_MAX
  return { min: Math.min(a, b), max: Math.max(a, b), includeUnset: !!range.includeUnset }
}

export function energyInRange(value: unknown, range: EnergyRange | null): boolean {
  if (!range) return true
  const e = toEnergy(value)
  if (e === null) return range.includeUnset
  return e >= range.min && e <= range.max
}

// Whether a filter actually narrows anything (the full range with unset
// included is the same as no filter).
export function isEnergyFilterActive(range: EnergyRange | null): boolean {
  if (!range) return false
  return !(range.min === ENERGY_MIN && range.max === ENERGY_MAX && range.includeUnset)
}
