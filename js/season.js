// Season-long and per-week fantasy numbers, straight from Sleeper.
//
// Measured 2026-11-10 against the league's own matchups endpoint: league
// fantasy points are exactly the dot product of Sleeper's stats record and the
// league's scoring_settings - 1390 of 1390 player-weeks across the nine
// completed weeks, team defences included. Sleeper names its stat fields and
// its scoring settings in the same vocabulary (rec, fgm_30_39, def_td,
// pts_allow_7_13), so there is nothing to reimplement here and nothing to
// parse. There is also no bridge in this path: both sides are Sleeper ids, so
// none of bridge.js's 58 unresolved athletes can affect these numbers.
//
// Season totals are SUMMED FROM THE WEEKLY FILES, never read from
// /stats/nfl/regular/2026. That aggregate lags by a whole game for whichever
// teams played most recently - measured the same day, 28 rows adrift, every
// one of them MIN or BUF, every one of them last played in week 9. Josh Allen
// read 234 passing yards, a touchdown and an interception short, 13.9 points
// of a 206-point season. The weekly files were each checked against Sleeper,
// so summing them is the only total that agrees with what the league actually
// awarded week by week.
import { SLEEPER, SEASON, LS_PREFIX } from './config.js';
import * as store from './store.js';
import { state } from './state.js';
import * as scoring from './scoring.js';
import * as sleeper from './sleeper.js';
import { TEAMS } from './teams.js';
import { TEAM_ALIASES } from './config.js';

/* ---------- scoring ---------- */

// Fantasy points under one set of scoring settings. A stat the league does not
// score contributes nothing, and a setting with no matching stat contributes
// nothing - which is why the 11 settings that saw no stat in week 9
// (pass_2pt, safe, blk_kick, fgm_60p...) cost nothing to leave in.
export function scoreWith(stats, set) {
  if (!stats || !set) return 0;
  let pts = 0;
  for (const key in set) {
    const v = stats[key];
    if (typeof v === 'number') pts += v * set[key];
  }
  return Math.round(pts * 100) / 100;
}

// The connected league's own settings, unmerged. scoring.rules() layers the
// full-PPR defaults underneath, which is right for the live leaders board but
// wrong here: a default weight for a key this league deliberately does not
// score would quietly add points Sleeper never awarded. With no league
// connected there is nothing to be faithful to, so the defaults are the
// sensible fallback and the view says so.
export function settings() {
  const lg = state.sleeper.league?.scoring_settings;
  if (lg && Object.keys(lg).length) return lg;
  return scoring.rules();
}

export const usingLeagueRules = () =>
  !!Object.keys(state.sleeper.league?.scoring_settings || {}).length;

