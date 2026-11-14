# Local wifi sync protocol (v1)

Status: phone side built (`src/sync`, `src/db/patchOutbox.ts`) against
revision 1. Desktop server, pairing and auth built against **revision 2**
(`src/main/localSync/`, branch `feature/local-sync`); patch and snapshot not
built yet. Revision 3 (typed pairing) changes only client behavior and is not
built on either side yet. If either side needs a change, change this document
first.

## Revision 3 (2026-11-14): typed pairing with fingerprint confirmation

**The wire protocol is unchanged.** Paths (`/v1/...`), headers, bodies, status
codes and the QR payload are exactly as in revision 2, and `v` stays `1`.
Revision 3 changes only what the phone must do when the DJ pairs by typing
instead of scanning.

**What changed**

1. **Typed (manual) pairing is supported over HTTPS**, using a short
   fingerprint the DJ compares by eye. It replaces revision 2's "manual
   pairing is not supported over HTTPS". The flow is under "What the phone
   must do" in revision 2 below.
2. **Short fingerprint** defined (below), for the desktop to display and the
   phone to show for comparison.

**Fingerprints**

- **Full fingerprint:** SHA-256 of the server certificate's DER bytes, as 64
  lower-case hex characters with no separators. This is what the QR carries as
  `certFingerprint` and what the phone pins.
- **Short fingerprint:** the first 16 hex characters of the full fingerprint,
  upper-cased, in four groups of four joined by hyphens.

Worked example:

```
full:  3f9a01c277bed4104cadeac43e1310162266e1edaa616c3855705d7e5b6a115f
short: 3F9A-01C2-77BE-D410
```

The short form is only for the DJ to compare. The phone always pins and checks
the **full** fingerprint.

**Rules that apply to every pairing**

- **QR pairing is unchanged:** the phone pins `certFingerprint` from the QR and
  rejects any other certificate.
- **After pairing, a fingerprint mismatch is never accepted automatically.**
  The phone treats it as "the desktop changed or can't be trusted", sends
  nothing on that connection, and requires the DJ to pair again.

## Revision 2 (2026-11-11): HTTPS, pinned certificate, /v1/status

**What changed**

1. **HTTPS instead of plain HTTP.** Desktop serves TLS with a self-signed
   certificate generated once per install and kept for about ten years.
2. **`certFingerprint` in the QR payload**: SHA-256 of the certificate's DER
   bytes, 64 lower-case hex characters, no colons.
3. **`GET /v1/status`** (authenticated): `{ v, desktopId, serverTime }`.
4. **Version check by path prefix.** Any path not under `/v1/` gets
   **426** `{ "error": "unsupported_version", "supported": [1], "message": "..." }`.
5. **mDNS advertising** (`_deepcrated._tcp`, TXT `v`, `id`). Groundwork only;
   see Discovery.

The wire version stays `v: 1`: paths, headers, bodies and the rest of the QR
payload are unchanged.

**Why.** Plain HTTP sent the device secret, and every edit, readable to
anyone on the same wifi. Pinning the fingerprint from the QR (which the DJ
scans in person) authenticates the desktop without a certificate authority.

**What the phone must do**

- Connect with `https://<address>` for every request, including `/v1/hello`.
- **Pin the certificate:** accept the connection only if the SHA-256 of the
  server's leaf certificate (DER) equals the `certFingerprint` from the QR. Do
  not use system CA validation or hostname checks (the certificate is
  self-signed and the address is an IP). Never send the device secret, the
  pairing code or anything else over a connection that failed the pin.
- Store `certFingerprint` with the pairing (secure store, next to
  `desktopId`). A fingerprint mismatch later means the desktop's identity
  changed (reinstall or a deliberate reset): treat it like 401, clear the
  pairing and show "Pair again".
