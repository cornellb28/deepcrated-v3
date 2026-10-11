import { test, expect } from '@playwright/test'
import { join } from 'path'
import { REPO_ROOT } from '../helpers/paths'
import { readThirdPartyNotices } from '../../src/main/licenses'

// What Settings > About shows comes straight from resources/licenses/.

const notices = readThirdPartyNotices(join(REPO_ROOT, 'resources', 'licenses'))

test('the shipped fpcalc has its notice, licence text and source offer', () => {
  const chromaprint = notices.find((n) => n.id === 'chromaprint')
  expect(chromaprint, 'resources/licenses/chromaprint').toBeTruthy()
  expect(chromaprint?.title).toBe('fpcalc (Chromaprint)')
  const names = chromaprint?.files.map((f) => f.name)
  expect(names?.[0]).toBe('NOTICE.md') // first: what it is, and where the source is
  expect(names).toEqual(expect.arrayContaining(['LGPL-2.1.txt', 'CHROMAPRINT-LICENSE.md']))
  const notice = chromaprint?.files[0].text ?? ''
  expect(notice).toContain('1.6.1')
  expect(notice).toMatch(/source/i)
  expect(chromaprint?.files.find((f) => f.name === 'LGPL-2.1.txt')?.text).toContain(
    'GNU LESSER GENERAL PUBLIC LICENSE'
  )
})

test('the notice names the same version the fetch script pins', async () => {
  const { readFileSync } = await import('fs')
  const script = readFileSync(join(REPO_ROOT, 'scripts', 'fetch-fpcalc.mjs'), 'utf8')
  const pinned = /FPCALC_VERSION = '([^']+)'/.exec(script)?.[1]
  expect(pinned).toBeTruthy()
  const notice = notices.find((n) => n.id === 'chromaprint')?.files[0].text ?? ''
  expect(notice).toContain(`fpcalc\` ${pinned}`)
})

test('a missing licences folder is an empty list, not an error', () => {
  expect(readThirdPartyNotices('/nonexistent/licenses')).toEqual([])
})
