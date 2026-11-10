// Table-driven tests for js/bets-core.js.
//
// Bet settlement is the kind of code that fails quietly: an off-by-one in a
// comparison still produces a plausible-looking number, and you only find out
// when the tracker says you won a bet you lost. So every state transition gets
// a case, including the ones books price specifically to avoid.
//
//   node tools/bets-test.mjs
//
// bets-core.js has no imports of its own, so it is loaded through a data: URL
// rather than by path. That keeps this harness independent of how the repo is
// packaged - it predates package.json and still passes without it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'bets-core.js'), 'utf8');
const B = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

let pass = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; return; }
  failures.push(`${name}\n      got  ${g}\n      want ${w}`);
}

/* ------------------------------------------------------------- fixtures */

const game = (state, extra = {}) => ({
  id: 'G1', state, date: '2026-11-08T18:00:00Z',
  home: { abbr: 'CIN', score: 0 }, away: { abbr: 'BAL', score: 0 }, ...extra,
});

// ctx stands in for the live box score. `cats` is exactly the shape
// boxscore.js builds per player.
const ctx = (cats, g) => ({
  statsFor: () => cats,
  gameFor: () => g,
});

const recYds = (y) => ({ receiving: { receptions: '3', receivingYards: String(y) } });

/* ----------------------------------------------- over / under lifecycle */

const over = { market: 'rec_yds', side: 'over', line: 39.5, cmp: 'gt', athleteId: '1', playerName: 'Ja\'Marr Chase' };

{
  const p = B.legProgress(over, ctx(recYds(26), game('in')));
  check('over, live, short', [p.state, p.needed, p.label, p.detail],
    ['open', 14, '26 / 39.5 yds', '14 yds to go']);
}
check('over, live, cleared',
  B.legProgress(over, ctx(recYds(40), game('in'))).state, 'hit');
check('over, final, cleared',
  B.legProgress(over, ctx(recYds(40), game('post'))).state, 'won');
check('over, final, short',
  B.legProgress(over, ctx(recYds(26), game('post'))).state, 'lost');
check('over, not kicked off',
  B.legProgress(over, ctx(null, game('pre'))).state, 'pending');

// A player with no box-score line in a game under way has 0, not "unknown":
// they are playing, they just have not touched the ball.
{
  const p = B.legProgress(over, ctx(null, game('in')));
  check('over, live, no stat line yet', [p.state, p.current], ['open', 0]);
}

/* --------------------------------------- "40+" means at least 40, not >40 */

const plus40 = { ...over, line: 40, cmp: 'gte' };
check('40+ with exactly 40 clears',
  B.legProgress(plus40, ctx(recYds(40), game('in'))).state, 'hit');
check('40+ with 39 does not',
  B.legProgress(plus40, ctx(recYds(39), game('in'))).state, 'open');
check('40+ from 26 needs 14',
  B.legProgress(plus40, ctx(recYds(26), game('in'))).needed, 14);

// The same 40 on a "> 40" whole-number line is a push, not a win.
const gt40 = { ...over, line: 40, cmp: 'gt' };
check('over 40 (whole line), exactly 40, final = push',
  B.legProgress(gt40, ctx(recYds(40), game('post'))).state, 'push');
check('over 40 (whole line), 41, final = won',
  B.legProgress(gt40, ctx(recYds(41), game('post'))).state, 'won');
check('over 40 (whole line) from 26 needs 15, not 14',
  B.legProgress(gt40, ctx(recYds(26), game('in'))).needed, 15);

/* ----------------------------------------------------------- the under */

const under = { ...over, side: 'under' };
{
  const p = B.legProgress(under, ctx(recYds(26), game('in')));
  check('under, live, still safe', [p.state, p.detail],
    ['open', '13.5 yds of room left']);
}
check('under, live, already exceeded',
  B.legProgress(under, ctx(recYds(40), game('in'))).state, 'busted');
check('under, final, exceeded',
  B.legProgress(under, ctx(recYds(40), game('post'))).state, 'lost');
