import { useEffect, useState } from 'react'

// Content-addressed hashes never change what file they point to, so a
// resolved URL is safe to cache for the lifetime of the renderer — the only
// thing that could invalidate it is a manual orphan sweep, which nobody can
// trigger yet (see sweepOrphanedArtwork's TODO in main).
const resolvedUrlCache = new Map<string, string | null>()

// Resolves an artwork_hash to a ready-to-use `artwork://` URL via the main
// process — components never build artwork paths themselves.
export function useArtworkUrl(
  hash: string | null | undefined,
  size: 'full' | 'thumb'
): string | null {
  const cacheKey = hash ? `${size}:${hash}` : null
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hash || !cacheKey || resolvedUrlCache.has(cacheKey)) return

    let cancelled = false
    window.api.artwork.pathFor(hash, size).then((path) => {
      const resolved = path ? `artwork://${path}` : null
      resolvedUrlCache.set(cacheKey, resolved)
      if (!cancelled) setFetchedUrl(resolved)
    })

    return () => {
      cancelled = true
    }
  }, [hash, size, cacheKey])

  if (!cacheKey) return null
  // Already resolved (this render or a prior one, possibly for another
  // component instance sharing the same hash) — return it directly instead
  // of waiting on fetchedUrl state to catch up.
  if (resolvedUrlCache.has(cacheKey)) return resolvedUrlCache.get(cacheKey) ?? null
  return fetchedUrl
}
