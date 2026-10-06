import { useCallback, useRef, useState } from 'react'

interface UseFileDropOptions {
  onDrop: (paths: string[]) => void
  // Gate for whether this target should currently react to drops at all
  // (e.g. FolderView while no folder is open). Still calls preventDefault
  // so a drop over a disabled target doesn't fall through to the window
  // and navigate the app to the file.
  accept?: boolean
}

interface UseFileDropResult {
  isDragging: boolean
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

// Finder drag-and-drop for one drop target. Modern Electron removed
// File.path, so paths are resolved through window.api.getPathForFile (the
// preload's webUtils.getPathForFile bridge) — never file.path, and never
// dataTransfer.items[i].webkitGetAsEntry() to walk directories here; main
// already has a folder walker and decides dir vs. audio vs. other itself
// (see fs:classify-paths) rather than the renderer guessing from a name.
export function useFileDrop({ onDrop, accept = true }: UseFileDropOptions): UseFileDropResult {
  const [isDragging, setIsDragging] = useState(false)
  // Counts nested enter/leave pairs so a child element's dragleave (which
  // fires before the parent's own dragenter on the same pointer move)
  // doesn't flicker isDragging off while still over the drop zone.
  const depth = useRef(0)

  const hasFiles = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (!accept) return
      // Same reason as the drop: a nested target owns the pointer, so the
      // shell must not also light up behind it.
      e.stopPropagation()
      depth.current++
      setIsDragging(true)
    },
    [accept]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
  }, [])

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (!accept) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setIsDragging(false)
    },
    [accept]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return // text/URL drops etc. — ignore, let it fall through
      e.preventDefault()
      depth.current = 0
      setIsDragging(false)

      // A target that is not accepting must NOT claim the drop — it has to
      // fall through to the app shell, which imports it. preventDefault
      // above still stops Electron navigating to the file.
      if (!accept) return

      // Claim it. The app shell is a drop target too (drop anywhere to
      // import), and without this a drop onto a folder would run BOTH
      // handlers — importing the files into the folder and then again as a
      // top-level import. The most specific target that will actually act
      // wins, which is the one the pointer is over.
      e.stopPropagation()

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      const paths = files
        .map((f) => window.api.getPathForFile(f))
        .filter((p): p is string => !!p)
      if (paths.length > 0) onDrop(paths)
    },
    [accept, onDrop]
  )

  return {
    isDragging,
    dropHandlers: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop: handleDrop
    }
  }
}
