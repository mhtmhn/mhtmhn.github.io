// Claude Status, phase 1: pair from a link, install, turn on push, and log
// what arrives. The pairing link is https://mohitmohan.com/ccstatus/#<id>.<jwt>:
// the channel is status:<id>, and <jwt> an Ably token the laptop signed for
// that channel alone. The part after # never leaves the phone (browsers do
// not send it to the server).
'use strict'

const VERSION = 'p1.3'
// Ably's REST endpoint, as ably-js 2.x names its primary host.
const ABLY_REST = 'https://main.realtime.ably.net'
const $ = id => document.getElementById(id)
const STORE = 'ccstatus.pairing'
const COOKIE = 'ccstatus_pairing'

function log(text, kind) {
  const li = document.createElement('li')
  li.textContent = new Date().toLocaleTimeString() + '  ' + text
  if (kind) li.className = kind
  $('log').prepend(li)
}

// ---------------------------------------------------------------- platform

const ua = navigator.userAgent
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// ---------------------------------------------------------------- pairing

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(escape(atob(s + '==='.slice((s.length + 3) % 4))))
}

function validPairing(p) {
  return p && p.v === 1 && typeof p.ch === 'string' && /^status:[A-Za-z0-9_-]{16,64}$/.test(p.ch) && typeof p.t === 'string' && p.t.length < 4096
}

// The token's own expiry, read from the JWT payload (not verified here: Ably
// verifies it; this only decides when to ask for a fresh one).
function tokenExpiry(t) {
  try { return JSON.parse(b64urlDecode(t.split('.')[1])).exp * 1000 } catch { return 0 }
}

function savePairing(p) {
  const text = JSON.stringify(p)
  localStorage.setItem(STORE, text)
  // iOS copies cookies, and only cookies, into the app added to the Home
  // Screen: this is how a pairing made in Safari reaches the installed app.
  const days = 2
  document.cookie = `${COOKIE}=${encodeURIComponent(text)}; Max-Age=${days * 86400}; Path=/ccstatus/; Secure; SameSite=Strict`
}

function loadPairing() {
  const fromHash = location.hash.slice(1)
  if (fromHash) {
    try {
      const dot = fromHash.indexOf('.')
      const p = { v: 1, ch: 'status:' + fromHash.slice(0, dot), t: fromHash.slice(dot + 1) }
      if (dot > 0 && validPairing(p)) {
        savePairing(p)
        log('Paired from the link', 'ok')
      } else {
        log('The pairing link is not valid', 'err')
      }
    } catch {
      log('The pairing link could not be read', 'err')
    }
    // Drop the token from the address bar and the history.
    history.replaceState(null, '', location.pathname)
  }
  let text = localStorage.getItem(STORE)
  if (!text) {
    const c = document.cookie.split('; ').find(x => x.startsWith(COOKIE + '='))
    if (c) {
      text = decodeURIComponent(c.slice(COOKIE.length + 1))
      localStorage.setItem(STORE, text)
      log('Pairing carried over from Safari', 'ok')
    }
  }
  try {
    const p = JSON.parse(text || 'null')
    return validPairing(p) ? p : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- install sheet

function chip(icon, label) {
  const s = document.createElement('span')
  s.className = 'chip'
  s.textContent = (icon ? icon + ' ' : '') + label
  return s
}

function step(...parts) {
  const li = document.createElement('li')
  for (const p of parts) li.append(typeof p === 'string' ? p : p)
  return li
}

let deferredInstall = null
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault()
  deferredInstall = e
  // iOS has no install prompt: the steps are the only way there.
  $('installBtn').hidden = isIOS
})

function showSheet() {
  if (isStandalone || sessionStorage.getItem('sheetClosed')) return
  const steps = $('steps')
  steps.textContent = ''
  if (isIOS) {
    steps.append(
      step('Tap ', chip('⬆︎', 'Share'), ' in the browser bar'),
      step('Scroll and tap ', chip('⊞', 'Add to Home Screen')),
      step('Open ', chip('', 'CC Status'), ' from your Home Screen'),
    )
  } else {
    steps.append(
      step('Tap ', chip('', 'Install'), ' below, or ', chip('⋮', 'menu'), ' → ', chip('', 'Install app')),
      step('Open ', chip('', 'CC Status'), ' from your home screen'),
    )
  }
  $('sheet').hidden = false
}
$('sheetClose').onclick = () => { $('sheet').hidden = true; sessionStorage.setItem('sheetClosed', '1') }
$('installBtn').onclick = async () => {
  if (!deferredInstall) return
  deferredInstall.prompt()
  const { outcome } = await deferredInstall.userChoice
  log('Install: ' + outcome)
  deferredInstall = null
  $('installBtn').hidden = true
}

// ---------------------------------------------------------------- Ably

let client = null

function connect(p) {
  client = new Ably.Realtime({
    token: p.t,
    plugins: { Push: AblyPushPlugin },
    pushServiceWorkerUrl: '/ccstatus/sw.js',
    // The phone never publishes; it only listens.
    echoMessages: false,
  })
  client.connection.on(change => {
    log('Ably: ' + change.current + (change.reason ? ' (' + change.reason.message + ')' : ''), change.current === 'failed' ? 'err' : '')
  })
  // The live channel, rewound by one: the latest status shows at once.
  const channel = client.channels.get(p.ch, { params: { rewind: '1' } })
  channel.subscribe(msg => log('Message: ' + msg.name + ' ' + JSON.stringify(msg.data).slice(0, 160)))
  return channel
}

// iOS only shows the permission prompt for a request made in the tap
// itself, and answers "denied" to any later request made outside one, even
// after the person tapped Allow. Ably's own activate() asks for permission
// again after a network round trip, so on iOS it always failed. Here the
// whole browser half of web push runs from the tap, and Ably is handed the
// finished subscription (activatePush): it never asks.

