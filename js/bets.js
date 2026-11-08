// Bet storage, bet-slip parsing and player resolution.
//
// The settlement maths lives in bets-core.js, which is pure so the push Worker
// can run the identical logic. This module is the browser half: localStorage,
// matching a name on a slip to an ESPN athlete, and diffing stats between
// polls so an alert can say what moved.
//
// On syncing from the books: neither FanDuel nor DraftKings exposes a user's
// bets. There is no public API, no developer programme and no OAuth for
// account data - only odds, and only through paid aggregators. The only route
// to a real bet history would be driving their internal endpoints with your
// login, which means handling your sportsbook credentials and breaking their
// terms. So this reads a pasted slip instead: no credentials, nothing to
// breach, and about as fast once the parser knows the format.
import { state, emit } from './state.js';
import * as store from './store.js';
import * as espn from './espn.js';
import { normName } from './bridge.js';
import { TEAMS } from './teams.js';
import * as core from './bets-core.js';

const KEY = 'bets';

/* ----------------------------------------------------------- persistence */

export function load() {
  const raw = store.get(KEY);
  state.bets = Array.isArray(raw) ? raw.map(migrate) : [];
  return state.bets;
}

export function save() {
  store.set(KEY, state.bets);
  emit('bets');
}

// Room to change the shape later without losing what is already stored.
function migrate(bet) {
  return { v: 1, legs: [], ...bet };
}

const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function add(bet) {
  const rec = {
    v: 1,
    id: uid(),
    book: bet.book || 'manual',
    stake: Number(bet.stake) || 0,
    odds: Number(bet.odds) || 0,
    placedAt: bet.placedAt || Date.now(),
    note: bet.note || '',
    legs: (bet.legs || []).map((l, i) => ({ id: `${uid()}-${i}`, ...l })),
  };
  state.bets.push(rec);
  save();
  return rec;
}

export function remove(id) {
  state.bets = state.bets.filter((b) => b.id !== id);
  save();
}

export function update(id, patch) {
  const b = state.bets.find((x) => x.id === id);
  if (!b) return null;
  Object.assign(b, patch);
  save();
  return b;
}

export function updateLeg(betId, legId, patch) {
  const b = state.bets.find((x) => x.id === betId);
  const leg = b?.legs.find((l) => l.id === legId);
  if (!leg) return null;
  Object.assign(leg, patch);
  save();
  return leg;
}

/* --------------------------------------------------- the live stat context */

// bets-core asks for two things and nothing else, which is what lets the same
// file run in a Worker that has no app state.
export function ctx() {
  return {
    statsFor: (athleteId) => state.playerStats.get(String(athleteId))?.cats || null,
    gameFor: (leg) => {
      if (leg.eventId) return state.games.get(String(leg.eventId)) || null;
      if (leg.athleteId) {
        const rec = state.playerStats.get(String(leg.athleteId));
        if (rec?.eventId) return state.games.get(String(rec.eventId)) || null;
      }
      const abbr = leg.teamAbbr || leg.team;
      return abbr ? espn.gameForTeam(abbr) : null;
    },
  };
}

export const statusFor = (bet) => core.betStatus(bet, ctx());

export function allStatuses() {
  const c = ctx();
  return state.bets.map((bet) => ({ bet, status: core.betStatus(bet, c) }));
}

// Every athlete any open bet depends on - what the Worker needs to poll, and
// what the alert diff watches.
export function trackedAthletes() {
  const ids = new Set();
  for (const bet of state.bets) {
    for (const leg of bet.legs) if (leg.athleteId) ids.add(String(leg.athleteId));
  }
  return ids;
}

/* ------------------------------------------------------ player resolution */

let nameIndex = null;
let indexBuiltFrom = null;

// athleteId -> [fullName, teamAbbr, pos], from ESPN's own 32 rosters. Those are
// already fetched and cached for the fantasy bridge, so this costs nothing.
function buildNameIndex() {
  const rosters = store.get('espnRosters');
  if (!rosters) return null;
  if (nameIndex && indexBuiltFrom === rosters) return nameIndex;

  const byName = new Map();
  for (const [athleteId, rec] of Object.entries(rosters)) {
    const [fullName, team, pos] = rec;
    const n = normName(fullName);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push({ athleteId: String(athleteId), name: fullName, team, pos });
  }
  nameIndex = byName;
  indexBuiltFrom = rosters;
  return byName;
}

// Resolving "J. Chase" or "Ja'Marr Chase" to an athlete id.
//
// Duplicate names are real (two Michael Carters have shared the league), so
// this returns candidates rather than guessing, and narrows by team when the
// slip named one and by "is their team playing today" otherwise - which on a
// Sunday is a strong filter and usually leaves exactly one.
export function resolvePlayer(rawName, teamHint) {
  const idx = buildNameIndex();
  const n = normName(rawName);
  if (!idx || !n) return { athleteId: null, candidates: [], reason: idx ? 'empty name' : 'rosters not loaded yet' };

  let cands = idx.get(n) || [];

  // Surname-only or initial-and-surname, e.g. "J.Chase" from play text.
  if (!cands.length) {
    const loose = [...idx.entries()].filter(([k]) => k.endsWith(n) || k.startsWith(n));
    cands = loose.flatMap(([, v]) => v);
  }

  if (teamHint) {
    const t = String(teamHint).toUpperCase();
    const onTeam = cands.filter((c) => espn.sameTeam(c.team, t));
    if (onTeam.length) cands = onTeam;
  }

  if (cands.length > 1) {
    const playing = cands.filter((c) => !!espn.gameForTeam(c.team));
    if (playing.length) cands = playing;
  }

  return {
    athleteId: cands.length === 1 ? cands[0].athleteId : null,
    candidates: cands.slice(0, 8),
    reason: cands.length === 0 ? 'no player of that name'
      : cands.length > 1 ? 'more than one match' : null,
  };
}

/* ------------------------------------------------------------ team names */

const TEAM_LOOKUP = (() => {
  const m = new Map();
  for (const [, abbr, short] of TEAMS) {
    m.set(abbr.toLowerCase(), abbr);
    m.set(short.toLowerCase(), abbr);
  }
  return m;
})();

export function resolveTeam(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  if (TEAM_LOOKUP.has(t)) return TEAM_LOOKUP.get(t);
  // "Cincinnati Bengals" - match on the nickname at the end.
  for (const [name, abbr] of TEAM_LOOKUP) {
    if (name.length > 3 && (t.endsWith(name) || t.startsWith(name))) return abbr;
  }
  return null;
}

/* --------------------------------------------------------- slip parsing */

// The pattern matching lives in bets-core.js so it can be unit-tested without
// a browser; this supplies the two lookups it cannot do on its own.
export function parseSlip(text) {
  return core.parseSlip(text, { player: resolvePlayer, team: resolveTeam });
}

/* --------------------------------------------------------------- alerts */

// The diffing itself is in bets-core so the push Worker runs the identical
// code; this just holds the "last seen" map for the page.
let lastSeen = {};

export function resetAlertBaseline() {
  lastSeen = core.diffLegs(state.bets, ctx(), {}).next;
}

// Called after each box-score poll. Returns what is worth announcing; the
// caller decides how loud to be.
export function pollAlerts() {
  const { events, next } = core.diffLegs(state.bets, ctx(), lastSeen);
  lastSeen = next;
  return events;
}

export const describeEvent = core.describeEvent;
export const eventTitle = core.eventTitle;

export { core };
