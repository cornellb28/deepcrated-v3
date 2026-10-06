import React, { useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Trash2 } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { Badge } from '@renderer/components/ui/badge'
import { TagEditDialog } from '../components/TagEditDialog'

// Fields in alphabetical order
const FIELD_ORDER = [
  { field: 'album', label: 'Album' },
  { field: 'artist', label: 'Artist' },
  { field: 'comment', label: 'Comment' },
  { field: 'composer', label: 'Composer' },
  { field: 'genre', label: 'Genre' },
  { field: 'grouping', label: 'Grouping' },
  { field: 'label', label: 'Label' },
  { field: 'remixer', label: 'Remixer' }
]

interface TagsCloudViewProps {
  onTagSelect: (tag: Tag) => void
}

export function TagsCloudView({ onTagSelect }: TagsCloudViewProps): React.JSX.Element {
  const { tags } = useLibraryStore()

  // Track counts per tag — computed from trackTags map
  const { trackTags } = useLibraryStore()
  const tagCounts = new Map<number, number>()
  trackTags.forEach((tagList) => {
    tagList.forEach((tag) => {
      tagCounts.set(tag.id, (tagCounts.get(tag.id) ?? 0) + 1)
    })
  })

  // Which accordion sections are open — comment open by default
  const [openFields, setOpenFields] = useState<Set<string>>(new Set(['comment']))

  const [hoveredTagId, setHoveredTagId] = useState<number | null>(null)
  // The tag being renamed or deleted, with the track count it had when the
  // dialog opened — the dialog says how many tracks a change will touch, and
  // recomputing that mid-dialog would make the number move under the DJ.
  const [editing, setEditing] = useState<{
    tag: Tag
    count: number
    mode: 'rename' | 'delete'
  } | null>(null)

  // Both operations change tracks, so the whole library slice is refetched
  // rather than patched — a rename can merge two tags and a delete can clear
  // a derived column on any number of rows.
  async function refreshAfterChange(): Promise<void> {
    const store = useLibraryStore.getState()
    const [allTracks, allTags] = await Promise.all([
      window.api.db.allTracks(),
      window.api.tags.all()
    ])
    store.setTracks(allTracks)
    store.setTags(allTags)
    const byTrack = await window.api.tags.forTracks(allTracks.map((t) => t.id))
    store.setAllTrackTags(byTrack)
  }

  async function handleRename(newValue: string): Promise<void> {
    if (!editing) return
    const result = await window.api.tags.rename(editing.tag.id, newValue)
    if (!result.ok) {
      toast.error('Could not rename the tag', { description: result.error })
      return
    }
    await refreshAfterChange()
    toast.success(
      result.mergedInto
        ? `Merged into “${newValue}”`
        : `Renamed to “${newValue}”`,
      {
        description: result.tracksUpdated
          ? `${result.tracksUpdated} track${result.tracksUpdated === 1 ? '' : 's'} updated.`
          : undefined
      }
    )
    setEditing(null)
  }

  async function handleDelete(): Promise<void> {
    if (!editing) return
    const result = await window.api.tags.delete(editing.tag.id)
    if (!result.ok) {
      toast.error('Could not delete the tag', { description: result.error })
      return
    }
    await refreshAfterChange()
    toast.success(`Deleted “${editing.tag.value}”`, {
      description: result.tracksUpdated
        ? `Removed from ${result.tracksUpdated} track${result.tracksUpdated === 1 ? '' : 's'}.`
        : undefined
    })
    setEditing(null)
  }

  function toggleField(field: string): void {
    setOpenFields((prev) => {
      const next = new Set(prev)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return next
    })
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px'
      }}
    >
      <div
        style={{
          fontSize: '13px',
          fontWeight: 500,
          color: '#e8e8f0',
          marginBottom: '16px'
        }}
      >
        Tags Cloud
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {FIELD_ORDER.map(({ field, label }) => {
          const fieldTags = tags
            .filter((t) => t.field === field)
            .sort((a, b) => {
              const countA = tagCounts.get(a.id) ?? 0
              const countB = tagCounts.get(b.id) ?? 0
              return countB - countA
            })

          if (fieldTags.length === 0) return null

          const isOpen = openFields.has(field)

          return (
            <div
              key={field}
              style={{
                background: '#13131b',
                border: '0.5px solid #1e1e2a',
                borderRadius: '8px',
                overflow: 'hidden'
              }}
            >
              {/* Accordion header */}
              <button
                onClick={() => toggleField(field)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#c0c0d8' }}>
                    {label}
                  </span>
                  <span
                    style={{
                      fontSize: '10px',
                      background: '#1e1e2a',
                      color: '#555',
                      padding: '1px 6px',
                      borderRadius: '10px'
                    }}
                  >
                    {fieldTags.length}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    color: '#444',
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s'
                  }}
                >
                  ▾
                </span>
              </button>

              {/* Tags */}
              {isOpen && (
                <div
                  style={{
                    padding: '0 14px 12px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px'
                  }}
                >
                  {fieldTags.map((tag) => {
                    const count = tagCounts.get(tag.id) ?? 0
                    return (
                      <span
                        key={tag.id}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                        onMouseEnter={() => setHoveredTagId(tag.id)}
                        onMouseLeave={() => setHoveredTagId(null)}
                      >
                      <Badge
                        variant="outline"
                        onClick={() => onTagSelect(tag)}
                        style={{
                          background: tag.color + '22',
                          color: tag.color,
                          borderColor: tag.color + '44',
                          fontSize: '11px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          padding: '3px 10px',
                          userSelect: 'none',
                          transition: 'all 0.1s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = tag.color + '44'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = tag.color + '22'
                        }}
                      >
                        {tag.value}
                        {count > 0 && (
                          <span
                            style={{
                              marginLeft: '5px',
                              fontSize: '9px',
                              opacity: 0.7
                            }}
                          >
                            {count}
                          </span>
                        )}
                      </Badge>

                      {/* Shown on hover, not always: a cloud of hundreds of
                          tags with two controls each is unreadable. */}
                      {hoveredTagId === tag.id && (
                        <>
                          <IconAction
                            label={`Rename "${tag.value}"`}
                            onClick={() => setEditing({ tag, count, mode: 'rename' })}
                          >
                            <Pencil size={11} />
                          </IconAction>
                          <IconAction
                            label={`Delete "${tag.value}"`}
                            danger
                            onClick={() => setEditing({ tag, count, mode: 'delete' })}
                          >
                            <Trash2 size={11} />
                          </IconAction>
                        </>
                      )}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {editing && (
        <TagEditDialog
          open
          mode={editing.mode}
          tag={editing.tag}
          trackCount={editing.count}
          onRename={(value) => void handleRename(value)}
          onDelete={() => void handleDelete()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// A 16px action beside a tag. Small on purpose — it sits inside a wrapping
// row of badges and must not change their line height.
function IconAction({
  label,
  onClick,
  danger = false,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        // The badge beside this opens the tag's page on click; without this
        // the rename button would do that too.
        e.stopPropagation()
        onClick()
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        height: '16px',
        borderRadius: '3px',
        background: 'none',
        border: 'none',
        color: danger ? '#d8695d' : '#6a6a80',
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit'
      }}
    >
      {children}
    </button>
  )
}
