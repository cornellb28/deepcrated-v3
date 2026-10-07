import { artistDimension, genreDimension, tagsDimension } from './dimensions'
import type { BrowseDimension, BrowseValue } from './types'

// The hub lists these in this order. A new dimension is one entry here.
//
// TODO(browse): label, album, year, key and BPM range are natural next
// dimensions; each is a BrowseDimension in dimensions.ts.
export const BROWSE_DIMENSIONS: readonly BrowseDimension[] = [
  genreDimension,
  tagsDimension,
  artistDimension
]

export function getDimension(id: string): BrowseDimension | undefined {
  return BROWSE_DIMENSIONS.find((d) => d.id === id)
}

// What a hub card reports: real values only. A bucket is a convenience, not
// something the DJ would count as "how many artists do I have".
export function distinctValueCount(values: readonly BrowseValue[]): number {
  return values.filter((v) => v.kind === 'value').length
}
