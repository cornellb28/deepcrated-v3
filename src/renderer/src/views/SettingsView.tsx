import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AuthPanel } from '@renderer/components/AuthPanel'
import { AccountProfile } from '@renderer/components/AccountProfile'
import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { ReconciliationModal } from '@renderer/components/ReconciliationModal'
import { SeratoImportConfirmDialog } from '@renderer/components/SeratoImportConfirmDialog'
import { useLibraryStore } from '../store/useLibraryStore'
import { FilenameTemplateEditor } from '../components/FilenameTemplateEditor'

// Settings as a full page rather than a modal. A modal was wrong for this:
// it capped the content at 440px with everything stacked in one scroll, and
// several of these actions (a library rescan, a Serato import) start
// long-running jobs the DJ then wants to watch — which a dialog sitting over
// the app actively gets in the way of.

interface SettingsViewProps {
  libraryRoots: LibraryRoot[]
  onRootsChanged: () => void
  // Passed down rather than fetched here so there is one source of auth truth
  // in the app (App.tsx's auth:changed subscription) instead of two that can
  // disagree. Nullable: there is no auth gate, so this page renders before
  // the stored session has finished restoring, and while signed out.
  auth: AuthState | null
  onAuthChanged: (state: AuthState) => void
  onBack: () => void
}

const SERATO_OVERRIDE_KEY = 'serato_library_override'
const SERATO_OVERWRITE_KEY = 'serato_overwrite_existing'
// Which tab was last open. Same app_settings mechanism useViewMode uses, so
// it survives a reload the same way the list/grid choice does. Exported
// because the Dashboard and empty-state "Sign in" controls write it before
// navigating here, which is how they land on Account rather than on
// whichever tab was open last.
export const SETTINGS_TAB_KEY = 'settings_tab'

type TabId = 'account' | 'library' | 'serato'
const TABS: { id: TabId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'library', label: 'Library' },
  { id: 'serato', label: 'Serato' }
]

function isTabId(value: string | null): value is TabId {
  return value === 'account' || value === 'library' || value === 'serato'
}

const UPGRADE_URL = import.meta.env.RENDERER_VITE_UPGRADE_URL

// One spacing scale for the whole page. Every gap below is one of these
// rather than a number picked per-element, which is what keeps three tabs of
// unrelated content reading as one page.
const SPACE = {
  page: '24px 32px', // matches DashboardView, so views line up as you switch
  afterHeader: '24px',
  betweenSections: '28px',
  betweenBlocks: '16px',
  betweenItems: '8px'
} as const

// Text stops being readable long before it stops fitting, so panels are
// measured rather than full-bleed — and a settings form that stretched to a
// 2000px window would be unusable.
const MEASURE = '620px'

const sectionLabel: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 500,
  letterSpacing: '0.8px',
  textTransform: 'uppercase',
  color: '#444',
  marginBottom: '4px'
}

// A titled block with optional supporting text. Every section on every tab
// uses one, so the vertical rhythm is the component's job rather than
// something each tab has to remember.
function Section({
  title,
  description,
  children,
  last = false
}: {
  title: string
  description?: string
  children: React.ReactNode
  last?: boolean
}): React.JSX.Element {
  return (
    <section style={{ marginBottom: last ? 0 : SPACE.betweenSections }}>
      <div style={sectionLabel}>{title}</div>
      {description && (
        <div
          style={{
            fontSize: '11px',
            color: '#555',
            lineHeight: 1.6,
            marginBottom: SPACE.betweenBlocks,
            maxWidth: '48ch'
          }}
        >
          {description}
        </div>
      )}
      {!description && <div style={{ height: '10px' }} />}
      {children}
    </section>
  )
}

// A bordered card — used for a library root row and the signed-in account
// block, which were previously styled separately despite being the same
// thing on screen.
function Card({
  children,
  style
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '12px 14px',
        background: '#1a1a26',
        border: '0.5px solid #252535',
        borderRadius: '6px',
        ...style
      }}
    >
      {children}
    </div>
  )
}

