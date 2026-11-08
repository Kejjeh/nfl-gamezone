// Exercise the push Worker without deploying it.
//
//   node tools/worker-test.mjs
//
// Covers everything except the final hop to Apple: the VAPID signature is
// generated and verified, the cron tick runs against live ESPN data with a
// fake KV, and the push request is intercepted so its headers can be checked.
// Whether an iPhone actually buzzes is the one thing only an iPhone can say.
import { webcrypto as crypto } from 'node:crypto';
import * as core from '../js/bets-core.js';

// The same suite runs against either the three real modules or the flattened
// single-file bundle the Cloudflare dashboard needs:
//
//   node tools/worker-test.mjs                  # worker/src/
//   GZ_WORKER=bundle node tools/worker-test.mjs # worker/dist/
//
// A bundler that drops a function would otherwise look fine until a Sunday.
const BUNDLE = process.env.GZ_WORKER === 'bundle';
const mod = await import(BUNDLE
  ? '../worker/dist/gamezone-push.bundle.js'
  : '../worker/src/index.js');
const worker = mod.default;
const { tick, normalizeGames } = mod;
const { authHeaders } = BUNDLE ? mod : await import('../worker/src/vapid.js');
console.log(`target: ${BUNDLE ? 'worker/dist/gamezone-push.bundle.js' : 'worker/src/index.js'}`);

globalThis.crypto ??= crypto;

let pass = 0;
const failures = [];
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1;
  else failures.push(`${name}\n      got  ${g}\n      want ${w}`);
};
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
};

/* ------------------------------------------------------------- fake KV */

const makeKV = () => {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '', cursor } = {}) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  };
};

/* --------------------------------------------------- VAPID, for real */

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VAPID_PUBLIC_KEY = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));

{
  const env = { VAPID_PRIVATE_JWK, VAPID_PUBLIC_KEY, VAPID_SUBJECT: 'mailto:test@example.com' };
  const h = await authHeaders('https://web.push.apple.com/abc123', env);

  ok('vapid: Authorization is a vapid scheme', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(h.Authorization),
    h.Authorization.slice(0, 60));

  const jwt = h.Authorization.match(/t=([^,]+)/)[1];
  const [h64, p64, s64] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h64, 'base64url'));
  const payload = JSON.parse(Buffer.from(p64, 'base64url'));

  check('vapid: header', header, { typ: 'JWT', alg: 'ES256' });
  check('vapid: audience is the push origin', payload.aud, 'https://web.push.apple.com');
  check('vapid: subject carried through', payload.sub, 'mailto:test@example.com');
  ok('vapid: expiry in the future but inside 24h',
    payload.exp > Date.now() / 1000 && payload.exp < Date.now() / 1000 + 86400);

  // The real test: does the signature verify against the public key?
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(s64, 'base64url'), new TextEncoder().encode(`${h64}.${p64}`),
  );
  ok('vapid: signature verifies', valid);

  // A second call for the same origin must reuse the cached JWT.
  const h2 = await authHeaders('https://web.push.apple.com/zzz', env);
  check('vapid: JWT cached per push origin', h2.Authorization === h.Authorization, true);
  const h3 = await authHeaders('https://updates.push.services.mozilla.com/x', env);
  ok('vapid: different origin gets a different JWT', h3.Authorization !== h.Authorization);
}

/* ------------------------------------------- statsFromSummary, live data */

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const sb = await (await fetch(`${ESPN}/scoreboard`)).json();
const games = normalizeGames(sb);
ok('scoreboard normalises', games.length > 0, `${games.length} games`);

const live = games.filter((g) => g.state === 'in');
const sample = live[0] || games.find((g) => g.state === 'post');
const summary = await (await fetch(`${ESPN}/summary?event=${sample.id}`)).json();
const flat = core.statsFromSummary(summary, sample.id);
const ids = Object.keys(flat);
ok('statsFromSummary returns players', ids.length > 10, `${ids.length} players`);

{
  const withRec = ids.find((id) => flat[id].cats.receiving?.receivingYards);
  ok('a receiving line is readable', !!withRec);
  if (withRec) {
    const yds = core.MARKETS.rec_yds.read(flat[withRec].cats);
    ok('rec_yds reads a number', Number.isFinite(yds), `got ${yds}`);
  }
  const withDef = ids.find((id) => flat[id].cats.defensive?.totalTackles);
  ok('a defensive line is readable', !!withDef);
}

/* --------------------------------------------------------- the cron tick */

// Build a real bet on a real player who already has yards, then rewind the
// baseline so the tick has something to report.
const target = ids
  .map((id) => ({ id, yds: Number(flat[id].cats.receiving?.receivingYards) }))
  .filter((x) => Number.isFinite(x.yds) && x.yds > 25)
  .sort((a, b) => b.yds - a.yds)[0];

