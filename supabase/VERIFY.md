# Verifying the Supabase auth pass

Everything here needs your Supabase project, your Google Cloud console and a
real browser, so none of it could be done from the coding session — it was
written unverified against a live project and is waiting on this checklist.

Automated coverage that *did* run: 12 unit tests on the `cratecloud://`
callback parser, 7 integration tests on safeStorage persistence (real
keychain, real process exit), and a production build confirming the
`MAIN_VITE_` values inline correctly. See the bottom of this file.

---

## 0. Config — **done**

`.env` is populated and the built bundle inlines both values as real strings
(verified: the `anon` role claim matches the project ref, expiry 2036). If you
ever need to redo it:

```bash
cp .env.example .env
```

Fill both values from **Supabase dashboard > Project Settings > API**:

- `MAIN_VITE_SUPABASE_URL` — the Project URL
- `MAIN_VITE_SUPABASE_ANON_KEY` — the `anon` / `public` key, **not** the
  service role key. The service role key bypasses RLS and must never be in a
  desktop client.

The `MAIN_VITE_` prefix is required — electron-vite only inlines variables
with it into the main-process bundle. A plain `SUPABASE_URL` reads fine under
`npm run dev` and comes back `undefined` in a packaged build.

> Keep real values out of `.env.example` — it is committed, so anything left
> there lands in git history and hands a cloner your project rather than a
> blank template. `.env` is gitignored; that is the one to fill in.

**Check:** `npm run dev`. If the config is missing you get the login screen's
setup message instead of a form — that is `isConfigured()` working, not a bug.

## 1. Apply the migration — **done 2026-09-23**

Applied via the dashboard SQL editor. Verified from this repo with the anon
key: the table is reachable (HTTP 200, was 404), all 13 columns are present,
and RLS is enforcing — an anon INSERT was refused with `42501` (the policy),
not `23503` (the foreign key), which is the difference between "RLS blocked
it" and "RLS let it through and the FK caught it". An empty SELECT alone
proves nothing here, since the table starts empty either way.

**Signup trigger: verified 2026-09-23.** A Google sign-up produced an
entitlements row in the same second as the auth.users insert, with every
default correct (plan 'free', status 'active', seats 1, current_period_end
null, cancel_at_period_end false) and user_id matching the JWT's sub. Worth
noting the path: Google signup never touches the desktop app's code, and the
row still appeared — which is the reason provisioning lives in a DB trigger
rather than in auth.ts.

Client secret: a stale secret left over from creating a second Google OAuth
client surfaced as `Unable to exchange external code` with a valid
authorization code. If that error ever returns, check the secret matches the
client id Supabase is actually sending — /auth/v1/authorize's Location header
shows which client id it uses.

<details><summary>Original instructions</summary>


```bash
supabase db push        # or paste supabase/migrations/20260922000000_entitlements.sql
                        # into the dashboard SQL editor
```

**Check** in the SQL editor:

```sql
-- table + constraints
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'entitlements'
order by ordinal_position;

-- RLS on, exactly one policy, SELECT only
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename = 'entitlements';
select policyname, cmd, qual from pg_policies
where schemaname = 'public' and tablename = 'entitlements';

-- the signup trigger exists on auth.users
select tgname from pg_trigger
where tgrelid = 'auth.users'::regclass
  and tgname = 'on_auth_user_created_provision_entitlement';
```

Expected: `rowsecurity = true`, one policy named `own entitlement is
readable` with `cmd = SELECT`, and the trigger present. **No INSERT or
UPDATE policy** — that is deliberate; only the service role writes.

</details>

## 1b. Apply the tier migration — **not yet applied**

`supabase/migrations/20260923000000_entitlements_tiers.sql`, written
2026-09-23. Additive and re-runnable; it changes exactly two things.

```bash
supabase db push    # or paste the file into the dashboard SQL editor,
                    # the way 20260922000000 went in
```

**What it does**

1. Adds `stripe_price_id text` — which price, not just which product, the
   subscription is on. The webhook writes it; nothing reads it yet and it is
   deliberately un-indexed (Stripe events carry the customer or subscription
   id, never the price).
