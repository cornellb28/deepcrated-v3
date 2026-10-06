// Types for the MAIN_VITE_ variables electron-vite inlines into the main
// bundle. Without this, import.meta.env.MAIN_VITE_* is `any` and a typo in
// a variable name compiles cleanly and fails at runtime.
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
