// Shared by the page and the service worker: the pairing as stored, and the
// opening of what the laptop sealed.
//
// A pairing link is https://mohitmohan.com/ccstatus/#<id>.<phoneSecret>.<key>
// (base64url each): the channel status:<id>, the secret that renews this
// phone's read-only token at the token service, and the AES-256 key the
// laptop seals every message with. It is kept in IndexedDB, which the
// service worker can read when a push arrives.
'use strict'

const CCS = (() => {
  const DB = 'ccstatus'
  const STORE = 'kv'

  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(bin, c => c.charCodeAt(0))
  }

  function parseLink(fragment) {
    const parts = String(fragment || '').replace(/^#/, '').split('.')
    if (parts.length !== 3) return null
    const [id, secret, key] = parts
    if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null
    if (b64urlDecode(key).length !== 32) return null
    return { channel: 'status:' + id, secret, key }
  }

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function get(k) {
    const d = await db()
    return new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(k)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }

  async function set(k, v) {
    const d = await db()
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite')
      if (v === undefined) tx.objectStore(STORE).delete(k)
      else tx.objectStore(STORE).put(v, k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  const keys = new Map()
  async function cryptoKey(pairing) {
    if (!keys.has(pairing.key)) {
      keys.set(pairing.key, await crypto.subtle.importKey('raw', b64urlDecode(pairing.key), 'AES-GCM', false, ['decrypt']))
    }
    return keys.get(pairing.key)
  }

  // "v1.<iv>.<ciphertext+tag>", the channel name as associated data.
  async function open(pairing, sealed) {
    const parts = String(sealed || '').split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('not a sealed message')
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(parts[1]), additionalData: new TextEncoder().encode(pairing.channel) },
      await cryptoKey(pairing),
      b64urlDecode(parts[2]),
    )
    return JSON.parse(new TextDecoder().decode(pt))
  }

  return { parseLink, get, set, open }
})()