2. Replaces the `plan` check with `('free', 'cloud_mobile',
   'cloud_mobile_plus')`, remapping any `'sync'` row first so the constraint
   cannot fail. No row can actually hold `'sync'` — the only writer of
   `plan` is the future webhook — but the remap makes that assumption
   harmless if it is ever wrong.

**⚠ The two paid names are placeholders** and will change once the tier
lineup is settled. Nothing branches on a specific paid value anywhere: the
app tests `plan === 'free'` and reads the name for display only, so renaming
a tier later is a constraint change plus one lookup table in
`src/renderer/src/lib/plan.ts`.

**Deliberately NOT changed**, though an earlier brief asked for them:

- `status` keeps all nine Stripe values and `not null default 'active'`.
  Narrowing it to five would make the webhook throw on a live event —
  `unpaid`, `incomplete_expired` and `paused` are all real — and the event
  most likely to trigger that is a card declining.
- `purchased_at` and `stripe_checkout_session_id` stay. Unused, zero app-code
  references, kept as the hook for a one-time desktop purchase.
- RLS is untouched.

**Check** in the SQL editor:

```sql
-- the new column exists, the constraint has the new vocabulary
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'entitlements'
  and column_name = 'stripe_price_id';

select pg_get_constraintdef(oid) from pg_constraint
where conname = 'entitlements_plan_check';

-- no row was left on a value the new constraint forbids
select plan, count(*) from public.entitlements group by plan;
```

Expected: one row for `stripe_price_id`; a constraint reading
`CHECK (plan = ANY (ARRAY['free'::text, 'cloud_mobile'::text,
'cloud_mobile_plus'::text]))`; and every row on `free`.

**Then check the app against it** — this is the step that cannot be done
from a coding session, because it needs a real sign-in:

1. `npm run dev`, sign in.
2. Settings > Account. The profile card should read **Free**, with the
   library list under it and no error.
3. Click **Refresh** on the plan card. A toast should say *"Still on Free"* —
   that round trip is `fetchEntitlement` reading the altered table, which is
   what proves the new shape and the app agree.

To see a paid tier render without a webhook, set one row by hand in the SQL
editor (service role, via the dashboard) and hit Refresh again:

```sql
update public.entitlements set plan = 'cloud_mobile',
  current_period_end = now() + interval '30 days'
where user_id = '<your uuid>';
-- put it back afterwards:
-- update public.entitlements set plan = 'free', current_period_end = null
-- where user_id = '<your uuid>';
```

Expected: the card reads **Cloud + Mobile**, with *"Renews <date>"* under it,
and the Cloud Sync upgrade pitch disappears.

## 2. Email/password signup auto-provisions a free row

1. `npm run dev`, enter an email + password, click **Create account**.
2. If the project has email confirmation on (Authentication > Providers >
   Email), you get *"Account created. Check your email…"* — click the link,
   then sign in. That message is expected, not a failure.
3. Table editor > `entitlements`.

**Check:** a row exists for the new user with `plan = 'free'`,
`status = 'active'`, `current_period_end = null`, `seats = 1`, and `user_id`
matching Authentication > Users.

```sql
select e.plan, e.status, e.current_period_end, e.cancel_at_period_end, u.email
from public.entitlements e join auth.users u on u.id = e.user_id
order by e.created_at desc limit 5;
```

**Also check RLS actually bites** — sign in as user A and confirm you cannot
read user B's row. The app only ever asks for its own, so a broken policy
would not otherwise show up until it mattered.

## 3. Google OAuth round trip

Two pieces of dashboard config first, neither of which is in the repo:

**Google Cloud Console** > APIs & Services > Credentials > OAuth 2.0 Client
(Web application). Authorised redirect URI:

```
https://qjsdqjlpakptirwyxcia.supabase.co/auth/v1/callback
```

Must match exactly — no trailing slash, no `http`. Google rejects a
near-miss with `redirect_uri_mismatch` rather than anything more helpful.

Note this is the *Supabase* callback, going into *Google's* console. It is
not `cratecloud://auth-callback`, and the two are not interchangeable:
Google hands the user to Supabase at the URL above, and Supabase then hands
them to the app at the `cratecloud://` one below. Nothing in the repo
references this URL — it is dashboard config only.

**Supabase** > Authentication > Providers > Google: enable it, paste the
client ID + secret. Then Authentication > URL Configuration > **Redirect
URLs**, add:

