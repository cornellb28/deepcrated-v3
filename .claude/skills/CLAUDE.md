# DeepCrate desktop (cratecloud-v3)

## Always
- Inspect before changing. No new dependencies without my approval.
- Confirm before touching any data layer (local SQLite, Supabase migrations/RLS).
- Never put the Supabase service role key or Stripe secret key in this repo.
- Entitlements are read-only here; only the website's webhook writes them.
- Stripe test mode only until I say go live.

## Accounts and billing
For anything touching login, sessions, deep links, plans, or entitlements,
use the `deepcrate-*` skills in .claude/skills/. Start with
`deepcrate-account-contract`. If you change the contract, tell me so I can
mirror it in deepcrate-web.