// A short stable fingerprint of whatever rules are in force. It goes in the
// cache key, which is the only way to make a stale score impossible: the
// weekly files are stored already scored, so a cache entry written under one
// set of rules is simply wrong under another. Invalidating on a league
// connecting cannot be made to cover it - the first connect races the first
// load, and a user switching leagues would read the previous league's points
// until something thought to clear them. Keying on the rules means a change
// misses the cache and refetches, which is cheap and cannot be got wrong.
export function rulesTag() {
  const set = settings();
  const flat = JSON.stringify(Object.keys(set).sort().map((k) => [k, set[k]]));
  let h = 0;
  for (let i = 0; i < flat.length; i += 1) h = (Math.imul(h, 31) + flat.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ---------- weekly stat files ---------- */

const TEAM_ID = /^[A-Z]{2,3}$/;
export const isTeamId = (id) => TEAM_ID.test(id);

const NAME_BY_ABBR = new Map(TEAMS.map(([, abbr, short]) => [abbr, short]));

// Sleeper says WAS where ESPN says WSH, and teams.js is generated from ESPN.
export function teamDefName(abbr) {
  const n = NAME_BY_ABBR.get(abbr) || NAME_BY_ABBR.get(TEAM_ALIASES[abbr]);
  return n ? `${n} D/ST` : `${abbr} D/ST`;
}

async function getJson(path) {
  const res = await fetch(`${SLEEPER}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Sleeper HTTP ${res.status} for ${path}`);
  return res.json();
}

// Sleeper's own idea of where the season is. `week` is the transaction week,
// which is already 10 while week 10 has no stats at all; `display_week` is the
// last week with results. Defaulting to `week` shows an empty table.
export async function nflWeeks() {
  const cached = store.get('nflWeeks');
  if (cached) return cached;
  try {
    const st = await sleeper.getNflState();
    const rec = {
      week: Number(st.week) || 1,
      display: Number(st.display_week) || Number(st.week) || 1,
    };
    store.set('nflWeeks', rec, 3e5);
    return rec;
  } catch (e) {
    console.warn('[season] nfl state failed, assuming week 1', e);
    return { week: 1, display: 1 };
  }
}

// One week, projected down to { pid: points } the moment it arrives. The raw
// payload is ~534 KB and nine of them would be 4.8 MB against a ~5 MB
// localStorage cap, so the raw form is never stored - only the scored map,
// which is about 32 KB a week.
//
// A week before the current one is finished and can be kept for a week. The
// current one is still moving, so it gets two minutes.
async function loadWeek(week, current, tag) {
  const key = `wkpts:${SEASON}:${week}:${tag}`;
  const cached = store.get(key);
  if (cached) return cached;

  const raw = await getJson(`/stats/nfl/regular/${SEASON}/${week}`);
  const set = settings();
  const out = {};
  for (const [pid, stats] of Object.entries(raw || {})) out[pid] = scoreWith(stats, set);

  store.set(key, out, week < current ? 7 * 864e5 : 12e4);
  return out;
}

// Every completed week, newest first so the table fills in from the end the
// user cares about. Failures degrade to a shorter season rather than an empty
// table: a missing week costs that column, not the view.
export async function loadSeason(onWeek) {
  const { display } = await nflWeeks();
  const tag = rulesTag();
  const weeks = new Map();

  for (let w = display; w >= 1; w -= 1) {
    try {
      weeks.set(w, await loadWeek(w, display, tag));
      onWeek?.(weeks.size, display);
    } catch (e) {
      console.warn(`[season] week ${w} failed`, e);
    }
  }

  state.season.weeks = weeks;
  state.season.through = display;
  state.season.rulesTag = tag;      // what these numbers were scored under
  state.season.loaded = true;
  return weeks;
}

// Drop every stored week, whatever rules scored it. The rules tag already
// stops a stale entry being read, so this is housekeeping rather than
// correctness: without it, trying two leagues leaves both sets on disk.
export function pruneCache(keepTag = null) {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${LS_PREFIX}wkpts:`)) continue;
      if (keepTag && k.endsWith(`:${keepTag}`)) continue;
      stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    return stale.length;
  } catch (e) {
    console.warn('[season] cache prune failed', e);
    return 0;
  }
}

/* ---------- ownership ---------- */

// pid -> { label, mine }. Team defences sit in `players` as a bare team
// abbreviation, exactly as they do in the stats files, so they need no special
// casing. Anyone absent from every roster is a free agent.
export function ownerIndex() {
  const s = state.sleeper;
  const out = new Map();
  for (const r of s.rosters || []) {
    const mine = r.roster_id === s.myRosterId;
    const u = s.usersById?.get(r.owner_id);
    const label = mine
      ? 'You'
      : (r.metadata?.team_name || u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`);
    for (const pid of r.players || []) out.set(String(pid), { label, mine });
  }
  return out;
}

/* ---------- rows ---------- */

export const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const FANTASY = new Set(POS_ORDER);

