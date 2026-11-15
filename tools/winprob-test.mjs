// Table-driven tests for js/winprob.js.
//
//   node tools/winprob-test.mjs
//
// Offline and deterministic. The eight fixtures in live-pwin-fixtures.mjs are
// real held-out snapshots of this league paired with the probability the
// gridiron reference implementation produced for them, so this harness checks
// the browser's arithmetic against a number computed in another language in
// another repo - not against itself.
//
// Everything else here is the part the fixtures cannot reach: they carry `f`
// and `proj` already computed, so the game clock and the projection scoring
// are tested directly.
import { state } from '../js/state.js';
import * as wp from '../js/winprob.js';
import { CONSTS, OT_FRACTION } from '../js/winprob-consts.js';
import { FIXTURES, MODEL } from './live-pwin-fixtures.mjs';

let pass = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; return; }
  failures.push(`${name}\n      got  ${g}\n      want ${w}`);
}

function near(name, got, want, tol) {
  if (Number.isFinite(got) && Math.abs(got - want) <= tol) { pass += 1; return; }
  failures.push(`${name}\n      got  ${got}\n      want ${want} +/- ${tol}`);
}

/* ------------------------------------------------- the held-out fixtures */

check('the fixtures are the shipped model', MODEL, CONSTS.version);
check('all eight fixtures are present', FIXTURES.length, 8);

// The fixture carries `now` per starter; a side's `now` is their sum, which is
// what Sleeper's matchup `points` holds.
const sideOf = (starters) => ({
  now: starters.reduce((t, s) => t + (s.now || 0), 0),
  starters,
});

let worst = 0;
FIXTURES.forEach((fx, i) => {
  const got = wp.pWin(sideOf(fx.sides[0]), sideOf(fx.sides[1])).p;
  worst = Math.max(worst, Math.abs(got - fx.expected_p));
  near(`fixture #${i} reproduces ${fx.expected_p}`, got, fx.expected_p, 0.0005);
});
// Stated rather than merely asserted: if a later change leaves the fixtures
// passing but drifts the error towards the tolerance, that is worth seeing.
check('the worst fixture error is far inside the tolerance', worst < 0.0002, true);

// The model should also be on the right side of most of these outcomes. Not a
// measure of accuracy - eight snapshots prove nothing - just a guard against
// a sign flip that still lands inside the tolerance on symmetric cases.
{
  const right = FIXTURES.filter((fx) => {
    const p = wp.pWin(sideOf(fx.sides[0]), sideOf(fx.sides[1])).p;
    return (p > 0.5) === (fx.won === 1);
  }).length;
  check('the favourite won in all eight', right, 8);
}

// Swapping the sides must mirror the probability exactly.
FIXTURES.forEach((fx, i) => {
  const a = wp.pWin(sideOf(fx.sides[0]), sideOf(fx.sides[1])).p;
  const b = wp.pWin(sideOf(fx.sides[1]), sideOf(fx.sides[0])).p;
  near(`fixture #${i} is symmetric under a swap`, a + b, 1, 1e-9);
});

/* ------------------------------------------------------------- the clock */

check('a clock parses', wp.clockSeconds('7:30'), 450);
check('a two-digit minute parses', wp.clockSeconds('12:05'), 725);
check('tenths under a minute parse', wp.clockSeconds('43.2'), 43.2);
check('an empty clock is missing, not zero', wp.clockSeconds(''), null);
check('a null clock is missing', wp.clockSeconds(null), null);
check('nonsense is missing', wp.clockSeconds('halftime'), null);

const game = (state_, period, clock) => ({ state: state_, period, clock });

check('before kickoff the whole game is left', wp.remainingFraction(game('pre', null, null)), 1);
check('a final game has nothing left', wp.remainingFraction(game('post', 4, '0:00')), 0);
// No game at all is zero, not one: a bye or an empty slot must not invent
// points on its side.
check('no game at all is nothing left', wp.remainingFraction(null), 0);
check('an undefined game is nothing left', wp.remainingFraction(undefined), 0);

check('Q2 7:30 is 0.625', wp.remainingFraction(game('in', 2, '7:30')), 0.625);
check('halftime is exactly half', wp.remainingFraction(game('in', 2, '0:00')), 0.5);
check('the opening kickoff is the whole game', wp.remainingFraction(game('in', 1, '15:00')), 1);
check('the two-minute warning in Q4 is 1/30th',
  wp.remainingFraction(game('in', 4, '2:00')), 120 / 3600);
