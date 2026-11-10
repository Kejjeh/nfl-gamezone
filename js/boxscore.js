// Box-score aggregation across every game in the slate.
//
// ESPN's summary endpoint returns one box score per game, split by team and
// then by category. This module flattens that into a single player-keyed
// table so the leaders board can rank across all games at once, and attaches
// fantasy points computed under the connected league's scoring settings.
import { state } from './state.js';
import * as espn from './espn.js';
import * as scoring from './scoring.js';
import * as bridge from './bridge.js';
import { TEAMS } from './teams.js';

// Fantasy scoring only needs the first five. The rest are here for bet
// markets - tackles, sacks and return yards are all commonly priced - and for
// defensive scoring later. Aggregating them costs nothing: the box scores are
// already fetched and in memory.
const SKILL = [
  'passing', 'rushing', 'receiving', 'kicking', 'fumbles',
  'defensive', 'interceptions', 'kickReturns', 'puntReturns',
];

export async function refresh(eventIds) {
  for (const id of eventIds) {
    try {
      const box = await espn.fetchSummary(id);
      state.boxscores.set(String(id), box);
    } catch (err) {
      console.warn('[boxscore] failed', id, err);
    }
  }
  rebuildContext();
  rebuildPlayerTable();
}

// Win probability and drives, flattened across every game so a caller with a
// play id does not have to know which box score it came from. Cheap enough to
// redo wholesale on every poll, which keeps it impossible for a stale entry
// to survive a game being re-fetched.
export function rebuildContext() {
  const wp = new Map();
  const dr = new Map();
  for (const box of state.boxscores.values()) {
    if (box.winProb) for (const [id, v] of box.winProb) wp.set(id, v);
    if (box.drives?.length) dr.set(String(box.eventId), box.drives);
  }
  state.winProb = wp;
  state.drives = dr;
}

// espnAthleteId -> aggregated line. A player appears in one game only, so no
// cross-game summing is needed - but the table spans the whole slate.
export function rebuildPlayerTable() {
  const table = new Map();
  const fgByAthlete = new Map();
  const twoPtByAthlete = new Map();
  const twoPtMissed = [];

  for (const box of state.boxscores.values()) {
    const game = state.games.get(box.eventId);
    for (const team of box.teams) {
      creditTwoPoints(team, twoPtByAthlete, twoPtMissed);
      const opp = game
        ? (game.home.abbr === team.abbr ? game.away.abbr : game.home.abbr)
        : null;

      for (const catName of SKILL) {
        const cat = team.categories[catName];
        if (!cat) continue;
        for (const row of cat.rows) {
          if (!row.id) continue;
          let rec = table.get(row.id);
          if (!rec) {
            rec = {
              id: row.id,
              name: row.name,
              short: row.short,
              // The box score itself carries no position, so it comes from
              // the roster map, normalised to the fantasy spelling (PK -> K).
              pos: bridge.normPos(espn.positionOf(row.id)),
              team: team.abbr,
              opp,
              eventId: box.eventId,
              cats: {},
            };
            table.set(row.id, rec);
          }
          rec.cats[catName] = row.stats;

          if (catName === 'kicking') {
            fgByAthlete.set(row.id, scoring.fgForRow(row, team.fgMade, cat.rows.length));
          }
        }
      }
    }
  }

  for (const rec of table.values()) {
    rec.fpts = scoring.totalFor(rec.cats, fgByAthlete.get(rec.id), twoPtByAthlete.get(rec.id));
  }

  // A conversion scored by somebody with no box-score row is two points nobody
  // gets. It should not happen - every converter has a stat line - so say so
  // rather than let the total read quietly low.
  if (twoPtMissed.length) {
    console.warn(`[scoring] ${twoPtMissed.length} two-point conversion(s) unmatched:`,
      twoPtMissed.join(', '));
  }

  addDefences(table);

  state.playerStats = table;
  return table;
}

// Two-point conversions carry names, not athlete ids - exactly like field-goal
// distances - so they are matched back onto the team's own box-score rows by
// normalised name. Scoped to the one team, which is what keeps the match safe:
// a name has to collide inside a single roster to go wrong.
function creditTwoPoints(team, byAthlete, missed) {
  if (!team.twoPt?.length) return;

  const byName = new Map();
  for (const cat of Object.values(team.categories || {})) {
    for (const row of cat.rows || []) {
      if (!row.id) continue;
      const key = bridge.normName(row.name);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, row.id);
    }
  }

  const award = (name, kind) => {
    const id = byName.get(bridge.normName(name));
    if (!id) { missed.push(`${name} (${team.abbr} ${kind})`); return; }
    const rec = byAthlete.get(id) || { pass: 0, rec: 0, rush: 0 };
    rec[kind] += 1;
    byAthlete.set(id, rec);
  };

  for (const c of team.twoPt) {
    if (c.kind === 'run') award(c.rusher, 'rush');
    else { award(c.passer, 'pass'); award(c.receiver, 'rec'); }
  }
}

