// ESPN data access. All endpoints are undocumented and carry no SLA, so every
// field read here is treated as optional.
import { ESPN_SITE, ESPN_CORE, SEASON, PLAYS_PAGE_SIZE, TTL, TEAM_ALIASES } from './config.js';
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

// Which game a team is in this week, or null on a bye. Sleeper and ESPN
// disagree on a handful of abbreviations (WSH/WAS, JAX/JAC, LV/LVR), so the
// alias table gets a second try before giving up.
export function sameTeam(a, b) {
  if (!a || !b) return false;
  const x = String(a).toUpperCase(), y = String(b).toUpperCase();
  return x === y || TEAM_ALIASES[x] === y || TEAM_ALIASES[y] === x;
}

export function gameForTeam(abbr) {
  if (!abbr) return null;
  for (const g of state.games.values()) {
    if (sameTeam(g.home?.abbr, abbr) || sameTeam(g.away?.abbr, abbr)) return g;
  }
  return null;
}

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

// Team-defence counts for fantasy scoring.
//
// No single part of the payload has these, and the three obvious shortcuts are
// all wrong. Measured on the full Week 8 slate against Sleeper's own numbers:
//
//   Sacks        the `defensive` group's per-player `sacks`, summed. Agrees
//                with the opponent's team-stat `sacksYardsLost` on 10 of 10
//                team-sides, and handles half-sacks.
//   Takeaways    the OPPONENT's team-stat `fumblesLost`. Summing the team's own
//                players' `fumblesRecovered` disagreed on 3 of 10 team-sides
//                (GB 2 vs 1, TEN 3 vs 1, DAL 3 vs 1) because that field counts
//                a player falling on his own team's fumble, which is not a
//                takeaway and scores nothing.
//   Defensive TD `scoringPlays`, by type text. Neither obvious source works.
//                A pick-six appears in BOTH the `defensive` group's
//                `defensiveTouchdowns` and the `interceptions` group's
//                `interceptionTouchdowns`, so summing player rows double-counts
//                it (JAX read 26 against Sleeper's 20). The team-stat
//                `defensiveTouchdowns` is wrong too: LV reads 2 having scored
//                no defensive touchdown at all - its only non-offensive score
//                was a 95-yard kickoff return. The scoring-play list is the
//                only place that says which kind of touchdown it was.
//   Safeties     `scoringPlays` with type `SF`, the same place field-goal
//                distances come from. They are in no stat group at all.
//
// With those four, points allowed from the opponent's score and yards allowed
// from their `totalYards`, all 10 defences anyone in the league started in
// Week 8 matched Sleeper to the cent.
//
// Known gaps, both unmeasurable on the Week 8 slate and both named in the
// README: a blocked kick (`blk_kick`) is in no stat group and is not a scoring
// play, and none occurred; and no league member started a team whose returner
// scored, so whether Sleeper credits a kick- or punt-return touchdown to the
// D/ST could not be checked. Return touchdowns are therefore left out, which
// is what the 10 verified defences support.
// Two-point conversions.
//
// Nothing in the box score records one: a successful two-point pass shows up in
// no passing, rushing or receiving stat line, so a quarterback who runs one in
// scores two points that the stat sheet cannot see. Diagnostics caught it as
// two players reading exactly 2.00 low against Sleeper on a finished slate
// (Jordan Love 34.18 vs 36.18, Baker Mayfield 7.72 vs 9.72) - both had run a
// conversion.
//
// They are in the scoring-play text instead, in the parenthetical after the
// touchdown, which is the same complete whole-game source field-goal distances
// come from. Measured over 104 games (weeks 3-9) there are exactly four forms
// and no others:
//
//   "<Passer> Pass to <Receiver> for Two-Point Conversion"   22x  succeeded
//   "<Rusher> Run for Two-Point Conversion"                  10x  succeeded
//   "Two-Point Pass Conversion Failed"                       25x  failed
//   "Two-Point Run Conversion Failed"                         2x  failed
//
// A failure never carries a name and a success always does, so requiring the
// name is what separates them - no "Failed" test is needed, and a fifth form
// would be ignored rather than mis-scored.
//
// Like field goals, the entry gives names and no athlete ids, so these are
// matched back to box-score rows by name in boxscore.js.
const TWO_PT_PAREN = /\(([^()]*Two-Point[^()]*)\)/i;
const TWO_PT_RUN = /^([A-Za-z][A-Za-z.'’\s-]*?)\s+Run\s+for\s+Two-Point\s+Conversion$/i;
const TWO_PT_PASS = /^([A-Za-z][A-Za-z.'’\s-]*?)\s+Pass\s+to\s+([A-Za-z][A-Za-z.'’\s-]*?)\s+for\s+Two-Point\s+Conversion$/i;

function twoPointConversions(d) {
  const byTeam = new Map();
  for (const p of d?.scoringPlays || []) {
    const m = TWO_PT_PAREN.exec(p.text || '');
    if (!m) continue;
    const inner = m[1].trim();

    let rec = null;
    const run = TWO_PT_RUN.exec(inner);
    if (run) rec = { kind: 'run', rusher: run[1].trim() };
    else {
      const pass = TWO_PT_PASS.exec(inner);
      if (pass) rec = { kind: 'pass', passer: pass[1].trim(), receiver: pass[2].trim() };
    }
    if (!rec) continue;                      // a failed attempt, or a new form

    const tid = String(p.team?.id ?? '');
    if (!byTeam.has(tid)) byTeam.set(tid, []);
    byTeam.get(tid).push(rec);
  }
  return byTeam;
}

const DEF_TD_TEXT = /\b(?:interception|fumble|blocked\s+(?:punt|field\s*goal))\s+return\s+touchdown\b/i;

function teamDefence(d) {
  const num = (v) => {
    const x = parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(x) ? x : 0;
  };

  // Team-level stat lines, by team id.
  const teamStats = new Map();
  for (const t of d?.boxscore?.teams || []) {
    const m = {};
    for (const st of t.statistics || []) m[st.name] = st.displayValue;
    teamStats.set(String(t.team?.id ?? ''), m);
  }

  const scores = new Map();
  for (const c of d?.header?.competitions?.[0]?.competitors || []) {
    scores.set(String(c.team?.id ?? ''), num(c.score));
  }

  // Safeties and defensive touchdowns, both only knowable from the play's own
  // type text. DEF_TD_TEXT deliberately excludes kickoff and punt returns:
  // those are special teams, scored separately, and are exactly what makes the
  // team-stat `defensiveTouchdowns` unusable.
  const safeties = new Map();
  const defTds = new Map();
  for (const p of d?.scoringPlays || []) {
    const tid = String(p.team?.id ?? '');
    const abbr = p.type?.abbreviation || '';
    if (abbr === 'SF') {
      safeties.set(tid, (safeties.get(tid) || 0) + 1);
      continue;
    }
    if (abbr === 'TD' && DEF_TD_TEXT.test(p.type?.text || '')) {
      defTds.set(tid, (defTds.get(tid) || 0) + 1);
    }
  }

  // Per-player sacks and interceptions, summed per team.
  const tally = new Map();
  for (const group of d?.boxscore?.players || []) {
    const tid = String(group.team?.id ?? '');
    const acc = { sacks: 0, ints: 0 };
    for (const cat of group.statistics || []) {
      const keys = cat.keys || [];
      const at = (stats, key) => {
        const i = keys.indexOf(key);
        return i < 0 ? 0 : num(stats?.[i]);
      };
      for (const a of cat.athletes || []) {
        if (cat.name === 'defensive') acc.sacks += at(a.stats, 'sacks');
        if (cat.name === 'interceptions') acc.ints += at(a.stats, 'interceptions');
      }
    }
    tally.set(tid, acc);
  }

  const ids = [...tally.keys()];
  const out = new Map();
  for (const tid of ids) {
    const oppId = ids.find((x) => x !== tid);
    const opp = teamStats.get(oppId) || {};
    const acc = tally.get(tid) || { sacks: 0, ints: 0 };
    out.set(tid, {
      sacks: acc.sacks,
      ints: acc.ints,
      fumRec: num(opp.fumblesLost),
      defTd: defTds.get(tid) || 0,
      safeties: safeties.get(tid) || 0,
      ptsAllowed: scores.get(oppId) ?? null,
      ydsAllowed: num(opp.totalYards),
    });
  }
  return out;
}

// Per-play win probability, as a swing rather than a level.
//
// The summary already carries this; it costs nothing extra to keep. The
// entries arrive in play order, so the swing is just the step from the
// previous entry. `playId` joins straight onto the play feed's own ids -
// measured 197 of 197 on a full game, so there is no bridge here and no
// fallback worth writing.
function winProbByPlay(d) {
  const out = new Map();
  let prev = null;
  for (const w of Array.isArray(d?.winprobability) ? d.winprobability : []) {
    const id = String(w?.playId ?? '');
    const home = Number(w?.homeWinPercentage);
    if (!id || !Number.isFinite(home)) continue;
    out.set(id, { home, swing: prev == null ? 0 : Math.abs(home - prev) });
    prev = home;
  }
  return out;
}

// Drive summaries: 25 lines where the play feed has 197. `previous` holds the
// finished drives and `current` the one in progress, and a game that has not
// kicked off has neither - all three are normal, so nothing here throws.
function normalizeDrives(d) {
  const src = d?.drives;
  if (!src) return [];
  const all = Array.isArray(src.previous) ? src.previous.slice() : [];
  if (src.current) all.push(src.current);
  const out = [];
  for (const x of all) {
    const id = String(x?.id ?? '');
    if (!id) continue;
    const plays = Array.isArray(x?.plays) ? x.plays : [];
    out.push({
      id,
      team: x?.team?.abbreviation || '',
      teamId: String(x?.team?.id ?? ''),
      // "8 plays, 56 yards, 3:33" - ESPN writes this line, so it is not
      // rebuilt here from parts that might disagree with it.
      description: x?.description || '',
      result: x?.displayResult || x?.shortDisplayResult || x?.result || '',
      isScore: !!x?.isScore,
      playCount: plays.length,
      yards: Number(x?.yards) || 0,
      period: x?.start?.period?.number ?? null,
      startText: x?.start?.text || '',
      firstPlayId: plays.length ? String(plays[0]?.id ?? '') : '',
      lastPlayId: plays.length ? String(plays[plays.length - 1]?.id ?? '') : '',
    });
  }
  return out;
}

function normalizeBoxscore(d, eventId) {
  const out = {
    eventId: String(eventId),
    teams: [],
    fetched: Date.now(),
    winProb: winProbByPlay(d),
    drives: normalizeDrives(d),
  };
  const fgByTeam = madeFieldGoals(d);
  const defByTeam = teamDefence(d);
  const twoPtByTeam = twoPointConversions(d);
  for (const group of d?.boxscore?.players || []) {
    const team = {
      id: String(group.team?.id ?? ''),
      abbr: group.team?.abbreviation || '??',
      categories: {},
      fgMade: fgByTeam.get(String(group.team?.id ?? '')) || [],
      defense: defByTeam.get(String(group.team?.id ?? '')) || null,
      twoPt: twoPtByTeam.get(String(group.team?.id ?? '')) || [],
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
// Held in memory as well as in the store, so synchronous callers can ask a
// player's position without awaiting. `null` means "not loaded yet", which is
// a different answer from "this player has no position" - see positionOf.
let rosterMap = null;

function rosters() {
  if (!rosterMap) rosterMap = store.get('espnRosters') || null;
  return rosterMap;
}

export const rostersReady = () => !!rosters();

// ESPN's box-score summaries carry no athlete position at all: measured on a
// full Week 8 slate, 0 of 892 stat rows had one. The rosters do, so they are
// the position source. Returns '' when the rosters have not loaded, so a
// caller that cares about the difference must check rostersReady() first.
export function positionOf(athleteId) {
  return rosters()?.[String(athleteId)]?.[2] || '';
}

export async function loadRosters(onProgress) {
  const cached = store.get('espnRosters');
  if (cached) { rosterMap = cached; return cached; }

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
  rosterMap = map;
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
