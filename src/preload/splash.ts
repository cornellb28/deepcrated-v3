// ── Launch screen preload ─────────────────────────────────────────────────
// The splash page (resources/splash.html) runs no script of its own; this
// fills it in. Read-only by design: it shows what main pushes over
// 'splash:stage' / 'splash:error' and can only ask main to retry or quit.
// It never reaches the database or anything else in main.

import { ipcRenderer } from 'electron'

type SplashState =
  { kind: 'stage'; text: string } | { kind: 'error'; title: string; detail: string }

// Messages can arrive before the DOM exists; keep the latest and apply it
// once it does.
let latest: SplashState | null = null

function render(): void {
  if (!latest || !document.body) return
  if (latest.kind === 'stage') {
    setText('status', latest.text)
    return
  }
  setText('error-title', latest.title)
  setText('error-detail', latest.detail)
  document.body.classList.add('failed')
  document.getElementById('retry')?.focus()
}

// textContent only: nothing main sends is ever parsed as HTML.
function setText(id: string, text: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

ipcRenderer.on('splash:stage', (_e, text: unknown) => {
  if (typeof text !== 'string' || latest?.kind === 'error') return
  latest = { kind: 'stage', text }
  render()
})

ipcRenderer.on('splash:error', (_e, payload: unknown) => {
  const p = (payload ?? {}) as { title?: unknown; detail?: unknown }
  latest = {
    kind: 'error',
    title: typeof p.title === 'string' ? p.title : "DeepCrated couldn't start",
    detail: typeof p.detail === 'string' ? p.detail : ''
  }
  render()
})

window.addEventListener('DOMContentLoaded', () => {
  const version = new URLSearchParams(location.search).get('version')
  if (version) setText('version', `v${version}`)
  document.getElementById('retry')?.addEventListener('click', () => {
    void ipcRenderer.invoke('splash:retry')
  })
  document.getElementById('quit')?.addEventListener('click', () => {
    void ipcRenderer.invoke('splash:quit')
  })
  render()
})
