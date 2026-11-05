# Local wifi sync protocol (v1)

Status: phone side built (`src/sync`, `src/db/patchOutbox.ts`); desktop side
not built yet. Build the desktop to match this document. If either side needs
a change, change this document first.

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

- JSON over plain HTTP on the local network. Desktop listens on one TCP port
  on its LAN addresses (not on the public internet).
- All bodies are `application/json`, UTF-8. Timestamps are epoch ms. Ids are
  lower-case v4 uuids.
- Plain HTTP is acceptable for v1 because every request after pairing carries
  the device secret. **TODO(sync-tls):** TLS with a self-signed certificate
  whose SHA-256 fingerprint is carried in the QR code, pinned by the phone.
- Error bodies: `{ "error": "<code>" }` with the status codes below.

| Status | Meaning |
|---|---|
| 400 | Malformed request (`bad_request`) |
| 401 | Missing or unknown device secret (`unpaired`). The phone clears its pairing and shows "Pair again". |
| 403 | `/v1/pair` only: pairing code wrong, expired or already used (`pairing_code_invalid`) |
| 409 | `/v1/patch` only: a different body for a patchId already received (`patch_id_reused`) |
| 5xx | Desktop error. The phone keeps everything queued and retries next sync. |

## 1. Pairing

Desktop shows a QR code (and the same values as text, for manual entry):

```json
{ "v": 1, "desktopId": "uuid", "desktopName": "Studio iMac", "addresses": ["192.168.1.20:47823"], "pairingCode": "K7Q-4MZ" }
```

- `desktopId`: v4 uuid minted once per desktop install, never changes.
- `addresses`: every LAN `host:port` desktop listens on; IPv6 in brackets
  (`[fe80::1]:47823`).
- `pairingCode`: short, random, **single-use**, expires after a few minutes
  (recommended 5). Desktop accepts at most a handful of wrong attempts per code,
  then invalidates it.

Phone, after scanning (or after the DJ types an address and the code):

1. `GET /v1/hello` on each address until one answers with `v: 1` and (for a QR
   code) the same `desktopId`.
2. `POST /v1/pair` on that address:

```json
// request
{ "pairingCode": "K7Q-4MZ", "deviceId": "uuid", "deviceName": "DeepCrated on iPhone" }
// 200
{ "deviceSecret": "opaque string, at least 32 random bytes, base64url" }
```

Desktop stores `(deviceId, deviceName, hash(deviceSecret), pairedAt)` and lists
paired phones so the DJ can unpair one. Pairing again with the same deviceId
replaces the old secret.

The phone stores `desktopId`, `desktopName`, the addresses, the last address
that worked and `deviceSecret` in the platform secure store. `deviceId` is a
v4 uuid minted once per install and stored the same way.

## 2. Authentication

Every request except `/v1/hello` and `/v1/pair` carries:

```
Authorization: Bearer <deviceSecret>
X-DeepCrated-Device: <deviceId>
```

Desktop answers 401 if the pair is unknown (for example the DJ unpaired the
phone on desktop). The phone then forgets the pairing; its queued edits stay.

## 3. Finding the desktop again

The phone tries the last address that worked, then the other QR addresses,
each with `GET /v1/hello` and a short timeout (2.5 s), and uses the first that
answers with the paired `desktopId`. It never sends the secret to an address
whose hello doesn't match. If none answer: "Can't reach your desktop. Make
sure DeepCrated is open and you're on the same wifi."

**TODO(sync-discovery):** mDNS/zeroconf to find a desktop whose address
changed (needs a native module on the phone). Until then, a changed address
means pairing again.

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

- [ ] HTTP server on a fixed port, LAN only; Windows firewall prompt handled
- [ ] Pairing screen: QR + text, single-use expiring code, attempt limit
- [ ] Paired devices list with unpair
- [ ] `/v1/hello`, `/v1/pair`, `/v1/patch`, `/v1/snapshot`
- [ ] Applied-patch log keyed by patchId (at most once, repeat returns stored outcomes)
- [ ] Patch applier through the repository layer, write-back to files (sync contract)
- [ ] Review panel for conflicts
- [ ] Snapshot paging with a stable `serverTime`, tombstones from `sync_tombstones`
- [ ] `complete` sets for entities answered conflict/skipped/rejected
- [ ] `crate.create` uses the phone's crate uuid