// Advertising, not gating. Nothing in the desktop app is locked — this
// describes the paid cloud surface, which is sold on the web and does not
// exist yet. There is deliberately no LockedView/LockBadge anywhere.
function UpgradeSection({
  entitlement
}: {
  entitlement: Entitlement | null
}): React.JSX.Element | null {
  // Any paid tier hides the pitch — deliberately not a list of paid plan
  // names, which would need editing every time the lineup changes.
  if (entitlement && entitlement.plan !== 'free') return null

  return (
    <div
      style={{
        marginTop: '16px',
        padding: '14px',
        background: '#16161f',
        border: '0.5px solid #252535',
        borderRadius: '6px'
      }}
    >
      <div style={{ fontSize: '12px', color: '#c0c0d8', marginBottom: '4px' }}>Cloud Sync</div>
      <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.6, marginBottom: '10px' }}>
        Keep your tags, crates and play history in sync across every machine — and browse them on
        your phone when mobile lands. Your audio files stay where they are.
      </div>
      <Button
        onClick={() => UPGRADE_URL && void window.api.openExternal(UPGRADE_URL)}
        disabled={!UPGRADE_URL}
        variant="outline"
        size="sm"
      >
        {UPGRADE_URL ? 'See plans' : 'Coming soon'}
      </Button>
    </div>
  )
}