check('under, final, stayed below',
  B.legProgress(under, ctx(recYds(26), game('post'))).state, 'won');

/* ------------------------------------------------------- anytime touchdown */

const atd = { market: 'anytime_td', side: 'yes', athleteId: '1', playerName: 'Chase' };
check('anytime TD, none yet, live',
  B.legProgress(atd, ctx({ receiving: { receivingTouchdowns: '0' } }, game('in'))).state, 'open');
check('anytime TD, scored, live',
  B.legProgress(atd, ctx({ receiving: { receivingTouchdowns: '1' } }, game('in'))).state, 'hit');
check('anytime TD, none, final',
  B.legProgress(atd, ctx({ receiving: { receivingTouchdowns: '0' } }, game('post'))).state, 'lost');
// A quarterback throwing a touchdown has not scored one.
check('anytime TD ignores passing TDs',
  B.legProgress(atd, ctx({ passing: { passingTouchdowns: '3' } }, game('in'))).state, 'open');
// A kick return counts.
check('anytime TD counts return TDs',
  B.legProgress(atd, ctx({ kickReturns: { kickReturnTouchdowns: '1' } }, game('in'))).state, 'hit');

/* ----------------------------------------------- combined-yardage markets */

check('rush + rec yards sums both',
  B.legProgress({ market: 'rush_rec_yds', side: 'over', line: 99.5, cmp: 'gt', athleteId: '1' },
    ctx({ rushing: { rushingYards: '60' }, receiving: { receivingYards: '45' } }, game('in'))).state,
  'hit');

// Missing one half must not read as zero for that half and settle early.
{
  const p = B.legProgress({ market: 'rush_rec_yds', side: 'over', line: 99.5, cmp: 'gt', athleteId: '1' },
    ctx({ receiving: { receivingYards: '45' } }, game('in')));
  check('rush + rec with only receiving', [p.state, p.current], ['open', 45]);
}

/* ----------------------------------------------------- defensive markets */

check('tackles over',
  B.legProgress({ market: 'tackles', side: 'over', line: 5.5, cmp: 'gt', athleteId: '1' },
    ctx({ defensive: { totalTackles: '6' } }, game('in'))).state, 'hit');
check('sacks, quarter line',
  B.legProgress({ market: 'sacks', side: 'over', line: 0.5, cmp: 'gt', athleteId: '1' },
    ctx({ defensive: { sacks: '1' } }, game('in'))).state, 'hit');

/* --------------------------------------------------------- game markets */

const scored = (a, h, state = 'in') => game(state, {
  home: { abbr: 'CIN', score: h }, away: { abbr: 'BAL', score: a },
});

{
  // 24 + 21 = 45, which has not cleared 47.5 - it needs 3 more.
  const p = B.legProgress({ market: 'game_total', side: 'over', line: 47.5, cmp: 'gt' },
    { statsFor: () => null, gameFor: () => scored(24, 21) });
  check('game total, over, not there yet', [p.state, p.current, p.needed], ['open', 45, 3]);
}
{
  const p = B.legProgress({ market: 'game_total', side: 'over', line: 47.5, cmp: 'gt' },
    { statsFor: () => null, gameFor: () => scored(27, 21) });
  check('game total, over, cleared', [p.state, p.current, p.needed], ['hit', 48, 0]);
}
{
  const p = B.legProgress({ market: 'game_total', side: 'under', line: 47.5, cmp: 'gt' },
    { statsFor: () => null, gameFor: () => scored(27, 21) });
  check('game total, under, blown through', p.state, 'busted');
}
check('game total, under, still safe',
  B.legProgress({ market: 'game_total', side: 'under', line: 47.5, cmp: 'gt' },
    { statsFor: () => null, gameFor: () => scored(10, 7) }).state, 'open');