check('Q4 0:00 is nothing left', wp.remainingFraction(game('in', 4, '0:00')), 0);

check('overtime is a stub', wp.remainingFraction(game('in', 5, '10:00')), OT_FRACTION);
check('a second overtime is the same stub', wp.remainingFraction(game('in', 6, '10:00')), OT_FRACTION);

// Degrade, never throw: ESPN has sent a live game with fields missing before.
check('a live game with no period has just kicked off',
  wp.remainingFraction(game('in', null, null)), 1);
check('a live game with an unreadable clock keeps its own quarter',
  wp.remainingFraction(game('in', 3, 'halftime')), (900 + 900) / 3600);
check('an unknown state is treated as over',
  wp.remainingFraction(game('weird', 2, '7:30')), 0);

/* ------------------------------------------- projections become points */

// A real week-9 Sleeper projection row for a kicker, captured 2026-11-15.
// Projections split missed field goals by distance and carry one 50-plus
// made band; the league scores a single fgmiss and a 50-59 band.
const KICKER = {
  fga: 2.32, fgm: 2, fgm_20_29: 0.31, fgm_30_39: 0.46, fgm_40_49: 0.41,
  fgm_50p: 0.41, fgm_yds: 67.44,
  fgmiss_30_39: 0.04, fgmiss_40_49: 0.04, fgmiss_50p: 0.12,
  gp: 1, pts_ppr: 8.57, xpa: 2.83, xpm: 2.71, xpmiss: 0.13,
};
const LEAGUE = {
  fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6,
  fgmiss: -1, xpm: 1, xpmiss: -1, rec: 1,
};

check('the projection row really carries no plain fgmiss', 'fgmiss' in KICKER, false);
check('and no fgm_50_59', 'fgm_50_59' in KICKER, false);

const derived = wp.derivedKeys(KICKER, LEAGUE);
near('fgmiss is the sum of the distance bands', derived.fgmiss, 0.20, 1e-9);
near('the 50-plus band becomes fgm_50_59', derived.fgm_50_59, 0.41, 1e-9);

// 0.31*3 + 0.46*3 + 0.41*4 + 0.41*5 + 2.71*1 - 0.13 - 0.20
near('a kicker scores under the league rules',
  wp.projectedPoints(KICKER, LEAGUE), 8.38, 0.005);

// The whole reason the aliases exist: without them a kicker is short by the
// 50-plus band and the misses, measured at 1.43 points on average across the
// 30 real week-9 kicker rows.
near('without the aliases the same kicker is 1.85 short',
  wp.projectedPoints(KICKER, LEAGUE) - 8.38 + 1.85,
  1.85, 0.005);
{
  const naive = Object.entries(LEAGUE)
    .reduce((t, [k, w]) => t + (typeof KICKER[k] === 'number' ? KICKER[k] * w : 0), 0);
  near('the naive dot product drops 2.05 of made kicks and 0.20 of misses',
    wp.projectedPoints(KICKER, LEAGUE) - naive, 2.05 - 0.20, 0.005);
}

// A league that does not score a key must not have it invented.
{
  const noMiss = { fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, xpm: 1 };
  check('a league that ignores misses gets no fgmiss', 'fgmiss' in wp.derivedKeys(KICKER, noMiss), false);
  check('and no fgm_50_59 either', 'fgm_50_59' in wp.derivedKeys(KICKER, noMiss), false);
}
// An upstream row that already carries the key is left alone rather than
// doubled - the weekly stats files carry both forms.
{
  const both = { ...KICKER, fgmiss: 3 };
  check('a row that already has fgmiss keeps it', 'fgmiss' in wp.derivedKeys(both, LEAGUE), false);
  near('and it is scored as given', wp.projectedPoints(both, LEAGUE),
    wp.projectedPoints(KICKER, LEAGUE) - 0.20 * -1 + 3 * -1, 0.005);
}

