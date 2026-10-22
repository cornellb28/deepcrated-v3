/// <reference types="vite/client" />

// electron-vite exposes renderer variables under the RENDERER_VITE_ prefix,
// inlined at build time. Typed here so a misspelled name is a compile error
// rather than a silently-undefined value at runtime.
interface ImportMetaEnv {
  // None yet. Website pages are opened by name through main
  // (src/main/websiteLinks.ts), never from a renderer-supplied URL.
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