- **Typed pairing (revision 3).** When the DJ pairs without the QR, in this
  order:
  1. The DJ enters the desktop's address, port and pairing code on the phone.
  2. The phone connects over HTTPS, accepting the server's certificate for
     this connection only (for example to call `GET /v1/hello`, which carries
     no secret), and records the full fingerprint the server presented. It
     does **not** send the pairing code yet.
  3. The phone shows the short fingerprint and asks the DJ to confirm it
     matches the one on the desktop's pairing screen.
  4. Only after the DJ confirms does the phone call `POST /v1/pair` with the
     code, on a connection that presents that same full fingerprint. If the
     fingerprint differs from step 2, abort.
  5. On success the phone pins the full fingerprint for all future
     connections, exactly as for a QR pairing. If the DJ declines at step 3,
     the phone discards the address, code and fingerprint and sends nothing.

  The code is sent last so it never reaches an impostor: a device pretending
  to be the desktop is caught at step 3, before it can see the code.
- On 426, stop syncing and tell the DJ to update the app.


Source of truth for data rules: deepcrated-v3 `docs/sync-contract.md`,
"Conflict resolution" and "Mobile edits: field-level patches" (branch
`docs/mobile-patch-sync` until merged). This document covers only how the
phone and desktop talk on the home network.

## Decisions (2026-11-05)

- Local wifi first. The cloud comes later and carries the **same** patch
  format; the phone keeps the transport behind one `SyncTransport` interface.
- Local wifi sync is free: no account, plan or entitlement check.
- Desktop is the source of truth. The phone proposes field-level changes;
  desktop applies them and holds conflicts in its own review panel.
- The phone never sends whole rows and never deletes tracks.

## Transport

- JSON over **HTTPS** on the local network (revision 2). Desktop listens on
  one TCP port on its private LAN IPv4 addresses only (10/8, 172.16/12,
  192.168/16), never on a public interface. Preferred port 47823; if it is
  taken desktop uses the next free one and the QR carries the real port.
- All bodies are `application/json`, UTF-8. Timestamps are epoch ms. Ids are
  lower-case v4 uuids.
- TLS: a self-signed certificate (EC P-256, about ten years), generated once
  per desktop install and never regenerated automatically. Its SHA-256 (DER)
  fingerprint is in the QR code and the phone pins it. A new certificate
  means every phone pairs again.
- Error bodies: `{ "error": "<code>" }` with the status codes below.

| Status | Meaning |
|---|---|
| 400 | Malformed request (`bad_request`) |
| 401 | Missing or unknown device secret (`unpaired`). The phone clears its pairing and shows "Pair again". |
| 403 | `/v1/pair` only: pairing code wrong, expired or already used (`pairing_code_invalid`) |
| 404 | Unknown path under `/v1/` (`not_found`) |
| 405 | Known path, wrong method (`method_not_allowed`) |
| 409 | `/v1/patch` only: a different body for a patchId already received (`patch_id_reused`) |
| 426 | Path not under `/v1/` (`unsupported_version`, with `supported` and `message`). The phone tells the DJ to update. |
| 5xx | Desktop error. The phone keeps everything queued and retries next sync. |

## 1. Pairing

Desktop shows a QR code (and the same values as text, for manual entry):

```json
{ "v": 1, "desktopId": "uuid", "desktopName": "Studio iMac", "addresses": ["192.168.1.20:47823"], "pairingCode": "K7Q-4MZ", "certFingerprint": "64 lower-case hex chars" }
```

- `desktopId`: v4 uuid minted once per desktop install, never changes.
- `addresses`: every LAN `host:port` desktop listens on; IPv6 in brackets
  (`[fe80::1]:47823`).
- `pairingCode`: six characters shown as `K7Q-4MZ` (no 0/O/1/I/L; case, spaces
  and the dash are ignored when typed), **single-use**, expires after 5
  minutes, and is invalidated after 5 wrong attempts. One code is live at a
  time.
- `certFingerprint` (revision 2): see TLS above.

Phone, after scanning (or after the DJ types an address and the code; typed
pairing adds the fingerprint confirmation in revision 3 before step 2):

1. `GET /v1/hello` on each address until one answers with `v: 1` and (for a QR
   code) the same `desktopId`.
2. `POST /v1/pair` on that address:

```json
// request
{ "pairingCode": "K7Q-4MZ", "deviceId": "uuid", "deviceName": "DeepCrated on iPhone" }
// 200
{ "deviceSecret": "opaque string, at least 32 random bytes, base64url" }
```

