// ── Browse navigation ────────────────────────────────────────────────────
// A stack of locations (hub → dimension → results) plus a remembered page
// state per dimension. Pure so the rules are testable: the thing the DJ
// notices is that Back returns to the page they left with the search text,
// sort and scroll position still there.
//
// Page state is keyed by DIMENSION, not by stack depth, so it survives the
// round trip hub → Artist → Aaliyah → back, and a second visit to the same
// dimension later in the session.

import type { BrowseSort } from './types'

export type BrowseLocation =
  | { kind: 'hub' }
  | { kind: 'dimension'; dimensionId: string }
  | {
      kind: 'results'
      dimensionId: string
      // Which value was opened. For a tag-backed value this is only the
      // starting point: the tag view stacks more tags, tracked in tagIds.
      valueKey: string
      label: string
      tagIds: number[]
    }

export interface PageState {
  search: string
  sort: BrowseSort
  group: string | null
  scrollTop: number
}

export interface BrowseNavState {
  // Never empty; stack[0] is always the hub.
  stack: BrowseLocation[]
  pages: Record<string, PageState>
}

export const DEFAULT_PAGE: PageState = { search: '', sort: 'name', group: null, scrollTop: 0 }

export const INITIAL_NAV: BrowseNavState = { stack: [{ kind: 'hub' }], pages: {} }

export type BrowseNavAction =
  | { type: 'open'; location: BrowseLocation }
  | { type: 'back' }
  | { type: 'toHub' }
  // Jump to a stack position (breadcrumb click): keeps everything up to it.
  | { type: 'popTo'; depth: number }
  | { type: 'setPage'; dimensionId: string; patch: Partial<PageState> }
  | { type: 'setResultTags'; tagIds: number[] }

export function currentLocation(state: BrowseNavState): BrowseLocation {
  return state.stack[state.stack.length - 1]
}

export function pageFor(state: BrowseNavState, dimensionId: string): PageState {
  return state.pages[dimensionId] ?? DEFAULT_PAGE
}

export function navReducer(state: BrowseNavState, action: BrowseNavAction): BrowseNavState {
  switch (action.type) {
    case 'open':
      return { ...state, stack: [...state.stack, action.location] }
    case 'back':
      return state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : state
    case 'toHub':
      return { ...state, stack: [state.stack[0]] }
    case 'popTo': {
      const depth = Math.max(0, Math.min(action.depth, state.stack.length - 1))
      return { ...state, stack: state.stack.slice(0, depth + 1) }
    }
    case 'setPage':
      return {
        ...state,
        pages: {
          ...state.pages,
          [action.dimensionId]: {
            ...pageFor(state, action.dimensionId),
            ...action.patch
          }
        }
      }
    case 'setResultTags': {
      const top = currentLocation(state)
      if (top.kind !== 'results') return state
      return {
        ...state,
        stack: [...state.stack.slice(0, -1), { ...top, tagIds: action.tagIds }]
      }
    }
  }
}

export interface Crumb {
  label: string
  // Stack index to pop to when the crumb is clicked.
  depth: number
}

// The breadcrumb trail for the current stack: "Browse all", then the
// dimension, then the value. Labels come from the locations themselves, so a
// dimension the registry has since dropped still shows something sensible.
export function browseCrumbs(
  state: BrowseNavState,
  dimensionLabel: (dimensionId: string) => string | undefined
): Crumb[] {
  return state.stack.map((location, depth) => {
    switch (location.kind) {
      case 'hub':
        return { label: 'Browse all', depth }
      case 'dimension':
        return { label: dimensionLabel(location.dimensionId) ?? 'Browse', depth }
      case 'results':
        return { label: location.label, depth }
    }
  })
}
