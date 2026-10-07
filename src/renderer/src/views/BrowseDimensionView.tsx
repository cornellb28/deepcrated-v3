import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { useBrowseStore } from '../store/useBrowseStore'
import { pageFor } from '../lib/browse/nav'
import { distinctValueCount } from '../lib/browse/registry'
import { indexOfLetter, lettersPresent, listValues } from '../lib/browse/listing'
import type { BrowseDimension, BrowseSort, BrowseValue } from '../lib/browse/types'
import { VirtualValueGrid, type VirtualValueGridHandle } from '../components/VirtualValueGrid'
import { BrowseCard } from '../components/BrowseCard'
import { BROWSE_CARD_HEIGHT, browseCardColor } from '../lib/browse/cardStyle'
import { Message, Shell } from '../components/BrowseChrome'

// ── One dimension's page ─────────────────────────────────────────────────
// Search, sort, an optional field filter, and (for lists sorted by name) an
// A-Z jump bar over a virtualized grid of values. Cards for dimensions that
// are tags (the same card as the dashboard's Browse by genre), rows for the
// rest. Everything the DJ typed or scrolled is kept in the browse store, so
// Back from a value lands on exactly this page as it was left.

const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const ROW_HEIGHT = 40
const GAP = 10

interface Props {
  dimension: BrowseDimension
}

export function BrowseDimensionView({ dimension }: Props): React.JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const trackTags = useLibraryStore((s) => s.trackTags)
  const nav = useBrowseStore((s) => s.nav)
  const dispatch = useBrowseStore((s) => s.dispatch)

  const page = pageFor(nav, dimension.id)
  const gridRef = useRef<VirtualValueGridHandle>(null)
  const scrollTop = useRef(page.scrollTop)
  // Stacking several tags: ids ticked on the cards, opened together (AND).
  const [picked, setPicked] = useState<Set<number>>(new Set())

  // Remember where the DJ was scrolled to when they leave (open a value,
  // switch view, go back). The grid is restored from this on the next mount.
  useEffect(() => {
    return () => {
      dispatch({
        type: 'setPage',
        dimensionId: dimension.id,
        patch: { scrollTop: scrollTop.current }
      })
    }
  }, [dispatch, dimension.id])

  const values = useMemo(
    () => dimension.values({ tracks, trackTags }),
    [dimension, tracks, trackTags]
  )
  const listed = useMemo(
    () => listValues(values, { search: page.search, sort: page.sort, group: page.group }),
    [values, page.search, page.sort, page.group]
  )

  const groups = useMemo(
    () => [...new Set(values.map((v) => v.group).filter((g): g is string => !!g))].sort(),
    [values]
  )
  const letters = useMemo(() => lettersPresent(listed), [listed])

  const distinct = distinctValueCount(values)
  const isCards = dimension.presentation === 'cards'
  const showJumpBar = !isCards && page.sort === 'name' && listed.length > 0
  const filtered = page.search.trim() !== '' || page.group !== null

  // A new search, sort or filter is a different list: start it at the top.
  function changePage(
    patch: Partial<{ search: string; sort: BrowseSort; group: string | null }>
  ): void {
    scrollTop.current = 0
    dispatch({ type: 'setPage', dimensionId: dimension.id, patch: { ...patch, scrollTop: 0 } })
    gridRef.current?.scrollToItem(0)
  }

  function openValue(v: BrowseValue): void {
    dispatch({
      type: 'open',
      location: {
        kind: 'results',
        dimensionId: dimension.id,
        valueKey: v.key,
        label: v.label,
        tagIds: v.tag ? [v.tag.id] : []
      }
    })
  }

  function openPicked(): void {
    const chosen = values.filter((v) => v.tag && picked.has(v.tag.id))
    if (chosen.length === 0) return
    dispatch({
      type: 'open',
      location: {
        kind: 'results',
        dimensionId: dimension.id,
        valueKey: chosen[0].key,
        label: chosen.length === 1 ? chosen[0].label : `${chosen.length} tags`,
        tagIds: chosen.map((v) => v.tag!.id)
      }
    })
  }

  function togglePicked(tagId: number): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  // ── Empty states ─────────────────────────────────────────────────────
  if (tracks.length === 0) {
    return (
      <Shell dimension={dimension} onBack={() => dispatch({ type: 'back' })}>
        <Message
          title="Your library is empty"
          detail={`Import some music, then browse it by ${dimension.label.toLowerCase()}.`}
        />
      </Shell>
    )
  }
  if (values.length === 0) {
    return (
      <Shell dimension={dimension} onBack={() => dispatch({ type: 'back' })}>
        <Message title={`No ${dimension.noun} yet`} detail={dimension.emptyMessage} />
      </Shell>
    )
  }

  return (
    <Shell
      dimension={dimension}
      onBack={() => dispatch({ type: 'back' })}
      summary={
        filtered
          ? `${distinctValueCount(listed).toLocaleString()} of ${distinct.toLocaleString()} ${dimension.noun}`
          : `${distinct.toLocaleString()} ${dimension.noun}`
      }
    >
      {/* ── Controls ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 20px 8px',
          flexShrink: 0
        }}
      >
        <input
          type="search"
          value={page.search}
          onChange={(e) => changePage({ search: e.target.value })}
          placeholder={`Search ${dimension.noun}`}
          aria-label={`Search ${dimension.noun}`}
          style={{
            flex: '1 1 220px',
            maxWidth: '320px',
            background: '#13131b',
            border: '0.5px solid #252535',
            borderRadius: '6px',
            padding: '6px 10px',
            color: '#e8e8f0',
            fontSize: '12px',
            fontFamily: 'inherit',
            outline: 'none'
          }}
        />

        <div role="group" aria-label="Sort by" style={{ display: 'flex', gap: '4px' }}>
          {(['name', 'count'] as const).map((sort) => (
            <button
              key={sort}
              type="button"
              aria-pressed={page.sort === sort}
              onClick={() => changePage({ sort })}
              style={chip(page.sort === sort)}
            >
              {sort === 'name' ? 'Name' : 'Most tracks'}
            </button>
          ))}
        </div>

        {groups.length > 1 && (
          <div
            role="group"
            aria-label="Filter by field"
            style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}
          >
            <button
              type="button"
              aria-pressed={page.group === null}
              onClick={() => changePage({ group: null })}
              style={chip(page.group === null)}
            >
              All
            </button>
            {groups.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={page.group === g}
                onClick={() => changePage({ group: page.group === g ? null : g })}
                style={chip(page.group === g)}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Jump bar ─────────────────────────────────────────────── */}
      {showJumpBar && (
        <div
          role="group"
          aria-label="Jump to letter"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '2px',
            padding: '0 20px 8px',
            flexShrink: 0
          }}
        >
          {ALPHABET.map((letter) => {
            const has = letters.has(letter)
            return (
              <button
                key={letter}
                type="button"
                disabled={!has}
                aria-label={`Jump to ${letter === '#' ? 'numbers and symbols' : letter}`}
                onClick={() => {
                  const index = indexOfLetter(listed, letter)
                  if (index >= 0) gridRef.current?.scrollToItem(index)
                }}
                style={{
                  minWidth: '22px',
                  padding: '3px 0',
                  background: 'none',
                  border: 'none',
                  borderRadius: '4px',
                  color: has ? '#a09be8' : '#2e2e3a',
                  fontSize: '11px',
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  cursor: has ? 'pointer' : 'default'
                }}
              >
                {letter}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Multi-tag bar ────────────────────────────────────────── */}
      {picked.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            margin: '0 20px 8px',
            padding: '8px 12px',
            background: '#191521',
            border: '0.5px solid #7f77dd55',
            borderRadius: '8px',
            fontSize: '12px',
            color: '#c0c0d8',
            flexShrink: 0
          }}
        >
          <span>{picked.size} selected — tracks that carry all of them</span>
          <button type="button" onClick={openPicked} style={{ ...chip(true), marginLeft: 'auto' }}>
            Open
          </button>
          <button type="button" onClick={() => setPicked(new Set())} style={chip(false)}>
            Clear
          </button>
        </div>
      )}

      {/* ── Values ───────────────────────────────────────────────── */}
      {listed.length === 0 ? (
        <Message
          title={`No ${dimension.noun} match${page.search.trim() ? ` “${page.search.trim()}”` : ' these filters'}`}
          detail="Try a different search."
          action={
            <button
              type="button"
              onClick={() => changePage({ search: '', group: null })}
              style={chip(true)}
            >
              Clear search and filters
            </button>
          }
        />
      ) : (
        <VirtualValueGrid
          ref={gridRef}
          items={listed}
          getKey={(v) => v.key}
          minItemWidth={isCards ? 170 : null}
          rowHeight={isCards ? BROWSE_CARD_HEIGHT : ROW_HEIGHT}
          gap={isCards ? GAP : 2}
          initialScrollTop={page.scrollTop}
          onScrollTop={(top) => (scrollTop.current = top)}
          ariaLabel={`${dimension.label} values`}
          renderItem={(v, index, { tabIndex }) =>
            isCards ? (
              <BrowseCard
                label={v.label}
                count={v.count}
                color={v.kind === 'bucket' ? '#3a3a4a' : browseCardColor(v.key)}
                onClick={() => openValue(v)}
                ariaLabel={`Browse ${v.count} tracks: ${v.label}`}
                title={`Show all ${v.count} tracks — ${v.label}`}
                tabIndex={tabIndex}
                index={index}
                selected={v.tag ? picked.has(v.tag.id) : undefined}
                onToggleSelected={v.tag ? () => togglePicked(v.tag!.id) : undefined}
              />
            ) : (
              <ValueRow value={v} index={index} tabIndex={tabIndex} onOpen={() => openValue(v)} />
            )
          }
        />
      )}
    </Shell>
  )
}

