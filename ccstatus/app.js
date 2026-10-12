// Claude Status: the live state of your Claude Code sessions, and a
// notification when one needs you or is done.
//
// Pairing comes from the link /ccstatus shows as a QR (see crypt.js). The
// phone's Ably token comes from the token service, renewed with the
// pairing's phone secret; that token may only listen on its one channel and
// register this device for push there. Every message is sealed by the
// laptop; the page opens it with the pairing's key.
'use strict'

const VERSION = '3.3'
const WORKER = 'https://claude-status.mohitsandroid.workers.dev'
const ABLY_REST = 'https://main.realtime.ably.net'
const COOKIE = 'ccstatus_pair'
// A session that has not reported for this long is shown as gone.
const STALE_MS = 3 * 60_000

const COLORS = { idle: '#3fb950', running: '#2f81f7', attention: '#f0a020', background: '#a371f7', error: '#f85149', starting: '#8b949e', ended: '#6e7681' }
const KINDS = { think: '#a371f7', reply: '#3fb950', read: '#2f81f7', search: '#39c5cf', write: '#f0a020', run: '#db61a2', web: '#39c5cf', delegate: '#a371f7', plan: '#8b949e', ask: '#f0a020', tool: '#8b949e' }

const $ = id => document.getElementById(id)
const ua = navigator.userAgent
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// ---------------------------------------------------------------- diagnostics

const logLines = []
function log(text) {
  logLines.push(new Date().toLocaleTimeString() + '  ' + text)
  if (logLines.length > 200) logLines.shift()
  if (!$('diag').hidden) renderLog()
}
function renderLog() {
  const ol = $('log')
  ol.textContent = ''
  for (const line of logLines.slice().reverse()) {
    const li = document.createElement('li')
    li.textContent = line
    ol.append(li)
  }
}
let taps = 0, tapTimer = 0
$('version').textContent = 'v' + VERSION
$('version').onclick = () => {
  clearTimeout(tapTimer)
  tapTimer = setTimeout(() => { taps = 0 }, 1500)
  if (++taps >= 5) { taps = 0; $('diag').hidden = !$('diag').hidden; renderLog() }
}
window.addEventListener('error', e => log('error: ' + e.message))
window.addEventListener('unhandledrejection', e => log('error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)))

function problem(text) {
  $('problem').textContent = text || ''
  $('problem').hidden = !text
}

// ---------------------------------------------------------------- pairing

// The link's pairing, kept in IndexedDB (the service worker reads it) and,
// on iOS, in a cookie: adding to the Home Screen copies cookies alone into
// the installed app, so that is how a pairing made in Safari gets there.
async function loadPairing() {
  const fromLink = CCS.parseLink(location.hash)
  if (location.hash) history.replaceState(null, '', location.pathname)
  if (fromLink) {
    await CCS.set('pairing', fromLink)
    document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(fromLink))}; Max-Age=${2 * 86400}; Path=/ccstatus/; Secure; SameSite=Strict`
    log('paired from the link')
    return fromLink
  }
  const saved = await CCS.get('pairing').catch(() => null)
  if (saved) return saved
  const c = document.cookie.split('; ').find(x => x.startsWith(COOKIE + '='))
  if (c) {
    try {
      const p = JSON.parse(decodeURIComponent(c.slice(COOKIE.length + 1)))
      if (p && p.channel && p.secret && p.key) {
        await CCS.set('pairing', p)
        log('pairing carried over from Safari')
        return p
      }
    } catch {}
  }
  return null
}

async function unpair() {
  if (!confirm('Unpair this phone? It stops showing status and notifications until you scan a new code.')) return
  try { await client?.push.deactivate() } catch {}
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    await sub?.unsubscribe()
  } catch {}
  await CCS.set('pairing', undefined)
  localStorage.clear()
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/ccstatus/; Secure; SameSite=Strict`
  location.reload()
}
$('unpair').onclick = unpair

// ---------------------------------------------------------------- install sheet

// After khmyznikov/pwa-install's per-browser steps (MIT, see icons.js).
const nav = {
  iosNonSafari: /CriOS|EdgiOS|FxiOS|OPiOS|OPT\/|Ddg|YaBrowser/.test(ua),
  inApp: /FBAN|FBAV|Instagram|Line\/|LinkedInApp|Twitter|MicroMessenger|GSA\//.test(ua),
  edge: /Edg(e|A|iOS)?\//.test(ua),
  firefox: /Firefox\/|FxiOS/.test(ua),
  opera: /OPR\/|OPT\/|OPiOS/.test(ua),
  android: /Android/i.test(ua),
  // iOS 26 moved Share into a menu behind the address bar, then "View More".
  ios26: typeof CSS !== 'undefined' && CSS.supports('text-wrap', 'pretty'),
  // iOS 27 draws that menu as three lines instead of three dots.
  ios27: typeof CSS !== 'undefined' && CSS.supports('background', 'revert-rule'),
}

function chip(icon, label) {
  const s = document.createElement('span')
  s.className = 'chip'
  if (icon) {
    const i = document.createElement('span')
    i.className = 'ci'
    i.innerHTML = ICONS[icon]
    s.append(i)
  }
  if (label) s.append(label)
  return s
}
function step(...parts) {
  const li = document.createElement('li')
  li.append(...parts)
  return li
}
let deferredInstall = null
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault()
  deferredInstall = e
  $('installBtn').hidden = false
})

