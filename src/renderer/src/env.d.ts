/// <reference types="vite/client" />

// electron-vite exposes renderer variables under the RENDERER_VITE_ prefix,
// inlined at build time. Typed here so a misspelled name is a compile error
// rather than a silently-undefined value at runtime.
interface ImportMetaEnv {
  // Where "Upgrade" in Settings sends the DJ — the payments website, once it
  // exists. Optional on purpose: unset, the section renders as "Coming soon"
  // with the button disabled rather than opening a dead link.
  readonly RENDERER_VITE_UPGRADE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
