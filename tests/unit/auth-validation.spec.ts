import { test, expect } from '@playwright/test'
import {
  validateEmail,
  validatePassword,
  validateForm,
  hasErrors,
  friendlyAuthError,
  MIN_PASSWORD_LENGTH
} from '../../src/renderer/src/lib/authValidation'

// Form rules and error wording. Pure, so the same rules can be asserted here
// and relied on by every form that uses them.

test('an ordinary address passes', () => {
  expect(validateEmail('dj@example.com')).toBeUndefined()
  expect(validateEmail('  dj@example.com  ')).toBeUndefined()
})

test('the shapes that are definitely wrong are caught', () => {
  expect(validateEmail('')).toBeDefined()
  expect(validateEmail('   ')).toBeDefined()
  expect(validateEmail('dj')).toBeDefined()
  expect(validateEmail('dj@')).toBeDefined()
  expect(validateEmail('@example.com')).toBeDefined()
  expect(validateEmail('dj@example')).toBeDefined()
  expect(validateEmail('dj @example.com')).toBeDefined()
})

// Deliberately permissive: client-side email validation cannot be both
// correct and strict, and rejecting a valid address is worse than accepting
// an invalid one the server will bounce.
test('unusual but legitimate addresses are not rejected', () => {
  expect(validateEmail('dj+serato@example.co.uk')).toBeUndefined()
  expect(validateEmail("o'brien@example.com")).toBeUndefined()
  expect(validateEmail('dj_1999@sub.example.com')).toBeUndefined()
})

test('an empty password is caught in both modes', () => {
  expect(validatePassword('', 'sign-in')).toBeDefined()
  expect(validatePassword('', 'sign-up')).toBeDefined()
})

test('signing up enforces the minimum length', () => {
  expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1), 'sign-up')).toBeDefined()
  expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH), 'sign-up')).toBeUndefined()
})

// The account already exists with whatever password it has. A minimum
// enforced on sign-in would lock out anyone who predates the rule — and it
// is not our call to make at that point anyway.
test('signing in never lectures about password length', () => {
  expect(validatePassword('short', 'sign-in')).toBeUndefined()
  expect(validatePassword('a', 'sign-in')).toBeUndefined()
})

test('validateForm reports both fields at once', () => {
  const errors = validateForm('nope', '', 'sign-up')
  expect(errors.email).toBeDefined()
  expect(errors.password).toBeDefined()
  expect(hasErrors(errors)).toBe(true)
})

test('a valid form reports nothing', () => {
  expect(hasErrors(validateForm('dj@example.com', 'longenough', 'sign-up'))).toBe(false)
})

// ── Error wording ───────────────────────────────────────────────────────

test('the most common sign-in failure is rewritten', () => {
  const friendly = friendlyAuthError('Invalid login credentials')
  expect(friendly).not.toBe('Invalid login credentials')
  expect(friendly.toLowerCase()).toContain('password')
})

test('matching ignores case, since these strings are not a stable API', () => {
  expect(friendlyAuthError('invalid login credentials')).toBe(
    friendlyAuthError('Invalid Login Credentials')
  )
})

test('an unconfirmed email points at the inbox', () => {
  expect(friendlyAuthError('Email not confirmed').toLowerCase()).toContain('inbox')
})

test('a duplicate signup suggests signing in instead', () => {
  expect(friendlyAuthError('User already registered').toLowerCase()).toContain('signing in')
})

test('a network failure is named as one', () => {
  expect(friendlyAuthError('TypeError: Failed to fetch').toLowerCase()).toContain('connection')
})

test('a rate limit tells you to wait', () => {
  expect(
    friendlyAuthError('For security purposes, you can only request this after 47 seconds')
  ).toMatch(/wait/i)
})

// A message we did not anticipate is still more useful than "Something went
// wrong" — and it is what makes a bug report actionable.
test('an unrecognised message is passed through untouched', () => {
  const odd = 'Some brand new Supabase error nobody has seen'
  expect(friendlyAuthError(odd)).toBe(odd)
})