function iosSteps() {
  if (nav.inApp) return [step('Open this page in ', chip('', 'Safari'), ': this app\'s browser cannot install it')]
  const out = []
  const menu = nav.ios26 && (!nav.iosNonSafari || nav.edge || nav.opera)
  if (menu) out.push(step('Tap ', chip(nav.ios27 && !nav.opera ? 'menu' : 'dots'), ' in the address bar'))
  out.push(step('Tap ', chip('share', 'Share')))
  if (nav.ios26) out.push(step('Tap ', chip('viewMore', 'View More')))
  out.push(step('Tap ', chip('addHome', 'Add to Home Screen')))
  out.push(step('Open ', chip('', 'CC Status'), ' from your Home Screen'))
  return out
}
function otherSteps() {
  const open = step('Open ', chip('', 'CC Status'), ' from your ' + (nav.android ? 'home screen' : 'apps'))
  if (nav.android) {
    if (nav.firefox) return [step('Tap ', chip('kebab'), ' in the toolbar'), step('Tap ', chip('', 'Add app to Home screen')), open]
    return [step('Tap ', chip('', 'Install'), ' below, or ', chip('kebab'), ' → ', chip('', 'Add to Home screen')), open]
  }
  // Desktop: the install button sits at the right of the address bar.
  if (nav.firefox) return [step('Click ', chip('firefoxInstall'), ' at the right of the address bar'), open]
  if (nav.edge) return [step('Click ', chip('edgeInstall'), ' at the right of the address bar'), open]
  return [step('Click ', chip('chromeInstall'), ' at the right of the address bar'), open]
}
function showSheet() {
  if (isStandalone || sessionStorage.getItem('sheetClosed')) return
  $('steps').replaceChildren(...(isIOS ? iosSteps() : otherSteps()))
  $('installBtn').hidden = !deferredInstall
  $('sheet').hidden = false
}
$('sheetClose').onclick = () => { $('sheet').hidden = true; sessionStorage.setItem('sheetClosed', '1') }
$('installBtn').onclick = async () => {
  if (!deferredInstall) return
  deferredInstall.prompt()
  await deferredInstall.userChoice
  deferredInstall = null
  $('installBtn').hidden = true
}

// ---------------------------------------------------------------- Ably

let client = null
let pairing = null
let currentToken = null

// The phone's token, from the token service.
async function fetchToken() {
  const res = await fetch(WORKER + '/renew', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: pairing.channel, secret: pairing.secret, role: 'phone' }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 403) throw Object.assign(new Error('This phone is no longer paired. Scan a new code from /ccstatus.'), { unpaired: true })
  if (!res.ok || !body.phone) throw new Error(body.error || 'The token service answered ' + res.status)
  currentToken = body.phone.token
  return body.phone.token
}