ok('found a player with receiving yards to test against', !!target,
  target ? `athlete ${target.id} at ${target.yds}` : 'none in this game');

if (target) {
  const KV = makeKV();
  const pushes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url?.url || url);
    if (u.startsWith('https://fake.push.test/')) {
      pushes.push({ url: u, headers: init?.headers, method: init?.method });
      return new Response('', { status: 201 });
    }
    return realFetch(url, init);
  };

  const env = {
    GZ: KV, VAPID_PRIVATE_JWK, VAPID_PUBLIC_KEY,
    VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGIN: '*',
  };
  const endpoint = 'https://fake.push.test/sub-1';
  const bet = {
    id: 'b1', stake: 10, odds: -110,
    legs: [{
      id: 'l1', market: 'rec_yds', side: 'over', cmp: 'gt',
      line: target.yds - 10,                       // already cleared
      athleteId: target.id, playerName: 'Test Player', eventId: sample.id,
    }],
  };

  // subscribe
  const res = await worker.fetch(new Request('https://w/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } }, bets: [bet] }),
  }), env);
  check('subscribe accepted', res.status, 200);
  ok('subscription stored', KV.m.size === 1, `${KV.m.size} keys`);

  // first tick only primes
  const t1 = await tick(env);
  ok('first tick primes rather than alerting',
    t1.skipped === 'no live games' || (t1.results || []).every((r) => r.primed),
    JSON.stringify(t1).slice(0, 160));
  check('nothing pushed while priming', pushes.length, 0);

  if (!t1.skipped) {
    // Rewind the stored baseline so the next tick sees movement.
    const key = [...KV.m.keys()][0];
    const rec = JSON.parse(KV.m.get(key));
    const legKey = Object.keys(rec.lastSeen).find((k) => k.startsWith('b1:'));
    ok('baseline recorded the leg', !!legKey, JSON.stringify(rec.lastSeen).slice(0, 120));
    rec.lastSeen[legKey] = Math.max(0, target.yds - 30);
    KV.m.set(key, JSON.stringify(rec));

    const t2 = await tick(env);
    ok('second tick sent a push', pushes.length === 1, JSON.stringify(t2).slice(0, 200));

    if (pushes.length) {
      const h = pushes[0].headers || {};
      ok('push carries a VAPID Authorization', /^vapid t=/.test(h.Authorization || ''));
      check('push is a POST with no body', pushes[0].method, 'POST');
      ok('push sets a TTL', !!h.TTL, JSON.stringify(h));
    }

    // and the message the service worker will come back for
    const pend = await worker.fetch(new Request('https://w/pending', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }), env);
    const msg = await pend.json();
    ok('pending message is about the leg hitting',
      /hit/i.test(msg.title) && /Test Player/.test(msg.body), JSON.stringify(msg));

    // and it is consumed, so the same message is not shown twice
    const again = await (await worker.fetch(new Request('https://w/pending', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }), env)).json();
    ok('pending is cleared once read', again.body === 'Your bets moved.', JSON.stringify(again));
  }

  // a dead subscription is dropped
  globalThis.fetch = async (url, init) => {
    const u = String(url?.url || url);
    if (u.startsWith('https://fake.push.test/')) return new Response('', { status: 410 });
    return realFetch(url, init);
  };
  const key = [...KV.m.keys()][0];
  if (key) {
    const rec = JSON.parse(KV.m.get(key));
    const lk = Object.keys(rec.lastSeen).find((k) => k.startsWith('b1:'));
    if (lk) {
      rec.lastSeen[lk] = 0;
      rec.primed = true;
      KV.m.set(key, JSON.stringify(rec));
      await tick(env);
      check('a 410 drops the subscription', KV.m.size, 0);
    }
  }
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------- CORS etc */

{
  const env = { GZ: makeKV(), ALLOWED_ORIGIN: 'https://kejjeh.github.io' };
  const pre = await worker.fetch(new Request('https://w/subscribe', { method: 'OPTIONS' }), env);
  check('preflight is 204', pre.status, 204);
  check('preflight names the allowed origin',
    pre.headers.get('access-control-allow-origin'), 'https://kejjeh.github.io');

  const health = await worker.fetch(new Request('https://w/health'), env);
  const body = await health.json();
  check('health reports unconfigured when no key is set', body.configured, false);
  check('health names every missing secret', body.missing,
    ['VAPID_PRIVATE_JWK', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);

  const healthy = await worker.fetch(new Request('https://w/health'), {
    GZ: makeKV(), VAPID_PRIVATE_JWK, VAPID_PUBLIC_KEY,
    VAPID_SUBJECT: 'mailto:test@example.com',
  });
  const hb = await healthy.json();
  check('health is clean once everything is set', [hb.configured, hb.missing], [true, []]);

  const unknown = await worker.fetch(new Request('https://w/bets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://nope/', bets: [] }),
  }), env);
  check('unknown subscription is rejected', unknown.status, 404);
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
