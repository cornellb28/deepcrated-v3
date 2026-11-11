import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash, X509Certificate } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'fs'
import { request as httpsRequest, Agent } from 'https'
import { createServer as createNetServer, type Server as NetServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyLocalSyncSchema } from '../../src/main/localSync/schema'
import { createPhoneStore, type PhoneStore } from '../../src/main/localSync/phones'
import {
  CERT_FILE,
  CertificateError,
  KEY_FILE,
  loadOrCreateCertificate,
  type TlsIdentity
} from '../../src/main/localSync/cert'
import {
  buildPairingPayload,
  encodePairingPayload,
  pairingQrDataUrl,
  parsePairingPayload,
  PROTOCOL_VERSION
} from '../../src/main/localSync/protocol'
import {
  constantTimeEqual,
  generateDeviceSecret,
  hashSecret,
  normalizePairingCode,
  PairingCodes
} from '../../src/main/localSync/security'
import {
  createLocalSyncServer,
  isPrivateIPv4,
  LocalSyncError,
  startListener,
  type LocalSyncServer,
  type LocalSyncServerOptions
} from '../../src/main/localSync/server'
import type { Advertiser } from '../../src/main/localSync/discovery'

// The local sync server (Phase 2) end to end over real HTTPS on 127.0.0.1,
// with a real self-signed certificate. Plain Node: no Electron.

const DESKTOP_ID = '0b8f2c4e-1d3a-4b5c-9e7f-1a2b3c4d5e6f'
const PHONE_ID = '7c1e9a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d'
const OTHER_PHONE = '2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a8b'

let dir: string
let tls: TlsIdentity
let db: Database.Database
let phones: PhoneStore
let server: LocalSyncServer | null
let clock: number

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'local-sync-server-'))
  tls = await loadOrCreateCertificate(dir)
  db = new Database(':memory:')
  applyLocalSyncSchema(db)
  phones = createPhoneStore(db)
  server = null
  clock = Date.UTC(2026, 10, 11, 12)
})

test.afterEach(async () => {
  await server?.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(
  extra: Partial<LocalSyncServerOptions> = {}
): Promise<{ server: LocalSyncServer; port: number; codes: PairingCodes }> {
  const codes = extra.pairingCodes ?? new PairingCodes({ now: () => clock })
  server = createLocalSyncServer({
    phones,
    desktopId: DESKTOP_ID,
    desktopName: 'Studio iMac',
    tls,
    hosts: ['127.0.0.1'],
    preferredPort: 0,
    advertiser: null,
    now: () => clock,
    log: () => {},
    ...extra,
    pairingCodes: codes
  })
  const info = await server.start()
  return { server, port: info.port, codes }
}

interface Reply {
  status: number
  body: Record<string, unknown>
  fingerprint: string
}

function call(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; agent?: Agent } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers
        },
        // The phone pins the fingerprint instead of trusting a CA; the test
        // does the same with the peer certificate below.
        rejectUnauthorized: false,
        agent: options.agent ?? false
      },
      (res) => {
        const raw = (res.socket as import('tls').TLSSocket).getPeerCertificate(true).raw
        const fingerprint = createHash('sha256').update(raw).digest('hex')
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
            fingerprint
          })
        )
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function pairPhone(port: number, codes: PairingCodes, phoneId = PHONE_ID): Promise<string> {
  const { code } = codes.issue()
  const res = await call(port, 'POST', '/v1/pair', {
    body: { pairingCode: code, deviceId: phoneId, deviceName: 'DeepCrated on iPhone' }
  })
  expect(res.status).toBe(200)
  return res.body.deviceSecret as string
}

const authHeaders = (secret: string, device = PHONE_ID): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  'X-DeepCrated-Device': device
})

// ── Certificate ───────────────────────────────────────────────────────────

test('the certificate is created once, reused on the next start, and its fingerprint matches the file', async () => {
  expect(tls.created).toBe(true)
  const certOnDisk = readFileSync(join(dir, CERT_FILE), 'utf8')
  const x509 = new X509Certificate(certOnDisk)
  expect(tls.fingerprint).toBe(createHash('sha256').update(x509.raw).digest('hex'))
  expect(tls.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  // About ten years.
  const years =
    (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (365.25 * 24 * 3600 * 1000)
  expect(years).toBeGreaterThan(9.9)
  if (process.platform !== 'win32') expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600)

  const second = await loadOrCreateCertificate(dir)
  expect(second.created).toBe(false)
  expect(second.fingerprint).toBe(tls.fingerprint)
  expect(second.cert).toBe(tls.cert)
})

test('a missing key is an error, never a silent new identity', async () => {
  unlinkSync(join(dir, KEY_FILE))
  await expect(loadOrCreateCertificate(dir)).rejects.toBeInstanceOf(CertificateError)
  expect(readFileSync(join(dir, CERT_FILE), 'utf8')).toBe(tls.cert)
})

test('the server presents the stored certificate, so the QR fingerprint pins it', async () => {
  const { port } = await startServer()
  const res = await call(port, 'GET', '/v1/hello')
  expect(res.fingerprint).toBe(tls.fingerprint)
})

// ── Hello, status, version prefix ─────────────────────────────────────────

test('/v1/hello answers without auth with only v, desktopId and desktopName', async () => {
  const { port } = await startServer()
  const res = await call(port, 'GET', '/v1/hello')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ v: 1, desktopId: DESKTOP_ID, desktopName: 'Studio iMac' })
})

