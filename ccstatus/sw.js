// Claude Status service worker: opens each push and shows it as a
// notification, and opens the app when one is tapped.
//
// A push's visible text is generic ("A session needs you"); the real title
// and body ride sealed, and are opened here with the pairing's key, which
// never left the phone. Every push shows a notification, the generic one if
// it cannot be opened: iOS revokes the permission of a web app that receives
// a push and shows nothing.
'use strict'

importScripts('crypt.js?v=3')

const APP = '/ccstatus/'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function parse(event) {
  try {
    return event.data ? event.data.json() : {}
  } catch {
    return {}
  }
}

async function readable(payload) {
  const n = payload.notification || {}
  const data = payload.data || {}
  let title = n.title || 'Claude Status'
  let body = n.body || 'Open the app for details.'
  try {
    const pairing = await CCS.get('pairing')
    if (pairing && data.sealed) {
      const real = await CCS.open(pairing, data.sealed)
      if (typeof real.title === 'string') title = real.title
      if (typeof real.body === 'string') body = real.body
    }
  } catch {
    // A push from before a re-pair, or a damaged one: the generic text stands.
  }
  return { title, body, tag: typeof data.tag === 'string' ? data.tag : 'ccstatus', session: typeof data.tag === 'string' ? data.tag.replace(/^s-/, '') : '' }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const shown = await readable(parse(event))
    await self.registration.showNotification(shown.title, {
      body: shown.body,
      icon: APP + 'icons/icon-192.png',
      badge: APP + 'icons/icon-192.png',
      // One notification per session: a newer one replaces it.
      tag: shown.tag,
      renotify: true,
      data: { session: shown.session },
    })
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) w.postMessage({ type: 'push' })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const session = (event.notification.data || {}).session || ''
  // Only ever this app, whatever a payload says.
  const target = new URL(APP + (session ? '#s=' + encodeURIComponent(session) : ''), self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) {
      if (new URL(w.url).pathname.startsWith(APP)) {
        await w.focus()
        w.postMessage({ type: 'open', session })
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})
