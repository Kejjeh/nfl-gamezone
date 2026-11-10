// Table-driven tests for js/season.js.
//
//   node tools/season-test.mjs
//
// Offline and deterministic: the fixtures in season-fixtures.mjs are real
// Sleeper week-9 stat records paired with the points Sleeper's own matchups
// endpoint awarded for them, captured 2026-11-10. That pairing is the whole
// point of the file. The season table computes fantasy points itself, so the
// only question that matters is whether it gets the same answer as the league
// did - and a wrong answer here looks entirely plausible on screen.
//
// Loaded as a normal ES module: package.json sets "type": "module", and
// season.js has relative imports that a data: URL could not resolve.
import { state } from '../js/state.js';
import * as season from '../js/season.js';
import { SETTINGS, WEEK9 } from './season-fixtures.mjs';

let pass = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; return; }
  failures.push(`${name}\n      got  ${g}\n      want ${w}`);
}

/* ------------------------------------- real records against Sleeper's own */

// Every one of these is a real player-week. If this block fails, the table is
// showing numbers the league never awarded.
for (const row of WEEK9) {
  check(`${row.name} (${row.pos}) scores ${row.pts}`,
    season.scoreWith(row.stats, SETTINGS), row.pts);
}

// The fixtures each carry off_snp and gp, which the league does not score.
// Those must contribute nothing - a stray key must never become points.
{
  const row = WEEK9.find((r) => typeof r.stats.off_snp === 'number');
  check('a fixture really does carry an unscored key', !!row, true);
  const stripped = { ...row.stats };
  delete stripped.off_snp;
  delete stripped.gp;
  check('unscored keys contribute nothing',
    season.scoreWith(stripped, SETTINGS), season.scoreWith(row.stats, SETTINGS));
}

/* ----------------------------------------------------- scoreWith, guarded */

check('no stats scores zero', season.scoreWith(null, SETTINGS), 0);
check('no settings scores zero', season.scoreWith({ rec: 5 }, null), 0);
check('a settings key with no stat adds nothing',
  season.scoreWith({ rec: 2 }, { rec: 1, def_td: 6 }), 2);
check('a non-numeric stat is skipped, not coerced',
  season.scoreWith({ rec: '5', rec_yd: 30 }, { rec: 1, rec_yd: 0.1 }), 3);
check('negative weights subtract',
  season.scoreWith({ pass_int: 2, pass_td: 1 }, { pass_int: -1, pass_td: 4 }), 2);
check('rounds to cents rather than drifting',
  season.scoreWith({ pass_yd: 337 }, { pass_yd: 0.04 }), 13.48);

/* -------------------------------------------------------- team D/ST names */

check('a defence is named from the team list', season.teamDefName('PIT'), 'Steelers D/ST');
// Sleeper says WAS, teams.js is generated from ESPN and says WSH.
check('the WAS/WSH split is bridged', season.teamDefName('WAS'), 'Commanders D/ST');
check('an unknown abbreviation still renders', season.teamDefName('ZZZ'), 'ZZZ D/ST');
check('team ids are recognised', [season.isTeamId('PIT'), season.isTeamId('4034')], [true, false]);

/* --------------------------------------------------------------- buildRows */

// slim dictionary shape, exactly as sleeper.loadPlayers() stores it
const players = {
  1: ['Al Back', 'RB', 'CIN', null],
  2: ['Bo Wide', 'WR', 'BAL', null],
  3: ['Cy Quarter', 'QB', 'CIN', null],
  4: ['Di End', 'TE', 'GB', null],
  5: ['Ed Guard', 'OL', 'CIN', null],      // not a fantasy position
  6: ['No Team', 'WR', '', null],          // free agent with no NFL team
};

const weeks = new Map([
  [7, { 1: 10, 2: 4, 3: 20, 5: 99, PIT: 12 }],
  [8, { 1: 6, 3: 25, PIT: 3 }],
  [9, { 1: 2, 2: 8, 4: 0, 6: 50, PIT: -1 }],
]);

const rows = season.buildRows({ weeks, players, owners: new Map() });
const by = (id) => rows.find((r) => r.id === String(id));