{
  const p = B.legProgress({ market: 'spread', teamAbbr: 'CIN', line: -3.5 },
    { statsFor: () => null, gameFor: () => scored(17, 24) });
  check('spread, covering live', [p.state, p.detail], ['open', 'covering by 3.5']);
}
{
  const p = B.legProgress({ market: 'spread', teamAbbr: 'CIN', line: -3.5 },
    { statsFor: () => null, gameFor: () => scored(21, 24, 'post') });
  check('spread, missed by a half point', [p.state, p.detail], ['lost', 'did not cover']);
}
{
  const p = B.legProgress({ market: 'moneyline', teamAbbr: 'BAL' },
    { statsFor: () => null, gameFor: () => scored(28, 24, 'post') });
  check('moneyline won', [p.state, p.detail], ['won', 'won outright']);
}
{
  const p = B.legProgress({ market: 'team_total', teamAbbr: 'CIN', side: 'over', line: 23.5, cmp: 'gt' },
    { statsFor: () => null, gameFor: () => scored(10, 24) });
  check('team total over', [p.state, p.current], ['hit', 24]);
}

/* --------------------------------------------------------------- parlays */

const parlay = (legs) => ({ stake: 10, odds: 600, legs });
const twoLeg = [
  { market: 'rec_yds', side: 'over', line: 39.5, cmp: 'gt', athleteId: 'A' },
  { market: 'rec_yds', side: 'over', line: 39.5, cmp: 'gt', athleteId: 'B' },
];

{
  // one leg home, one still running
  const c = {
    statsFor: (id) => recYds(id === 'A' ? 55 : 10),
    gameFor: () => game('in'),
  };
  const s = B.betStatus(parlay(twoLeg), c);
  check('parlay, one leg hit, one live', [s.state, s.legsHit, s.legsTotal, s.outstanding.length],
    ['open', 1, 2, 2]);
}
{
  // one leg already dead - the parlay is gone no matter what the other does
  const c = {
    statsFor: (id) => recYds(id === 'A' ? 150 : 10),
    gameFor: (leg) => game(leg.athleteId === 'B' ? 'post' : 'in'),
  };
  const s = B.betStatus(parlay(twoLeg), c);
  check('parlay, one leg lost, kills it', [s.state, s.legsHit], ['lost', 1]);
}
{
  const c = { statsFor: () => recYds(99), gameFor: () => game('post') };
  const s = B.betStatus(parlay(twoLeg), c);
  check('parlay, all legs won', [s.state, s.returned], ['won', 70]);
}
{
  // every leg clear but nothing final: winning, not won
  const c = { statsFor: () => recYds(99), gameFor: () => game('in') };
  check('parlay, all hit but live', B.betStatus(parlay(twoLeg), c).state, 'all hit');
}
{
  // An under already blown through cannot recover, so the parlay is dead even
  // though no game has ended.
  const legs = [twoLeg[0], { ...twoLeg[1], side: 'under' }];
  const c = { statsFor: () => recYds(99), gameFor: () => game('in') };
  check('parlay with a busted under is dead', B.betStatus(parlay(legs), c).state, 'lost');
}
{
  // A single busted under is likewise lost, not merely at risk.
  const one = { stake: 10, odds: -110, legs: [{ ...twoLeg[0], side: 'under' }] };
  const c = { statsFor: () => recYds(99), gameFor: () => game('in') };
  check('single busted under is lost', B.betStatus(one, c).state, 'lost');
}
{
  // Whole points: closing a half-point deficit takes one.
  const p = B.legProgress({ market: 'spread', teamAbbr: 'CIN', line: -3.5 },
    { statsFor: () => null, gameFor: () => scored(17, 20) });
  check('spread needs whole points', [p.needed, p.detail], [1, '1 point from covering']);
}

/* ------------------------------------------------------------------ odds */

check('profit on a plus price', B.profit(10, 600), 60);
check('profit on a minus price', B.profit(110, -110), 100);
check('profit on nonsense', B.profit(10, 0), 0);
check('decimal odds, plus', Math.round(B.decimalOdds(600) * 100) / 100, 7);
check('decimal odds, minus', Math.round(B.decimalOdds(-110) * 100) / 100, 1.91);
check('parlay odds of two -110s', B.parlayOdds([-110, -110]), 264);
check('format plus', B.formatOdds(250), '+250');
check('format minus', B.formatOdds(-110), '-110');