export function SettingsView({
  libraryRoots,
  onRootsChanged,
  auth,
  onAuthChanged,
  onBack
}: SettingsViewProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('account')
  const [adding, setAdding] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const analysisProgress = useLibraryStore((s) => s.analysisProgress)
  const [signingOut, setSigningOut] = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [seratoImportPrompt, setSeratoImportPrompt] = useState<{
    folderPath: string
    seratoDir: string
  } | null>(null)
  const [seratoOverride, setSeratoOverride] = useState<string | null>(null)
  const [overwriteExisting, setOverwriteExisting] = useState(true)

  // On mount now, not on an `open` prop — this is a page, and it only
  // mounts when the DJ navigates to it.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.settings.get(SERATO_OVERRIDE_KEY),
      window.api.settings.get(SERATO_OVERWRITE_KEY),
      window.api.settings.get(SETTINGS_TAB_KEY)
    ]).then(([override, overwrite, storedTab]) => {
      if (cancelled) return
      setSeratoOverride(override || null)
      setOverwriteExisting(overwrite !== 'false')
      if (isTabId(storedTab)) setTab(storedTab)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function selectTab(next: string): void {
    if (!isTabId(next)) return
    setTab(next)
    void window.api.settings.set(SETTINGS_TAB_KEY, next)
  }

  async function handleChooseSeratoFolder(): Promise<void> {
    const folderPath = await window.api.openFolder()
    if (!folderPath) return
    await window.api.settings.set(SERATO_OVERRIDE_KEY, folderPath)
    setSeratoOverride(folderPath)
  }

  async function handleClearSeratoFolder(): Promise<void> {
    await window.api.settings.set(SERATO_OVERRIDE_KEY, '')
    setSeratoOverride(null)
  }

  async function handleToggleOverwrite(): Promise<void> {
    const next = !overwriteExisting
    setOverwriteExisting(next)
    await window.api.settings.set(SERATO_OVERWRITE_KEY, String(next))
  }

  async function addRoot(folderPath: string, importSeratoData: boolean): Promise<void> {
    setAdding(true)
    await window.api.roots.add(folderPath, importSeratoData)
    setAdding(false)
    onRootsChanged()
  }

  async function handleAddFolder(): Promise<void> {
    const folderPath = await window.api.openFolder()
    if (!folderPath) return

    const detection = await window.api.detectSeratoForFolder(folderPath)
    if (detection.found && detection.seratoDir) {
      setSeratoImportPrompt({ folderPath, seratoDir: detection.seratoDir })
      return
    }
    await addRoot(folderPath, false)
  }

  // No longer closes anything on the way out: signing out leaves the DJ on
  // this page, signed out, with the sign-in form in its place. There is no
  // auth gate to bounce them to.
  async function handleSignOut(): Promise<void> {
    setSigningOut(true)
    try {
      const result = await window.api.auth.signOut()
      onAuthChanged(result.state)
    } finally {
      setSigningOut(false)
    }
  }

  async function handleRescan(): Promise<void> {
    setRescanning(true)
    try {
      const result = await window.api.rescanLibrary()
      if (!result.ok) {
        toast.error('Rescan failed', { description: result.error })
        return
      }
      const parts: string[] = []
      if (result.imported) parts.push(`${result.imported} checked`)
      if (result.relinked) parts.push(`${result.relinked} relinked`)
      // Deliberately worded "missing", not "removed" — nothing was deleted.
      if (result.swept) parts.push(`${result.swept} now missing`)
      if (result.skippedRoots?.length) {
        parts.push(`${result.skippedRoots.join(', ')} offline — skipped`)
      }
      toast.success(`Rescanned ${result.roots} folder${result.roots === 1 ? '' : 's'}`, {
        description: parts.length > 0 ? parts.join(' · ') : 'Nothing changed.'
      })
      onRootsChanged()
    } finally {
      setRescanning(false)
    }
  }

  async function handleRemove(id: number): Promise<void> {
    await window.api.roots.remove(id)
    onRootsChanged()
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: SPACE.page,
        color: '#e8e8f0',
        fontFamily: 'inherit'
      }}
    >
      {/* Header: title left, the way out on the right. No rule under it —
          the tab strip's own border sits just below and two horizontal lines
          that close together read as clutter. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '24px',
          marginBottom: SPACE.afterHeader
        }}
      >
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 500, margin: 0 }}>Settings</h1>
          <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>
            Account, library folders and Serato
          </div>
        </div>

        <Button
          onClick={onBack}
          variant="outline"
          style={{
            fontSize: '13px',
            padding: '11px 20px',
            height: 'auto',
            flexShrink: 0,
            whiteSpace: 'nowrap'
          }}
        >
          ← Back to Dashboard
        </Button>
      </div>

      <Tabs value={tab} onValueChange={selectTab}>
        {/* The border spans the full width and the active tab sits on it,
            so the strip reads as attached to its panel rather than floating
            above it. */}
        <TabsList
          style={{
            width: '100%',
            borderBottom: '0.5px solid #1e1e2a',
            paddingBottom: '6px',
            gap: '2px'
          }}
        >
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div style={{ paddingTop: SPACE.afterHeader, maxWidth: MEASURE }}>
          {/* ── Account ─────────────────────────────────────────────── */}
          <TabsContent value="account">
            {auth === null || auth.user === null ? (
              <Section
                title="Account"
                description="CrateCloud is free and works without an account. Sign in only if you want Cloud Sync across your machines."
                last
              >
                <div style={{ maxWidth: '320px' }}>
                  <AuthPanel
                    configured={auth?.configured ?? false}
                    persistent={auth?.persistent ?? false}
                    onSignedIn={onAuthChanged}
                  />
                </div>
              </Section>
            ) : (
              <>
                <Section
                  title="Profile"
                  description="Your account and the tier it is on. Shown for transparency — nothing in the desktop app is locked behind it."
                >
                  <AccountProfile
                    user={auth.user}
                    entitlement={auth.entitlement}
                    // Merged into the auth state the app already holds, so a
                    // refresh here does not create a second, disagreeing copy
                    // of the entitlement.
                    onRefreshed={(entitlement) => onAuthChanged({ ...auth, entitlement })}
                    onSignOut={() => void handleSignOut()}
                    signingOut={signingOut}
                  />
                </Section>

                <UpgradeSection entitlement={auth.entitlement} />
              </>
            )}
          </TabsContent>

          {/* ── Library ─────────────────────────────────────────────── */}
          <TabsContent value="library">
            <Section
              title="Library folders"
              description="The folders CrateCloud watches. Each is scanned on import and kept current by the live watcher."
            >
              {libraryRoots.length === 0 ? (
                <div style={{ fontSize: '12px', color: '#444' }}>No folders registered yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.betweenItems }}>
                  {libraryRoots.map((root) => (
                    <Card key={root.id}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '12px', color: '#c0c0d8' }}>{root.name}</div>
                        <div
                          style={{
                            fontSize: '10px',
                            color: '#444',
                            marginTop: '2px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {root.path}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemove(root.id)}
                        title="Remove folder"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#555',
                          cursor: 'pointer',
                          fontSize: '13px',
                          flexShrink: 0,
                          padding: '4px'
                        }}
                      >
                        ✕
                      </button>
                    </Card>
                  ))}
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: SPACE.betweenItems,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginTop: SPACE.betweenBlocks
                }}
              >
                <Button onClick={handleAddFolder} disabled={adding} variant="outline" size="sm">
                  {adding ? 'Adding...' : '+ Add library folder'}
                </Button>

                <Button
                  onClick={() => void handleRescan()}
                  disabled={rescanning || libraryRoots.length === 0}
                  variant="outline"
                  size="sm"
                  title="Check every library folder against what is on disk. Nothing is deleted — files that have gone are marked missing."
                >
                  {rescanning ? 'Rescanning...' : '↺ Rescan Library'}
                </Button>
              </div>

              {/* The same run the toolbar bar is showing, with the same Stop.
                  A rescan is usually started from here, so this is where a DJ
                  looks when they want it to stop — expecting them to go find
                  the toolbar is the wrong way round. */}
              {analysisProgress !== null && analysisProgress.total > 0 && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '10px 12px',
                    background: '#16161f',
                    border: '0.5px solid #252535',
                    borderRadius: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: '#c0c0d8' }}>
                      Analyzing BPM + key — {analysisProgress.done} / {analysisProgress.total}
                    </div>
                    <div
                      style={{
                        marginTop: '6px',
                        background: '#1e1e2a',
                        borderRadius: '4px',
                        height: '3px',
                        overflow: 'hidden'
                      }}
                    >
                      <div
                        style={{
                          background: '#1d9e75',
                          height: '100%',
                          width: `${Math.round(
                            (analysisProgress.done / analysisProgress.total) * 100
                          )}%`,
                          transition: 'width 0.3s ease',
                          borderRadius: '4px'
                        }}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void window.api.stopAnalysis()}
                    variant="outline"
                    size="sm"
                    title="Stop analyzing — tracks already done are kept, the rest stay queued"
                    style={{ flexShrink: 0 }}
                  >
                    Stop
                  </Button>
                </div>
              )}
            </Section>

            <Section
              title="Filename template"
              description="What a renamed file is called. Used by the rename actions in the Folders view — nothing is renamed until you ask for it."
            >
              <FilenameTemplateEditor />
            </Section>

            <Section
              title="Pending changes"
              description="Files the watcher saw appear, move or vanish while the app was running, waiting on your review."
              last
            >
              <Button variant="outline" size="sm" onClick={() => setReconcileOpen(true)}>
                Review pending changes
              </Button>
            </Section>
          </TabsContent>

          {/* ── Serato ──────────────────────────────────────────────── */}
          <TabsContent value="serato">
            <Section
              title="Serato library"
              description="Where .crate files are written. Leave it on the default unless your Serato library lives somewhere unusual."
            >
              <div style={{ fontSize: '11px', color: '#c0c0d8', marginBottom: '4px' }}>
                {seratoOverride ?? 'Default'}
              </div>
              {!seratoOverride && (
                <div style={{ fontSize: '10px', color: '#444', marginBottom: SPACE.betweenBlocks }}>
                  ~/Music/_Serato_, or the volume root for tracks on another drive
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: SPACE.betweenItems,
                  marginTop: seratoOverride ? SPACE.betweenBlocks : 0
                }}
              >
                <Button onClick={() => void handleChooseSeratoFolder()} variant="outline" size="sm">
                  Choose folder…
                </Button>
                {seratoOverride && (
                  <Button
                    onClick={() => void handleClearSeratoFolder()}
                    variant="ghost"
                    size="sm"
                    style={{ color: '#555' }}
                  >
                    Reset to default
                  </Button>
                )}
              </div>
            </Section>

            <Section
              title="Export"
              description="What happens when a crate you export already exists in Serato."
              last
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '12px',
                  color: '#c0c0d8',
                  cursor: 'pointer'
                }}
              >
                <div
                  onClick={() => void handleToggleOverwrite()}
                  style={{
                    width: '30px',
                    height: '17px',
                    borderRadius: '10px',
                    background: overwriteExisting ? '#7f77dd' : '#252535',
                    position: 'relative',
                    flexShrink: 0,
                    transition: 'background 0.15s'
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: overwriteExisting ? '15px' : '2px',
                      width: '13px',
                      height: '13px',
                      borderRadius: '50%',
                      background: '#fff',
                      transition: 'left 0.15s'
                    }}
                  />
                </div>
                Overwrite existing crate of the same name
              </label>
            </Section>
          </TabsContent>
        </div>
      </Tabs>

      <ReconciliationModal open={reconcileOpen} onClose={() => setReconcileOpen(false)} />
      <SeratoImportConfirmDialog
        open={seratoImportPrompt !== null}
        seratoDir={seratoImportPrompt?.seratoDir ?? ''}
        onCancel={() => setSeratoImportPrompt(null)}
        onConfirm={(importSeratoData) => {
          const folderPath = seratoImportPrompt?.folderPath
          setSeratoImportPrompt(null)
          if (folderPath) void addRoot(folderPath, importSeratoData)
        }}
      />
    </div>
  )
}
