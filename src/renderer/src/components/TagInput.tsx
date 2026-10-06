import React, { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { useLibraryStore } from '../store/useLibraryStore'
import { Badge } from './ui/badge'
import { fieldToMetaKey, withTrackIdentity } from '../lib/tagMeta'

interface TagInputProps {
  trackId: number
  field: string // 'comment' | 'grouping' | 'remixer'
  label: string // display label e.g. "Comment tags"
  color?: string // badge color for this field
}

export function TagInput({ trackId, field, label, color = '#7f77dd' }: TagInputProps): React.JSX.Element {
  const { tags: allTags } = useLibraryStore()

  const [appliedTags, setAppliedTags] = useState<Tag[]>([])
  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Available tags for this field from the store
  const availableTags = allTags.filter((t) => t.field === field)

  // Filtered suggestions based on query
  const suggestions = availableTags.filter((t) => t.value.toLowerCase().includes(query.toLowerCase()) && !appliedTags.find((a) => a.id === t.id)
  )

  // Whether to show "Create X" option
  const queryNormalized = query.trim().toUpperCase()
  const showCreate = queryNormalized.length > 0 && !availableTags.find((t) => t.value === queryNormalized)

  // Load applied tags for this track on mount
  useEffect(() => {
    // Read from store cache first — Inspector preloads all tags
    // so badges appear instantly without waiting for IPC
    const cached = useLibraryStore.getState().trackTags.get(trackId)
    if (cached) {
      setAppliedTags(cached.filter((t: Tag) => t.field === field))
      setLoading(false)
      return
    }

    // Cache miss — fetch from DB
    async function load(): Promise<void> {
      setLoading(true)
      const result = await window.api.tags.forTrack(trackId)
      setAppliedTags(result.filter((t: Tag) => t.field === field))
      useLibraryStore.getState().setTrackTags(trackId, result)
      setLoading(false)
    }
    load()
  }, [trackId, field])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Write all current tags for this field back to the track row AND to the
  // file on disk. Both are needed: the tags/track_tags tables drive the
  // badges, the tracks column drives the library list and everything that
  // reads a track's metadata, and the file's own tags are the only thing
  // Serato or Finder will ever see.
  async function writeFieldToDisk(currentTags: Tag[]): Promise<void> {
    const store = useLibraryStore.getState()
    const track = store.tracks.find((t) => t.id === trackId)
    if (!track) return

    // One call, one transaction in main: the pivot rows for this field and
    // the derived tracks.<field> column move together, and the joined value
    // comes back so the file write below does not need a read.
    //
    // This used to be an optimistic store write plus a separate
    // updateTrackMeta, with the join done here — three steps that could each
    // fail on their own and leave the badges and the library list disagreeing.
    // See setTagsForField in main/db.ts.
    const result = await window.api.tags.setForField(
      trackId,
      field,
      currentTags.map((t) => t.value)
    )

    if (!result.ok) {
      toast.error('Could not save tag', { description: result.error ?? 'Unknown error' })
      return
    }

    const value = result.derived ?? null
    store.updateTrack(trackId, { [field]: value } as Partial<Track>)

    const fileWrite = await window.api.writeTags(
      track.filepath,
      withTrackIdentity(track, { [fieldToMetaKey(field)]: value ?? '' })
    )

    if (!fileWrite.ok) {
      toast.error('Could not save tag to file', { description: fileWrite.error ?? 'Unknown error' })
      return
    }
    const fileResult = fileWrite.results?.[0] as { success?: boolean; error?: string } | undefined
    if (fileResult && fileResult.success === false) {
      toast.error('Could not save tag to file', { description: fileResult.error ?? 'Unknown error' })
    }
  }

  // Apply an existing tag to the track
  // In applyTag — after optimistic update:
  async function applyTag(tag: Tag): Promise<void> {
    const updated = [...appliedTags, tag]
    setAppliedTags(updated)
    setQuery('')
    setDropdownOpen(false)

    // Sync full track tags to store so cache is fresh on remount
    const allCurrent = useLibraryStore.getState().trackTags.get(trackId) ?? []
    const merged = [...allCurrent.filter((t) => t.id !== tag.id), tag]
    useLibraryStore.getState().setTrackTags(trackId, merged)

    const result = await window.api.tags.apply(trackId, tag.id)
    if (!result.ok) {
      setAppliedTags((prev) => prev.filter(t => t.id !== tag.id))
      useLibraryStore.getState().setTrackTags(trackId, allCurrent)
      return
    }
    // Write all tags for this field to disk
    await writeFieldToDisk(updated)
  }

  // In removeAppliedTag — after optimistic update:
  async function removeAppliedTag(tag: Tag): Promise<void> {
    const updated = appliedTags.filter(t => t.id !== tag.id)
    setAppliedTags(updated)

    // Sync to store
    const allCurrent = useLibraryStore.getState().trackTags.get(trackId) ?? []
    const merged = allCurrent.filter((t) => t.id !== tag.id)
    useLibraryStore.getState().setTrackTags(trackId, merged)

    const result = await window.api.tags.remove(trackId, tag.id)
    if (!result.ok) {
      setAppliedTags((prev) => [...prev, tag])
      useLibraryStore.getState().setTrackTags(trackId, allCurrent)
      return
    }
    // Write updated tags for this field to disk
    await writeFieldToDisk(updated)
  }

  // Create a new tag and apply it
  async function createAndApply(): Promise<void> {
    if (!queryNormalized) return

    // Find or create the tag
    const result = await window.api.tags.findOrCreate(field, queryNormalized, color)
    if (!result.ok || !result.id) return

    const newTag: Tag = {
      id: result.id,
      field,
      value: queryNormalized,
      color,
      created_at: Date.now()
    }

    // Add to store so it appears in future searches
    useLibraryStore.getState().addTag(newTag)

    // Apply to track
    await applyTag(newTag)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) {
        applyTag(suggestions[0])
      } else if (showCreate) {
        createAndApply()
      }
    }
    if (e.key === 'Escape') {
      setDropdownOpen(false)
      setQuery('')
    }
    if (e.key === 'Backspace' && query === '' && appliedTags.length > 0) {
      // Remove last tag on backspace when input is empty
      removeAppliedTag(appliedTags[appliedTags.length - 1])
    }
  }

  return (
    <div ref={wrapRef} style={{ marginBottom: '12px' }}>

      {/* Section label */}
      <div style={{
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: '#444',
        marginBottom: '6px'
      }}>
        {label}
      </div>

      {/* Applied badges */}
      {appliedTags.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          marginBottom: '6px',
        }}>
          {appliedTags.map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              style={{
                background: tag.color + '22',
                color: tag.color,
                borderColor: tag.color + '44',
                fontSize: '11px',
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                paddingRight: '4px'
              }}
            >
              {tag.value}
              <button
                onClick={() => removeAppliedTag(tag)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: tag.color,
                  cursor: 'pointer',
                  padding: '0 2px',
                  fontSize: '12px',
                  lineHeight: 1,
                  opacity: 0.7,
                  fontFamily: 'inherit'
                }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '0.7'}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Search input */}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setDropdownOpen(true)
          }}
          onFocus={() => setDropdownOpen(true)}
          onKeyDown={onKeyDown}
          disabled={loading}
          placeholder={loading ? 'Loading tags...' : 'Search or add tag...'}
          style={{
            width: '100%',
            background: '#1a1a26',
            border: '0.5px solid #252535',
            borderRadius: dropdownOpen && (suggestions.length > 0 || showCreate)
              ? '6px 6px 0 0'
              : '6px',
            padding: '5px 10px',
            color: '#c0c0d8',
            fontSize: '12px',
            fontFamily: 'monospace',
            outline: 'none',
          }}
          onFocusCapture={(e) => e.target.style.borderColor = color}
          onBlurCapture={(e) => e.target.style.borderColor = '#252535'}
        />

        {/* Dropdown */}
        {dropdownOpen && (suggestions.length > 0 || showCreate) && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#1e1e2a',
            border: `0.5px solid ${color}44`,
            borderTop: 'none',
            borderRadius: '0 0 6px 6px',
            zIndex: 100,
            maxHeight: '180px',
            overflowY: 'auto',
          }}>
            {/* Existing tag suggestions */}
            {suggestions.map((tag) => (
              <div
                key={tag.id}
                onClick={() => applyTag(tag)}
                style={{
                  padding: '7px 10px',
                  fontSize: '12px',
                  color: '#c0c0d8',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#252535'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: color,
                  flexShrink: 0,
                }} />
                {tag.value}
              </div>
            ))}

            {/* Create new tag option */}
            {showCreate && (
              <div
                onClick={createAndApply}
                style={{
                  padding: '7px 10px',
                  fontSize: '12px',
                  color: color,
                  cursor: 'pointer',
                  borderTop: suggestions.length > 0 ? '0.5px solid #252535' : 'none',
                  fontWeight: 500,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#252535'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                + Create `{queryNormalized}`
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
