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
  // Team defence. Sleeper's own defaults, so a DEF reads sensibly with no
  // league connected. Yards-allowed buckets are deliberately absent: most
  // leagues do not score them, and an absent key must contribute nothing
  // rather than fall back to a guess.
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
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
// A team defence, from the counts espn.js assembles in teamDefence().
//
// Verified against Sleeper on the full Week 8 slate: all 10 defences anyone in
// the league had started matched to the cent. The traps that had to be measured
// away live in the comment on teamDefence() - read that before changing this.
//
// Blocked kicks are not counted. They appear in no stat group and are not a
// scoring play, and Week 8 contained none, so there was no sample to verify a
// detector against. A league that scores them (this one pays 2) will read a
// blocked kick low. defenseGaps() names it so the panel can say so.
export function defensePoints(def, r = rules()) {
  if (!def) return { pts: 0 };

  const bucket = (pa) => {
    if (pa == null) return 0;
    if (pa <= 0) return r.pts_allow_0 || 0;
    if (pa <= 6) return r.pts_allow_1_6 || 0;
    if (pa <= 13) return r.pts_allow_7_13 || 0;
    if (pa <= 20) return r.pts_allow_14_20 || 0;
    if (pa <= 27) return r.pts_allow_21_27 || 0;
    if (pa <= 34) return r.pts_allow_28_34 || 0;
    return r.pts_allow_35p || 0;
  };

  // Only scored by leagues that set the keys; absent means zero, not a guess.
  const yardBucket = (y) => {
    if (!y) return 0;
    if (y < 100) return r.yds_allow_0_100 || 0;
    if (y < 200) return r.yds_allow_100_199 || 0;
    if (y < 300) return r.yds_allow_200_299 || 0;
    if (y < 350) return r.yds_allow_300_349 || 0;
    if (y < 400) return r.yds_allow_350_399 || 0;
    if (y < 450) return r.yds_allow_400_449 || 0;
    if (y < 500) return r.yds_allow_450_499 || 0;
    if (y < 550) return r.yds_allow_500_549 || 0;
    return r.yds_allow_550p || 0;
  };

  const sacks = num(def.sacks);
  const ints = num(def.ints);
  const fumRec = num(def.fumRec);
  const defTd = num(def.defTd);
  const safeties = num(def.safeties);

  const pts = sacks * (r.sack || 0)
    + ints * (r.int || 0)
    + fumRec * (r.fum_rec || 0)
    + defTd * (r.def_td || 0)
    + safeties * (r.safe || 0)
    + bucket(def.ptsAllowed)
    + yardBucket(num(def.ydsAllowed));

  return {
    pts, sacks, ints, fumRec, defTd, safeties,
    ptsAllowed: def.ptsAllowed, ydsAllowed: num(def.ydsAllowed),
  };
}

// What this league scores but the box score cannot see. Empty for most.
export function defenseGaps(r = rules()) {
  const gaps = [];
  if (r.blk_kick) gaps.push('blocked kicks');
  return gaps;
}

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
export function totalFor(cats, fgMade, twoPt) {
  const r = rules();
  let pts = 0;
  if (cats.passing) pts += passingPoints(cats.passing, r).pts;
  if (cats.rushing) pts += rushingPoints(cats.rushing, r).pts;
  if (cats.receiving) pts += receivingPoints(cats.receiving, r).pts;
  if (cats.fumbles) pts += fumblePoints(cats.fumbles, r).pts;
  if (cats.kicking) pts += kickingPoints(cats.kicking, fgMade, r).pts;
  pts += twoPointPoints(twoPt, r).pts;
  return Math.round(pts * 100) / 100;
}

// A two-point conversion is in no stat line at all - see twoPointConversions()
// in espn.js for where the counts come from and why. Sleeper pays the passer,
// the receiver and the rusher separately, so all three keys are read.
export function twoPointPoints(twoPt, r = rules()) {
  const t = twoPt || {};
  const pass = num(t.pass);
  const rec = num(t.rec);
  const rush = num(t.rush);
  return {
    pts: pass * (r.pass_2pt || 0) + rec * (r.rec_2pt || 0) + rush * (r.rush_2pt || 0),
    pass, rec, rush,
  };
}