```
cratecloud://auth-callback
```

That last one is the step most likely to be missed — without it Supabase
refuses the redirect and the browser dead-ends instead of returning.

Then:

1. `npm run dev` > **Continue with Google**.
2. The system browser opens (not an in-app window — Google blocks OAuth in
   embedded frames, which is why the flow is built this way).
3. Complete consent. The browser should hand back to the app; the window
   focuses itself and the library appears.

**Check:** a new `auth.users` row with the Google identity, and an
`entitlements` row auto-created for it with `plan = 'free'`.

**If the browser dead-ends** — the deep link never arrived. On macOS check
Console.app for `open-url`; in dev the protocol is registered against
`process.execPath` + the script path, which only works while
`process.defaultApp` is true. A packaged build registers plainly.

## 4. Session survives a quit

1. Signed in, fully quit (⌘Q — not just closing the window).
2. Reopen.

**Check:** the library appears without a login prompt. There is a brief blank
hold while the stored refresh token is exchanged — that is deliberate, and
shorter than a spinner would be worth.

**Check the encrypted blob exists:**

```bash
ls -la ~/Library/Application\ Support/cratecloud-v3/cratecloud/session.enc
```

It should be unreadable ciphertext — `cat` it and you should see binary, not
a JWT. Only the refresh token is stored; access tokens expire hourly and a
stored one would be stale by the next launch anyway.

**Check sign-out clears it:** Settings > Sign out, then confirm
`session.enc` is gone and reopening shows the login screen.

## 5. What is deliberately *not* wired

`plan` and `status` cross IPC and show in Settings > Account, but **nothing
gates on them.** The desktop app is free (settled 2026-09-22) and there is
no `LockedView`/`LockBadge` in the repo to feed — the brief's step 5 assumed
both. Confirmed as the chosen approach: build the table, gate nothing.

The schema is shaped for the **cloud sync subscription** sold from the
payments website, not the retired desktop tiers: `plan in ('free','sync')`,
`status` accepting every value Stripe can send, plus `current_period_end`
and `cancel_at_period_end`. The one-time columns (`seats`,
`purchased_at`, `stripe_checkout_session_id`) are kept but unwritten, in
case a one-time desktop purchase is ever added.

**The entitlement rule is not in the database.** It depends on
`current_period_end` as well as `status`, which no constraint or generated
column can express, so it belongs in exactly one place in the website's
server code:

```
entitled = status in ('active','trialing')
           or (status = 'past_due' and current_period_end > now())
```

The `past_due` grace is what stops a retryable card from cutting someone off
mid-set. Get this wrong in the other direction and you serve someone who
stopped paying a month ago.

The Stripe webhook is the missing writer, and it belongs on the website —
it needs the service role key, which must never reach a desktop client.
`TODO(stripe-webhook)` marks every attachment point:

- `supabase/migrations/20260922000000_entitlements.sql` — which columns it
  writes, why the status check accepts all of Stripe's values, and that it
  runs as the service role
- `src/main/auth.ts` — `fetchEntitlement`, on why everything reads `free`
- `src/renderer/src/types/global.d.ts` — the `Entitlement` interface

Also stubbed, as the brief allowed: password reset sends the email and the
link opens Supabase's hosted page. `TODO` in `auth.ts` and `LoginView.tsx`
marks where an in-app reset screen would handle the recovery deep link.

---

## Automated coverage that already passed

```bash
npx playwright test --project=unit auth-callback      # 12 passed
npx playwright test --project=integration auth-session # 7 passed
npm test                                              # 334 passed
npm run build                                         # inlining confirmed
```

The callback parser tests cover both Supabase flows (implicit tokens in the
fragment, PKCE code in the query), a denied consent screen, an access token
with no refresh token, foreign schemes, and non-URL argv entries — the
Windows `second-instance` path sees every argument, not just deep links.

The persistence tests run against the real OS keychain and assert across a
genuine process exit, including refresh-token rotation (Supabase issues a new
one on every use, so the newest must overwrite).

What they cannot cover, and section 2–4 above exist for: that your project's
RLS policy behaves against two real accounts, that the Google redirect is
configured on both sides, and that the OS actually delivers
`cratecloud://` to the app.
