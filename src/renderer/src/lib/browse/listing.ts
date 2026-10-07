import type { BrowseSort, BrowseValue } from './types'

// Searching ignores case and accents ("beyonce" finds "Beyoncé") — unlike
// artist GROUPING, which keeps accents, because here a miss costs the DJ a
// retype and a false merge there would silently combine two artists.
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export interface ListingOptions {
  search: string
  sort: BrowseSort
  // Restrict to one tag field. null = all. Buckets are exempt: they exist so
  // that nothing is unreachable.
  group: string | null
}

// Filter, sort, and pin buckets last — whatever the sort and whatever the
// search matched. A bucket still has to match a search by its own label, so
// typing "zzz" does not leave "Untagged" hanging under an empty list.
export function listValues(values: readonly BrowseValue[], options: ListingOptions): BrowseValue[] {
  const query = foldForSearch(options.search.trim())

  const matches = values.filter((v) => {
    if (query !== '' && !foldForSearch(v.label).includes(query)) return false
    if (v.kind === 'value' && options.group !== null && v.group !== options.group) return false
    return true
  })

  const compare =
    options.sort === 'count'
      ? (a: BrowseValue, b: BrowseValue): number =>
          b.count - a.count || a.label.localeCompare(b.label)
      : (a: BrowseValue, b: BrowseValue): number => a.label.localeCompare(b.label)

  const real = matches.filter((v) => v.kind === 'value').sort(compare)
  const buckets = matches.filter((v) => v.kind === 'bucket').sort(compare)
  return [...real, ...buckets]
}

// The jump-bar letter for a label: its first letter, accents folded, or "#"
// for anything that does not start with one (digits, symbols).
export function jumpLetter(label: string): string {
  const first = foldForSearch(label.trim()).charAt(0).toUpperCase()
  return first >= 'A' && first <= 'Z' ? first : '#'
}

// Index of the first value (not bucket) whose jump letter is `letter`, or -1.
// Only meaningful for a name-sorted list; "#" entries sort first in
// localeCompare so they sit at the top, which matches where the bar puts "#".
export function indexOfLetter(values: readonly BrowseValue[], letter: string): number {
  return values.findIndex((v) => v.kind === 'value' && jumpLetter(v.label) === letter)
}

// Letters that have at least one entry, for greying out the rest of the bar.
export function lettersPresent(values: readonly BrowseValue[]): Set<string> {
  const present = new Set<string>()
  for (const v of values) if (v.kind === 'value') present.add(jumpLetter(v.label))
  return present
}
