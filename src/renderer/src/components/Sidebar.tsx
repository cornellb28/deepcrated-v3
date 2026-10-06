import React, { useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, Plus, MoreVertical, Pencil, Trash2, UploadCloud } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { DeleteCrateConfirmDialog } from './DeleteCrateConfirmDialog'
import { SeratoRunningConfirmDialog } from './SeratoRunningConfirmDialog'

// The kanban board view is gone — the status columns it showed are now
// tabs in the track tab bar (see lib/tabs.ts), built from the same boards
// rows. Boards remain the status system; only the view was removed.
type View = 'dashboard' | 'library' | 'tags' | 'folders' | 'crates' | 'settings'

interface SidebarProps {
  activeView: View
  onViewChange: (view: View) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  onOpenSettings: () => void
  selectedCrateId: number | null
  onSelectCrate: (id: number | null) => void
}

interface CrateNode extends Crate {
  children: CrateNode[]
}

function buildCrateTree(crates: Crate[]): CrateNode[] {
  const byId = new Map<number, CrateNode>(crates.map((c) => [c.id, { ...c, children: [] }]))
  const roots: CrateNode[] = []
  for (const node of byId.values()) {
    const parent = node.parent_crate_id !== null ? byId.get(node.parent_crate_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortByName = (nodes: CrateNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((n) => sortByName(n.children))
  }
  sortByName(roots)
  return roots
}

export function Sidebar({
  activeView,
  onViewChange,
  collapsed,
  onToggleCollapsed,
  onOpenSettings,
  selectedCrateId,
  onSelectCrate
}: SidebarProps): React.JSX.Element {
  const { tracks } = useLibraryStore()

  const navItem = (view: View, label: string, icon: string, count?: number): React.JSX.Element => {
    const isActive = activeView === view
    return (
      <button
        onClick={() => onViewChange(view)}
        title={collapsed ? label : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          width: '100%',
          padding: collapsed ? '7px 0' : '7px 12px',
          background: isActive ? '#1a1a26' : 'none',
          border: 'none',
          borderRadius: '6px',
          color: isActive ? '#a09be8' : '#666',
          fontSize: '13px',
          cursor: 'pointer',
          textAlign: 'left',
          borderRight: isActive ? '2px solid #7f77dd' : '2px solid transparent'
        }}
      >
        {collapsed ? (
          <span>{icon}</span>
        ) : (
          <>
            <span>{label}</span>
            {count !== undefined && (
              <span
                style={{
                  fontSize: '11px',
                  background: '#1e1e2a',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  color: '#444'
                }}
              >
                {count}
              </span>
            )}
          </>
        )}
      </button>
    )
  }

  const sectionLabel = (label: string): React.JSX.Element | null =>
    collapsed ? null : (
      <p
        style={{
          fontSize: '10px',
          fontWeight: 500,
          letterSpacing: '1px',
          textTransform: 'uppercase',
          color: '#333',
          margin: '0',
          padding: '6px 12px 4px'
        }}
      >
        {label}
      </p>
    )

  return (
    <div
      style={{
        width: collapsed ? '48px' : '200px',
        flexShrink: 0,
        background: '#12121a',
        borderRight: '0.5px solid #1e1e2a',
        padding: '12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        transition: 'width 0.15s ease',
        overflowY: 'auto'
      }}
    >
      {/* Collapse toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          padding: '4px 4px 8px'
        }}
      >
        {!collapsed && (
          <p
            style={{
              fontSize: '10px',
              fontWeight: 500,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: '#333',
              margin: 0
            }}
          >
            CrateCloud
          </p>
        )}
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            background: 'none',
            border: 'none',
            color: '#444',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '2px 4px',
            lineHeight: 1
          }}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {/* ── Browse section ───────────────────────── */}
      {sectionLabel('Browse')}

      {navItem('dashboard', 'Overview', '◉')}
      {navItem('library', 'All tracks', '♫', tracks.length)}
      {navItem('tags', 'Tags Cloud', '♪')}
      {navItem('folders', 'Folders', '⊟')}

      <CratesSection
        collapsed={collapsed}
        active={activeView === 'crates'}
        selectedCrateId={selectedCrateId}
        onOpen={() => onViewChange('crates')}
        onSelectCrate={(id) => {
          onViewChange('crates')
          onSelectCrate(id)
        }}
      />

      {/* Push settings to bottom */}
      <div style={{ flex: 1 }} />

      {/* Settings */}
      <button
        onClick={onOpenSettings}
        title={collapsed ? 'Settings' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: '8px',
          width: '100%',
          padding: collapsed ? '7px 0' : '7px 12px',
          background: activeView === 'settings' ? '#1a1a26' : 'none',
          border: 'none',
          borderRadius: '6px',
          color: activeView === 'settings' ? '#a09be8' : '#555',
          fontSize: '13px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span>⚙</span>
        {!collapsed && <span>Settings</span>}
      </button>
    </div>
  )
}

// ── Crates section ────────────────────────────────────────────────────────
// Nesting is via drag-and-drop only (dropping a crate row onto another one)
// — the spec allows drag OR a "move into" picker, and drag alone keeps this
// self-contained. Reuses the native-HTML5-DnD approach the old BoardView used
// for its cross-column card drag (draggable + onDragStart/onDragOver/onDrop
// state), just applied to nesting instead of board reassignment — there's
// no shared drag-and-drop library to reuse here.
function CratesSection({
  collapsed,
  active,
  selectedCrateId,
  onOpen,
  onSelectCrate
}: {
  collapsed: boolean
  active: boolean
  selectedCrateId: number | null
  onOpen: () => void
  onSelectCrate: (id: number | null) => void
}): React.JSX.Element {
  const { crates, upsertCrateLocally, patchCrateLocally, removeCrateLocally } = useLibraryStore()
  const [expanded, setExpanded] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Crate | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropTargetId, setDropTargetId] = useState<number | null>(null)
  const [seratoConfirmOpen, setSeratoConfirmOpen] = useState(false)
  const [exportingAll, setExportingAll] = useState(false)

  const tree = buildCrateTree(crates)

  async function runExportAll(): Promise<void> {
    setExportingAll(true)
    await window.api.crates.export(crates.map((c) => c.id))
    setExportingAll(false)
    toast.info('Exporting all crates — see the jobs panel for progress')
  }

  async function handleExportAllClick(): Promise<void> {
    if (crates.length === 0) return
    const running = await window.api.crates.isSeratoRunning()
    if (running) setSeratoConfirmOpen(true)
    else void runExportAll()
  }

  async function handleCreate(): Promise<void> {
    const trimmed = newName.trim()
    setNewName('')
    setCreating(false)
    if (!trimmed) return
    const result = await window.api.crates.insert(trimmed, null, '#7f77dd')
    if (result.ok && result.id !== undefined) {
      const now = Math.floor(Date.now() / 1000)
      upsertCrateLocally({
        id: result.id,
        name: trimmed,
        color: '#7f77dd',
        parent_crate_id: null,
        created_at: now,
        updated_at: now,
        last_exported_at: null,
        track_count: 0
      })
      onSelectCrate(result.id)
    } else {
      toast.error('Could not create crate', { description: result.error })
    }
  }

  async function commitRename(id: number): Promise<void> {
    const trimmed = renameValue.trim()
    setRenamingId(null)
    if (!trimmed) return
    const result = await window.api.crates.rename(id, trimmed)
    if (result.ok) patchCrateLocally(id, { name: trimmed })
    else toast.error('Could not rename crate', { description: result.error })
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return
    const result = await window.api.crates.delete(deleteTarget.id)
    if (result.ok) {
      removeCrateLocally(deleteTarget.id)
      if (selectedCrateId === deleteTarget.id) onSelectCrate(null)
      toast.success(`Deleted "${deleteTarget.name}"`)
    } else {
      toast.error('Could not delete crate', { description: result.error })
    }
    setDeleteTarget(null)
  }

  async function handleDropOnto(targetId: number): Promise<void> {
    const sourceId = draggingId
    setDraggingId(null)
    setDropTargetId(null)
    if (sourceId === null || sourceId === targetId) return
    const result = await window.api.crates.moveParent(sourceId, targetId)
    if (result.ok) patchCrateLocally(sourceId, { parent_crate_id: targetId })
    else toast.error(result.error ?? 'Could not nest crate')
  }

  // Dropping onto the "Crates" header itself un-nests back to top level.
  async function handleDropToRoot(): Promise<void> {
    const sourceId = draggingId
    setDraggingId(null)
    setDropTargetId(null)
    if (sourceId === null) return
    const crate = crates.find((c) => c.id === sourceId)
    if (!crate || crate.parent_crate_id === null) return
    const result = await window.api.crates.moveParent(sourceId, null)
    if (result.ok) patchCrateLocally(sourceId, { parent_crate_id: null })
    else toast.error(result.error ?? 'Could not move crate')
  }

  function renderNode(node: CrateNode, depth: number): React.ReactNode {
    const isSelected = active && selectedCrateId === node.id
    const isRenaming = renamingId === node.id
    const isDropTarget = dropTargetId === node.id && draggingId !== node.id

    return (
      <div key={node.id}>
        <div
          draggable={!isRenaming}
          onDragStart={(e) => {
            e.stopPropagation()
            setDraggingId(node.id)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (draggingId !== null && draggingId !== node.id) setDropTargetId(node.id)
          }}
          onDragLeave={() => setDropTargetId((id) => (id === node.id ? null : id))}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void handleDropOnto(node.id)
          }}
          onDragEnd={() => {
            setDraggingId(null)
            setDropTargetId(null)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%',
            padding: `5px 8px 5px ${12 + depth * 14}px`,
            background: isSelected ? '#1a1a26' : isDropTarget ? '#1e1b3a' : 'none',
            border: isDropTarget ? '1px dashed #7f77dd' : '1px solid transparent',
            borderRadius: '6px',
            color: isSelected ? '#a09be8' : '#666',
            fontSize: '12px',
            cursor: 'pointer',
            opacity: draggingId === node.id ? 0.4 : 1
          }}
          onClick={() => !isRenaming && onSelectCrate(node.id)}
          onMouseEnter={(e) => {
            if (!isSelected) e.currentTarget.style.color = '#999'
          }}
          onMouseLeave={(e) => {
            if (!isSelected) e.currentTarget.style.color = '#666'
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: node.color,
              flexShrink: 0
            }}
          />
          {isRenaming ? (
            <input
              autoFocus
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitRename(node.id)
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenamingId(null)
                }
              }}
              onBlur={() => void commitRename(node.id)}
              style={{
                flex: 1,
                minWidth: 0,
                background: '#14141c',
                border: '0.5px solid #7f77dd',
                borderRadius: '4px',
                color: '#e8e8f0',
                fontSize: '12px',
                padding: '2px 5px',
                fontFamily: 'inherit',
                outline: 'none'
              }}
            />
          ) : (
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {node.name}
            </span>
          )}
          {!isRenaming && (
            <>
              <span style={{ fontSize: '10px', color: '#444', flexShrink: 0 }}>
                {node.track_count ?? 0}
              </span>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  data-testid={`crate-menu-${node.id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenMenuId((id) => (id === node.id ? null : node.id))
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#444',
                    cursor: 'pointer',
                    padding: '2px',
                    display: 'flex'
                  }}
                >
                  <MoreVertical size={12} />
                </button>
                {openMenuId === node.id && (
                  <CrateRowMenu
                    onRename={() => {
                      setOpenMenuId(null)
                      setRenamingId(node.id)
                      setRenameValue(node.name)
                    }}
                    onDelete={() => {
                      setOpenMenuId(null)
                      setDeleteTarget(node)
                    }}
                    onClose={() => setOpenMenuId(null)}
                  />
                )}
              </div>
            </>
          )}
        </div>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  if (collapsed) {
    return (
      <button
        onClick={onOpen}
        title="Crates"
        style={{
          display: 'flex',
          justifyContent: 'center',
          width: '100%',
          padding: '7px 0',
          background: active ? '#1a1a26' : 'none',
          border: 'none',
          borderRadius: '6px',
          color: active ? '#a09be8' : '#666',
          fontSize: '13px',
          cursor: 'pointer'
        }}
      >
        ◫
      </button>
    )
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          if (draggingId !== null) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          void handleDropToRoot()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 8px 4px 12px'
        }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            background: 'none',
            border: 'none',
            color: '#333',
            fontSize: '10px',
            fontWeight: 500,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            cursor: 'pointer',
            padding: 0
          }}
        >
          <ChevronRight
            size={11}
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s' }}
          />
          Crates
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            onClick={() => void handleExportAllClick()}
            disabled={exportingAll || crates.length === 0}
            title="Export all crates to Serato"
            style={{
              background: 'none',
              border: 'none',
              color: '#444',
              cursor: exportingAll || crates.length === 0 ? 'default' : 'pointer',
              display: 'flex',
              opacity: exportingAll || crates.length === 0 ? 0.4 : 1
            }}
          >
            <UploadCloud size={13} />
          </button>
          <button
            onClick={() => setCreating(true)}
            title="New crate"
            style={{
              background: 'none',
              border: 'none',
              color: '#444',
              cursor: 'pointer',
              display: 'flex'
            }}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          {tree.map((node) => renderNode(node, 0))}

          {creating && (
            <input
              autoFocus
              value={newName}
              placeholder="Crate name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleCreate()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setCreating(false)
                  setNewName('')
                }
              }}
              onBlur={() => void handleCreate()}
              style={{
                margin: '2px 8px 2px 12px',
                background: '#14141c',
                border: '0.5px solid #7f77dd',
                borderRadius: '4px',
                color: '#e8e8f0',
                fontSize: '12px',
                padding: '4px 6px',
                fontFamily: 'inherit',
                outline: 'none'
              }}
            />
          )}
        </div>
      )}

      {deleteTarget && (
        <DeleteCrateConfirmDialog
          open
          crateName={deleteTarget.name}
          hasChildren={crates.some((c) => c.parent_crate_id === deleteTarget.id)}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <SeratoRunningConfirmDialog
        open={seratoConfirmOpen}
        onCancel={() => setSeratoConfirmOpen(false)}
        onConfirm={() => {
          setSeratoConfirmOpen(false)
          void runExportAll()
        }}
      />
    </div>
  )
}

function CrateRowMenu({
  onRename,
  onDelete,
  onClose
}: {
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    function handle(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    width: '100%',
    padding: '7px 10px',
    border: 'none',
    background: 'transparent',
    color: '#c0c0d8',
    fontSize: '11px',
    fontFamily: 'inherit',
    textAlign: 'left',
    cursor: 'pointer'
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        minWidth: '150px',
        background: '#1a1a26',
        border: '0.5px solid #252535',
        borderRadius: '7px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        zIndex: 300,
        overflow: 'hidden'
      }}
    >
      <button
        data-testid="crate-menu-rename"
        onClick={onRename}
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#252535')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <Pencil size={12} />
        Rename
      </button>
      <button
        data-testid="crate-menu-delete"
        onClick={onDelete}
        style={{ ...itemStyle, color: '#e08a80' }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#252535')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <Trash2 size={12} />
        Delete
      </button>
    </div>
  )
}

export type { View }
