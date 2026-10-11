// ── Third-party notices ───────────────────────────────────────────────────
// Licence texts for software DeepCrated ships alongside itself, one folder
// per component under resources/licenses/ (shown in Settings > About).
// Read-only, plain text, nothing user-supplied.
//
// TODO(licences): only Chromaprint/fpcalc is listed so far. Electron,
// Chromium, the Python sidecar's libraries (librosa, numba, mutagen, …) and
// the npm dependencies need notices here too before a public release.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export interface NoticeFile {
  name: string
  text: string
}

export interface ThirdPartyNotice {
  id: string
  // The NOTICE.md heading if there is one, else the folder name.
  title: string
  files: NoticeFile[]
}

// Same in dev and packaged: resources/ sits two levels above out/main and
// is inside app.asar (unpacked), which fs reads transparently.
export const LICENCES_DIR = join(__dirname, '..', '..', 'resources', 'licenses')

export function readThirdPartyNotices(dir: string = LICENCES_DIR): ThirdPartyNotice[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((id) => statSync(join(dir, id)).isDirectory())
    .sort()
    .map((id) => {
      const files = readdirSync(join(dir, id))
        .filter((name) => statSync(join(dir, id, name)).isFile())
        // NOTICE first: it says what the component is and how to get source.
        .sort((a, b) => (a === 'NOTICE.md' ? -1 : b === 'NOTICE.md' ? 1 : a.localeCompare(b)))
        .map((name) => ({ name, text: readFileSync(join(dir, id, name), 'utf8') }))
      const notice = files.find((f) => f.name === 'NOTICE.md')
      const heading = notice ? /^#\s+(.+)$/m.exec(notice.text)?.[1] : undefined
      return { id, title: heading?.split(' — ')[0] ?? id, files }
    })
}
