// Reads a renderer preference stored under its current key, falling back to
// the key the app used before the DeepCrated rename. Writes always go to the
// new key, so a preference migrates the first time it is changed, and nothing
// the DJ already set is lost.
//
// TODO(deepcrated): delete the legacy fallback (and the cratecloud_* keys it
// reads) once no install predates the rename.
export function readPref(key: string, legacyKey: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(legacyKey)
  } catch {
    return null
  }
}
