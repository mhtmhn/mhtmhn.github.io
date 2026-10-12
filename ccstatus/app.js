// Claude Status, phase 1: pair from a link, install, turn on push, and log
// what arrives. The pairing link is https://mohitmohan.com/ccstatus/#<id>.<jwt>:
// the channel is status:<id>, and <jwt> an Ably token the laptop signed for
// that channel alone. The part after # never leaves the phone (browsers do
// not send it to the server).
'use strict'

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

async function turnOnPush(p) {
  const btn = $('notifyBtn')
  btn.disabled = true
  try {
    log('Asking for notification permission…')
    await client.push.activate()
    log('Push activated, device ' + client.device().id, 'ok')
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

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data && e.data.type === 'push') log('Push received: ' + e.data.title + ' / ' + e.data.body, 'ok')
})

const pairing = loadPairing()
$('sub').textContent = isStandalone ? 'Installed app' : 'In the browser'
if (pairing) {
  const left = Math.round((tokenExpiry(pairing.t) - Date.now()) / 3600000)
  $('pairText').textContent = 'Paired. Access token valid for ' + (left > 0 ? left + ' more hours.' : 'no longer (expired); scan a new code.')
  connect(pairing)
  $('notifyBtn').onclick = () => turnOnPush(pairing)
} else {
  $('pairText').textContent = 'Not paired. Scan the QR code /status-web shows in Claude Code.'
}
renderNotify()
showSheet()
// iOS offers push to the installed app alone.
const canPush = hasPush && !(isIOS && !isStandalone)
log('Ready: ' + (isIOS ? 'iOS' : 'other') + ', ' + (isStandalone ? 'installed' : 'browser') + ', push ' + (canPush ? 'available' : 'unavailable here'))
