// Which entries the account chip's dropdown shows, besides "Sign out" (always
// last, not listed here). Pure so it can be unit tested without rendering.
//
// Profile and Settings need the host to supply a way to open Settings; the
// copy of the chip inside Settings itself has none and so omits them. Account
// opens a website page and is hidden until that page's URL is configured.

export type AccountMenuKey = 'profile' | 'settings' | 'account'

export interface AccountMenuItem {
  key: AccountMenuKey
  label: string
}

export function accountMenuItems(options: {
  canOpenSettings: boolean
  accountLinkConfigured: boolean
}): AccountMenuItem[] {
  const items: AccountMenuItem[] = []
  if (options.canOpenSettings) {
    items.push({ key: 'profile', label: 'Profile' }, { key: 'settings', label: 'Settings' })
  }
  if (options.accountLinkConfigured) {
    items.push({ key: 'account', label: 'Account' })
  }
  return items
}
