import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useCustomFieldsStore } from '../store/useCustomFieldsStore'
import {
  MAPPING_TARGETS,
  MAPPING_TARGET_LABELS,
  MAX_CUSTOM_FIELDS,
  TARGET_NOTES,
  colorForIndex,
  keyForLabel
} from '../lib/customFields'

// Settings → Serato → Custom fields. The DJ makes their own tag fields (Mood,
// Vibe, Venue) and picks which file field each one shows up in inside Serato.
// The rule for how the values land in that field is in main/customFields.ts.

const NOT_IN_SERATO = '__none__'

const selectStyle: React.CSSProperties = {
  background: '#16161f',
  color: '#c0c0d8',
  border: '1px solid #252535',
  borderRadius: '6px',
  fontSize: '12px',
  padding: '4px 8px',
  height: '28px'
}

// A changed placement only reaches a file the next time that file is saved.
// Offer to bring every affected file up to date now, as one background job
// (the same one the bulk editor runs, so progress shows in the jobs panel).
function offerRewrite(key: string, label: string, targets: MappingTarget[]): void {
  if (targets.length === 0) return
  toast(`Update files already tagged with ${label}?`, {
    description: 'Files change the next time they are saved. You can update them all now instead.',
    duration: 12000,
    action: {
      label: 'Update files',
      onClick: () => {
        void window.api.customFields.rewriteFiles([key], targets).then((r) => {
          if (r.total === 0) toast(`No tracks have a ${label} yet, so there is nothing to update.`)
        })
      }
    }
  })
}

export function CustomFieldsSettings(): React.JSX.Element {
  const fields = useCustomFieldsStore((s) => s.fields)
  const loaded = useCustomFieldsStore((s) => s.loaded)
  const load = useCustomFieldsStore((s) => s.load)
  const save = useCustomFieldsStore((s) => s.save)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const draftKey = keyForLabel(draft.trim())
  const duplicate = draftKey !== null && fields.some((f) => f.key === draftKey)
  const full = fields.length >= MAX_CUSTOM_FIELDS
  const canAdd = loaded && draftKey !== null && !duplicate && !full

  async function persist(next: CustomField[]): Promise<boolean> {
    const r = await save(next)
    if (!r.ok) toast.error('Could not save custom fields', { description: r.error })
    return r.ok
  }

  async function addField(): Promise<void> {
    if (!canAdd || !draftKey) return
    const field: CustomField = {
      key: draftKey,
      label: draft.trim(),
      color: colorForIndex(fields.length),
      writeTo: null
    }
    if (await persist([...fields, field])) {
      setDraft('')
      toast.success(`${field.label} added`, {
        description: 'It shows in the track inspector. Pick where Serato shows it below.'
      })
    }
  }

  async function changeTarget(field: CustomField, value: string): Promise<void> {
    const writeTo = value === NOT_IN_SERATO ? null : (value as MappingTarget)
    if (writeTo === field.writeTo) return
    const next = fields.map((f) => (f.key === field.key ? { ...f, writeTo } : f))
    if (!(await persist(next))) return
    const touched = [field.writeTo, writeTo].filter((t): t is MappingTarget => t !== null)
    offerRewrite(field.key, field.label, touched)
  }

  async function removeField(field: CustomField): Promise<void> {
    if (!(await persist(fields.filter((f) => f.key !== field.key)))) return
    // The tags themselves are kept, so adding the field back with the same
    // name brings every value back with it.
    toast(`${field.label} removed`, {
      description: 'Its values are kept and come back if you add the field again.'
    })
    if (field.writeTo) offerRewrite(field.key, field.label, [field.writeTo])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {fields.length === 0 && loaded && (
        <div style={{ fontSize: '11px', color: '#555' }}>
          No custom fields yet. Try Mood, Vibe or Venue.
        </div>
      )}

      {fields.map((field) => (
        <div key={field.key} data-testid={`custom-field-${field.key}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: field.color,
                flexShrink: 0
              }}
            />
            <span style={{ fontSize: '12px', color: '#c0c0d8', minWidth: '90px' }}>
              {field.label}
            </span>
            <span style={{ fontSize: '11px', color: '#555' }}>Show in Serato as</span>
            <select
              aria-label={`Show ${field.label} in Serato as`}
              value={field.writeTo ?? NOT_IN_SERATO}
              onChange={(e) => void changeTarget(field, e.target.value)}
              style={selectStyle}
            >
              <option value={NOT_IN_SERATO}>Keep in DeepCrated only</option>
              {MAPPING_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {MAPPING_TARGET_LABELS[t]}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void removeField(field)}
              style={{ color: '#555', marginLeft: 'auto' }}
            >
              Remove
            </Button>
          </div>
          {field.writeTo && (
            <div style={{ fontSize: '10px', color: '#555', marginTop: '4px', marginLeft: '18px' }}>
              Added after any {MAPPING_TARGET_LABELS[field.writeTo]} values already there, e.g.
              &quot;GOTOS | DARK&quot;.
              {TARGET_NOTES[field.writeTo] ? ` ${TARGET_NOTES[field.writeTo]}` : ''}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        <Input
          value={draft}
          placeholder={full ? `Up to ${MAX_CUSTOM_FIELDS} fields` : 'New field, e.g. Mood'}
          disabled={!loaded || full}
          maxLength={32}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addField()
          }}
          style={{ height: '28px', fontSize: '12px', maxWidth: '220px' }}
        />
        <Button variant="outline" size="sm" disabled={!canAdd} onClick={() => void addField()}>
          Add field
        </Button>
      </div>
      {duplicate && (
        <div style={{ fontSize: '10px', color: '#555' }}>You already have that field.</div>
      )}
    </div>
  )
}
