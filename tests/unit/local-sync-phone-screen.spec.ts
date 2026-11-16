import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadOrCreateCertificate } from '../../src/main/localSync/cert'
import { applyLocalSyncSchema } from '../../src/main/localSync/schema'
import { createPhoneStore, type PairedPhone } from '../../src/main/localSync/phones'
import { FINGERPRINT_RE, shortFingerprint } from '../../src/main/localSync/protocol'
import { generateDeviceSecret, hashSecret } from '../../src/main/localSync/security'
import { isExcludedInterface, lanAddressesFrom } from '../../src/main/localSync/server'
import {
  buildPhoneSyncState,
  defaultDesktopName,
  normalizeDesktopName,
  toPhoneSyncPhone
} from '../../src/main/localSync/view'

// Settings > Phone sync: the short-fingerprint helper, which interfaces count
// as the LAN, and the payload the renderer receives. Plain Node.

const PHONE_ID = '7c1e9a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

// ── Short fingerprint ─────────────────────────────────────────────────────

test('the short fingerprint matches the worked example in the protocol doc', () => {
  expect(shortFingerprint('3f9a01c277bed4104cadeac43e1310162266e1edaa616c3855705d7e5b6a115f')).toBe(
    '3F9A-01C2-77BE-D410'
  )
})

test('the short fingerprint is the first 16 hex of a real certificate, uppercased', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-sync-short-'))
  try {
    const { fingerprint } = await loadOrCreateCertificate(dir)
    const short = shortFingerprint(fingerprint)
    expect(short).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(short.replace(/-/g, '').toLowerCase()).toBe(fingerprint.slice(0, 16))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the short fingerprint refuses anything that is not a full fingerprint', () => {
  for (const bad of ['', '3f9a01c2', 'G'.repeat(64), '3F9A'.repeat(16), `${'a'.repeat(64)}0`]) {
    expect(FINGERPRINT_RE.test(bad)).toBe(false)
    expect(() => shortFingerprint(bad)).toThrow()
  }
})

// ── Interface filter ──────────────────────────────────────────────────────

const v4 = (
  address: string,
  internal = false
): { address: string; family: string; internal: boolean } => ({ address, family: 'IPv4', internal })

test('only real LAN interfaces with private IPv4 addresses are kept', () => {
  const addresses = lanAddressesFrom({
    lo0: [v4('127.0.0.1', true)],
    en0: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    en1: [v4('10.0.0.5')],
    eth0: [v4('172.16.4.2')],
    wlan0: [v4('8.8.8.8')], // public: never
    utun3: [v4('10.8.0.2')], // VPN
    tun0: [v4('10.9.0.2')],
    wg0: [v4('10.10.0.2')],
    tailscale0: [v4('100.101.1.1')],
    bridge100: [v4('192.168.64.1')], // VM / internet sharing
    vmnet8: [v4('172.16.200.1')],
    vboxnet0: [v4('192.168.56.1')],
    docker0: [v4('172.17.0.1')],
    'br-1a2b3c': [v4('172.18.0.1')],
    veth12ab: [v4('172.17.0.5')],
    awdl0: [v4('169.254.1.1')],
    'vEthernet (WSL)': [v4('172.20.0.1')],
    'VMware Network Adapter VMnet1': [v4('192.168.100.1')],
    'VirtualBox Host-Only Network': [v4('192.168.57.1')],
    'Wi-Fi': [v4('192.168.0.14')],
    Ethernet: [v4('192.168.0.15')],
    en2: undefined
  })
  expect(addresses).toEqual([
    '192.168.1.20',
    '10.0.0.5',
    '172.16.4.2',
    '192.168.0.14',
    '192.168.0.15'
  ])
})

test('Node builds that report the family as a number are handled', () => {
  expect(
    lanAddressesFrom({ en0: [{ address: '192.168.1.9', family: 4, internal: false }] })
  ).toEqual(['192.168.1.9'])
})

test('the same address on two interfaces is listed once', () => {
  expect(lanAddressesFrom({ en0: [v4('192.168.1.9')], en5: [v4('192.168.1.9')] })).toEqual([
    '192.168.1.9'
  ])
})

test('ordinary wifi and ethernet names are not excluded', () => {
  for (const name of ['en0', 'en7', 'eth0', 'enp3s0', 'wlan0', 'wlp2s0', 'Wi-Fi', 'Ethernet 2']) {
    expect(isExcludedInterface(name)).toBe(false)
  }
})