// One row per player, from the weekly maps. Pure: everything it reads is an
// argument, so the test harness can hand it fixtures.
//
// `games` is counted - the number of weeks the player has a stats row at all -
// rather than taken from the stats files' own `gp` or `gms_active`. Measured
// against that count over the 535 players who score more than a point: `gp`
// agreed on 370 and `gms_active` on 474. Neither is the number a per-game
// average should divide by.
export function buildRows({ weeks, players, owners }) {
  const rows = new Map();

  const ensure = (pid) => {
    let r = rows.get(pid);
    if (r) return r;

    const isDef = isTeamId(pid);
    const p = players?.[pid];
    const pos = isDef ? 'DEF' : (p?.[1] || '');
    const name = isDef ? teamDefName(pid) : (p?.[0] || '');
    const team = isDef ? pid : (p?.[2] || '');

    // Not a fantasy-relevant player, or one the slim dictionary has never
    // heard of. Either way there is nothing to show in a fantasy table.
    if (!FANTASY.has(pos) || (!isDef && (!name || !team))) { rows.set(pid, null); return null; }

    r = {
      id: pid, name, pos, team, isDef,
      owner: owners?.get(pid) || null,
      pts: 0, games: 0, best: null, byWeek: new Map(),
    };
    rows.set(pid, r);
    return r;
  };

  for (const [w, map] of weeks) {
    for (const pid in map) {
      const r = ensure(pid);
      if (!r) continue;
      const v = map[pid];
      r.byWeek.set(w, v);
      r.pts = Math.round((r.pts + v) * 100) / 100;
      r.games += 1;
      if (r.best == null || v > r.best) r.best = v;
    }
  }

  const out = [];
  for (const r of rows.values()) {
    if (!r) continue;
    r.ppg = r.games ? Math.round((r.pts / r.games) * 100) / 100 : null;
    out.push(r);
  }
  return out;
}

/* ---------- filtering and sorting ---------- */

export const OWNERSHIP = {
  all:  { label: 'Everyone', match: () => true },
  mine: { label: 'My team',  match: (r) => !!r.owner?.mine },
  free: { label: 'Free agents', match: (r) => !r.owner },
  taken: { label: 'Rostered', match: (r) => !!r.owner && !r.owner.mine },
};

// FLEX is what the league actually starts, so it earns a chip of its own.
const FLEX = new Set(['RB', 'WR', 'TE']);

export function filterRows(rows, { pos = 'all', own = 'all', q = '' } = {}) {
  const needle = q.trim().toLowerCase();
  const ownMatch = (OWNERSHIP[own] || OWNERSHIP.all).match;

  return rows.filter((r) => {
    if (pos === 'FLEX' ? !FLEX.has(r.pos) : pos !== 'all' && r.pos !== pos) return false;
    if (!ownMatch(r)) return false;
    if (needle && !r.name.toLowerCase().includes(needle)
      && !r.team.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// `shown` is whatever the points column is currently displaying - the season
// total, or one week's score when a week is selected. The view sets it; every
// other column means the same thing in either scope.
const shown = (r) => (r.shown ?? r.pts);

export const SORTS = {
  pts:   (a, b) => shown(b) - shown(a),
  ppg:   (a, b) => (b.ppg ?? -1) - (a.ppg ?? -1),
  best:  (a, b) => (b.best ?? -1) - (a.best ?? -1),
  games: (a, b) => b.games - a.games,
  name:  (a, b) => a.name.localeCompare(b.name),
  pos:   (a, b) => POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos) || shown(b) - shown(a),
  owner: (a, b) => (a.owner?.label || 'zzz').localeCompare(b.owner?.label || 'zzz') || shown(b) - shown(a),
};

export function sortRows(rows, key = 'pts', dir = 'desc') {
  const cmp = SORTS[key] || SORTS.pts;
  const out = rows.slice().sort(cmp);
  // Every comparator above is written descending-first (biggest number at the
  // top) except the two alphabetical ones, which read better ascending. One
  // reversal here keeps all of them honest about which way "dir" points.
  const naturallyAscending = key === 'name' || key === 'pos' || key === 'owner';
  if ((dir === 'asc') !== naturallyAscending) out.reverse();
  return out;
}