// A team defence: points-allowed tiers are 0/1 indicators, so the plain dot
// product handles them and nothing is derived.
{
  const DEF = { sack: 2.27, int: 0.69, fum_rec: 0.53, def_td: 0.16, blk_kick: 0.05,
    pts_allow: 15, pts_allow_14_20: 1, yds_allow: 283.09 };
  const rules = { sack: 1, int: 2, fum_rec: 2, def_td: 6, blk_kick: 2, pts_allow_14_20: 1 };
  check('a defence needs nothing derived', Object.keys(wp.derivedKeys(DEF, rules)).length, 0);
  near('a defence scores off its tier indicator', wp.projectedPoints(DEF, rules), 6.77, 0.005);
  // The raw points-allowed number must not be scored unless the league says so.
  check('raw pts_allow is ignored when unscored',
    wp.projectedPoints(DEF, rules) === wp.projectedPoints({ ...DEF, pts_allow: 99 }, rules), true);
}

check('no stats means no points', wp.projectedPoints(null, LEAGUE), 0);
check('no scoring means no points', wp.projectedPoints(KICKER, null), 0);

/* ------------------------------------------------------------ out tags */

for (const tag of ['Out', 'OUT', 'IR', 'Doubtful', 'Inactive', ' out ']) {
  check(`"${tag}" means he is done`, wp.isOut(tag), true);
}
for (const tag of ['Questionable', 'Probable', '', null, undefined]) {
  check(`"${tag}" does not zero him`, wp.isOut(tag), false);
}

/* ------------------------------------------------------- the arithmetic */

const starter = (pos, proj, f) => ({ pos, proj, f });

{
  const t = wp.starterTerms(starter('QB', 20, 1));
  near('a full game of a QB is all his projection', t.mu, 20, 1e-9);
  near('and his spread is a + b*proj', t.sd, CONSTS.a.QB + CONSTS.b.QB * 20, 1e-9);
}
{
  const t = wp.starterTerms(starter('QB', 20, 0));
  check('a finished starter contributes no mean', t.mu, 0);
  check('and no spread', t.sd, 0);
}
{
  // The spread shrinks as f^(g/2) = f^0.39. The study's prose calls that
  // faster than a square root; it is slower, because an exponent under 0.5
  // keeps more at every f < 1. Asserted in the direction the arithmetic
  // actually goes, so the wrong sentence cannot creep back into the code.
  const half = wp.starterTerms(starter('WR', 10, 0.5)).sd;
  const full = wp.starterTerms(starter('WR', 10, 1)).sd;
  near('half a game leaves f^(g/2) of the spread', half / full, Math.pow(0.5, CONSTS.g / 2), 1e-9);
  check('which is MORE than a square root would leave', half / full > Math.SQRT1_2, true);
  near('0.762 of it, against a square root 0.707', half / full, 0.7624, 0.0001);
}
{
  // An empty lineup slot: Sleeper writes "0" there and the caller resolves it
  // to nothing at all.
  const t = wp.starterTerms({ pos: '', proj: 0, f: 0 });
  check('an empty slot contributes nothing', [t.mu, t.sd], [0, 0]);
  // An unknown position degrades to mean-only rather than throwing.
  const u = wp.starterTerms(starter('LB', 10, 1));
  check('an unknown position still carries its mean', u.mu, 10);
  check('but contributes no spread', u.sd, 0);
}
{
  const t = wp.starterTerms(starter('RB', -3, 1));
  check('a negative projection cannot shrink the spread below its floor',
    t.sd, CONSTS.a.RB);
  check('though its mean stays negative', t.mu, -3);
}
{
  check('f is clamped above 1', wp.starterTerms(starter('QB', 10, 4)).mu, 10);
  check('and below 0', wp.starterTerms(starter('QB', 10, -1)).mu, 0);
}

// A settled week must read 0 or 1. This is the handoff's own acceptance test:
// load a finished week and every starter has f = 0.
{
  const done = (now) => ({ now, starters: [starter('QB', 20, 0), starter('RB', 10, 0)] });
  const ahead = wp.pWin(done(100), done(90));
  check('a finished week that is won reads 1', ahead.p, 1);
  check('and says it is settled', ahead.settled, true);
  check('a finished week that is lost reads 0', wp.pWin(done(90), done(100)).p, 0);
  // A dead tie with nothing left is the only honest 50%.
  check('an exact tie with nothing left is a coin flip', wp.pWin(done(90), done(90)).p, 0.5);
}