// ── The renderer payload ──────────────────────────────────────────────────

test('the phone-sync payload carries no device secret, token hash or key material', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-sync-payload-'))
  const db = new Database(':memory:')
  try {
    applyLocalSyncSchema(db)
    const store = createPhoneStore(db)
    const secret = generateDeviceSecret()
    store.savePairing(PHONE_ID, 'DeepCrated on iPhone', secret, 1_000)
    store.authenticate(PHONE_ID, secret, 2_000)
    const tls = await loadOrCreateCertificate(dir)

    const state = buildPhoneSyncState({
      enabled: true,
      status: { state: 'running', port: 47823, addresses: ['192.168.1.20:47823'] },
      desktopName: 'Studio iMac',
      defaultDesktopName: 'Studio-iMac',
      pairing: {
        qrDataUrl: 'data:image/png;base64,AAAA',
        hosts: ['192.168.1.20'],
        port: 47823,
        pairingCode: 'K7Q-4MZ',
        shortFingerprint: shortFingerprint(tls.fingerprint),
        expiresAt: 300_000
      },
      lastPairingEnd: null,
      phones: store.list()
    })

    const text = JSON.stringify(state)
    expect(text).not.toContain(secret)
    expect(text).not.toContain(hashSecret(secret))
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain(tls.key.split('\n')[1])
    expect(text).not.toMatch(/token|secret|hash|\bkey\b/i)
    expect(state.phones).toEqual([
      {
        phoneId: PHONE_ID,
        displayName: 'DeepCrated on iPhone',
        pairedAt: 1_000,
        lastSeenAt: 2_000,
        revokedAt: null
      }
    ])
    expect(Object.keys(state).sort()).toEqual([
      'defaultDesktopName',
      'desktopName',
      'enabled',
      'lastPairingEnd',
      'pairing',
      'phones',
      'status'
    ])
    expect(Object.keys(state.pairing!).sort()).toEqual([
      'expiresAt',
      'hosts',
      'pairingCode',
      'port',
      'qrDataUrl',
      'shortFingerprint'
    ])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extra fields on a phone row or a pairing never reach the payload', () => {
  const leaky = {
    phoneId: PHONE_ID,
    displayName: 'iPhone',
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    tokenHash: 'abc123',
    token_hash: 'abc123'
  } as PairedPhone
  expect(toPhoneSyncPhone(leaky)).toEqual({
    phoneId: PHONE_ID,
    displayName: 'iPhone',
    pairedAt: 1,
    lastSeenAt: null,
    revokedAt: null
  })

  const state = buildPhoneSyncState({
    enabled: false,
    status: { state: 'error', code: 'no_network', message: 'No network', stack: 'x' } as never,
    desktopName: 'A',
    defaultDesktopName: 'A',
    pairing: {
      qrDataUrl: 'q',
      hosts: [],
      port: 1,
      pairingCode: 'c',
      shortFingerprint: 's',
      expiresAt: 0,
      fingerprint: 'f'.repeat(64),
      key: '-----BEGIN PRIVATE KEY-----'
    } as never,
    lastPairingEnd: null,
    phones: [leaky]
  })
  const text = JSON.stringify(state)
  expect(text).not.toContain('abc123')
  expect(text).not.toContain('PRIVATE KEY')
  expect(text).not.toContain('f'.repeat(64))
  expect(text).not.toContain('stack')
})

// ── Desktop name ──────────────────────────────────────────────────────────

test('desktop names are trimmed, cleaned and capped for mDNS', () => {
  expect(normalizeDesktopName('  Booth   laptop \n')).toBe('Booth laptop')
  expect(normalizeDesktopName('   ')).toBeNull()
  expect(normalizeDesktopName('Studio\u0000iMac')).toBe('StudioiMac')
  expect(normalizeDesktopName('x'.repeat(100))).toBe('x'.repeat(63))
  // Multi-byte characters are never cut in half.
  const emoji = normalizeDesktopName('🎧'.repeat(20))!
  expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(63)
  expect(emoji).toBe('🎧'.repeat(15))
})

test('the default desktop name is the hostname without .local', () => {
  expect(defaultDesktopName('Studio-iMac.local')).toBe('Studio-iMac')
  expect(defaultDesktopName('')).toBe('DeepCrated desktop')
})