const sessions = new Map()

function connect() {
  client = new Ably.Realtime({
    authCallback: (_params, cb) => {
      fetchToken().then(t => cb(null, t), err => {
        if (err.unpaired) problem(err.message)
        log('token: ' + err.message)
        cb(err.message, null)
      })
    },
    plugins: { Push: AblyPushPlugin },
    pushServiceWorkerUrl: '/ccstatus/sw.js',
    echoMessages: false,
  })
  client.connection.on(change => {
    log('ably: ' + change.current + (change.reason ? ' (' + change.reason.message + ')' : ''))
    $('conn').className = 'conn ' + (change.current === 'connected' ? 'on' : change.current === 'connecting' ? '' : 'off')
  })
  // Rewound a little: each session's newest state arrives at once.
  const channel = client.channels.get(pairing.channel, { params: { rewind: '10' } })
  channel.subscribe('state', async msg => {
    try {
      const s = await CCS.open(pairing, msg.data)
      if (!s || !s.session) return
      // Messages arrive in the order each session sent them: the newest wins.
      // Ably's own timestamp, so a rewound state from hours ago is not shown as live.
      s.receivedAt = Math.min(msg.timestamp || Date.now(), Date.now())
      sessions.set(s.session, s)
      render()
    } catch (err) {
      log('could not open a message: ' + err.message)
    }
  })
}

// ---------------------------------------------------------------- push

function urlB64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}
function bytesToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

// The VAPID key Ably made for this app, fetched before any tap so the tap has
// nothing to wait for.
let vapidKey = null
async function fetchVapidKey() {
  const token = currentToken || await fetchToken()
  const res = await fetch(ABLY_REST + '/push/publicVapidKey', { headers: { authorization: 'Bearer ' + btoa(token), accept: 'text/plain' } })
  if (!res.ok) throw new Error('push key: HTTP ' + res.status)
  vapidKey = (await res.text()).trim().replace(/^"|"$/g, '')
}

// iOS shows the permission prompt only for a request made in the tap itself,
// and answers "denied" to a later one even after Allow. So the browser half
// of web push runs here, from the tap, and Ably is handed the subscription
// already made: its own activate() then never asks.
function turnOnPush() {
  const btn = $('notifyBtn')
  btn.disabled = true
  let asked
  try {
    asked = Notification.requestPermission()
  } catch (err) {
    log('permission: ' + err.message)
    btn.disabled = false
    return
  }
  Promise.resolve(asked).then(async perm => {
    log('permission: ' + perm)
    if (perm !== 'granted') { btn.disabled = false; renderNotify(); return }
    try {
      if (!vapidKey) await fetchVapidKey()
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidKey) })
      const device = await client.getDevice()
      device.push.recipient = {
        transportType: 'web',
        targetUrl: btoa(sub.endpoint),
        publicVapidKey: vapidKey,
        encryptionKey: { p256dh: bytesToB64(sub.getKey('p256dh')), auth: bytesToB64(sub.getKey('auth')) },
      }
      device.persist()
      await client.push.activate()
      await client.channels.get(pairing.channel).push.subscribeDevice()
      localStorage.setItem('ccstatus.push', pairing.channel)
      log('push on, device ' + device.id)
      renderNotify()
    } catch (err) {
      log('push setup: ' + (err && err.message ? err.message : err))
      problem('Could not turn on notifications. Try again in a moment.')
      btn.disabled = false
    }
  })
}
$('notifyBtn').onclick = turnOnPush

function renderNotify() {
  const box = $('notify'), btn = $('notifyBtn'), text = $('notifyText')
  box.hidden = false
  btn.hidden = true
  if (!pairing) { box.hidden = true; return }
  if (!hasPush || (isIOS && !isStandalone)) {
    text.textContent = isIOS ? 'Add this page to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications.' : 'This browser cannot show notifications.'
    return
  }
  const perm = Notification.permission
  if (perm === 'granted' && localStorage.getItem('ccstatus.push') === pairing.channel) {
    box.hidden = true
  } else if (perm === 'denied') {
    text.textContent = 'Notifications are off for this app. Turn them on in Settings → Notifications → CC Status, then reopen the app.'
  } else {
    text.textContent = 'Get a notification when a session needs you or is done.'
    btn.hidden = false
    btn.disabled = false
  }
}

