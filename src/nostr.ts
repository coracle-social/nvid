import { Relay } from 'nostr-tools/relay'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event, EventTemplate } from 'nostr-tools/core'
import { RELAY_URL } from './config'

/**
 * A broadcast signs a couple of events per second, which rules out a NIP-07 extension —
 * every chunk would be a permission prompt. Streams are addressed by their `t` tag rather
 * than by author, so a throwaway per-tab key costs nothing. Persisted to sessionStorage
 * only so a reload doesn't change identity mid-stream.
 */
const STORAGE_KEY = 'nvid:sk'

let secretKey: Uint8Array | undefined

function getSecretKey(): Uint8Array {
  if (secretKey) return secretKey

  const stored = sessionStorage.getItem(STORAGE_KEY)
  if (stored) {
    secretKey = Uint8Array.from(stored.match(/.{2}/g)!.map(b => parseInt(b, 16)))
  } else {
    secretKey = generateSecretKey()
    const hex = [...secretKey].map(b => b.toString(16).padStart(2, '0')).join('')
    sessionStorage.setItem(STORAGE_KEY, hex)
  }

  return secretKey
}

export function getPubkey(): string {
  return getPublicKey(getSecretKey())
}

export function sign(template: EventTemplate): Event {
  return finalizeEvent(template, getSecretKey())
}

let relayPromise: Promise<Relay> | undefined

export function getRelay(): Promise<Relay> {
  if (!relayPromise) {
    relayPromise = Relay.connect(RELAY_URL, { enableReconnect: true }).catch(error => {
      relayPromise = undefined // let the next caller retry rather than caching the failure
      throw error
    })
  }

  return relayPromise
}