Desktop stores `(deviceId, deviceName, sha256(deviceSecret), pairedAt)` and
lists paired phones so the DJ can unpair one. Pairing again with the same
deviceId replaces the old secret and un-revokes it. `deviceName` is trimmed and
cut to 100 characters. A malformed body is 400 and does not count as a wrong
attempt.

The phone stores `desktopId`, `desktopName`, the addresses, the last address
that worked, `certFingerprint` and `deviceSecret` in the platform secure store. `deviceId` is a
v4 uuid minted once per install and stored the same way.

## 2. Authentication

Every request except `/v1/hello` and `/v1/pair` carries:

```
Authorization: Bearer <deviceSecret>
X-DeepCrated-Device: <deviceId>
```

Desktop answers 401 if the pair is unknown (for example the DJ unpaired the
phone on desktop), if either header is missing, if the secret is wrong, or if
the secret belongs to a different deviceId. The phone then forgets the
pairing; its queued edits stay.

`GET /v1/status` (revision 2, authenticated) →
`{ "v": 1, "desktopId": "uuid", "serverTime": 1793836805000 }`. Lets the phone
check its pairing still works without pulling.

## 3. Finding the desktop again

The phone tries the last address that worked, then the other QR addresses,
each with `GET /v1/hello` and a short timeout (2.5 s), and uses the first that
answers with the paired `desktopId`. It never sends the secret to an address
whose hello doesn't match. If none answer: "Can't reach your desktop. Make
sure DeepCrated is open and you're on the same wifi."

Desktop advertises mDNS service `_deepcrated._tcp` on the server's port with
TXT `v` (protocol version, `"1"`) and `id` (desktopId), instance name = the
desktop name. **TODO(sync-discovery):** the phone browsing for it (needs a
native module on the phone). Until then, a changed address means pairing
again. When it is built, the phone must still check hello's `desktopId` and
the pinned fingerprint before sending anything.

## 4. Hello

`GET /v1/hello` (no auth) → `{ "v": 1, "desktopId": "uuid", "desktopName": "Studio iMac" }`

Lets the phone confirm it found the right desktop before sending anything.
Reveals nothing else.

## 5. Push (always first)

`POST /v1/patch`

```json
{
  "patchId": "uuid",
  "deviceId": "uuid",
  "baseSnapshotAt": 1793836800000,
  "entries": [ { "op": "set", "track": "uuid", "field": "energy", "from": 6, "to": 8, "editedAt": 1793836800000 } ]
}
```

- `entries` use the entry kinds in the sync contract (`set`, `tag.add`,
  `tag.remove`, `crate.create`, `crate.rename`, `crate.delete`, `crate.add`,
  `crate.remove`), in edit order. A `crate.create` comes before entries that
  use that crate.
- `baseSnapshotAt`: the phone's `last_pulled_at` (a desktop-clock time from a
  previous pull), or null if it never pulled. Informational.
- `crate.create` carries the phone-minted crate uuid; desktop **must** create
  the crate with that uuid so later entries and snapshots agree.

Response:

```json
{ "outcomes": [ { "index": 0, "status": "applied" }, { "index": 1, "status": "conflict", "reason": "energy changed on desktop" } ] }
```

- One outcome per entry, `index` into `entries`. `status` is one of
  `applied`, `noop`, `conflict` (held for the review panel), `skipped` (track or
  crate no longer exists), `rejected` (field not editable from mobile, bad value).
- **At most once:** desktop records each `patchId` with its outcomes before
  replying. A repeat of a known `patchId` returns the stored outcomes without
  applying anything. Keep at least the last 100 patchIds per device.
- Apply rules, three-way check and write-back are in the sync contract.

Phone side: before sending, the phone freezes the batch in `patch_outbox` with
a new `patchId`. A retry after a dropped connection resends the same `patchId`
and the same entries. On a response it clears every entry that got an outcome,
counts conflicts ("2 changes need a look on your desktop"), and drops the
batch. An entry without an outcome goes out again in the next batch. Edits
made while a batch is in flight become new entries; they never change or
cancel a frozen entry.

## 6. Pull (after push)

`GET /v1/snapshot?since=<ms>&cursor=<opaque>`

- `since` omitted: full snapshot. Otherwise every row with `updated_at > since`,
  tombstones included.
