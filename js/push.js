// Home Screen install and Web Push.
//
// What is and is not possible here, measured rather than assumed:
//
// - iOS only allows web push for a web app added to the Home Screen, from iOS
//   16.4. A page open in a Safari tab cannot receive push at all.
// - Web Push is server-initiated by definition. Something has to hold a VAPID
//   private key and send to *.push.apple.com. GitHub Pages serves static files
//   and cannot send anything, so the site alone can never push.
// - iOS supports neither Background Sync nor Periodic Background Sync, so an
//   installed web app cannot wake itself up to check scores either.
//
// Hence worker/: a tiny Cloudflare Worker on a cron that does the polling and
// the sending. Until it is deployed and push-config.json filled in, everything
// here stays switched off and says so, rather than pretending to work.
import { state } from './state.js';
import * as bets from './bets.js';

let config = null;
let registration = null;

export const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export async function loadConfig() {
  if (config !== null) return config;
  try {
    const res = await fetch('./push-config.json', { cache: 'no-store' });
    config = res.ok ? await res.json() : {};
  } catch (e) {
    config = {};
  }
  return config;
}

export const configured = () => !!(config && config.api && config.vapidPublicKey);

export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
    return registration;
  } catch (err) {
    console.warn('[push] service worker registration failed', err);
    return null;
  }
}

/* --------------------------------------------------------------- state */

// What the settings panel needs to say, in one call.
export async function status() {
  await loadConfig();
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const sub = await current();
  return {
    supported,
    configured: configured(),
    installed: installed(),
    permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    subscribed: !!sub,
    // iOS refuses push outright unless the app was added to the Home Screen,
    // which is the single most confusing part of this for anyone setting it up.
    needsInstall: isIOS() && !installed(),
  };
}

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function current() {
  if (!registration) {
    if (!('serviceWorker' in navigator)) return null;
    registration = await navigator.serviceWorker.getRegistration() || null;
  }
  if (!registration?.pushManager) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}

/* ----------------------------------------------------------- subscribe */

export async function enable() {
  await loadConfig();
  if (!configured()) throw new Error('Push is not set up yet - see worker/README.md.');
  if (typeof Notification === 'undefined') throw new Error('This browser has no notifications.');
  if (isIOS() && !installed()) {
    throw new Error('On iPhone, add this to your Home Screen first - Safari will not deliver push to a tab.');
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(`Notifications are ${perm}.`);

  const reg = registration || await registerWorker();
  if (!reg) throw new Error('Service worker would not register.');
  await navigator.serviceWorker.ready;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
  });

  await post('/subscribe', { subscription: sub.toJSON(), bets: state.bets });
  return sub;
}

export async function disable() {
  const sub = await current();
  if (!sub) return;
  try { await post('/unsubscribe', { endpoint: sub.endpoint }); } catch (e) { /* best effort */ }
  await sub.unsubscribe();
}

// Whenever the bet list changes, the sender needs the new one - it evaluates
// them itself, with the same bets-core this page uses.
export async function syncBets() {
  if (!configured()) return;
  const sub = await current();
  if (!sub) return;
  try {
    await post('/bets', { endpoint: sub.endpoint, bets: state.bets });
  } catch (err) {
    console.warn('[push] bet sync failed', err);
  }
}

// Fire one on demand. The only way to find out whether a phone actually
// buzzes is to make it buzz.
export async function sendTest() {
  await loadConfig();
  const sub = await current();
  if (!sub) throw new Error('Turn phone alerts on first.');
  return post('/test', { endpoint: sub.endpoint });
}

async function post(path, body) {
  const base = String(config.api || '').replace(/\/$/, '');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// The VAPID public key travels as base64url; subscribe() wants bytes.
function urlBase64ToUint8Array(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export { bets };
