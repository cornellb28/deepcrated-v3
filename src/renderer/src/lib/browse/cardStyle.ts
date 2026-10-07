// The coloured card the dashboard's "Browse by genre" row uses, lifted out so
// the Browse pages render exactly the same thing. Markup and styles are the
// dashboard's own, unchanged.
export const BROWSE_CARD_COLORS = ['#c13b6b', '#6250bd', '#147ca3', '#bd5e27', '#25825f']

// Same palette, picked by a stable hash of the card's key instead of its
// position, for lists that get filtered and re-sorted: position-based colours
// would reshuffle every time the search box changes.
export function browseCardColor(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return BROWSE_CARD_COLORS[hash % BROWSE_CARD_COLORS.length]
}

export const BROWSE_CARD_HEIGHT = 112