test('/v1/status needs auth and returns desktop id, version and server time', async () => {
  const { port, codes } = await startServer()
  expect((await call(port, 'GET', '/v1/status')).status).toBe(401)

  const secret = await pairPhone(port, codes)
  const res = await call(port, 'GET', '/v1/status', { headers: authHeaders(secret) })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ v: PROTOCOL_VERSION, desktopId: DESKTOP_ID, serverTime: clock })
})

test('a path outside /v1 gets the "update the app" error', async () => {
  const { port } = await startServer()
  for (const path of ['/v2/hello', '/status', '/']) {
    const res = await call(port, 'GET', path)
    expect(res.status).toBe(426)
    expect(res.body.error).toBe('unsupported_version')
    expect(res.body.supported).toEqual([1])
    expect(res.body.message).toMatch(/Update/)
  }
})

test('unknown /v1 paths are 404 and wrong methods 405', async () => {
  const { port } = await startServer()
  expect((await call(port, 'GET', '/v1/nope')).body).toEqual({ error: 'not_found' })
  expect((await call(port, 'POST', '/v1/hello')).status).toBe(405)
  expect((await call(port, 'GET', '/v1/pair')).status).toBe(405)
})

// ── Pairing ───────────────────────────────────────────────────────────────

test('pairing succeeds once: the secret is returned and only its hash is stored', async () => {
  const { port, codes } = await startServer()
  const secret = await pairPhone(port, codes)
  expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32)

  const row = db.prepare('SELECT * FROM paired_phones').get() as Record<string, unknown>
  expect(row.phone_id).toBe(PHONE_ID)
  expect(row.display_name).toBe('DeepCrated on iPhone')
  expect(row.token_hash).toBe(hashSecret(secret))
  expect(JSON.stringify(row)).not.toContain(secret)
})

test('an expired pairing code is refused', async () => {
  const { port, codes } = await startServer()
  const { code } = codes.issue()
  clock += 5 * 60 * 1000
  const res = await call(port, 'POST', '/v1/pair', {
    body: { pairingCode: code, deviceId: PHONE_ID, deviceName: 'iPhone' }
  })
  expect(res.status).toBe(403)
  expect(res.body).toEqual({ error: 'pairing_code_invalid' })
  expect(phones.list()).toEqual([])
})

test('a pairing code works once only', async () => {
  const { port, codes } = await startServer()
  const { code } = codes.issue()
  const body = { pairingCode: code, deviceId: PHONE_ID, deviceName: 'iPhone' }
  expect((await call(port, 'POST', '/v1/pair', { body })).status).toBe(200)
  const again = await call(port, 'POST', '/v1/pair', { body: { ...body, deviceId: OTHER_PHONE } })
  expect(again.status).toBe(403)
  expect(phones.list().map((p) => p.phoneId)).toEqual([PHONE_ID])
})

test('the code locks after five wrong attempts, even the right code fails after that', async () => {
  const { port, codes } = await startServer()
  const { code } = codes.issue()
  const wrong = code === 'AAA-AAA' ? 'BBB-BBB' : 'AAA-AAA'
  for (let i = 0; i < 5; i++) {
    const res = await call(port, 'POST', '/v1/pair', {
      body: { pairingCode: wrong, deviceId: PHONE_ID, deviceName: 'iPhone' }
    })
    expect(res.status).toBe(403)
  }
  const right = await call(port, 'POST', '/v1/pair', {
    body: { pairingCode: code, deviceId: PHONE_ID, deviceName: 'iPhone' }
  })
  expect(right.status).toBe(403)
  expect(codes.active()).toBeNull()
})

test('a typed code is accepted regardless of case and dash', async () => {
  const { port, codes } = await startServer()
  const { code } = codes.issue()
  const typed = code.replace('-', ' ').toLowerCase()
  const res = await call(port, 'POST', '/v1/pair', {
    body: { pairingCode: typed, deviceId: PHONE_ID, deviceName: 'iPhone' }
  })
  expect(res.status).toBe(200)
})