{
  // Level scores, identical lineups, everything still to play: a coin flip.
  const side = () => ({ now: 0, starters: [starter('QB', 20, 1), starter('RB', 12, 1)] });
  const r = wp.pWin(side(), side());
  near('two identical sides at kickoff are a coin flip', r.p, 0.5, 1e-9);
  near('with no margin', r.margin, 0, 1e-9);
  near('and a projected final of their projections', r.projA, 32, 1e-9);
  check('a live week is not settled', r.settled, false);
}

{
  // `now` is taken as given and never summed from the starters: Sleeper's
  // matchup total is the truth this app uses everywhere.
  const withNow = { now: 50, starters: [starter('QB', 20, 1)] };
  const r = wp.pWin(withNow, { now: 0, starters: [starter('QB', 20, 1)] });
  near('the side totals are now plus what is still to come', r.projA, 70, 1e-9);
  check('a starter-level now field is ignored by pWin',
    wp.pWin({ now: 50, starters: [{ pos: 'QB', proj: 20, f: 1, now: 999 }] },
      { now: 0, starters: [starter('QB', 20, 1)] }).projA, 70);
}

check('a bigger lead is never less likely to hold',
  wp.pWin({ now: 20, starters: [starter('QB', 20, 1)] },
    { now: 0, starters: [starter('QB', 20, 1)] }).p
  >= wp.pWin({ now: 10, starters: [starter('QB', 20, 1)] },
    { now: 0, starters: [starter('QB', 20, 1)] }).p, true);

/* --------------------------------------------------------- matters most */

{
  // Two starters, one with his whole game left and one finished. Only the
  // first can still score, so only the first has any leverage.
  const mine = { now: 40, starters: [starter('WR', 15, 1), starter('WR', 15, 0)] };
  const theirs = { now: 40, starters: [starter('WR', 15, 1), starter('WR', 15, 1)] };

  check('a finished starter swings nothing', wp.swing(mine, theirs, 1), 0);
  check('a live starter swings something', wp.swing(mine, theirs, 0) > 0, true);
  check('an index off the end is harmless', wp.swing(mine, theirs, 9), 0);
  check('leverage is the handoff name for the same thing', wp.leverage, wp.swing);

  const board = wp.leaderboard(mine, theirs);
  check('the leaderboard ranks the live starter first', board[0].index, 0);
  check('and carries every starter', board.length, 2);
  check('a swing is never negative', board.every((r) => r.swing >= 0), true);

  // The same quantity on either side of the matchup: it answers "how much is
  // riding on this man", which is a question about him, not about who he
  // plays for.
  check('an opponent starter swings too', wp.swing(theirs, mine, 0) > 0, true);
}
{
  // The man with more still to come matters more, which is the whole point of
  // the marker.
  const mine = { now: 0, starters: [starter('RB', 20, 1), starter('RB', 4, 1)] };
  const theirs = { now: 0, starters: [starter('RB', 24, 1)] };
  check('the bigger remaining projection has the bigger swing',
    wp.swing(mine, theirs, 0) > wp.swing(mine, theirs, 1), true);
}

/* ------------------------------------------------------------- the CDF */

near('Phi(0) is a half', wp.phi(0), 0.5, 1e-9);
// 1.96 is the rounded quantile: Phi(1.96) is 0.97500210, not 0.975. The
// approximation's own error bound is 1.5e-7, so it is asserted against the
// true value rather than the textbook rounding.
near('Phi(1.96) is 0.97500210', wp.phi(1.96), 0.9750021048517796, 1e-6);
near('Phi(-1.96) mirrors it', wp.phi(-1.96), 0.0249978951482204, 1e-6);
near('and the exact 97.5th percentile lands on 0.975',
  wp.phi(1.959963984540054), 0.975, 1e-6);
near('Phi(1) is the textbook 0.8413', wp.phi(1), 0.8413447, 1e-6);
check('Phi is monotonic', wp.phi(0.5) < wp.phi(0.6), true);
check('Phi stays inside 0 and 1 far out', wp.phi(40) <= 1 && wp.phi(-40) >= 0, true);

/* ----------------------------------------------------------- the module */

// This path must not touch app state: everything above ran without a league
// connected, which is what makes the harness offline.
check('nothing here connected a league', state.sleeper.leagueId, null);

/* ----------------------------------------------------------------- report */

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
