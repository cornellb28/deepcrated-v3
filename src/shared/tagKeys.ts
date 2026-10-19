// ── Tag values as Track Match compares them ───────────────────────────────
// One normalization, used by tag roles, tag overlap and co-occurrence, so
// "hip hop", "Hip-Hop" and "[hip hop]" are one tag everywhere matching
// happens. Comparison only: stored tags and audio files are never changed.
//
// Deliberately simple: fold case, strip brackets that wrap the whole value,
// treat - and _ as spaces, trim, collapse repeated spaces. Nothing fancier
// (no "&" → "and", no plural folding).

const WRAPPING = /^\s*[[({]\s*(.*?)\s*[\])}]\s*$/

export function tagValueKey(value: string): string {
  let v = value.trim()
  // Strip wrapping brackets, repeatedly: "[(House)]" → "House".
  for (let m = WRAPPING.exec(v); m; m = WRAPPING.exec(v)) v = m[1]
  return v.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

// ── Noise ─────────────────────────────────────────────────────────────────
// Values that are not tags a DJ chose: the label Serato's collection import
// stamps on everything, and URL-shaped text left by download sites. Never
// matched, never paired, never offered for a role.

const SERATO_COLLECTION = 'seratocollection'
const URL_SHAPED = /https?:\/\/|www\.|\.(com|net|org|info|biz|io|ru|co\.uk)\b/i

export function isNoiseTagValue(value: string): boolean {
  const v = value.trim()
  if (v.toLowerCase() === SERATO_COLLECTION) return true
  return URL_SHAPED.test(v)
}

// A track's values for one field → distinct keys, noise removed, in order.
export function tagKeysFor(values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    if (isNoiseTagValue(raw)) continue
    const key = tagValueKey(raw)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

// Normalizing every column of a large library repeats work: thousands of
// tracks share the same raw string ("Hip Hop | R&B"). This caches the keys
// per (field, raw string). `split` turns a column into values (tagFields'
// splitValue on desktop), passed in so this module stays pure.
export function createTagKeyCache(
  split: (field: string, raw: string | null | undefined) => string[]
): (field: string, raw: string | null | undefined) => string[] {
  const cache = new Map<string, string[]>()
  return (field, raw) => {
    if (!raw) return []
    const id = field + '\u0001' + raw
    let keys = cache.get(id)
    if (!keys) {
      keys = tagKeysFor(split(field, raw))
      cache.set(id, keys)
    }
    return keys
  }
}