test('a malformed pairing body is a 400 and does not use up an attempt', async () => {
  const { port, codes } = await startServer()
  codes.issue()
  const bad = [
    { pairingCode: 'X', deviceId: 'not-a-uuid', deviceName: 'iPhone' },
    { pairingCode: 'X', deviceId: PHONE_ID },
    'just a string'
  ]
  for (const body of bad) expect((await call(port, 'POST', '/v1/pair', { body })).status).toBe(400)
  expect(codes.active()).not.toBeNull()
})

test('pairing the same phone again replaces its secret and un-revokes it', async () => {
  const { port, codes } = await startServer()
  const first = await pairPhone(port, codes)
  phones.revoke(PHONE_ID, clock)
  const second = await pairPhone(port, codes)
  expect(second).not.toBe(first)
  expect((await call(port, 'GET', '/v1/status', { headers: authHeaders(first) })).status).toBe(401)
  expect((await call(port, 'GET', '/v1/status', { headers: authHeaders(second) })).status).toBe(200)
})

// ── Auth ──────────────────────────────────────────────────────────────────

test('missing either header is 401 unpaired', async () => {
  const { port, codes } = await startServer()
  const secret = await pairPhone(port, codes)
  for (const headers of [
    { Authorization: `Bearer ${secret}` },
    { 'X-DeepCrated-Device': PHONE_ID },
    { Authorization: secret, 'X-DeepCrated-Device': PHONE_ID }
  ] as Record<string, string>[]) {
    const res = await call(port, 'GET', '/v1/status', { headers })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unpaired' })
  }
})

test('a wrong token is 401', async () => {
  const { port, codes } = await startServer()
  await pairPhone(port, codes)
  const res = await call(port, 'GET', '/v1/status', {
    headers: authHeaders(generateDeviceSecret())
  })
  expect(res.status).toBe(401)
})

test("another phone's device id with this phone's token is 401", async () => {
  const { port, codes } = await startServer()
  const mine = await pairPhone(port, codes, PHONE_ID)
  await pairPhone(port, codes, OTHER_PHONE)
  const res = await call(port, 'GET', '/v1/status', { headers: authHeaders(mine, OTHER_PHONE) })
  expect(res.status).toBe(401)
})

test('a revoked phone is 401 from then on', async () => {
  const { port, codes } = await startServer()
  const secret = await pairPhone(port, codes)
  expect((await call(port, 'GET', '/v1/status', { headers: authHeaders(secret) })).status).toBe(200)
  expect(phones.revoke(PHONE_ID, clock)).toBe(true)
  expect((await call(port, 'GET', '/v1/status', { headers: authHeaders(secret) })).status).toBe(401)
})

test('a successful request updates last_seen_at', async () => {
  const { port, codes } = await startServer()
  const secret = await pairPhone(port, codes)
  clock += 60_000
  await call(port, 'GET', '/v1/status', { headers: authHeaders(secret) })
  expect(phones.list()[0].lastSeenAt).toBe(clock)
})

test('routes added by later phases are authenticated and get the phone and body', async () => {
  const seen: unknown[] = []
  const { port, codes } = await startServer({
    routes: {
      'POST /v1/patch': ({ phone, body }) => {
        seen.push({ phone: phone.phoneId, body })
        return { status: 200, body: { outcomes: [] } }
      }
    }
  })
  expect((await call(port, 'POST', '/v1/patch', { body: { a: 1 } })).status).toBe(401)
  const secret = await pairPhone(port, codes)
  const res = await call(port, 'POST', '/v1/patch', {
    headers: authHeaders(secret),
    body: { a: 1 }
  })
  expect(res.body).toEqual({ outcomes: [] })
  expect(seen).toEqual([{ phone: PHONE_ID, body: { a: 1 } }])
})

test('constantTimeEqual compares content, including different lengths', () => {
  expect(constantTimeEqual('abc', 'abc')).toBe(true)
  expect(constantTimeEqual('abc', 'abd')).toBe(false)
  expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  expect(constantTimeEqual('', '')).toBe(true)
  expect(constantTimeEqual('', 'x')).toBe(false)
})

test('pairing codes look like K7Q-4MZ and normalize when typed', () => {
  const codes = new PairingCodes()
  const { code } = codes.issue()
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/)
  expect(normalizePairingCode(' k7q-4mz ')).toBe('K7Q4MZ')
})

// ── Pairing payload and QR ────────────────────────────────────────────────