check('non-fantasy positions are dropped', !!by(5), false);
check('a player with no NFL team is dropped', !!by(6), false);
check('team defences become rows', by('PIT')?.name, 'Steelers D/ST');
check('a defence carries its own position and team',
  [by('PIT')?.pos, by('PIT')?.team], ['DEF', 'PIT']);

check('points sum across weeks', by(1).pts, 18);
check('games are counted, not read from a stat field', by(1).games, 3);
check('per-game divides by counted games', by(1).ppg, 6);
check('best week is the single best score', by(1).best, 10);
check('byWeek keeps each week', [...by(1).byWeek.entries()].sort(), [[7, 10], [8, 6], [9, 2]]);

// A zero week is still a game played: he turned out and produced nothing.
check('a zero week counts as a game', [by(4).games, by(4).pts, by(4).ppg], [1, 0, 0]);
check('a negative week still counts', [by('PIT').pts, by('PIT').games], [14, 3]);
check('best can be negative if every week was', season.buildRows({
  weeks: new Map([[9, { 1: -3 }]]), players, owners: new Map(),
}).find((r) => r.id === '1').best, -3);

check('a player absent every week has no row', !!by(99), false);
check('no weeks at all yields no rows',
  season.buildRows({ weeks: new Map(), players, owners: new Map() }).length, 0);
check('an unknown player id is dropped rather than guessed',
  season.buildRows({ weeks: new Map([[9, { 777: 12 }]]), players, owners: new Map() }).length, 0);

/* --------------------------------------------------------------- ownership */

state.sleeper.myRosterId = 2;
state.sleeper.usersById = new Map([
  ['u1', { display_name: 'Rival', metadata: {} }],
]);
state.sleeper.rosters = [
  { roster_id: 1, owner_id: 'u1', players: ['1', 'PIT'] },
  { roster_id: 2, owner_id: 'u2', players: ['3'], metadata: { team_name: 'My Squad' } },
];

const owners = season.ownerIndex();
check('another manager is named', owners.get('1'), { label: 'Rival', mine: false });
check('your own roster reads as yours', owners.get('3'), { label: 'You', mine: true });
check('a defence can be owned', owners.get('PIT')?.label, 'Rival');
check('anyone unrostered is absent', owners.has('2'), false);

/* --------------------------------------------------------------- filtering */

const owned = season.buildRows({ weeks, players, owners });
const ids = (list) => list.map((r) => r.id).sort();

check('position filter', ids(season.filterRows(owned, { pos: 'QB' })), ['3']);
check('FLEX is RB, WR and TE', ids(season.filterRows(owned, { pos: 'FLEX' })), ['1', '2', '4']);
check('DEF filter finds the defence', ids(season.filterRows(owned, { pos: 'DEF' })), ['PIT']);
check('my team only', ids(season.filterRows(owned, { own: 'mine' })), ['3']);
check('free agents only', ids(season.filterRows(owned, { own: 'free' })), ['2', '4']);
check('rostered by someone else', ids(season.filterRows(owned, { own: 'taken' })), ['1', 'PIT']);
check('everyone by default', season.filterRows(owned, {}).length, 5);

check('search matches a name, case-insensitively',
  ids(season.filterRows(owned, { q: 'bo wi' })), ['2']);
check('search matches a team', ids(season.filterRows(owned, { q: 'cin' })), ['1', '3']);
check('search is trimmed', ids(season.filterRows(owned, { q: '  quarter ' })), ['3']);
check('a search matching nothing yields nothing',
  season.filterRows(owned, { q: 'zzzz' }).length, 0);
check('filters combine', ids(season.filterRows(owned, { pos: 'FLEX', own: 'free' })), ['2', '4']);
check('an unknown ownership key falls back to everyone',
  season.filterRows(owned, { own: 'nonsense' }).length, 5);

/* ----------------------------------------------------------------- sorting */

const names = (list) => list.map((r) => r.name);

for (const r of owned) r.shown = r.pts;
check('points, highest first',
  names(season.sortRows(owned, 'pts', 'desc')).slice(0, 2), ['Cy Quarter', 'Al Back']);