// ---------------------------------------------------------------- the view

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'
}

function isLive(s) {
  return s.status !== 'ended' && Date.now() - s.receivedAt < STALE_MS
}

function pick(list) {
  const want = new URLSearchParams(location.hash.slice(1)).get('s') || sessionStorage.getItem('follow')
  return list.find(x => x.session === want) ||
    list.find(x => x.status === 'attention' || x.status === 'error') ||
    list.find(x => x.status === 'running') || list[0]
}

function render() {
  const list = [...sessions.values()].filter(isLive).sort((a, b) => a.project.localeCompare(b.project) || a.session.localeCompare(b.session))
  const selected = pick(list)
  $('empty').hidden = !pairing || list.length > 0
  $('view').hidden = !selected

  const nav = $('list')
  nav.textContent = ''
  if (list.length > 1) {
    for (const x of list) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'row ' + x.status + (x === selected ? ' sel' : '')
      b.style.setProperty('--rc', COLORS[x.status] || '#8b949e')
      const dot = document.createElement('span'); dot.className = 'rd'
      const name = document.createElement('span'); name.className = 'rp'; name.textContent = x.project || 'Session'
      const label = document.createElement('span'); label.className = 'rl'; label.textContent = x.label
      b.append(dot, name, label)
      b.onclick = () => { sessionStorage.setItem('follow', x.session); render() }
      nav.append(b)
    }
  }
  if (!selected) { document.body.className = 'idle'; return }

  const c = COLORS[selected.status] || '#8b949e'
  document.body.className = selected.status
  document.documentElement.style.setProperty('--c', c)
  $('label').textContent = selected.label
  $('meta').textContent = (selected.project || 'Session') + (selected.since ? ' · for ' + ago(Date.now() - selected.since) : '')
  $('detail').textContent = selected.detail || ''

  const a = selected.activity
  const sameVerb = a && a.verb === selected.label
  $('pill').hidden = !a || (sameVerb && !a.target)
  if (a) {
    $('pill').style.setProperty('--k', KINDS[a.kind] || '#8b949e')
    $('pic').textContent = a.icon
    $('pverb').textContent = sameVerb ? '' : a.verb
    $('ptgt').textContent = a.target || ''
  }

  const sm = selected.summary
  $('summary').hidden = !sm || sm.state === 'failed'
  if (sm) {
    $('summary').className = 'card ' + sm.state
    $('stext').textContent = sm.state === 'pending' ? 'Writing the action items…' : sm.text
  }
  document.title = selected.label + ' · Claude Status'
}
setInterval(render, 5000)

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data && e.data.type === 'open' && e.data.session) { sessionStorage.setItem('follow', e.data.session); render() }
})

// ---------------------------------------------------------------- start

;(async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/ccstatus/sw.js', { scope: '/ccstatus/' }).catch(err => log('service worker: ' + err.message))
  }
  pairing = await loadPairing()
  const follow = new URLSearchParams(location.hash.slice(1)).get('s')
  if (follow) sessionStorage.setItem('follow', follow)
  log('start: ' + (isIOS ? 'iOS' : 'other') + ', ' + (isStandalone ? 'installed' : 'browser') + ', ' + (pairing ? 'paired' : 'not paired'))
  if (!pairing) {
    $('welcome').hidden = false
    if (isStandalone && isIOS) {
      $('welcome').querySelector('p').textContent = 'Scan the QR code /ccstatus shows with the Camera, open it in Safari, then reopen this app.'
    }
  } else {
    connect()
    fetchVapidKey().catch(err => log('push key: ' + err.message))
  }
  renderNotify()
  render()
  showSheet()
})()
