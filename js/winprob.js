// Live fantasy win probability.
//
// Pure functions: no DOM, no fetch, no state. Everything here takes its inputs
// as arguments so `tools/winprob-test.mjs` can run the whole model offline
// against the held-out fixtures that came with the calibration.
//
// The model, fitted and tested in Kejjeh/gridiron (see `js/winprob-consts.js`
// for the numbers and what they are worth):
//
//   for each starter i on each side
//     f    = share of his game still to play
//     mu   = proj * f                     points still to come
//     sd   = f^(g/2) * (a[pos] + b[pos] * proj)
//
//   P(A wins) = Phi( (nowA - nowB + sum muA - sum muB) / (k * sqrt(sum sd^2)) )
//
// `now` is Sleeper's own live total and is never recomputed here - the same
// rule the matchup strip already follows. This module only ever adds what is
// still to come.
import { scoreWith } from './season.js';
import { CONSTS, OT_FRACTION, OUT_TAGS } from './winprob-consts.js';

const QUARTER_SECONDS = 900;
const REGULATION_SECONDS = 3600;

/* ------------------------------------------------------------ the clock */

// ESPN's displayClock is usually "M:SS", but under a minute some feeds send
// tenths ("43.2"). Anything else is a missing clock, not a zero one - see
// remainingFraction.
export function clockSeconds(display) {
  if (display == null) return null;
  const s = String(display).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    const mm = Number(m), ss = Number(sec);
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
    return mm * 60 + ss;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// How much of a starter's game is still to play, 0..1.
//
// No game at all is 0, not 1: a player on a bye, an empty lineup slot, or
// anyone the scoreboard does not carry will score nothing this week, and
// treating him as a full game still to come would invent points on his side.
export function remainingFraction(game) {
  if (!game) return 0;
  if (game.state === 'pre') return 1;
  if (game.state !== 'in') return 0;           // post, or anything unexpected

  const period = Number(game.period);
  // Live with no period yet means the kickoff has just happened.
  if (!Number.isFinite(period) || period < 1) return 1;
  // Overtime: regulation is spent, so only a stub is left.
  if (period > 4) return OT_FRACTION;

  // A live game with an unreadable clock still has at least the rest of its
  // own quarter to run, so assume the quarter just started rather than
  // dropping the player to zero. Degrade, never throw - ESPN has sent
  // isRedZone with a null downDistanceText before now.
  const secs = clockSeconds(game.clock) ?? QUARTER_SECONDS;
  const left = (4 - period) * QUARTER_SECONDS + secs;
  return Math.min(1, Math.max(0, left / REGULATION_SECONDS));
}

/* ------------------------------------------------- projections -> points */

// Keys a league scores that Sleeper's *projection* rows do not carry, and
// what to build them from. Both were measured against the live endpoint on
// 2026-11-15 (week 9, 3,305 rows):
//
//   fgmiss      projections split misses by distance (fgmiss_30_39, ...) and
//               carry no plain fgmiss; the weekly stats files carry both.
//   fgm_50_59   projections carry one 50-plus band, fgm_50p, and no
//               fgm_50_59 or fgm_60p; the stats files carry both.
//
// The second one is not in the handoff and is the larger of the two. Scoring
// the 30 real week-9 kicker projections against Sleeper's own pts_std:
// without this mapping the mean error is 1.43 points and the worst 2.32; with
// it, 0.016 and 0.050, which is Sleeper's own two-decimal rounding. A plain
// dot product silently under-projects every kicker by about a point and a
// half, and a kicker is a tenth of a lineup.
//
// Each alias applies only if the league actually scores the target key and
// the row does not already carry it, so a league that scores none of these is
// untouched.
const ALIASES = [
  { target: 'fgmiss', from: /^fgmiss_/ },
  // 60-plus field goals are a rounding error against 50-59 (and the two bands
  // are worth 5 and 6 in every preset), so the whole 50-plus band is credited
  // to fgm_50_59 rather than split on a guess.
  { target: 'fgm_50_59', from: /^fgm_50p$/ },
];

// Sum every projection key the alias matches. Exported so the test can assert
// the derivation directly rather than only through a score.
export function derivedKeys(stats, scoring) {
  const out = {};
  if (!stats || !scoring) return out;
  for (const { target, from } of ALIASES) {
    if (!(target in scoring)) continue;        // this league does not score it
    if (typeof stats[target] === 'number') continue;   // already supplied
    let sum = 0, found = false;
    for (const key in stats) {
      if (!from.test(key)) continue;
      const v = stats[key];
      if (typeof v !== 'number') continue;
      sum += v;
      found = true;
    }
    if (found) out[target] = sum;
  }
  return out;
}

// A projection row scored under the league's own settings. Same dot product
// as the season table (`season.scoreWith`), so there is one scoring
// implementation in this repo, not two - plus the derived keys above.
export function projectedPoints(stats, scoring) {
  if (!stats || !scoring) return 0;
  const derived = derivedKeys(stats, scoring);
  return scoreWith(Object.keys(derived).length ? { ...stats, ...derived } : stats, scoring);
}

// Sleeper's injury_status, if it says this player is done for the week.
// Questionable and Probable are deliberately not here: those players mostly
// play, and zeroing them would be a bigger error than leaving them alone.
export function isOut(tag) {
  if (!tag) return false;
  return OUT_TAGS.includes(String(tag).trim().toLowerCase());
}

/* ------------------------------------------------------------ the model */

// Abramowitz & Stegun 7.1.26. Maximum error 1.5e-7, which is four orders
// below the +/-0.0005 the fixtures are checked to, and it costs no dependency.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-z * z));
}

