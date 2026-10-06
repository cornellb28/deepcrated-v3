// ── Auth form validation and error wording ───────────────────────────────
// Pure, so it is testable and so the same rules apply wherever a form
// appears (sign in, sign up, and the password-reset panel).
//
// Catching the obvious problems before the call is not about saving a round
// trip — it is that Supabase's own errors are written for developers.
// "Invalid login credentials" and "Password should be at least 6 characters"
// are accurate and unhelpful to a DJ who mistyped their email.

// Supabase's own default. A project can raise it in the dashboard, in which
// case the server still rejects and friendlyAuthError passes that through —
// this only catches the case we can be sure about locally.
export const MIN_PASSWORD_LENGTH = 6

export interface FieldErrors {
  email?: string
  password?: string
}

// Deliberately permissive. Client-side email validation cannot be both
// correct and strict — the real check is whether the confirmation email
// arrives — so this only catches the shapes that are definitely wrong
// (no @, nothing before or after it, whitespace inside).
export function validateEmail(email: string): string | undefined {
  const trimmed = email.trim()
  if (trimmed === '') return 'Enter your email address.'
  if (/\s/.test(trimmed)) return "An email address can't contain spaces."
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(trimmed)) return "That doesn't look like an email address."
  return undefined
}

// `mode` matters: signing IN should never lecture about password length.
// The account already exists with whatever password it has, and a minimum
// enforced here would lock out anyone who predates the rule.
export function validatePassword(
  password: string,
  mode: 'sign-in' | 'sign-up'
): string | undefined {
  if (password === '') return 'Enter your password.'
  if (mode === 'sign-up' && password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return undefined
}

export function validateForm(
  email: string,
  password: string,
  mode: 'sign-in' | 'sign-up'
): FieldErrors {
  const errors: FieldErrors = {}
  const emailError = validateEmail(email)
  const passwordError = validatePassword(password, mode)
  if (emailError) errors.email = emailError
  if (passwordError) errors.password = passwordError
  return errors
}

export function hasErrors(errors: FieldErrors): boolean {
  return errors.email !== undefined || errors.password !== undefined
}

// Rewrites the Supabase messages a DJ is actually likely to hit. Anything
// unrecognised is passed through verbatim rather than replaced with a vague
// catch-all: a message we did not anticipate is still better than "Something
// went wrong", and it is what makes a bug report useful.
//
// Matched case-insensitively on a substring because these strings are not a
// stable API — Supabase has reworded them before.
const ERROR_REWRITES: [RegExp, string][] = [
  [
    /invalid login credentials/i,
    "That email or password isn't right. Check both, or reset your password."
  ],
  [/email not confirmed/i, 'Confirm your email first — check your inbox for the link.'],
  [
    /user already registered|already been registered/i,
    'An account with that email already exists. Try signing in instead.'
  ],
  [/password should be at least (\d+)/i, 'That password is too short.'],
  [
    /for security purposes|rate limit|too many requests/i,
    'Too many attempts — wait a minute, then try again.'
  ],
  [
    /failed to fetch|network|fetch failed|enotfound|econnrefused/i,
    "Couldn't reach the server. Check your internet connection."
  ],
  [/email address .* is invalid|invalid email/i, "That doesn't look like an email address."],
  [
    /same as the old password|should be different/i,
    'Choose a password different from your current one.'
  ]
]

export function friendlyAuthError(message: string): string {
  for (const [pattern, replacement] of ERROR_REWRITES) {
    if (pattern.test(message)) return replacement
  }
  return message
}