// One row per team defence, keyed by the team abbreviation.
//
// That key is not a convenience: it is the id Sleeper itself uses for a D/ST,
// so a DEF row needs no bridge and Diagnostics can check it against Sleeper the
// same way it checks a receiver. A team defence is not an athlete and has no
// ESPN athlete id, so nothing else in the table can collide with it.
function addDefences(table) {
  for (const box of state.boxscores.values()) {
    const game = state.games.get(box.eventId);
    for (const team of box.teams) {
      if (!team.defense || !team.abbr || team.abbr === '??') continue;
      const opp = game
        ? (game.home.abbr === team.abbr ? game.away.abbr : game.home.abbr)
        : null;
      const def = scoring.defensePoints(team.defense);
      table.set(team.abbr, {
        id: team.abbr,
        name: `${TEAM_NAME.get(team.abbr) || team.abbr} D/ST`,
        short: `${team.abbr} D/ST`,
        pos: 'DEF',
        team: team.abbr,
        opp,
        eventId: box.eventId,
        cats: {},
        def,
        fpts: Math.round(def.pts * 100) / 100,
      });
    }
  }
}

const TEAM_NAME = new Map(TEAMS.map(([, abbr, short]) => [abbr, short]));

/* ---------- leaders ---------- */

const n = (v) => {
  const x = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const firstOfPair = (v) => n(String(v ?? '').split(/[/-]/)[0]);

// Each entry: how to pull the ranking value, and the supporting line to show.
export const CATEGORIES = {
  fpts: {
    label: 'Fantasy points',
    short: 'FPTS',
    value: (r) => r.fpts,
    detail: (r) => summaryLine(r),
    fmt: (v) => v.toFixed(1),
  },
  passYds: {
    label: 'Passing yards',
    short: 'YDS',
    value: (r) => n(r.cats.passing?.passingYards),
    detail: (r) => {
      const c = r.cats.passing || {};
      return `${c['completions/passingAttempts'] || '0/0'} · ${n(c.passingTouchdowns)} TD · ${n(c.interceptions)} INT`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  rushYds: {
    label: 'Rushing yards',
    short: 'YDS',
    value: (r) => n(r.cats.rushing?.rushingYards),
    detail: (r) => {
      const c = r.cats.rushing || {};
      return `${n(c.rushingAttempts)} car · ${n(c.rushingTouchdowns)} TD · ${c.yardsPerRushAttempt || '0'} avg`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  recYds: {
    label: 'Receiving yards',
    short: 'YDS',
    value: (r) => n(r.cats.receiving?.receivingYards),
    detail: (r) => {
      const c = r.cats.receiving || {};
      return `${n(c.receptions)} rec · ${n(c.receivingTargets)} tgt · ${n(c.receivingTouchdowns)} TD`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  receptions: {
    label: 'Receptions',
    short: 'REC',
    value: (r) => n(r.cats.receiving?.receptions),
    detail: (r) => {
      const c = r.cats.receiving || {};
      return `${n(c.receivingTargets)} tgt · ${n(c.receivingYards)} yds`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  targets: {
    label: 'Targets',
    short: 'TGT',
    value: (r) => n(r.cats.receiving?.receivingTargets),
    detail: (r) => {
      const c = r.cats.receiving || {};
      return `${n(c.receptions)} rec · ${n(c.receivingYards)} yds`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  tds: {
    label: 'Touchdowns',
    short: 'TD',
    value: (r) => n(r.cats.passing?.passingTouchdowns)
      + n(r.cats.rushing?.rushingTouchdowns)
      + n(r.cats.receiving?.receivingTouchdowns),
    detail: (r) => summaryLine(r),
    fmt: (v) => String(Math.round(v)),
  },
  completions: {
    label: 'Completions',
    short: 'CMP',
    value: (r) => firstOfPair(r.cats.passing?.['completions/passingAttempts']),
    detail: (r) => {
      const c = r.cats.passing || {};
      return `${n(c.passingYards)} yds · ${n(c.passingTouchdowns)} TD`;
    },
    fmt: (v) => String(Math.round(v)),
  },
  kicking: {
    label: 'Kicking points',
    short: 'PTS',
    value: (r) => n(r.cats.kicking?.totalKickingPoints),
    detail: (r) => {
      const c = r.cats.kicking || {};
      return `${c['fieldGoalsMade/fieldGoalAttempts'] || '0/0'} FG · ${c['extraPointsMade/extraPointAttempts'] || '0/0'} XP`;
    },
    fmt: (v) => String(Math.round(v)),
  },
};

export function summaryLine(r) {
  const bits = [];
  const p = r.cats.passing;
  const ru = r.cats.rushing;
  const re = r.cats.receiving;
  if (p && n(p.passingYards)) bits.push(`${n(p.passingYards)} pass`);
  if (ru && n(ru.rushingYards)) bits.push(`${n(ru.rushingYards)} rush`);
  if (re && n(re.receivingYards)) bits.push(`${n(re.receivingYards)} rec`);
  const td = n(p?.passingTouchdowns) + n(ru?.rushingTouchdowns) + n(re?.receivingTouchdowns);
  if (td) bits.push(`${td} TD`);

  // A team defence has no stat line at all - its numbers are counts assembled
  // from three different parts of the payload - so it needs its own summary or
  // it reads as a blank row next to a double-digit total.
  if (r.pos === 'DEF' && r.def) {
    const d = r.def;
    const parts = [];
    if (d.sacks) parts.push(`${d.sacks} sack${d.sacks === 1 ? '' : 's'}`);
    if (d.ints) parts.push(`${d.ints} INT`);
    if (d.fumRec) parts.push(`${d.fumRec} FR`);
    if (d.defTd) parts.push(`${d.defTd} TD`);
    if (d.safeties) parts.push(`${d.safeties} safety`);
    if (d.ptsAllowed != null) parts.push(`${d.ptsAllowed} allowed`);
    return parts.join(' · ') || '—';
  }

  // A kicker has none of the above, so without this they read as a blank line
  // next to a double-digit fantasy total.
  const k = r.cats.kicking;
  if (!bits.length && k) {
    const fg = k['fieldGoalsMade/fieldGoalAttempts'];
    const xp = k['extraPointsMade/extraPointAttempts'];
    if (fg && fg !== '0/0') bits.push(`${fg} FG`);
    if (xp && xp !== '0/0') bits.push(`${xp} XP`);
    if (n(k.longFieldGoalMade)) bits.push(`${n(k.longFieldGoalMade)} long`);
  }

  return bits.join(' · ') || '—';
}

// Fantasy position groups for the leaders board, mirroring the league's own
// slots. DEF matches the synthetic team-defence rows addDefences() builds.
// Every category other than fpts and tds reads a skill-position stat line, so a
// defence scores 0 there and the leaders board drops it on its own.
export const POSITIONS = {
  all: { label: 'All', match: () => true },
  QB: { label: 'QB', match: (p) => p === 'QB' },
  RB: { label: 'RB', match: (p) => p === 'RB' },
  WR: { label: 'WR', match: (p) => p === 'WR' },
  TE: { label: 'TE', match: (p) => p === 'TE' },
  FLEX: { label: 'FLEX', match: (p) => p === 'RB' || p === 'WR' || p === 'TE' },
  K: { label: 'K', match: (p) => p === 'K' },
  DEF: { label: 'DEF', match: (p) => p === 'DEF' },
};

export function leaders(categoryKey, limit = 12, pos = 'all') {
  const cat = CATEGORIES[categoryKey];
  if (!cat || !state.playerStats) return [];
  const group = POSITIONS[pos] || POSITIONS.all;
  return [...state.playerStats.values()]
    .filter((r) => group.match(r.pos))
    .map((r) => ({ row: r, v: cat.value(r) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v || a.row.name.localeCompare(b.row.name))
    .slice(0, limit);
}

/* ---------- validation ---------- */

// Compare computed points against Sleeper's own numbers for every player it
// has an opinion on. Sleeper is authoritative; this exists so a scoring bug
// is visible rather than silently wrong.
export function validate() {
  const sleeperPts = state.sleeper.pointsByPlayer;
  if (!sleeperPts?.size || !state.playerStats.size || !state.bridge.ready) return null;

  // Split by game state. A live game is sampled from two sources seconds
  // apart, so a player who just gained yards reads higher here than in
  // Sleeper's tally until Sleeper catches up - a difference that says nothing
  // about whether the scoring is right. Finished games have no such skew, so
  // they are the real test and `final` is the number to trust.
  const rows = { final: [], live: [] };
  for (const rec of state.playerStats.values()) {
    // A D/ST is keyed by its team abbreviation, which is already Sleeper's own
    // id for it, so it needs no bridge lookup.
    const sid = rec.pos === 'DEF' ? rec.id : state.bridge.athleteToSleeper.get(rec.id);
    if (!sid || !sleeperPts.has(sid)) continue;
    const theirs = Number(sleeperPts.get(sid));
    if (!Number.isFinite(theirs)) continue;

    const bucket = state.games.get(rec.eventId)?.state === 'post' ? 'final' : 'live';
    rows[bucket].push({
      name: rec.name,
      mine: rec.fpts,
      theirs,
      diff: Math.round((rec.fpts - theirs) * 100) / 100,
    });
  }
  if (!rows.final.length && !rows.live.length) return null;

  const summarize = (a) => ({
    n: a.length,
    exact: a.filter((r) => Math.abs(r.diff) < 0.05).length,
    off: a.filter((r) => Math.abs(r.diff) >= 0.05)
          .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
          .slice(0, 5),
  });
  return { final: summarize(rows.final), live: summarize(rows.live) };
}
