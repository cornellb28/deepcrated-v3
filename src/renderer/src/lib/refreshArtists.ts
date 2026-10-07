import { useLibraryStore } from '../store/useLibraryStore'

// After artist names change in main (an import, an accepted suggestion, a
// batch), bring the renderer's copies back in step: the rows (tracks.artist
// was regenerated) and their tag badges.
export async function refreshArtists(trackIds?: number[]): Promise<void> {
  const store = useLibraryStore.getState()
  const tracks =
    trackIds && trackIds.length > 0
      ? await window.api.db.tracksByIds(trackIds)
      : await window.api.db.allTracks()
  if (trackIds && trackIds.length > 0) store.mergeTracks(tracks)
  else store.setTracks(tracks)
  const byTrack = await window.api.tags.forTracks(tracks.map((t) => t.id))
  store.setAllTrackTags(byTrack)
  // The tag list itself changes too (new canonical tags, removed raw ones).
  store.setTags(await window.api.tags.all())
}
