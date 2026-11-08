// VAPID: the signature that lets a push service accept a message from us.
//
// This sends pushes with NO payload. Encrypting a payload (RFC 8291) needs
// ECDH against the subscription key, then HKDF, then AES-GCM - a lot of
// crypto whose failure mode is a silently undelivered message. A push with no
// body needs only this signature, and the service worker fetches the text
// itself. One more round trip on the device, far less that can go wrong.

const b64url = (bytes) => {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const utf8 = (s) => new TextEncoder().encode(s);
const b64urlJSON = (obj) => b64url(utf8(JSON.stringify(obj)));

let cachedKey = null;
let cachedFrom = null;

async function signingKey(privateJwk) {
  if (cachedKey && cachedFrom === privateJwk) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'jwk',
    typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  cachedFrom = privateJwk;
  return cachedKey;
}

// One JWT per push service origin, valid for hours, so this is cached too.
const jwtCache = new Map();

export async function authHeaders(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 300) return headersFor(hit.jwt, env.VAPID_PUBLIC_KEY);

  const exp = now + 6 * 3600;                 // spec allows 24h; 6 is plenty
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: env.VAPID_SUBJECT || 'mailto:nobody@example.com' };
  const input = `${b64urlJSON(header)}.${b64urlJSON(payload)}`;

  const key = await signingKey(env.VAPID_PRIVATE_JWK);
  // WebCrypto returns ECDSA signatures as raw r||s, which is exactly what
  // JWS ES256 wants - no DER unwrapping needed.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));

  const jwt = `${input}.${b64url(sig)}`;
  jwtCache.set(aud, { jwt, exp });
  return headersFor(jwt, env.VAPID_PUBLIC_KEY);
}

const headersFor = (jwt, publicKey) => ({
  Authorization: `vapid t=${jwt}, k=${publicKey}`,
  TTL: '120',
  Urgency: 'high',
});

// Returns 'ok', 'gone' (the subscription is dead and should be dropped), or
// 'error'. Apple and Mozilla both answer 404/410 for a subscription that no
// longer exists, which is the only case worth acting on.
export async function sendPush(endpoint, env) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: await authHeaders(endpoint, env) });
  } catch (err) {
    return { state: 'error', detail: String(err) };
  }
  if (res.status === 404 || res.status === 410) return { state: 'gone', detail: res.status };
  if (res.ok) return { state: 'ok', detail: res.status };
  return { state: 'error', detail: `${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}` };
}
