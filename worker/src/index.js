// gamezone-push: the part GitHub Pages cannot be.
//
// The site is static, and iOS gives an installed web app no way to wake itself
// (no Background Sync, no Periodic Background Sync). Web Push is
// server-initiated by definition, so something has to sit on a cron, watch the
// box scores, and send. This is that something, and it is deliberately the
// smallest thing that can do the job.
//
// It evaluates bets with the SAME js/bets-core.js the page uses, imported
// directly rather than reimplemented, so the phone and the browser can never
// disagree about whether a leg has hit.
import * as core from '../../js/bets-core.js';
import { sendPush } from './vapid.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

/* ------------------------------------------------------------------ http */

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
});

const json = (body, env, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(env) },
  });

// Subscription endpoints are long and contain a token, so they are hashed
// rather than used as identifiers directly.
async function idFor(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every subscription lives in ONE record, keyed by endpoint hash inside it.
//
// It used to be one KV key each, which meant a list() on every cron tick to
// find them. The free plan allows 1,000 list requests a day and the cron fires
// 1,440 times, so list operations ran out at 16:40 UTC every day and the
// Worker then did nothing at all until the quota reset. One key means one read
// per tick, no list, and a second phone that costs nothing.
const SUBS_KEY = 'subs:all';

async function loadSubs(env) {
  const all = await read(env, SUBS_KEY);
  if (all) return all;
  return migrateSubs(env);
}

// Deployments before 2026-11-09 stored one key per subscription. Fold them in,
// so nobody has to re-enable alerts on their phone. The list() below runs only
// while SUBS_KEY is absent, and the record is written even when it is empty, so
// the next tick reads it instead of listing again.
//
// A failure here throws on purpose. Writing an empty record because a list
// failed would silently discard a working subscription; the cron just tries
// again next minute.
async function migrateSubs(env) {
  const all = {};
  const legacy = [];
  let cursor;
  do {
    const page = await env.GZ.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const rec = await read(env, k.name);
      if (rec?.subscription?.endpoint) {
        all[await idFor(rec.subscription.endpoint)] = rec;
        legacy.push(k.name);
      }
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  await env.GZ.put(SUBS_KEY, JSON.stringify(all));
  for (const k of legacy) await env.GZ.delete(k);
  return all;
}

// Always write, even when the record is empty: an absent key would send the
// next tick back into migrateSubs and its list().
const saveSubs = (env, all) => env.GZ.put(SUBS_KEY, JSON.stringify(all));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (url.pathname === '/health') {
      // Name what is missing. A half-configured Worker still answers every
      // route and still runs its cron; it just never gets a push accepted,
      // which is a miserable thing to debug from a phone.
      const missing = [
        !env.VAPID_PRIVATE_JWK && 'VAPID_PRIVATE_JWK',
        !env.VAPID_PUBLIC_KEY && 'VAPID_PUBLIC_KEY',
        !env.VAPID_SUBJECT && 'VAPID_SUBJECT',
        !env.GZ && 'GZ (KV namespace)',
      ].filter(Boolean);
      return json({ ok: true, configured: missing.length === 0, missing }, env);
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, env, 405);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, env, 400); }

    if (url.pathname === '/subscribe') {
      const sub = body.subscription;
      if (!sub?.endpoint) return json({ error: 'no subscription' }, env, 400);
      const all = await loadSubs(env);
      all[await idFor(sub.endpoint)] = {
        subscription: sub,
        bets: Array.isArray(body.bets) ? body.bets : [],
        // Start from the current numbers, so switching alerts on does not
        // immediately announce everything that already happened today.
        lastSeen: {},
        primed: false,
        updated: Date.now(),
      };
      await saveSubs(env, all);
      return json({ ok: true }, env);
    }

    if (url.pathname === '/bets') {
      const all = await loadSubs(env);
      const rec = all[await idFor(body.endpoint || '')];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      rec.bets = Array.isArray(body.bets) ? body.bets : [];
      rec.updated = Date.now();
      await saveSubs(env, all);
      return json({ ok: true, bets: rec.bets.length }, env);
    }

    // Prove the whole chain - signature, push service, service worker,
    // notification - without waiting for a bet to move. It only ever sends to
    // an endpoint already in KV, so it cannot be pointed at a stranger.
    if (url.pathname === '/test') {
      const all = await loadSubs(env);
      const id = await idFor(body.endpoint || '');
      const rec = all[id];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      rec.pending = {
        title: 'GameZone test',
        body: 'Phone alerts are working. Real ones look like this.',
        tag: 'gz-test',
      };
      await saveSubs(env, all);
      const out = await sendPush(rec.subscription.endpoint, env);
      if (out.state === 'gone') {
        delete all[id];
        await saveSubs(env, all);
      }
      return json({ ok: out.state === 'ok', state: out.state, detail: out.detail },
        env, out.state === 'ok' ? 200 : 502);
    }

    // The service worker asks for the message that belongs to this push.
    if (url.pathname === '/pending') {
      const all = await loadSubs(env);
      const rec = all[await idFor(body.endpoint || '')];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      const pending = rec.pending || null;
      if (pending) {
        rec.pending = null;
        await saveSubs(env, all);
      }
      return json(pending || { title: 'GameZone', body: 'Your bets moved.' }, env);
    }

    if (url.pathname === '/unsubscribe') {
      const all = await loadSubs(env);
      delete all[await idFor(body.endpoint || '')];
      await saveSubs(env, all);
      return json({ ok: true }, env);
    }

    return json({ error: 'no such route' }, env, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

async function read(env, key) {
  const raw = await env.GZ.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ tick */

export async function tick(env) {
  // The scoreboard comes FIRST, before any KV call. A tick on a Tuesday, or at
  // 3am on a Monday, has to cost nothing at all: the free plan allows 1,000
  // writes and 1,000 list requests a day, and this cron fires 1,440 times.
  const scoreboard = await fetchJSON(`${ESPN}/scoreboard`);
  const games = normalizeGames(scoreboard);
  const live = games.filter((g) => g.state === 'in');

  // Nothing is moving, so nothing can have changed.
  if (!live.length) return { skipped: 'no live games' };

  const all = await loadSubs(env);
  const ids = Object.keys(all);
  if (!ids.length) return { skipped: 'no subscriptions' };

  const stats = {};
  const eventOf = {};
  // Free plan allows 50 subrequests per invocation; a full slate is 16.
  for (const g of live.slice(0, 20)) {
    try {
      const summary = await fetchJSON(`${ESPN}/summary?event=${g.id}`);
      const flat = core.statsFromSummary(summary, g.id);
      for (const [id, v] of Object.entries(flat)) {
        stats[id] = v.cats;
        eventOf[id] = g.id;
      }
    } catch (err) {
      // One bad game must not cost everyone their alerts.
      console.log('summary failed', g.id, String(err));
    }
  }

  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const world = { stats, eventOf, byId, games };
  const before = JSON.stringify(all);
  const sending = [];
  const results = [];

  for (const id of ids) {
    try {
      const out = evaluate(all[id], world);
      results.push(out);
      if (out.push) sending.push(id);
    } catch (err) {
      console.log('sub failed', id, String(err));
    }
  }

  // One write for every device, and only when a tracked number actually moved.
  // This used to be an unconditional put() per subscription per live minute,
  // which is what emptied the daily write quota.
  const wrote = JSON.stringify(all) !== before;
  if (wrote) await saveSubs(env, all);

  // The message has to be stored before the push goes out: the service worker
  // wakes and immediately asks for it.
  let dropped = false;
  for (const id of sending) {
    const out = await sendPush(all[id].subscription.endpoint, env);
    if (out.state === 'gone') {
      delete all[id];
      dropped = true;
    }
  }
  if (dropped) await saveSubs(env, all);

  return { live: live.length, subs: ids.length, wrote, results };
}

// Decides what this subscription should be told and moves its baseline on.
// Deliberately free of KV: every operation for the whole tick lives in tick(),
// so the per-day budget can be read off one function.
function evaluate(rec, world) {
  const ctx = {
    statsFor: (athleteId) => world.stats[String(athleteId)] || null,
    gameFor: (leg) => {
      if (leg.eventId) return world.byId[String(leg.eventId)] || null;
      if (leg.athleteId) {
        const ev = world.eventOf[String(leg.athleteId)];
        if (ev) return world.byId[ev] || null;
      }
      const abbr = (leg.teamAbbr || leg.team || '').toUpperCase();
      return abbr ? world.games.find((g) => g.home.abbr === abbr || g.away.abbr === abbr) || null : null;
    },
  };

  const { events, next } = core.diffLegs(rec.bets || [], ctx, rec.lastSeen || {});
  rec.lastSeen = next;

  // The first run after subscribing only records where things stand.
  if (!rec.primed) {
    rec.primed = true;
    return { primed: true };
  }

  const worth = events.filter((e) => e.priority >= 1);
  if (!worth.length) return { events: events.length, sent: false };

  worth.sort((a, b) => b.priority - a.priority);
  const top = worth[0];
  const more = worth.length > 1 ? ` (+${worth.length - 1} more)` : '';

  rec.pending = {
    title: core.eventTitle(top),
    body: core.describeEvent(top) + more,
    tag: `gz-${top.betId}`,
  };
  return { push: true, body: rec.pending.body };
}

/* ------------------------------------------------------------------ espn */

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Only the fields the bet engine reads.
export function normalizeGames(sb) {
  const out = [];
  for (const ev of sb?.events || []) {
    const comp = (ev.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const side = (ha) => {
      const t = cs.find((c) => c.homeAway === ha) || {};
      return { abbr: (t.team || {}).abbreviation || '??', score: Number(t.score) || 0 };
    };
    out.push({
      id: String(ev.id),
      state: (ev.status?.type || {}).state || 'pre',
      date: ev.date,
      home: side('home'),
      away: side('away'),
    });
  }
  return out;
}
