// Fantasy points from box-score stat lines, under the connected league's own
// scoring settings.
//
// This is deliberately narrower than deriving points from raw play-by-play.
// A box score is already aggregated and unambiguous: yards, touchdowns,
// receptions and interceptions are single numbers, so the mapping to scoring
// settings is arithmetic rather than text parsing.
//
// One thing the box score cannot give is field-goal distance - it reports
// makes and attempts only, while most leagues (including this one) pay by
// distance. Those are read out of the summary's scoringPlays list in espn.js
// and handed in here as `fgMade`. See kickingPoints().
import { state } from './state.js';

// Full-PPR defaults, used when no league is connected so the leaders board
// still shows something sensible.
const DEFAULTS = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6,
  fgmiss: -1, xpm: 1, xpmiss: -1,
};

export function rules() {
  return { ...DEFAULTS, ...(state.sleeper.league?.scoring_settings || {}) };
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ESPN packs some stats as "made/attempts" or "sacks-yards".
const pair = (v) => {
  const m = String(v ?? '').split(/[/-]/);
  return [num(m[0]), num(m[1])];
};

/* ---------- per-category point contributions ---------- */

export function passingPoints(s, r = rules()) {
  const [comp, att] = pair(s['completions/passingAttempts']);
  const yds = num(s.passingYards);
  const td = num(s.passingTouchdowns);
  const int = num(s.interceptions);
  return {
    pts: yds * r.pass_yd + td * r.pass_td + int * r.pass_int,
    comp, att, yds, td, int,
  };
}

export function rushingPoints(s, r = rules()) {
  const car = num(s.rushingAttempts);
  const yds = num(s.rushingYards);
  const td = num(s.rushingTouchdowns);
  return { pts: yds * r.rush_yd + td * r.rush_td, car, yds, td, long: num(s.longRushing) };
}

export function receivingPoints(s, r = rules()) {
  const rec = num(s.receptions);
  const yds = num(s.receivingYards);
  const td = num(s.receivingTouchdowns);
  const tgts = num(s.receivingTargets);
  return { pts: rec * r.rec + yds * r.rec_yd + td * r.rec_td, rec, yds, td, tgts };
}

export function fumblePoints(s, r = rules()) {
  const lost = num(s.fumblesLost);
  return { pts: lost * r.fum_lost, lost, fum: num(s.fumbles) };
}

// Extra points come from the box score (exact), field goals from the play
// feed (needed for distance).
// `fgMade` is this kicker's made-FG distances, longest-irrelevant order, from
// espn.js. Misses need no distance: every Sleeper preset pays a flat fgmiss, so
// attempts minus makes is exact.
export function kickingPoints(s, fgMade, r = rules()) {
  const [xpm, xpa] = pair(s['extraPointsMade/extraPointAttempts']);
  const [fgm, fga] = pair(s['fieldGoalsMade/fieldGoalAttempts']);
  const long = num(s.longFieldGoalMade);

  let pts = xpm * r.xpm + Math.max(0, xpa - xpm) * r.xpmiss;
  pts += Math.max(0, fga - fgm) * r.fgmiss;

  let ds = (fgMade || []).map((x) => x.distance).slice(0, fgm);

  // One make means longFieldGoalMade *is* the distance, so a name that failed
  // to match still scores exactly.
  if (!ds.length && fgm === 1 && long) ds = [long];

  pts += ds.reduce((acc, d) => acc + r[bucketFor(d)], 0);

  // A make with no distance yet (scoringPlays trailing the stat line by a poll)
  // is credited at the median bucket rather than dropped, so the number drifts
  // by at most a point instead of understating the kicker by three.
  pts += Math.max(0, fgm - ds.length) * r.fgm_30_39;

  return { pts, fgm, fga, xpm, xpa, long, distances: ds };
}

function bucketFor(distance) {
  if (distance >= 60) return 'fgm_60p';
  if (distance >= 50) return 'fgm_50_59';
  if (distance >= 40) return 'fgm_40_49';
  if (distance >= 30) return 'fgm_30_39';
  if (distance >= 20) return 'fgm_20_29';
  return 'fgm_0_19';
}

/* ---------- matching a kicker to their field goals ---------- */

const normName = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');

// scoringPlays carries the kicker's full name but no athlete ID, so pair the
// list against the team's kicking rows by name. With a single kicking row - the
// case in all but an injury game - every made FG on that team is theirs, so the
// name is a cross-check rather than the mechanism.
export function fgForRow(row, teamFgMade, kickingRowCount = 1) {
  const list = teamFgMade || [];
  if (!list.length) return [];
  if (kickingRowCount <= 1) return list;
  const want = normName(row.name);
  return list.filter((f) => normName(f.name) === want);
}

/* ---------- totals ---------- */

// Sum every category for one player's line. `cats` is the per-category stat
// map assembled in boxscore.js.
export function totalFor(cats, fgMade) {
  const r = rules();
  let pts = 0;
  if (cats.passing) pts += passingPoints(cats.passing, r).pts;
  if (cats.rushing) pts += rushingPoints(cats.rushing, r).pts;
  if (cats.receiving) pts += receivingPoints(cats.receiving, r).pts;
  if (cats.fumbles) pts += fumblePoints(cats.fumbles, r).pts;
  if (cats.kicking) pts += kickingPoints(cats.kicking, fgMade, r).pts;
  return Math.round(pts * 100) / 100;
}