- `cursor`: from the previous page's `nextCursor`.

```json
{
  "serverTime": 1793836805000,
  "rows": { "tracks": [], "tags": [], "track_tags": [], "crates": [], "crate_tracks": [] },
  "complete": { "tracks": [], "crates": [] },
  "nextCursor": null
}
```

- Rows use the wire format in the sync contract: the mobile column names,
  `client_uuid`, epoch-ms `updated_at` (desktop's `sync_updated_at`) and
  `deleted_at` for deletes (from `sync_tombstones`). Never `filepath` or other
  desktop-only columns.
- `serverTime`: desktop's clock when the **first** page was built; the same on
  every page of one cursor sequence. Rows changed during paging are picked up
  by the next pull.
- Page size: up to about 2000 rows. `nextCursor: null` on the last page.
- Desktop sends a join row's parents before it or on an earlier page where it
  can, but the phone tolerates either order.

### Complete sets

A track or crate listed in `complete` has **all** its live links on that page
(`track_tags` for a track, `crate_tracks` for a crate). The phone drops any
other local link for it. Desktop must list, in the next snapshot to that
device, every track and crate named by an entry it answered `conflict`,
`skipped` or `rejected`, with its current row and complete links, even if
nothing changed since `since`. This is how the phone learns its edit didn't
land, for example to drop a tag it added that desktop rejected.

### How the phone applies a page

- One transaction per page, parents first: tracks, tags, crates, then
  track_tags, crate_tracks.
- Desktop rows replace local rows whatever the local `updated_at` (local stamps
  are the phone's clock; desktop is the source of truth in this direction).
- A track or crate with an unsent or unanswered patch entry is not touched,
  nor are its links. The phone keeps its local value and, by stopping
  `last_pulled_at` just before the oldest skipped row, gets the row again on the
  next pull.
- A phone-created tag with the same `(field, value)` as a desktop tag is merged
  into the desktop tag (links repointed, the local tag retired). A link for a
  pair the phone already linked under its own uuid is replaced by desktop's.
- Display strings (`genre`, `label`, ...) are re-derived for tracks whose links
  changed without their row. `artist` and `album` are never re-derived on the
  phone.
- After the last page: `last_pulled_at = serverTime` (or just before the
  oldest skipped row).

**TODO(sync):** a full snapshot does not yet remove local rows desktop doesn't
have. Pairing with a different desktop than before should start from an empty
library; not handled yet.

## When the phone syncs

Push then pull, only when paired and on wifi (or ethernet): when the app comes
to the foreground, right after pairing, and on "Sync now". Never in a loop,
never two at once. Offline or on cellular, edits wait in the queue; that is
normal, not an error.

## Unpairing

The phone's "Unpair" forgets the pairing locally. **TODO(sync):**
`DELETE /v1/pair` so desktop drops the device too. Desktop's own unpair makes
the phone's next request get 401.

## Desktop checklist

- [x] HTTPS server, LAN only, preferred port with fallback; listen failures
      (firewall, permissions, no network) reported, not retried
- [x] Self-signed certificate generated once, fingerprint in the QR (rev. 2)
- [x] Single-use expiring pairing code with attempt limit; QR data URL
- [ ] Pairing screen (Settings UI)
- [ ] **TODO(rev. 3):** the Phase 4 pairing screen shows the short fingerprint
      alongside the typed address, port and code, so the DJ has something to
      compare against
- [ ] **TODO(rev. 3):** code helper for the short-fingerprint format, with a
      unit test
- [x] Paired phones stored with hashed secrets; revoke
- [ ] Paired devices list with unpair (Settings UI)
- [x] `/v1/hello`, `/v1/pair`, `/v1/status`
- [ ] `/v1/patch`, `/v1/snapshot`
- [x] mDNS advertising (groundwork)
- [ ] Applied-patch log keyed by patchId (at most once, repeat returns stored outcomes)
- [ ] Patch applier through the repository layer, write-back to files (sync contract)
- [ ] Review panel for conflicts
- [ ] Snapshot paging with a stable `serverTime`, tombstones from `sync_tombstones`
- [ ] `complete` sets for entities answered conflict/skipped/rejected
- [ ] `crate.create` uses the phone's crate uuid