function urlB64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}

function bytesToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

// The VAPID public key Ably made for this app, fetched before any tap so the
// tap has nothing to wait for. Any valid token may read it.
let vapidKey = null
async function fetchVapidKey(p) {
  const res = await fetch(ABLY_REST + '/push/publicVapidKey', {
    headers: { authorization: 'Bearer ' + btoa(p.t), accept: 'text/plain' },
  })
  if (!res.ok) throw new Error('VAPID key: HTTP ' + res.status)
  vapidKey = (await res.text()).trim().replace(/^"|"$/g, '')
}

function turnOnPush(p) {
  const btn = $('notifyBtn')
  btn.disabled = true
  log('Asking for notification permission…')
  let asked
  try {
    asked = Notification.requestPermission()
  } catch (err) {
    log('Permission request failed: ' + err.message, 'err')
    btn.disabled = false
    return
  }
  Promise.resolve(asked).then(async perm => {
    log('Permission: ' + perm, perm === 'granted' ? 'ok' : 'err')
    if (perm !== 'granted') { btn.disabled = false; renderNotify(); return }
    try {
      if (!vapidKey) await fetchVapidKey(p)
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidKey) })
      }
      log('Browser subscription made', 'ok')
      await activatePush(p, sub)
    } catch (err) {
      log('Push setup failed: ' + (err && err.message ? err.message : err), 'err')
      btn.disabled = false
    }
  })
}

// Hands Ably the subscription made in the tap. A device that already has a
// push recipient saved skips Ably's own getting-device-details step (and so
// its second permission request) and goes straight to registration.
async function activatePush(p, sub) {
  const btn = $('notifyBtn')
  try {
    log('Registering with Ably…')
    const device = await client.getDevice()
    device.push.recipient = {
      transportType: 'web',
      targetUrl: btoa(sub.endpoint),
      publicVapidKey: vapidKey,
      encryptionKey: { p256dh: bytesToB64(sub.getKey('p256dh')), auth: bytesToB64(sub.getKey('auth')) },
    }
    device.persist()
    await client.push.activate()
    log('Push activated, device ' + device.id, 'ok')
    // Subscribe the device on the plain channel (no rewind param in the name).
    await client.channels.get(p.ch).push.subscribeDevice()
    log('Subscribed to push on ' + p.ch.slice(0, 14) + '…', 'ok')
    localStorage.setItem('ccstatus.push', 'on')
    renderNotify()
  } catch (err) {
    log('Push failed: ' + (err && err.message ? err.message : err), 'err')
    btn.disabled = false
  }
}

function renderNotify() {
  const btn = $('notifyBtn')
  const text = $('notifyText')
  if (!pairing) {
    text.textContent = 'Pair first: scan the QR code /status-web shows in Claude Code, from inside this app.'
    btn.hidden = true
    return
  }
  if (!hasPush) {
    text.textContent = isIOS && !isStandalone
      ? 'Install the app (Share → Add to Home Screen), then open it to turn on notifications.'
      : 'This browser has no push support.'
    btn.hidden = true
    return
  }
  if (isIOS && !isStandalone) {
    text.textContent = 'On iPhone, notifications only work in the installed app. Install it, then open it from the Home Screen.'
    btn.hidden = true
    return
  }
  const perm = Notification.permission
  if (perm === 'granted' && localStorage.getItem('ccstatus.push') === 'on') {
    text.textContent = 'Notifications are on.'
    btn.hidden = true
  } else if (perm === 'denied') {
    text.textContent = 'Notifications are blocked. Allow them for this app in Settings, then reopen it.'
    btn.hidden = true
  } else {
    text.textContent = 'Tap to allow notifications when a session needs you or is done.'
    btn.hidden = false
    btn.disabled = false
  }
}

// ---------------------------------------------------------------- start

// Nothing fails silently: every error lands in the log.
window.addEventListener('error', e => log('Error: ' + e.message, 'err'))
window.addEventListener('unhandledrejection', e => log('Error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason), 'err'))

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data && e.data.type === 'push') log('Push received: ' + e.data.title + ' / ' + e.data.body, 'ok')
})

const pairing = loadPairing()
$('sub').textContent = (isStandalone ? 'Installed app' : 'In the browser') + ' · ' + VERSION
// The worker registered up front, so the tap has nothing to wait for.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/ccstatus/sw.js', { scope: '/ccstatus/' })
    .then(() => log('Service worker ready'))
    .catch(err => log('Service worker failed: ' + err.message, 'err'))
}
if (pairing) {
  const left = Math.round((tokenExpiry(pairing.t) - Date.now()) / 3600000)
  $('pairText').textContent = 'Paired. Access token valid for ' + (left > 0 ? left + ' more hours.' : 'no longer (expired); scan a new code.')
  connect(pairing)
  fetchVapidKey(pairing).catch(err => log('Could not fetch the push key: ' + err.message, 'err'))
  $('notifyBtn').onclick = () => turnOnPush(pairing)
} else {
  $('pairText').textContent = isStandalone
    ? 'Not paired in this app. The pairing from Safari did not carry over: scan the QR code again with the Camera, then reopen this app.'
    : 'Not paired. Scan the QR code /status-web shows in Claude Code.'
  log('No pairing found (cookie ' + (document.cookie.includes(COOKIE + '=') ? 'present' : 'absent') + ')', 'err')
}
renderNotify()
showSheet()
// iOS offers push to the installed app alone.
const canPush = hasPush && !(isIOS && !isStandalone)
log('Ready: ' + (isIOS ? 'iOS' : 'other') + ', ' + (isStandalone ? 'installed' : 'browser') + ', push ' + (canPush ? 'available' : 'unavailable here'))