test('the pairing payload has the doc shape plus certFingerprint, and round-trips', async () => {
  const { server, port, codes } = await startServer()
  expect(server.pairingPayload()).toBeNull() // no live code yet
  const { code } = codes.issue()
  const payload = server.pairingPayload()
  expect(payload).toEqual({
    v: 1,
    desktopId: DESKTOP_ID,
    desktopName: 'Studio iMac',
    addresses: [`127.0.0.1:${port}`],
    pairingCode: code,
    certFingerprint: tls.fingerprint
  })
  expect(Object.keys(payload!)).toEqual([
    'v',
    'desktopId',
    'desktopName',
    'addresses',
    'pairingCode',
    'certFingerprint'
  ])
  expect(parsePairingPayload(encodePairingPayload(payload!))).toEqual(payload)

  const url = await pairingQrDataUrl(payload!)
  expect(url).toMatch(/^data:image\/png;base64,/)
})

test('parsePairingPayload rejects the wrong version or a bad fingerprint', () => {
  const good = buildPairingPayload({
    desktopId: DESKTOP_ID,
    desktopName: 'x',
    addresses: ['192.168.1.20:47823'],
    pairingCode: 'K7Q-4MZ',
    certFingerprint: 'a'.repeat(64)
  })
  expect(parsePairingPayload(JSON.stringify(good))).toEqual(good)
  expect(parsePairingPayload(JSON.stringify({ ...good, v: 2 }))).toBeNull()
  expect(parsePairingPayload(JSON.stringify({ ...good, certFingerprint: 'AB:CD' }))).toBeNull()
  expect(parsePairingPayload('not json')).toBeNull()
})

// ── Listening ─────────────────────────────────────────────────────────────

test('only private IPv4 addresses count as LAN', () => {
  for (const ok of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20']) {
    expect(isPrivateIPv4(ok)).toBe(true)
  }
  for (const no of ['127.0.0.1', '8.8.8.8', '172.32.0.1', '169.254.1.1', '100.64.0.1', 'fe80::1']) {
    expect(isPrivateIPv4(no)).toBe(false)
  }
})

test('no LAN address is a clear no_network error', async () => {
  const err = await startListener([], tls, () => {}, { preferredPort: 0, attempts: 1 }).catch(
    (e) => e
  )
  expect(err).toBeInstanceOf(LocalSyncError)
  expect(err.code).toBe('no_network')
})

test('a taken port moves to the next one and reports it', async () => {
  const blocker: NetServer = createNetServer()
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
  const taken = (blocker.address() as { port: number }).port
  try {
    const { port } = await startServer({ preferredPort: taken, portAttempts: 5 })
    expect(port).toBeGreaterThan(taken)
    expect(server!.listenInfo()).toEqual({ port, addresses: [`127.0.0.1:${port}`] })
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()))
  }
})

test('all ports taken is a port_in_use error, not a retry loop', async () => {
  const blocker: NetServer = createNetServer()
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
  const taken = (blocker.address() as { port: number }).port
  try {
    const err = await startListener(['127.0.0.1'], tls, () => {}, {
      preferredPort: taken,
      attempts: 1
    }).catch((e) => e)
    expect(err).toBeInstanceOf(LocalSyncError)
    expect(err.code).toBe('port_in_use')
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()))
  }
})

// ── mDNS and shutdown ─────────────────────────────────────────────────────

test('the advertiser gets the desktop id and real port, and is stopped with the server', async () => {
  const events: unknown[] = []
  const advertiser: Advertiser = {
    start: (info) => void events.push(['start', info]),
    stop: async () => void events.push(['stop'])
  }
  const { server, port } = await startServer({ advertiser })
  await server.stop()
  expect(events).toEqual([
    ['start', { desktopId: DESKTOP_ID, desktopName: 'Studio iMac', port }],
    ['stop']
  ])
})

test('an advertiser that throws does not stop the server', async () => {
  const advertiser: Advertiser = {
    start: () => {
      throw new Error('multicast unavailable')
    },
    stop: async () => {}
  }
  const { port } = await startServer({ advertiser })
  expect((await call(port, 'GET', '/v1/hello')).status).toBe(200)
})

const tcpHandles = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap' || r === 'TCPSocketWrap')
    .length

test('start then stop leaves no open handles, even with a phone connection held open', async () => {
  const baseline = tcpHandles()
  const { server, port, codes } = await startServer()
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const secret = await pairPhone(port, codes)
  await call(port, 'GET', '/v1/status', { headers: authHeaders(secret), agent })
  expect(tcpHandles()).toBeGreaterThan(baseline)

  await server.stop()
  expect(server.isRunning()).toBe(false)
  // Let the client side see its kept-alive socket close.
  await new Promise((r) => setTimeout(r, 50))
  agent.destroy()
  expect(tcpHandles()).toBe(baseline)
  // A stopped server issues no payload.
  codes.issue()
  expect(server.pairingPayload()).toBeNull()
})