/* ----------------------------------------------------------- descriptions */

check('describe over leg',
  B.describeLeg({ market: 'rec_yds', side: 'over', line: 39.5, cmp: 'gt', playerName: 'Ja\'Marr Chase' }),
  "Ja'Marr Chase over 39.5 receiving yards");
check('describe plus leg',
  B.describeLeg({ market: 'rush_yds', side: 'over', line: 40, cmp: 'gte', playerName: 'Chase Brown' }),
  'Chase Brown 40+ rushing yards');
check('describe anytime TD',
  B.describeLeg({ market: 'anytime_td', side: 'yes', playerName: 'Chase' }), 'Chase anytime TD');
check('describe spread',
  B.describeLeg({ market: 'spread', teamAbbr: 'CIN', line: -3.5 }), 'CIN -3.5');
check('describe total',
  B.describeLeg({ market: 'game_total', side: 'under', line: 47.5 }), 'game total under 47.5');

/* ------------------------------------------------------------ unmatched */

check('unmatched player says so',
  B.legProgress({ market: 'rec_yds', side: 'over', line: 10, athleteId: null },
    { statsFor: () => null, gameFor: () => null }).detail, 'player not matched');
check('unsupported market says so',
  B.legProgress({ market: 'who_knows', side: 'over', line: 10, athleteId: '1' },
    { statsFor: () => ({}), gameFor: () => game('in') }).detail, 'unsupported market');

/* ------------------------------------------------------- slip parsing */

// Fake resolvers: the real ones need ESPN's rosters in localStorage.
const ROSTER = [
  { athleteId: '1', name: "Ja'Marr Chase", team: 'CIN', pos: 'WR' },
  { athleteId: '2', name: 'Chase Brown', team: 'CIN', pos: 'RB' },
  { athleteId: '3', name: 'Logan Wilson', team: 'CIN', pos: 'LB' },
  { athleteId: '4', name: 'Joe Burrow', team: 'CIN', pos: 'QB' },
];
const slim = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
const R = {
  player: (name) => {
    const c = ROSTER.filter((r) => slim(r.name) === slim(name));
    return {
      athleteId: c.length === 1 ? c[0].athleteId : null,
      candidates: c,
      reason: c.length ? null : 'no player of that name',
    };
  },
  team: (t) => {
    const x = slim(t);
    if (!x) return null;
    if (x.includes('bengals') || x === 'cin') return 'CIN';
    if (x.includes('ravens') || x === 'bal') return 'BAL';
    return null;
  },
};

const legShape = (l) => [l.market, l.side, l.line, l.cmp, l.athleteId || l.teamAbbr || null];

{
  const r = B.parseSlip([
    'FanDuel',
    "Ja'Marr Chase Over 39.5 Receiving Yards",
    '+110',
    'Wager $10.00',
    'To Win $21.00',
  ].join('\n'), R);
  check('single prop: book/stake/odds', [r.book, r.stake, r.odds], ['fanduel', 10, 110]);
  check('single prop: leg', r.legs.map(legShape), [['rec_yds', 'over', 39.5, 'gt', '1']]);
  check('single prop: no warnings', r.warnings, []);
}

{
  // "40+" is at least 40, which is a different comparison from "over 40".
  const r = B.parseSlip("Ja'Marr Chase 40+ Receiving Yards -115", R);
  check('alt line uses gte', r.legs.map(legShape), [['rec_yds', 'over', 40, 'gte', '1']]);
  check('alt line inline price', r.legs[0].odds, -115);
}

{
  const r = B.parseSlip("Anytime Touchdown Scorer - Ja'Marr Chase +180", R);
  check('anytime TD leg', r.legs.map(legShape), [['anytime_td', 'yes', 1, 'gt', '1']]);
}

