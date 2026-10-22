import { test, expect } from '@playwright/test'
import { WEBSITE_LINKS, isWebsiteLink, openWebsiteLink } from '../../src/main/websiteLinks'

// The renderer opens website pages by name; main owns the URL. These cover
// the two halves of that promise: a known name opens exactly its fixed page,
// and nothing else opens at all.

function recorder(): { opened: string[]; open: (url: string) => Promise<void> } {
  const opened: string[] = []
  return { opened, open: async (url) => void opened.push(url) }
}

test('each known name opens its fixed https page', async () => {
  for (const [name, url] of Object.entries(WEBSITE_LINKS)) {
    const { opened, open } = recorder()
    expect(await openWebsiteLink(name, open)).toEqual({ ok: true })
    expect(opened).toEqual([url])
  }
})

test('account and plans point at the real website routes', () => {
  expect(WEBSITE_LINKS.account).toBe('https://www.deepcrated.com/account')
  expect(WEBSITE_LINKS.plans).toBe('https://www.deepcrated.com/pricing')
})

test('every link is https with no query or fragment to carry user data', () => {
  for (const url of Object.values(WEBSITE_LINKS)) {
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('https:')
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
  }
})

test('unknown names, URLs and prototype keys are refused without opening anything', async () => {
  const refused: unknown[] = [
    'portal',
    'https://evil.example',
    'file:///etc/passwd',
    '__proto__',
    'toString',
    'constructor',
    '',
    undefined,
    null,
    42,
    { name: 'account' }
  ]
  for (const name of refused) {
    const { opened, open } = recorder()
    expect(isWebsiteLink(name)).toBe(false)
    const result = await openWebsiteLink(name, open)
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  }
})

test('a browser that fails to open is reported, without echoing the OS error', async () => {
  const result = await openWebsiteLink('account', async () => {
    throw new Error('no handler for https://www.deepcrated.com/account')
  })
  expect(result.ok).toBe(false)
  expect(result.error).toBe('Could not open your browser.')
})
