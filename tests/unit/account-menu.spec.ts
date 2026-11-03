import { test, expect } from '@playwright/test'
import { accountMenuItems } from '../../src/renderer/src/lib/accountMenu'

// The account chip's dropdown contents. The risk this covers is the menu
// offering entries that do nothing: Settings with no way to open it, or
// Account before its website URL is configured.

const labels = (o: Parameters<typeof accountMenuItems>[0]): string[] =>
  accountMenuItems(o).map((item) => item.label)

test('full menu: Settings, Account in that order', () => {
  expect(labels({ canOpenSettings: true, accountLinkConfigured: true })).toEqual([
    'Settings',
    'Account'
  ])
})

test('there is no Profile entry', () => {
  const all = accountMenuItems({ canOpenSettings: true, accountLinkConfigured: true })
  expect(all.map((i) => i.label)).not.toContain('Profile')
})

test('inside Settings (no way to open it) only Account is offered', () => {
  expect(labels({ canOpenSettings: false, accountLinkConfigured: true })).toEqual(['Account'])
})

test('Account is hidden until its website URL is configured', () => {
  expect(labels({ canOpenSettings: true, accountLinkConfigured: false })).toEqual(['Settings'])
})

test('nothing configured gives an empty list (Sign out is added by the chip)', () => {
  expect(labels({ canOpenSettings: false, accountLinkConfigured: false })).toEqual([])
})

test('no subscription or password-reset entries in the dropdown', () => {
  const all = accountMenuItems({ canOpenSettings: true, accountLinkConfigured: true })
  expect(all.map((i) => i.key)).not.toContain('portal')
  expect(all.map((i) => i.key)).not.toContain('passwordReset')
})
