import { create } from 'zustand'

// The DJ's custom tag fields (Mood, Vibe...) and where Serato shows them.
// Main owns the setting (main/customFields.ts); this is the renderer's copy,
// loaded once and replaced with whatever main hands back after a save, so
// the Inspector and Settings never disagree about which fields exist.
interface CustomFieldsState {
  fields: CustomField[]
  loaded: boolean
  load: () => Promise<void>
  save: (fields: CustomField[]) => Promise<{ ok: boolean; error?: string }>
}

export const useCustomFieldsStore = create<CustomFieldsState>((set, get) => ({
  fields: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return
    try {
      const fields = await window.api.customFields.get()
      set({ fields, loaded: true })
    } catch (err) {
      console.error('[customFields] load failed:', err)
      set({ loaded: true })
    }
  },
  save: async (fields) => {
    const r = await window.api.customFields.set(fields)
    if (r.ok && r.fields) set({ fields: r.fields })
    return { ok: r.ok, error: r.error }
  }
}))
