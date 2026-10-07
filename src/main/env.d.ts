// Types for the MAIN_VITE_ variables electron-vite inlines into the main
// bundle. Without this, import.meta.env.MAIN_VITE_* is `any` and a typo in
// a variable name compiles cleanly and fails at runtime.
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
  // Website destinations stay unset until the production website routes are
  // confirmed; renderer menu entries are hidden while their URL is blank.
  readonly MAIN_VITE_AUTH_URL?: string
  // POST endpoint that trades { key, verifier } for a session. Browser
  // sign-in stays hidden while this or MAIN_VITE_AUTH_URL is blank.
  readonly MAIN_VITE_DESKTOP_REDEEM_URL?: string
  readonly MAIN_VITE_AUTH_PASSWORD_RESET_URL?: string
  readonly MAIN_VITE_ACCOUNT_MANAGEMENT_URL?: string
  readonly MAIN_VITE_CUSTOMER_PORTAL_URL?: string
  // Optional online track identification (off by default, a Settings
  // toggle). Both must be set or the toggle is unavailable.
  readonly MAIN_VITE_ACOUSTID_API_KEY?: string
  readonly MAIN_VITE_MB_CONTACT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
