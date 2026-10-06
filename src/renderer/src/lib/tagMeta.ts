// ── Building the payload for a tag write ──────────────────────────────────
// Every path that writes metadata into the audio file goes through here, so
// none of them can forget the identity tag or disagree about how a field
// maps onto edit_tags.py's meta keys.

// CRATECLOUD_ID is what lets a track survive a rename or a move: analyze.py
// reads it back as client_uuid and the reconcile pass matches on it before
// it falls back to size/duration fingerprinting. It only ever gets onto a
// file if a write puts it there, so every write puts it there.
//
// If the file already carries a different id, the main process retries the
// write without this field rather than failing the user's edit — see
// editTagsResolvingIdConflicts in main/index.ts.
export function withTrackIdentity(track: Track, meta: EditTagsMeta): EditTagsMeta {
  if (!track.client_uuid) return meta
  return { ...meta, cratecloud_id: track.client_uuid }
}

// A tag badge field's name is its edit_tags.py meta key in every case
// except key_camelot, which travels as `key`.
export function fieldToMetaKey(field: string): keyof EditTagsMeta {
  return (field === 'key_camelot' ? 'key' : field) as keyof EditTagsMeta
}

// The whole of a track's editable metadata, as the file should hold it.
// Used by the inspector, which writes every field on every save so a file
// that was never written before catches up in one go rather than only ever
// gaining the one field that was just typed.
export function fullTrackMeta(track: Track, overrides: EditTagsMeta = {}): EditTagsMeta {
  return withTrackIdentity(track, {
    title: track.title ?? undefined,
    artist: track.artist ?? undefined,
    album: track.album ?? undefined,
    genre: track.genre ?? undefined,
    bpm: track.bpm ?? undefined,
    key: track.key_camelot ?? undefined,
    year: track.year ?? undefined,
    remixer: track.remixer ?? undefined,
    grouping: track.grouping ?? undefined,
    composer: track.composer ?? undefined,
    comment: track.comment ?? undefined,
    label: track.label ?? undefined,
    ...overrides
  })
}
