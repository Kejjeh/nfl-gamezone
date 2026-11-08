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
    for (const [id, abbr, short] of TEAMS) {
      state.teamsById.set(id, { id, abbr, short, name: short });
    }
  }
  return [...state.teamsById.values()];
}

export const teamAbbr = (id) => state.teamsById.get(String(id))?.abbr || null;

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
    const athleteIds = (p.participants || [])
      .map((x) => idFromRef(x.athlete?.$ref))
      .filter(Boolean);

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
      // Field position, present on every play observed. Drives the red-zone
      // filter without needing the game-level situation flag.
      startYTE: p.start?.yardsToEndzone ?? null,
      endYTE: p.end?.yardsToEndzone ?? null,
      downDistance: p.start?.shortDownDistanceText || null,
      // wallclock is when the play happened; fall back to modified, then now.
      ts: Date.parse(p.wallclock || p.modified || '') || Date.now(),
    };
  } catch (err) {
    console.warn('[espn] bad play payload', err);
    return null;
  }
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
