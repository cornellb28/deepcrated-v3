// Which entries the account chip's dropdown shows, besides "Sign out" (always
// last, not listed here). Pure so it can be unit tested without rendering.
//
// Settings needs the host to supply a way to open it, and is omitted when it
// has none. Account opens a website page and is hidden until that page's URL
// is configured.

export type AccountMenuKey = 'settings' | 'account'

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
    items.push({ key: 'settings', label: 'Settings' })
  }
  if (options.accountLinkConfigured) {
    items.push({ key: 'account', label: 'Account' })
  }
  return items
}
