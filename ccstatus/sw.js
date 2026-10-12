// Claude Status service worker: shows each push as a notification and opens
// the app when one is tapped.
//
// Every push must show a notification: iOS revokes the permission of a web
// app that receives one and shows nothing, so even a malformed payload gets
// a generic one.

const APP = '/ccstatus/'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function parse(event) {
  try {
    return event.data ? event.data.json() : {}
  } catch {
    return { notification: { body: event.data ? event.data.text() : '' } }
  }
}

self.addEventListener('push', event => {
  const payload = parse(event)
  const n = payload.notification || {}
  const data = payload.data || {}
  const title = n.title || 'Claude Status'
  const options = {
    body: n.body || 'Open the app for details.',
    icon: APP + 'icons/icon-192.png',
    badge: APP + 'icons/icon-192.png',
    // One notification per session and kind: a newer one replaces it.
    tag: data.tag || 'ccstatus',
    renotify: true,
    data,
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options)
    // An open app learns of the push too, and refreshes at once.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) w.postMessage({ type: 'push', title, body: options.body, data })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data || {}
  // Only ever open this app, whatever the payload says.
  const target = new URL(APP + (data.session ? '#s=' + encodeURIComponent(data.session) : ''), self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) {
      if (new URL(w.url).pathname.startsWith(APP)) {
        await w.focus()
        w.postMessage({ type: 'open', data })
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})
