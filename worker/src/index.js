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
// rather than used as keys directly.
async function keyFor(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return `sub:${[...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

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
      const key = await keyFor(sub.endpoint);
      await env.GZ.put(key, JSON.stringify({
        subscription: sub,
        bets: Array.isArray(body.bets) ? body.bets : [],
        // Start from the current numbers, so switching alerts on does not
        // immediately announce everything that already happened today.
        lastSeen: {},
        primed: false,
        updated: Date.now(),
      }));
      return json({ ok: true }, env);
    }

    if (url.pathname === '/bets') {
      const key = await keyFor(body.endpoint || '');
      const rec = await read(env, key);
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      rec.bets = Array.isArray(body.bets) ? body.bets : [];
      rec.updated = Date.now();
      await env.GZ.put(key, JSON.stringify(rec));
      return json({ ok: true, bets: rec.bets.length }, env);
    }

    // The service worker asks for the message that belongs to this push.
    if (url.pathname === '/pending') {
      const key = await keyFor(body.endpoint || '');
      const rec = await read(env, key);
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      const pending = rec.pending || null;
      if (pending) {
        rec.pending = null;
        await env.GZ.put(key, JSON.stringify(rec));
      }
      return json(pending || { title: 'GameZone', body: 'Your bets moved.' }, env);
    }

    if (url.pathname === '/unsubscribe') {
      await env.GZ.delete(await keyFor(body.endpoint || ''));
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
  const subs = await listSubs(env);
  if (!subs.length) return { skipped: 'no subscriptions' };

  const scoreboard = await fetchJSON(`${ESPN}/scoreboard`);
  const games = normalizeGames(scoreboard);
  const live = games.filter((g) => g.state === 'in');

  // Nothing is moving, so nothing can have changed.
  if (!live.length) return { skipped: 'no live games' };

  // Only pull box scores for games that actually matter to somebody's bet.
  const wanted = new Set();
  for (const { rec } of subs) {
    for (const bet of rec.bets || []) {
      for (const leg of bet.legs || []) {
        if (leg.athleteId) wanted.add(String(leg.athleteId));
      }
    }
  }

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
  const results = [];

  for (const { key, rec } of subs) {
    try {
      results.push(await handleSub(env, key, rec, { stats, eventOf, byId, games }));
    } catch (err) {
      console.log('sub failed', key, String(err));
    }
  }
  return { live: live.length, subs: subs.length, results };
}

async function handleSub(env, key, rec, world) {
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
    await env.GZ.put(key, JSON.stringify(rec));
    return { key, primed: true };
  }

  const worth = events.filter((e) => e.priority >= 1);
  if (!worth.length) {
    await env.GZ.put(key, JSON.stringify(rec));
    return { key, events: events.length, sent: false };
  }

  worth.sort((a, b) => b.priority - a.priority);
  const top = worth[0];
  const more = worth.length > 1 ? ` (+${worth.length - 1} more)` : '';

  rec.pending = {
    title: core.eventTitle(top),
    body: core.describeEvent(top) + more,
    tag: `gz-${top.betId}`,
  };
  await env.GZ.put(key, JSON.stringify(rec));

  const out = await sendPush(rec.subscription.endpoint, env);
  if (out.state === 'gone') await env.GZ.delete(key);
  return { key, sent: out.state, body: rec.pending.body };
}

async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.GZ.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const rec = await read(env, k.name);
      if (rec?.subscription?.endpoint) out.push({ key: k.name, rec });
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  return out;
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
