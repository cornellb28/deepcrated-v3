import { createServer, type Server } from 'https'
import type { IncomingMessage, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import type { Advertiser } from './discovery'
import type { PairedPhone, PhoneStore } from './phones'
import {
  buildPairingPayload,
  DEVICE_HEADER,
  formatAddress,
  PREFERRED_PORT,
  PROTOCOL_PREFIX,
  PROTOCOL_VERSION,
  type PairingPayload,
  type ProtocolError
} from './protocol'
import { isUuidV4 } from './schema'
import { generateDeviceSecret, PairingCodes } from './security'

// ── Local sync HTTPS server ───────────────────────────────────────────────
// Protocol: docs/local-sync-protocol.md. This module owns transport,
// pairing and auth. Later phases add endpoints through `routes` (patch,
// snapshot) without touching any of it.
//
// Logging rule: never log a token, a pairing code, a request body or a URL
// with its query string.

export interface RouteResult {
  status: number
  body: unknown
}

export interface AuthedRequest {
  phone: PairedPhone
  method: string
  url: URL
  body: unknown
}

export type RouteHandler = (req: AuthedRequest) => RouteResult | Promise<RouteResult>

// Keyed 'METHOD /v1/path', e.g. 'POST /v1/patch'. All are authenticated.
export type Routes = Record<string, RouteHandler>

export interface LocalSyncServerOptions {
  phones: PhoneStore
  desktopId: string
  // A function when the DJ can rename the desktop while the server runs:
  // hello and the QR read it on every request.
  desktopName: string | (() => string)
  tls: { cert: string; key: string; fingerprint: string }
  routes?: Routes
  // Hosts to listen on. Defaults to this machine's private LAN addresses.
  hosts?: string[]
  preferredPort?: number
  portAttempts?: number
  advertiser?: Advertiser | null
  pairingCodes?: PairingCodes
  now?: () => number
  log?: (message: string) => void
  // Told when the live pairing code ends because of a phone: used to pair,
  // or invalidated after too many wrong attempts. Never given the code.
  onPairingEvent?: (event: PairingEvent) => void
}

export type PairingEvent =
  { type: 'paired'; phoneId: string; displayName: string } | { type: 'locked' }

export interface ListenInfo {
  port: number
  // Bare hosts, for the typed-pairing details.
  hosts: string[]
  // host:port, as in the QR.
  addresses: string[]
}

export interface LocalSyncServer {
  start(): Promise<ListenInfo>
  stop(): Promise<void>
  isRunning(): boolean
  listenInfo(): ListenInfo | null
  issuePairingCode(): { code: string; expiresAt: number }
  cancelPairingCode(): void
  // The QR / manual-entry payload, or null when the server is not running or
  // no pairing code is live.
  pairingPayload(): PairingPayload | null
}

export type LocalSyncErrorCode =
  'no_network' | 'port_in_use' | 'permission_denied' | 'listen_failed'

// Thrown by start(). The message is written for the DJ.
export class LocalSyncError extends Error {
  constructor(
    readonly code: LocalSyncErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LocalSyncError'
  }
}

const MAX_BODY_BYTES = 5 * 1024 * 1024
const DEFAULT_PORT_ATTEMPTS = 10

// ── LAN addresses ─────────────────────────────────────────────────────────
// Private IPv4 ranges only (RFC 1918), so the server is never reachable on
// a public interface even when the machine has one. Loopback, link-local
// (169.254/16) and carrier-grade NAT / VPN ranges are left out.
// TODO(sync): IPv6 (ULA / link-local with a scope id); the doc allows
// bracketed IPv6 addresses but v1 only advertises IPv4.
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// Interfaces that are never the DJ's real wifi or ethernet, by name: loopback,
// VPN and tunnels (utun, tun/tap, ppp, ipsec, WireGuard, Tailscale,
// ZeroTier), Apple's peer-to-peer links (awdl, llw, anpi), virtual machine
// and container networks (bridge, vmnet, vboxnet, virbr, docker, veth, CNI
// plugins), and Windows adapters named for Hyper-V, WSL, VMware, VirtualBox
// or a VPN. Their addresses are often private (192.168.64.x for a VM, 10.x
// for a VPN), so the address range alone does not catch them. A phone could
// not reach them anyway, and binding there would offer the server to a VM or
// a VPN peer.
const EXCLUDED_INTERFACE_PREFIX =
  /^(lo|utun|tun|tap|ppp|ipsec|wg|gif|stf|awdl|llw|anpi|bridge|vmnet|vboxnet|virbr|docker|br-|veth|cni|flannel|cali|vxlan|tailscale|zt|feth)/i
const EXCLUDED_INTERFACE_WORD =
  /(virtual|vmware|hyper-v|vethernet|wsl|loopback|vpn|tailscale|zerotier|docker|npcap|tap-windows)/i

export function isExcludedInterface(name: string): boolean {
  return EXCLUDED_INTERFACE_PREFIX.test(name) || EXCLUDED_INTERFACE_WORD.test(name)
}

type InterfaceMap = Record<
  string,
  { address: string; family: string | number; internal: boolean }[] | undefined
>

// Pure, for tests: what lanAddresses() keeps from os.networkInterfaces().
export function lanAddressesFrom(interfaces: InterfaceMap): string[] {
  const out: string[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    if (isExcludedInterface(name)) continue
    for (const info of list ?? []) {
      // family is the number 4 on some Node 18 builds.
      const ipv4 = info.family === 'IPv4' || info.family === 4
      if (ipv4 && !info.internal && isPrivateIPv4(info.address)) out.push(info.address)
    }
  }
  return Array.from(new Set(out))
}

export function lanAddresses(): string[] {
  return lanAddressesFrom(networkInterfaces())
}

// ── The listener ──────────────────────────────────────────────────────────
// The one place a socket is opened. One HTTPS server per host, all on the
// same port. If the port is taken on any host, every server opened so far
// is closed and the next port is tried; any other failure stops at once
// with a clear error (no silent retry loop).
export async function startListener(
  hosts: string[],
  tls: { cert: string; key: string },
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: { preferredPort: number; attempts: number }
): Promise<{ servers: Server[]; port: number }> {
  if (hosts.length === 0) {
    throw new LocalSyncError(
      'no_network',
      'Connect this computer to wifi or ethernet to sync with your phone.'
    )
  }
  const attempts = options.preferredPort === 0 ? 1 : options.attempts
  for (let i = 0; i < attempts; i++) {
    let port = options.preferredPort === 0 ? 0 : options.preferredPort + i
    const servers: Server[] = []
    try {
      for (const host of hosts) {
        const server = createServer({ cert: tls.cert, key: tls.key }, handler)
        server.requestTimeout = 30_000
        server.headersTimeout = 10_000
        server.keepAliveTimeout = 5_000
        await listen(server, host, port)
        servers.push(server)
        // Port 0 (tests): the first host picks, the rest follow it.
        if (port === 0) port = (server.address() as { port: number }).port
      }
      return { servers, port }
    } catch (err) {
      await Promise.all(servers.map(closeServer))
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') continue
      if (code === 'EACCES' || code === 'EPERM') {
        throw new LocalSyncError(
          'permission_denied',
          `DeepCrated isn't allowed to accept connections on port ${port}. Check your firewall or security settings, then try again.`
        )
      }
      throw new LocalSyncError(
        'listen_failed',
        `DeepCrated couldn't start phone sync (${code ?? 'unknown error'}). Check your network and try again.`
      )
    }
  }
  throw new LocalSyncError(
    'port_in_use',
    `Ports ${options.preferredPort}–${options.preferredPort + attempts - 1} are all in use. Close the app using them and try again.`
  )
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

// ── Server ────────────────────────────────────────────────────────────────

export function createLocalSyncServer(options: LocalSyncServerOptions): LocalSyncServer {
  const now = options.now ?? Date.now
  const log = options.log ?? console.warn
  const desktopName = (): string =>
    typeof options.desktopName === 'function' ? options.desktopName() : options.desktopName
  const codes = options.pairingCodes ?? new PairingCodes({ now })
  const routes: Routes = { 'GET /v1/status': status, ...(options.routes ?? {}) }
  const publicPaths = new Set(['/v1/hello', '/v1/pair'])
  const knownPaths = new Set([
    ...publicPaths,
    ...Object.keys(routes).map((key) => key.slice(key.indexOf(' ') + 1))
  ])

  let servers: Server[] = []
  let info: ListenInfo | null = null
  let advertising = false

  function status(): RouteResult {
    return {
      status: 200,
      body: { v: PROTOCOL_VERSION, desktopId: options.desktopId, serverTime: now() }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'https://desktop.invalid')
    const path = url.pathname

    if (!path.startsWith(PROTOCOL_PREFIX)) {
      return send(res, 426, {
        error: 'unsupported_version',
        supported: [PROTOCOL_VERSION],
        message:
          'This version of DeepCrated on your phone does not match the desktop. Update both apps to sync.'
      })
    }

    if (path === '/v1/hello') {
      if (method !== 'GET') return fail(res, 405, 'method_not_allowed')
      return send(res, 200, {
        v: PROTOCOL_VERSION,
        desktopId: options.desktopId,
        desktopName: desktopName()
      })
    }

    if (path === '/v1/pair') {
      if (method !== 'POST') return fail(res, 405, 'method_not_allowed')
      const body = await readJson(req)
      if (body === undefined) return fail(res, 400, 'bad_request')
      return pair(res, body)
    }

    if (!knownPaths.has(path)) return fail(res, 404, 'not_found')
    const handler = routes[`${method} ${path}`]
    if (!handler) return fail(res, 405, 'method_not_allowed')

    const phone = authenticate(req)
    if (!phone) return fail(res, 401, 'unpaired')

    let body: unknown = null
    if (method !== 'GET' && method !== 'HEAD') {
      const parsed = await readJson(req)
      if (parsed === undefined) return fail(res, 400, 'bad_request')
      body = parsed
    }
    const result = await handler({ phone, method, url, body })
    return send(res, result.status, result.body)
  }

  function pair(res: ServerResponse, body: unknown): void {
    if (typeof body !== 'object' || body === null) return fail(res, 400, 'bad_request')
    const { pairingCode, deviceId, deviceName } = body as Record<string, unknown>
    if (typeof pairingCode !== 'string' || !isUuidV4(deviceId) || typeof deviceName !== 'string') {
      return fail(res, 400, 'bad_request')
    }
    const redeemed = codes.redeem(pairingCode)
    if (redeemed === 'locked') notify({ type: 'locked' })
    if (redeemed !== 'ok') return fail(res, 403, 'pairing_code_invalid')
    const name = deviceName.trim().slice(0, 100) || 'Phone'
    const deviceSecret = generateDeviceSecret()
    options.phones.savePairing(deviceId, name, deviceSecret, now())
    log(`[local-sync] paired a phone (${name})`)
    send(res, 200, { deviceSecret })
    notify({ type: 'paired', phoneId: deviceId, displayName: name })
  }

  function notify(event: PairingEvent): void {
    try {
      options.onPairingEvent?.(event)
    } catch (err) {
      log(`[local-sync] pairing listener failed: ${(err as Error).message}`)
    }
  }

  function authenticate(req: IncomingMessage): PairedPhone | null {
    const authorization = req.headers.authorization
    const deviceId = req.headers[DEVICE_HEADER]
    if (typeof authorization !== 'string' || typeof deviceId !== 'string') return null
    const match = /^Bearer (\S+)$/.exec(authorization)
    if (!match || !isUuidV4(deviceId)) return null
    return options.phones.authenticate(deviceId, match[1], now())
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err) => {
      log(`[local-sync] ${req.method} ${requestPath(req)} failed: ${(err as Error).message}`)
      if (!res.headersSent) fail(res, 500, 'internal')
      else res.destroy()
    })
  }

  return {
    async start() {
      if (info) return info
      const hosts = options.hosts ?? lanAddresses()
      const opened = await startListener(hosts, options.tls, handler, {
        preferredPort: options.preferredPort ?? PREFERRED_PORT,
        attempts: options.portAttempts ?? DEFAULT_PORT_ATTEMPTS
      })
      servers = opened.servers
      info = {
        port: opened.port,
        hosts: [...hosts],
        addresses: hosts.map((h) => formatAddress(h, opened.port))
      }
      if (options.advertiser) {
        try {
          options.advertiser.start({
            desktopId: options.desktopId,
            desktopName: desktopName(),
            port: opened.port
          })
          advertising = true
        } catch (err) {
          log(`[local-sync] mDNS could not start: ${(err as Error).message}`)
        }
      }
      return info
    },

    async stop() {
      codes.cancel()
      const closing = servers
      servers = []
      info = null
      if (advertising && options.advertiser) {
        advertising = false
        try {
          await options.advertiser.stop()
        } catch (err) {
          log(`[local-sync] mDNS stop failed: ${(err as Error).message}`)
        }
      }
      await Promise.all(closing.map(closeServer))
    },

    isRunning: () => info !== null,
    listenInfo: () => info,
    issuePairingCode: () => codes.issue(),
    cancelPairingCode: () => codes.cancel(),

    pairingPayload() {
      const live = codes.active()
      if (!info || !live) return null
      return buildPairingPayload({
        desktopId: options.desktopId,
        desktopName: desktopName(),
        addresses: info.addresses,
        pairingCode: live.code,
        certFingerprint: options.tls.fingerprint
      })
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0]
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function fail(res: ServerResponse, status: number, error: ProtocolError): void {
  send(res, status, { error })
}

// undefined = not valid JSON (or too large); the caller answers 400.
function readJson(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: unknown | undefined): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}
