import { Bonjour } from 'bonjour-service'
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from './protocol'

// ── mDNS advertising (groundwork) ─────────────────────────────────────────
// _deepcrated._tcp with TXT { v, id } so a phone can find this desktop again
// after its address changes. The phone cannot browse mDNS yet
// (TODO(sync-discovery) in the protocol doc), so nothing depends on this:
// any failure is logged and swallowed, never fatal to the server.

const STOP_TIMEOUT_MS = 1000

export interface Advertiser {
  start(info: { desktopId: string; desktopName: string; port: number }): void
  stop(): Promise<void>
}

export function createBonjourAdvertiser(log: (message: string) => void = console.warn): Advertiser {
  let bonjour: Bonjour | null = null

  return {
    start({ desktopId, desktopName, port }) {
      try {
        bonjour = new Bonjour(undefined, (err: Error) => {
          log(`[local-sync] mDNS error: ${err.message}`)
        })
        const service = bonjour.publish({
          name: desktopName,
          type: MDNS_SERVICE_TYPE,
          protocol: 'tcp',
          port,
          txt: { v: String(PROTOCOL_VERSION), id: desktopId }
        })
        service.on('error', (err: Error) =>
          log(`[local-sync] mDNS advertise failed: ${err.message}`)
        )
      } catch (err) {
        log(`[local-sync] mDNS could not start: ${(err as Error).message}`)
        bonjour = null
      }
    },
    stop() {
      const current = bonjour
      bonjour = null
      if (!current) return Promise.resolve()
      return new Promise((resolve) => {
        // Goodbye packets are best effort: never let them hold up a quit.
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          try {
            current.destroy()
          } catch (err) {
            log(`[local-sync] mDNS stop failed: ${(err as Error).message}`)
          }
          resolve()
        }
        const timer = setTimeout(finish, STOP_TIMEOUT_MS)
        timer.unref()
        try {
          current.unpublishAll(finish)
        } catch (err) {
          log(`[local-sync] mDNS stop failed: ${(err as Error).message}`)
          finish()
        }
      })
    }
  }
}