export const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// One starter's contribution: the points still to come and their spread.
// An unknown position contributes mean but no spread rather than throwing -
// if Sleeper ever adds a slot this does not know, the number degrades instead
// of the panel disappearing.
export function starterTerms(starter, consts = CONSTS) {
  const f = Math.min(1, Math.max(0, Number(starter?.f) || 0));
  const proj = Number(starter?.proj) || 0;
  const a = consts.a[starter?.pos] ?? 0;
  const b = consts.b[starter?.pos] ?? 0;
  const sd = Math.pow(f, consts.g / 2) * (a + b * Math.max(proj, 0));
  return { mu: proj * f, sd };
}

// A side's totals. `now` is passed in, never summed from the starters:
// Sleeper's matchup `points` is the truth this app has always used, and it
// includes anything a starter-by-starter sum would miss.
export function sideTerms(side, consts = CONSTS) {
  let mu = 0, variance = 0;
  for (const s of side?.starters || []) {
    const t = starterTerms(s, consts);
    mu += t.mu;
    variance += t.sd * t.sd;
  }
  return { now: Number(side?.now) || 0, mu, variance };
}

// P(side A wins), plus the pieces the UI wants to show.
//
// With nothing left to play the spread is zero and the normal CDF is
// undefined, so the result is the settled one: whoever is ahead has won. A
// finished week must read 0 or 1, never 50%.
export function pWin(sideA, sideB, consts = CONSTS) {
  const A = sideTerms(sideA, consts);
  const B = sideTerms(sideB, consts);
  const margin = (A.now - B.now) + (A.mu - B.mu);
  const sd = consts.k * Math.sqrt(A.variance + B.variance);
  const p = sd > 0 ? phi(margin / sd) : (margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
  return {
    p,
    margin,
    sd,
    muA: A.mu,
    muB: B.mu,
    projA: A.now + A.mu,
    projB: B.now + B.mu,
    settled: sd === 0,
  };
}

/* ---------------------------------------------------------- matters most */

// How much one starter still swings the matchup: P(win) if he delivers his
// whole remaining projection, minus P(win) if he delivers nothing.
//
// The handoff writes this as P(win | +10 for him) - P(win), and that does not
// work in this model. P depends on the two side totals and on the spread; a
// flat +10 on the side total is the same number whoever scored it, so every
// starter would tie. The model only tells starters apart through what each
// still has to come, so the question it can actually answer is "how much is
// still riding on this man" - his own best case against his own worst case.
//
// Both branches take his spread off the board, because either way his game is
// decided; what is left is the gap his points make. A starter with nothing
// left to play swings nothing, which is why a finished lineup has no marker.
//
// Always >= 0, and on the same scale for either side, so the opponent's
// starters can be ranked the same way.
export function swing(side, other, index, consts = CONSTS) {
  const starters = side?.starters || [];
  const s = starters[index];
  if (!s || !(Number(s.f) > 0)) return 0;

  const now = Number(side.now) || 0;
  const settled = starters.map((x, i) => (i === index ? { ...x, f: 0 } : x));
  const { mu } = starterTerms(s, consts);

  const hit = pWin({ now: now + mu, starters: settled }, other, consts).p;
  const bust = pWin({ now, starters: settled }, other, consts).p;
  return hit - bust;
}

// Kept as the handoff's name for the same quantity.
export const leverage = swing;

// Every starter's swing, biggest first, carrying the index back so the caller
// can mark the right row.
export function leaderboard(side, other, consts = CONSTS) {
  return (side?.starters || [])
    .map((s, i) => ({ index: i, pos: s.pos, swing: swing(side, other, i, consts) }))
    .sort((x, y) => y.swing - x.swing);
}
