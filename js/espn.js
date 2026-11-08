// ESPN data access. All endpoints are undocumented and carry no SLA, so every
// field read here is treated as optional.
import { ESPN_SITE, ESPN_CORE, SEASON, PLAYS_PAGE_SIZE, TTL } from './config.js';
import { TEAMS } from './teams.js';
import * as store from './store.js';
import { state } from './state.js';

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const idFromRef = (ref) => {
  if (!ref) return null;
  const m = String(ref).match(/\/(\d+)(?:\?|$)/);
  return m ? m[1] : null;
};

/* ---------- teams (id -> abbreviation) ---------- */

// Baked in, not fetched. ESPN's site.api /teams list endpoint is the single
// path tested that omits Access-Control-Allow-Origin, so fetching it from a
// browser fails outright. See js/teams.js.
export function loadTeams() {
  if (!state.teamsById.size) {
    for (const [id, abbr, short, accent] of TEAMS) {
      state.teamsById.set(id, { id, abbr, short, name: short, accent });
    }
  }
  return [...state.teamsById.values()];
}

export const teamAbbr = (id) => state.teamsById.get(String(id))?.abbr || null;

export const teamColor = (id) => state.teamsById.get(String(id))?.accent || null;

export function colorForAbbr(abbr) {
  for (const t of state.teamsById.values()) if (t.abbr === abbr) return t.accent;
  return null;
}

/* ---------- scoreboard ---------- */

export async function fetchScoreboard({ week, seasonType = 2 } = {}) {
  let url = `${ESPN_SITE}/scoreboard`;
  if (week) url += `?dates=${SEASON}&seasontype=${seasonType}&week=${week}`;
  const d = await fetchJSON(url);

  const games = (d.events || []).map(normalizeGame).filter(Boolean);
  return { games, week: d.week?.number ?? week ?? null };
}

function normalizeGame(e) {
  try {
    const c = e.competitions?.[0];
    if (!c) return null;
    const comps = c.competitors || [];
    const side = (ha) => {
      const t = comps.find((x) => x.homeAway === ha) || {};
      return {
        id: String(t.team?.id ?? ''),
        abbr: t.team?.abbreviation || '??',
        name: t.team?.shortDisplayName || t.team?.displayName || '',
        logo: t.team?.logo || null,
        score: t.score != null ? Number(t.score) : 0,
        record: t.records?.[0]?.summary || null,
      };
    };
    const st = e.status || {};
    const sit = c.situation || null;

    return {
      id: String(e.id),
      shortName: e.shortName || '',
      date: e.date || null,
      state: st.type?.state || 'pre',          // pre | in | post
      detail: st.type?.shortDetail || st.type?.detail || '',
      completed: !!st.type?.completed,
      period: st.period ?? null,
      clock: st.displayClock || null,
      home: side('home'),
      away: side('away'),
      isRedZone: !!sit?.isRedZone,
      downDistance: sit?.downDistanceText || null,
      possessionText: sit?.possessionText || null,
      possessionTeamId: sit?.possession ? String(sit.possession) : null,
      lastPlayId: sit?.lastPlay?.id ? String(sit.lastPlay.id) : null,
      lastPlayText: sit?.lastPlay?.text || null,
    };
  } catch (err) {
    console.warn('[espn] bad game payload', err);
    return null;
  }
}

/* ---------- play-by-play ---------- */

// Fetch the newest page of plays for one game. `sort=desc` is ignored by the
// API, so we page to the end instead. pageCount is cached per game and the
// response self-corrects it when a page rolls over.
export async function fetchPlaysTail(eventId) {
  const meta = state.playsMeta.get(eventId) || { pageCount: 1 };
  const base = `${ESPN_CORE}/events/${eventId}/competitions/${eventId}/plays?limit=${PLAYS_PAGE_SIZE}`;

  let d = await fetchJSON(`${base}&page=${meta.pageCount}`);
  let plays = (d.items || []).map((p) => normalizePlay(p, eventId)).filter(Boolean);

  // Page rolled over since the last poll — grab the new last page too.
  if (d.pageCount && d.pageCount !== meta.pageCount) {
    const d2 = await fetchJSON(`${base}&page=${d.pageCount}`);
    plays = plays.concat((d2.items || []).map((p) => normalizePlay(p, eventId)).filter(Boolean));
    d = d2;
  }

  state.playsMeta.set(eventId, { pageCount: d.pageCount || 1, count: d.count || plays.length });
  return plays;
}

// Every play of one game in a single request (~37 KB gzipped for a finished
// game). Used to backfill completed games when replaying a past week.
export async function fetchAllPlays(eventId) {
  const d = await fetchJSON(
    `${ESPN_CORE}/events/${eventId}/competitions/${eventId}/plays?limit=400`
  );
  state.playsMeta.set(eventId, { pageCount: 1, count: d.count || 0 });
  return (d.items || []).map((p) => normalizePlay(p, eventId)).filter(Boolean);
}