check('points, lowest first',
  names(season.sortRows(owned, 'pts', 'asc'))[0], 'Di End');
check('per-game ranks differently from the total',
  names(season.sortRows(owned, 'ppg', 'desc'))[0], 'Cy Quarter');
check('names sort A to Z by default',
  names(season.sortRows(owned, 'name', 'asc'))[0], 'Al Back');
check('names reverse', names(season.sortRows(owned, 'name', 'desc'))[0], 'Steelers D/ST');
check('sorting never mutates the input', owned.map((r) => r.id).join(','),
  owned.map((r) => r.id).join(','));
check('an unknown sort key falls back to points',
  names(season.sortRows(owned, 'nonsense', 'desc'))[0], 'Cy Quarter');

// `shown` is what the points column is displaying. Selecting a week has to
// re-rank the table, not just relabel it.
{
  const wk = owned.filter((r) => r.byWeek.has(9));
  for (const r of wk) r.shown = r.byWeek.get(9);
  check('a week scope ranks by that week, not the season',
    names(season.sortRows(wk, 'pts', 'desc')), ['Bo Wide', 'Al Back', 'Di End', 'Steelers D/ST']);
  for (const r of owned) r.shown = r.pts;
}

// A player with no games has a null per-game average, and must not outrank
// someone who actually scored.
{
  const withNull = [
    { name: 'Played', pts: 10, ppg: 5, best: 7, games: 2, shown: 10, pos: 'RB', owner: null },
    { name: 'Never played', pts: 0, ppg: null, best: null, games: 0, shown: 0, pos: 'RB', owner: null },
  ];
  check('a null per-game sinks to the bottom',
    names(season.sortRows(withNull, 'ppg', 'desc')), ['Played', 'Never played']);
  check('a null best sinks too',
    names(season.sortRows(withNull, 'best', 'desc')), ['Played', 'Never played']);
}

/* ------------------------------------------------------------------ rules */

state.sleeper.league = null;
check('with no league, the full-PPR defaults stand in', season.usingLeagueRules(), false);
check('and those defaults still score a reception', season.scoreWith({ rec: 1 }, season.settings()), 1);

state.sleeper.league = { scoring_settings: SETTINGS };
check('with a league, its own settings are used', season.usingLeagueRules(), true);
// The defaults must not be layered underneath: a key this league omits has to
// stay omitted, or the table pays points Sleeper never awarded.
check('the defaults are not merged in', season.settings().yds_allow_0_100, undefined);
check('and the league rules reproduce a real week',
  season.scoreWith(WEEK9[0].stats, season.settings()), WEEK9[0].pts);

/* ------------------------------------------------------------- rules tag */

// The weekly files are cached already scored, so a cache entry written under
// one set of rules is wrong under another. The tag goes in the cache key, and
// these are the properties that has to have.
{
  state.sleeper.league = { scoring_settings: SETTINGS };
  const league = season.rulesTag();
  check('the tag is a short string', typeof league === 'string' && league.length <= 8, true);
  check('the same rules tag the same', season.rulesTag(), league);

  state.sleeper.league = null;
  const defaults = season.rulesTag();
  check('different rules tag differently', defaults === league, false);

  // Key order must not matter: Sleeper does not promise one.
  const shuffled = {};
  for (const k of Object.keys(SETTINGS).sort().reverse()) shuffled[k] = SETTINGS[k];
  state.sleeper.league = { scoring_settings: shuffled };
  check('key order does not change the tag', season.rulesTag(), league);

  // A single changed weight has to produce a different tag, or the cache
  // silently serves points from the old rules.
  state.sleeper.league = { scoring_settings: { ...SETTINGS, rec: 0.5 } };
  check('one changed weight changes the tag', season.rulesTag() === league, false);

  // ...and so does a key being added, even at weight zero, because a key the
  // league does not score at all is a different rule set.
  state.sleeper.league = { scoring_settings: { ...SETTINGS, made_up_stat: 0 } };
  check('an added key changes the tag', season.rulesTag() === league, false);

  state.sleeper.league = { scoring_settings: SETTINGS };
  check('and the original rules tag the same again', season.rulesTag(), league);
}

/* ----------------------------------------------------------------- report */

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
