import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// ── A virtualized grid (or, with one column, list) of browse values ───────
// Only the rows near the viewport are in the DOM, so a library with thousands
// of artists or tags costs the same as one with fifty. Columns follow the
// container's own width, like VirtualizedTrackGrid.
//
// Keyboard: ONE item is a tab stop (roving tabindex); arrow keys move between
// items — left/right by one, up/down by a row — Home/End jump to the ends,
// PageUp/PageDown move a screenful. Enter or Space activates the focused item
// natively, because every item is a real <button>. Focus moves to an item that
// is scrolled out of the DOM by scrolling it in first.

export interface VirtualValueGridHandle {
  scrollToItem: (index: number) => void
}

interface VirtualValueGridProps<T> {
  items: readonly T[]
  getKey: (item: T) => string
  // null = a single-column list. For cards, the minimum card width; the
  // column count fills the container.
  minItemWidth: number | null
  rowHeight: number
  gap: number
  // Fires with the scroll offset so the caller can remember it. Called on
  // every scroll event, so the caller should keep it in a ref, not state.
  onScrollTop?: (top: number) => void
  initialScrollTop?: number
  ariaLabel: string
  renderItem: (item: T, index: number, focus: { tabIndex: number }) => React.ReactNode
}

function VirtualValueGridInner<T>(
  {
    items,
    getKey,
    minItemWidth,
    rowHeight,
    gap,
    onScrollTop,
    initialScrollTop = 0,
    ariaLabel,
    renderItem
  }: VirtualValueGridProps<T>,
  ref: React.ForwardedRef<VirtualValueGridHandle>
): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  // Set when an arrow key moved the active item, so focus follows it — but
  // not when it merely changed because the list did.
  const focusAfterRender = useRef(false)

  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columns =
    width > 0 && minItemWidth !== null
      ? Math.max(1, Math.floor((width + gap) / (minItemWidth + gap)))
      : 1
  const rowCount = Math.ceil(items.length / columns)
  const stride = rowHeight + gap

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => stride,
    overscan: 4,
    initialOffset: initialScrollTop
  })

  // If the list shrinks under the active item (a search narrowed it), the
  // active item is the last one that still exists.
  const safeActive = items.length === 0 ? 0 : Math.min(activeIndex, items.length - 1)

  const scrollToItem = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'start' })
    },
    [virtualizer, columns]
  )

  useImperativeHandle(ref, () => ({ scrollToItem }), [scrollToItem])

  useEffect(() => {
    if (!focusAfterRender.current) return
    focusAfterRender.current = false
    parentRef.current?.querySelector<HTMLElement>(`[data-browse-index="${safeActive}"]`)?.focus()
  })

  function move(to: number): void {
    if (items.length === 0) return
    const next = Math.max(0, Math.min(items.length - 1, to))
    setActiveIndex(next)
    focusAfterRender.current = true
    virtualizer.scrollToIndex(Math.floor(next / columns), { align: 'auto' })
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const visibleRows = Math.max(
      1,
      Math.floor((parentRef.current?.clientHeight ?? stride) / stride)
    )
    let target: number | null = null
    switch (e.key) {
      case 'ArrowRight':
        if (columns > 1) target = safeActive + 1
        break
      case 'ArrowLeft':
        if (columns > 1) target = safeActive - 1
        break
      case 'ArrowDown':
        target = safeActive + columns
        break
      case 'ArrowUp':
        target = safeActive - columns
        break
      case 'PageDown':
        target = safeActive + columns * visibleRows
        break
      case 'PageUp':
        target = safeActive - columns * visibleRows
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = items.length - 1
        break
    }
    if (target === null) return
    e.preventDefault()
    move(target)
  }

  return (
    <div
      ref={parentRef}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onScroll={(e) => onScrollTop?.(e.currentTarget.scrollTop)}
      style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const start = row.index * columns
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${rowHeight}px`,
                transform: `translateY(${row.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: `${gap}px`,
                alignContent: 'start'
              }}
            >
              {items.slice(start, start + columns).map((item, offset) => {
                const index = start + offset
                return (
                  <React.Fragment key={getKey(item)}>
                    {renderItem(item, index, { tabIndex: index === safeActive ? 0 : -1 })}
                  </React.Fragment>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// forwardRef erases the generic; this restores it.
export const VirtualValueGrid = forwardRef(VirtualValueGridInner) as <T>(
  props: VirtualValueGridProps<T> & { ref?: React.Ref<VirtualValueGridHandle> }
) => React.JSX.Element