function normalizePlay(p, eventId) {
  try {
    if (!p?.id) return null;
    // Roles matter: a field goal play lists kicker, snapper and holder, and
    // only the kicker should be credited with the points.
    const parts = (p.participants || [])
      .map((x) => ({ id: idFromRef(x.athlete?.$ref), role: x.type || null }))
      .filter((x) => x.id);
    const athleteIds = parts.map((x) => x.id);

    const typeText = p.type?.text || '';
    const isTD = !!p.scoringPlay && (Number(p.scoreValue) >= 6 || /touchdown/i.test(typeText));

    return {
      id: String(p.id),
      eventId: String(eventId),
      seq: Number(p.sequenceNumber) || 0,
      text: p.text || p.alternativeText || '',
      shortText: p.shortText || p.shortAlternativeText || '',
      type: typeText,
      scoringPlay: !!p.scoringPlay,
      scoreValue: Number(p.scoreValue) || 0,
      isTD,
      isTurnover: !!p.isTurnover,
      isPenalty: !!p.isPenalty,
      period: p.period?.number ?? null,
      clock: p.clock?.displayValue || null,
      awayScore: Number(p.awayScore) || 0,
      homeScore: Number(p.homeScore) || 0,
      teamId: idFromRef(p.team?.$ref),
      athleteIds,
      participants: parts,
      // Field position, present on every play observed. Drives the red-zone
      // filter without needing the game-level situation flag.
      startYTE: p.start?.yardsToEndzone ?? null,
      endYTE: p.end?.yardsToEndzone ?? null,
      downDistance: p.start?.shortDownDistanceText || null,
      yards: Number(p.statYardage) || 0,
      // wallclock is when the play happened; fall back to modified, then now.
      ts: Date.parse(p.wallclock || p.modified || '') || Date.now(),
    };
  } catch (err) {
    console.warn('[espn] bad play payload', err);
    return null;
  }
}

/* ---------- box score ---------- */

// The game summary carries a full, already-parsed box score: passing, rushing,
// receiving, kicking and the rest, keyed by ESPN athlete id. ~19 KB gzipped.
export async function fetchSummary(eventId) {
  const d = await fetchJSON(`${ESPN_SITE}/summary?event=${eventId}`);
  return normalizeBoxscore(d, eventId);
}

// Made field goals, by team, with their distances.
//
// The stat line gives only made/attempts, and fantasy scoring buckets makes by
// distance, so the distance has to come from somewhere else. It cannot come
// from the play feed: that is a rolling tail, so a field goal kicked before the
// page loaded is simply not there. `summary.scoringPlays` covers the whole game
// and its text carries the distance ("Brandon Aubrey 45 Yd Field Goal"), which
// makes it the only complete source in a payload already being fetched.
//
// athletesInvolved is empty on field-goal entries, so there is no athlete ID to
// key on and the kicker's name has to be read out of the text.
const FG_TEXT = /^(.+?)\s+(\d+)\s*Yd\s+Field\s+Goal/i;

function madeFieldGoals(d) {
  const byTeam = new Map();
  for (const p of d?.scoringPlays || []) {
    if ((p.type?.abbreviation || '') !== 'FG') continue;
    const m = FG_TEXT.exec(p.text || '');
    if (!m) continue;
    const tid = String(p.team?.id ?? '');
    if (!byTeam.has(tid)) byTeam.set(tid, []);
    byTeam.get(tid).push({ name: m[1].trim(), distance: Number(m[2]) });
  }
  return byTeam;
}

function normalizeBoxscore(d, eventId) {
  const out = { eventId: String(eventId), teams: [], fetched: Date.now() };
  const fgByTeam = madeFieldGoals(d);
  for (const group of d?.boxscore?.players || []) {
    const team = {
      id: String(group.team?.id ?? ''),
      abbr: group.team?.abbreviation || '??',
      categories: {},
      fgMade: fgByTeam.get(String(group.team?.id ?? '')) || [],
    };
    for (const cat of group.statistics || []) {
      const keys = cat.keys || [];
      const labels = cat.labels || [];
      const rows = [];
      for (const a of cat.athletes || []) {
        const stats = a.stats || [];
        const byKey = {};
        keys.forEach((k, i) => { byKey[k] = stats[i]; });
        rows.push({
          id: String(a.athlete?.id ?? ''),
          name: a.athlete?.displayName || '',
          short: a.athlete?.shortName || '',
          pos: a.athlete?.position?.abbreviation || '',
          stats: byKey,
          raw: stats,
        });
      }
      team.categories[cat.name] = { keys, labels, rows };
    }
    out.teams.push(team);
  }
  return out;
}

/* ---------- team rosters: the athleteId -> name/team/pos bridge source ---------- */

// Sleeper's espn_id covers only ~26% of fantasy-relevant players, so the real
// link runs through ESPN's own rosters. 32 calls, cached for a day.
export async function loadRosters(onProgress) {
  const cached = store.get('espnRosters');
  if (cached) return cached;

  const teams = loadTeams();
  const map = {};
  let done = 0;

  // Small concurrency pool — be polite to an API that owes us nothing.
  const queue = teams.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const d = await fetchJSON(`${ESPN_SITE}/teams/${t.abbr.toLowerCase()}/roster`);
        for (const a of flattenAthletes(d)) {
          if (!a.id) continue;
          map[String(a.id)] = [a.fullName || '', t.abbr, a.position?.abbreviation || ''];
        }
      } catch (err) {
        console.warn('[espn] roster failed', t.abbr, err);
      }
      done++;
      onProgress?.(done, teams.length);
    }
  });
  await Promise.all(workers);

  store.set('espnRosters', map, TTL.espnRosters);
  return map;
}

function flattenAthletes(d) {
  const out = [];
  const src = d?.athletes;
  if (!Array.isArray(src)) return out;
  for (const entry of src) {
    if (entry?.items) out.push(...entry.items);   // grouped by offense/defense
    else if (entry?.id) out.push(entry);          // flat
  }
  return out;
}
