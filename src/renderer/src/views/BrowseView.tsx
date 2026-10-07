import React from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { useBrowseStore } from '../store/useBrowseStore'
import { currentLocation } from '../lib/browse/nav'
import { getDimension } from '../lib/browse/registry'
import { BrowseHubView } from './BrowseHubView'
import { BrowseDimensionView } from './BrowseDimensionView'
import { BackButton, Message } from '../components/BrowseChrome'
import { BrowseTrackListView } from './BrowseTrackListView'
import { TagPageView } from './TagPageView'

// ── Browse ───────────────────────────────────────────────────────────────
// Chooses what to show from the browse store's current location:
//   hub → dimension page → results.
// Results for a tag-backed value reuse the existing TagPageView, so stacking
// tags (AND), "Narrow further", bulk actions and the list/grid toggle behave
// exactly as they do from Tags Cloud — only Back goes somewhere different.

export function BrowseView(): React.JSX.Element {
  const nav = useBrowseStore((s) => s.nav)
  const dispatch = useBrowseStore((s) => s.dispatch)
  const allTags = useLibraryStore((s) => s.tags)

  const location = currentLocation(nav)

  if (location.kind === 'hub') return <BrowseHubView />

  const dimension = getDimension(location.dimensionId)
  if (!dimension) {
    // A dimension that no longer exists (an old build's stored location can't
    // happen — nav is not persisted — but a registry change mid-session can).
    return (
      <Message
        title="That page is not available"
        detail="Go back to Browse all and pick another."
        action={<BackButton onClick={() => dispatch({ type: 'toHub' })}>← Browse all</BackButton>}
      />
    )
  }

  if (location.kind === 'dimension') return <BrowseDimensionView dimension={dimension} />

  if (location.tagIds.length > 0) {
    // Resolved against the live tag list: a tag deleted while this page is
    // open simply drops out of the filter.
    const tags = location.tagIds
      .map((id) => allTags.find((t) => t.id === id))
      .filter((t): t is Tag => t !== undefined)

    if (tags.length === 0) {
      return (
        <Message
          title="Those tags no longer exist"
          detail="They were deleted or merged."
          action={
            <BackButton onClick={() => dispatch({ type: 'back' })}>← {dimension.label}</BackButton>
          }
        />
      )
    }

    return (
      <TagPageView
        tags={tags}
        backLabel={`← ${dimension.label}`}
        onChange={(next) =>
          // Removing the last tag leaves nothing to filter by: go back, as the
          // Tags Cloud flow does, rather than fall through to another list.
          next.length === 0
            ? dispatch({ type: 'back' })
            : dispatch({ type: 'setResultTags', tagIds: next.map((t) => t.id) })
        }
        onBack={() => dispatch({ type: 'back' })}
      />
    )
  }

  return (
    <BrowseTrackListView
      dimension={dimension}
      valueKey={location.valueKey}
      label={location.label}
    />
  )
}
