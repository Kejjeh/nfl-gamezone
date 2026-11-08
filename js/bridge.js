// ESPN athlete id  ->  Sleeper player id.
//
// The obvious route, Sleeper's espn_id field, covers only 221 of 864 active
// fantasy-relevant players (26%). On a typical starting lineup it misses most
// of it - Ja'Marr Chase, Evan McPherson and Jaylen Waddle all come back with
// espn_id: null. So espn_id is a fast path only; the mechanism that actually
// works is name + team + position matching against ESPN's own team rosters.
import { state } from './state.js';
import * as espn from './espn.js';
import * as sleeper from './sleeper.js';
import { TEAM_ALIASES } from './config.js';

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\.?$/i;

export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(SUFFIX, '')
    .replace(/[^a-z]/g, '');                            // drop apostrophes, dots, spaces
}

function normPos(p) {
  const x = String(p || '').toUpperCase();
  if (x === 'PK') return 'K';
  if (x === 'FB') return 'RB';
  if (x === 'DST' || x === 'D/ST') return 'DEF';
  return x;
}

function teamKeys(abbr) {
  const a = String(abbr || '').toUpperCase();
  const alias = TEAM_ALIASES[a];
  return alias && alias !== a ? [a, alias] : [a];
}

export async function build(onProgress) {
  const players = state.sleeper.players || await sleeper.loadPlayers();
  const rosters = await espn.loadRosters(onProgress);

  // Index Sleeper players several ways, most specific first.
  const byEspnId = new Map();
  const byNameTeamPos = new Map();
  const byNameTeam = new Map();
  const byNamePos = new Map();
  const byName = new Map();
  const nameCount = new Map();

  for (const [pid, rec] of Object.entries(players)) {
    const [name, pos, team, espnId] = rec;
    const n = normName(name);
    if (!n) continue;
    const p = normPos(pos);
    if (espnId) byEspnId.set(String(espnId), pid);
    for (const t of teamKeys(team)) {
      byNameTeamPos.set(`${n}|${t}|${p}`, pid);
      byNameTeam.set(`${n}|${t}`, pid);
    }
    byNamePos.set(`${n}|${p}`, pid);
    byName.set(n, pid);
    nameCount.set(n, (nameCount.get(n) || 0) + 1);
  }

  const map = new Map();
  let viaEspnId = 0;
  let viaName = 0;
  const unresolved = [];

  for (const [athleteId, rec] of Object.entries(rosters)) {
    const [fullName, team, pos] = rec;
    const fast = byEspnId.get(String(athleteId));
    if (fast) { map.set(athleteId, fast); viaEspnId++; continue; }

    const n = normName(fullName);
    const p = normPos(pos);
    let hit = null;
    for (const t of teamKeys(team)) {
      hit = byNameTeamPos.get(`${n}|${t}|${p}`) || byNameTeam.get(`${n}|${t}`);
      if (hit) break;
    }
    if (!hit) hit = byNamePos.get(`${n}|${p}`);
    if (!hit && nameCount.get(n) === 1) hit = byName.get(n);   // unique names only

    if (hit) { map.set(athleteId, hit); viaName++; }
    else unresolved.push(`${fullName} (${pos} ${team})`);
  }

  state.bridge.athleteToSleeper = map;
  state.bridge.unresolved = unresolved;
  state.bridge.ready = true;

  console.log(
    `[bridge] ${map.size} athletes linked - ${viaEspnId} via espn_id, ` +
    `${viaName} via name match; ${unresolved.length} unresolved`
  );
  return map;
}

export const toSleeperId = (athleteId) =>
  state.bridge.athleteToSleeper.get(String(athleteId)) || null;

// The reverse direction, built lazily and invalidated whenever the forward map
// is rebuilt. Needed to go from a Sleeper roster slot to the ESPN athlete whose
// plays and stat line we hold.
let reverse = null;
let reverseFor = null;

export function toAthleteId(sleeperId) {
  const fwd = state.bridge.athleteToSleeper;
  if (reverse === null || reverseFor !== fwd) {
    reverse = new Map();
    for (const [aid, pid] of fwd) if (!reverse.has(pid)) reverse.set(pid, aid);
    reverseFor = fwd;
  }
  return reverse.get(String(sleeperId)) || null;
}

// Team defenses are not athletes. Sleeper keys them by team abbreviation, so a
// DEF starter is matched on the team involved in the play instead.
export function defIdForTeam(abbr) {
  const players = state.sleeper.players || {};
  for (const t of teamKeys(abbr)) if (players[t]) return t;
  return null;
}

// Coverage check: which starters across the whole league failed to resolve.
// Loud failures only - a silent miss here is exactly the espn_id trap.
export function coverageReport() {
  const s = state.sleeper;
  if (!s.rosters || !state.bridge.ready) return null;

  const linked = new Set(state.bridge.athleteToSleeper.values());
  const rows = [];
  for (const r of s.rosters) {
    for (const pid of r.starters || []) {
      if (!pid || pid === '0') continue;
      const pos = sleeper.playerPos(pid);
      if (pos === 'DEF') continue;                 // handled by team abbreviation
      if (!linked.has(pid)) {
        rows.push({ roster: r.roster_id, pid, name: sleeper.playerName(pid), pos, team: sleeper.playerTeam(pid) });
      }
    }
  }
  return rows;
}

// Classify a play against the live lineups: 'mine' | 'opp' | null.
export function classifyPlay(play) {
  const s = state.sleeper;
  if (!s.myStarters || !s.myStarters.size) return null;

  const hits = [];
  for (const aid of play.athleteIds || []) {
    const pid = toSleeperId(aid);
    if (pid) hits.push(pid);
  }

  // Defensive credit: on a turnover or defensive score, the unit that benefits
  // is the team that was NOT on offense.
  if (play.teamId && (play.isTurnover || play.isTD)) {
    const offense = espn.teamAbbr(play.teamId);
    const g = state.games.get(play.eventId);
    if (g && offense) {
      const defAbbr = g.home.abbr === offense ? g.away.abbr : g.home.abbr;
      const defId = defIdForTeam(defAbbr);
      if (defId) hits.push(defId);
    }
  }

  const mine = hits.filter((p) => s.myStarters.has(p));
  const opp = hits.filter((p) => s.oppStarters.has(p));
  if (!mine.length && !opp.length) return null;

  const side = mine.length ? 'mine' : 'opp';
  const ids = [...new Set(mine.length ? mine : opp)];
  return {
    side,
    players: ids.map((pid) => ({
      id: pid,
      name: sleeper.playerName(pid),
      points: s.pointsByPlayer?.get(pid) ?? null,
    })),
  };
}