{
  const r = B.parseSlip([
    'DraftKings',
    'Same Game Parlay',
    'CIN @ BAL',
    "Ja'Marr Chase Over 39.5 Receiving Yards",
    'Chase Brown 40+ Rushing Yards',
    'Bengals -3.5',
    '$25.00',
    '+650',
  ].join('\n'), R);
  check('parlay: book/stake/odds', [r.book, r.stake, r.odds], ['draftkings', 25, 650]);
  check('parlay: three legs', r.legs.map(legShape), [
    ['rec_yds', 'over', 39.5, 'gt', '1'],
    ['rush_yds', 'over', 40, 'gte', '2'],
    ['spread', 'over', -3.5, 'gt', 'CIN'],
  ]);
  check('parlay: nothing unparsed', r.warnings, []);
}

// Receptions must not be read as receiving yards.
check('receptions, not yards',
  B.parseSlip('Ja\'Marr Chase Over 5.5 Receptions', R).legs.map((l) => l.market), ['rec']);
check('receiving yards, not receptions',
  B.parseSlip('Ja\'Marr Chase Over 59.5 Receiving Yards', R).legs.map((l) => l.market), ['rec_yds']);
check('rush + rec combined',
  B.parseSlip('Chase Brown Over 99.5 Rushing + Receiving Yards', R).legs.map((l) => l.market), ['rush_rec_yds']);
check('tackles + assists',
  B.parseSlip('Logan Wilson Over 7.5 Tackles + Assists', R).legs.map((l) => l.market), ['tackles']);
check('passing yards',
  B.parseSlip('Joe Burrow Over 249.5 Passing Yards', R).legs.map((l) => l.market), ['pass_yds']);
check('game total',
  B.parseSlip('Over 47.5 Total Points -105', R).legs.map(legShape),
  [['game_total', 'over', 47.5, 'gt', null]]);
check('under sticks',
  B.parseSlip('Under 47.5 Total Points', R).legs.map((l) => l.side), ['under']);

// A bare team and a small number is a spread; a bare team and a price is a
// moneyline. Telling them apart is the whole trick.
check('bare spread', B.parseSlip('Bengals -3.5', R).legs.map(legShape),
  [['spread', 'over', -3.5, 'gt', 'CIN']]);
check('bare moneyline', B.parseSlip('Bengals -140', R).legs.map((l) => [l.market, l.teamAbbr, l.odds]),
  [['moneyline', 'CIN', -140]]);

{
  // An unknown player must be flagged, not silently attached to nobody.
  const r = B.parseSlip('Some Guy Over 39.5 Receiving Yards', R);
  check('unknown player is flagged',
    [r.legs[0].athleteId, r.legs[0].unresolved], [null, 'no player of that name']);
}

{
  const r = B.parseSlip(['Bet Slip', 'Cash Out', 'wat 123 wat'].join('\n'), R);
  check('nothing recognised', [r.legs.length, r.warnings.length > 0], [0, true]);
  check('says so first', r.warnings[0], 'No legs recognised. Add them by hand below.');
}

{
  // Odds derived from stake and payout when the slip prints no price.
  const r = B.parseSlip(['Bengals -3.5', 'Wager $10.00', 'To Win $30.00'].join('\n'), R);
  check('odds inferred from payout', r.odds, 200);
}

/* ------------------------------------------------- frozen settlement */

// The bug these cover: legProgress resolves legs against the CURRENT
// scoreboard, so once the week rolls over the game is gone, every leg reads
// 'unknown', and a decided bet reads 'open' again - forever.

const bet = (legs, extra = {}) => ({
  v: 1, id: 'B1', stake: 10, odds: -110, legs, ...extra,
});

const recLeg = (over) => ({
  id: 'L1', market: 'rec_yds', side: over, line: 39.5, cmp: 'gt',
  athleteId: '1', playerName: 'A Receiver',
});

// A scoreboard that has rolled past the week: no game matches any more.
const gone = (cats) => ({ statsFor: () => cats, gameFor: () => null });

