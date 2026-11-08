// Sleeper public API. Read-only, no auth, no key. Documented limit is 1000
// calls/min; we use roughly six.
//
// Design note: Sleeper's matchups endpoint already returns live per-player
// fantasy points under the league's own 43 scoring settings. We read those as
// truth rather than recomputing scoring from raw plays.
import { SLEEPER, SEASON, TTL } from './config.js';
import * as store from './store.js';
import { state } from './state.js';

async function get(path) {
  const res = await fetch(`${SLEEPER}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Sleeper HTTP ${res.status} for ${path}`);
  return res.json();
}

export const getNflState = () => get('/state/nfl');

export async function resolveUser(username) {
  const u = await get(`/user/${encodeURIComponent(username.trim())}`);
  if (!u || !u.user_id) throw new Error(`No Sleeper user "${username}"`);
  return u;
}

export const getLeagues = (userId) => get(`/user/${userId}/leagues/nfl/${SEASON}`);
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getUsers = (leagueId) => get(`/league/${leagueId}/users`);
export const getMatchups = (leagueId, week) => get(`/league/${leagueId}/matchups/${week}`);

/* ---------- player dictionary ---------- */

// The full dict is ~14.6 MB raw. Fetched once a day, in the background, and
// immediately projected down to the four fields we need (~115 KB for ~2.7k
// active players) so it fits comfortably in localStorage.
export async function loadPlayers() {
  const cached = store.get('sleeperPlayers');
  if (cached) { state.sleeper.players = cached; return cached; }

  const all = await get('/players/nfl');
  const slim = {};
  for (const [id, p] of Object.entries(all)) {
    const keep = (p.active && p.team) || p.position === 'DEF';
    if (!keep) continue;
    const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
    slim[id] = [name, p.position || '', p.team || '', p.espn_id || null];
  }
  store.set('sleeperPlayers', slim, TTL.sleeperPlayers);
  state.sleeper.players = slim;
  return slim;
}

export const playerName = (id) => state.sleeper.players?.[id]?.[0] || String(id);
export const playerPos = (id) => state.sleeper.players?.[id]?.[1] || '';
export const playerTeam = (id) => state.sleeper.players?.[id]?.[2] || '';

/* ---------- league + live matchup ---------- */

export async function connect(username, preferredLeagueId) {
  const s = state.sleeper;
  const user = await resolveUser(username);
  s.username = user.username || username;
  s.userId = user.user_id;

  const leagues = await getLeagues(user.user_id);
  if (!leagues || !leagues.length) {
    throw new Error('That Sleeper account has no 2026 NFL leagues.');
  }

  const league = leagues.find((l) => l.league_id === preferredLeagueId) || leagues[0];
  s.leagueId = league.league_id;
  s.league = league;
  s.allLeagues = leagues.map((l) => ({ id: l.league_id, name: l.name }));

  const [rosters, users] = await Promise.all([
    getRosters(s.leagueId),
    getUsers(s.leagueId).catch(() => []),
  ]);
  s.rosters = rosters;
  // owner_id -> display name. Rosters carry metadata.team_name only when the
  // manager set one, so fall back to the Sleeper display name.
  s.usersById = new Map((users || []).map((u) => [u.user_id, u]));

  const mine = s.rosters.find(
    (r) => r.owner_id === s.userId || (r.co_owners || []).includes(s.userId)
  );
  s.myRosterId = mine ? mine.roster_id : null;
  s.error = null;
  return league;
}

export async function refreshMatchups(week) {
  const s = state.sleeper;
  if (!s.leagueId || !week) return;

  const m = await getMatchups(s.leagueId, week);
  s.matchups = m;

  const mine = m.find((x) => x.roster_id === s.myRosterId);
  if (!mine) { s.myPoints = null; s.oppPoints = null; return; }

  const opp = mine.matchup_id != null
    ? m.find((x) => x.matchup_id === mine.matchup_id && x.roster_id !== s.myRosterId)
    : null;

  s.oppRosterId = opp ? opp.roster_id : null;
  s.myPoints = mine.points ?? 0;
  s.oppPoints = opp ? (opp.points ?? 0) : null;
  s.myLineup = (mine.starters || []).filter(Boolean);
  s.oppLineup = opp ? (opp.starters || []).filter(Boolean) : [];
  s.myStarters = new Set(s.myLineup);
  s.oppStarters = new Set(s.oppLineup);

  // roster_positions lists every slot including the bench; the starters array
  // lines up with the non-bench ones, in order, so this labels each row.
  s.slotLabels = (s.league?.roster_positions || [])
    .filter((x) => x !== 'BN' && x !== 'IR' && x !== 'TAXI');

  // Per-player live points for the badge subtitles. Taken from every roster in
  // the league, not just this matchup: it costs nothing (the payload is already
  // here) and it gives the scoring check a sample of a few hundred players
  // instead of thirty.
  const pts = new Map();
  for (const entry of m) {
    for (const [pid, v] of Object.entries(entry.players_points || {})) pts.set(pid, v);
  }
  s.pointsByPlayer = pts;

  s.myName = rosterLabel(s.myRosterId);
  s.oppName = opp ? rosterLabel(opp.roster_id) : null;
}

function rosterLabel(rosterId) {
  const s = state.sleeper;
  const r = s.rosters?.find((x) => x.roster_id === rosterId);
  if (!r) return `Roster ${rosterId}`;
  const u = s.usersById?.get(r.owner_id);
  return r.metadata?.team_name
    || u?.metadata?.team_name
    || u?.display_name
    || `Roster ${rosterId}`;
}