function ValueRow({
  value,
  index,
  tabIndex,
  onOpen
}: {
  value: BrowseValue
  index: number
  tabIndex: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      tabIndex={tabIndex}
      data-browse-index={index}
      aria-label={`${value.label}, ${value.count} ${value.count === 1 ? 'track' : 'tracks'}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        width: '100%',
        height: `${ROW_HEIGHT}px`,
        padding: '0 12px',
        background: value.kind === 'bucket' ? '#101018' : '#13131b',
        border: '0.5px solid #1e1e2a',
        borderRadius: '6px',
        color: value.kind === 'bucket' ? '#8a8a9a' : '#e8e8f0',
        fontSize: '13px',
        fontStyle: value.kind === 'bucket' ? 'italic' : 'normal',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer'
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value.label}
      </span>
      <span style={{ fontSize: '11px', color: '#555', flexShrink: 0 }}>
        {value.count.toLocaleString()}
      </span>
    </button>
  )
}

function chip(active: boolean): React.CSSProperties {
  return {
    background: active ? '#7f77dd22' : 'none',
    border: `0.5px solid ${active ? '#7f77dd88' : '#252535'}`,
    borderRadius: '999px',
    color: active ? '#a09be8' : '#666',
    fontSize: '11px',
    padding: '4px 10px',
    cursor: 'pointer',
    fontFamily: 'inherit'
  }
}