{
  const b = bet([recLeg('over')]);
  const live = B.betStatus(b, ctx(recYds(55), game('post')));
  check('won before freezing', live.state, 'won');
  check('a decided bet is freezable', B.freezable(b, live), true);

  b.settled = B.snapshot(b, live, 1762600000000);
  const after = B.betStatus(b, gone(null));
  check('still won once the week rolls over', after.state, 'won');
  check('frozen status says so', [after.frozen, after.settledAt], [true, 1762600000000]);
  check('return survives', after.returned, 10 + B.profit(10, -110));
  check('leg detail survives', after.legs[0].prog.detail, 'cleared');
  check('leg progress survives', after.legs[0].prog.label, live.legs[0].prog.label);
  check('nothing outstanding', after.legs[0].prog.state, 'won');
  check('already frozen is not freezable again', B.freezable(b, after), false);
}

{
  // Without the freeze this is the actual regression: open, with the stake
  // counted as live exposure again.
  const b = bet([recLeg('over')]);
  check('unfrozen bet rots to open', B.betStatus(b, gone(null)).state, 'open');
}

{
  const b = bet([recLeg('over')]);
  const mid = B.betStatus(b, ctx(recYds(55), game('in')));
  check('hit but live', mid.state, 'all hit');
  check('a live bet does not freeze', B.freezable(b, mid), false);
}

{
  // An under already past its line is arithmetically dead, but ESPN still
  // revises stat lines, so it waits for the whistle.
  const b = bet([recLeg('under')]);
  const busted = B.betStatus(b, ctx(recYds(80), game('in')));
  check('busted under reads lost', busted.state, 'lost');
  check('busted mid-game does not freeze', B.freezable(b, busted), false);
  const final = B.betStatus(b, ctx(recYds(80), game('post')));
  check('busted under freezes once final', B.freezable(b, final), true);
}

{
  // A parlay cannot recover, so one dead leg in a finished game decides it
  // even while the other game is still running.
  const dead = { ...recLeg('over'), id: 'L1', line: 200.5 };
  const other = { ...recLeg('over'), id: 'L2' };
  const b = bet([dead, other]);
  const mixed = {
    statsFor: () => recYds(40),
    gameFor: (leg) => game(leg.id === 'L1' ? 'post' : 'in'),
  };
  const st = B.betStatus(b, mixed);
  check('parlay with a dead leg is lost', st.state, 'lost');
  check('lost parlay freezes on the dead leg', B.freezable(b, st), true);
  b.settled = B.snapshot(b, st);
  check('lost parlay stays lost', B.betStatus(b, gone(null)).state, 'lost');
  check('lost returns nothing', B.betStatus(b, gone(null)).returned, 0);
}

{
  // A win needs every game home - one still running means no freeze.
  const b = bet([{ ...recLeg('over'), id: 'L1' }, { ...recLeg('over'), id: 'L2' }]);
  const half = {
    statsFor: () => recYds(55),
    gameFor: (leg) => game(leg.id === 'L1' ? 'post' : 'in'),
  };
  check('half-finished parlay does not freeze', B.freezable(b, B.betStatus(b, half)), false);
}

{
  // An unmatched leg has no game, so there is nothing to be sure about.
  const b = bet([{ id: 'L1', market: 'rec_yds', side: 'over', line: 39.5 }]);
  const st = B.betStatus(b, gone(null));
  check('unmatched leg stays open', st.state, 'open');
  check('unmatched leg never freezes', B.freezable(b, st), false);
}

{
  const b = bet([]);
  check('a bet with no legs never freezes', B.freezable(b, B.betStatus(b, gone(null))), false);
}

{
  // A snapshot missing a leg must not invent progress for it.
  const b = bet([recLeg('over')]);
  const live = B.betStatus(b, ctx(recYds(55), game('post')));
  b.settled = { ...B.snapshot(b, live), legs: [] };
  const after = B.betStatus(b, gone(null));
  check('missing snapshot leg reads unknown', after.legs[0].prog.state, 'unknown');
  check('and says why', after.legs[0].prog.detail, 'not recorded');
}

/* ----------------------------------------------------------------- report */

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
