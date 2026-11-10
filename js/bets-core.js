// Bet markets, progress and settlement. Pure functions, no browser APIs.
//
// This module is imported by the site AND bundled into the Cloudflare Worker
// that sends push notifications, so the phone and the browser can never
// disagree about whether a leg has hit. Nothing in here may touch the DOM,
// localStorage, fetch or state.js.
//
// Where the numbers come from: ESPN's box score, already flattened per player
// by boxscore.js into `cats` - a map of category name to that player's stat
// line, e.g. { receiving: { receptions: '7', receivingYards: '155', ... } }.
//
// One field is deliberately never read. Across 718 box-score rows measured on
// a full slate, 17 had a `passing` category with 8 keys but only 7 values, so
// the trailing adjQBR/QBRating pair is silently shifted. The first six keys -
// which is every passing market anyone bets - always align.

/* ------------------------------------------------------------------ atoms */

const num = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ESPN packs some stats as "made/attempts" or "sacks-yards".
const part = (v, i, sep = '/') => {
  if (v == null) return null;
  return num(String(v).split(sep)[i]);
};

// Sum that stays null when nothing is known, so "no data yet" and "zero" do
// not get confused - a 0 renders as real progress, a null renders as waiting.
const sum = (...vals) => {
  const known = vals.filter((v) => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/* ---------------------------------------------------------------- markets */

// read(cats) -> number | null.  binary markets resolve on >= 1 rather than a line.
export const MARKETS = {
  // passing
  pass_yds:    { label: 'passing yards',     unit: 'yds',    read: (c) => num(c.passing?.passingYards) },
  pass_tds:    { label: 'passing TDs',       unit: 'TD',     read: (c) => num(c.passing?.passingTouchdowns) },
  pass_comp:   { label: 'completions',       unit: 'comp',   read: (c) => part(c.passing?.['completions/passingAttempts'], 0) },
  pass_att:    { label: 'pass attempts',     unit: 'att',    read: (c) => part(c.passing?.['completions/passingAttempts'], 1) },
  pass_int:    { label: 'interceptions',     unit: 'INT',    read: (c) => num(c.passing?.interceptions) },
  sacks_taken: { label: 'sacks taken',       unit: 'sack',   read: (c) => part(c.passing?.['sacks-sackYardsLost'], 0, '-') },

  // rushing
  rush_yds:    { label: 'rushing yards',     unit: 'yds',    read: (c) => num(c.rushing?.rushingYards) },
  rush_att:    { label: 'carries',           unit: 'car',    read: (c) => num(c.rushing?.rushingAttempts) },
  rush_tds:    { label: 'rushing TDs',       unit: 'TD',     read: (c) => num(c.rushing?.rushingTouchdowns) },
  rush_long:   { label: 'longest rush',      unit: 'yds',    read: (c) => num(c.rushing?.longRushing) },

  // receiving
  rec:         { label: 'receptions',        unit: 'rec',    read: (c) => num(c.receiving?.receptions) },
  rec_yds:     { label: 'receiving yards',   unit: 'yds',    read: (c) => num(c.receiving?.receivingYards) },
  rec_tds:     { label: 'receiving TDs',     unit: 'TD',     read: (c) => num(c.receiving?.receivingTouchdowns) },
  rec_long:    { label: 'longest reception', unit: 'yds',    read: (c) => num(c.receiving?.longReception) },
  targets:     { label: 'targets',           unit: 'tgt',    read: (c) => num(c.receiving?.receivingTargets) },

  // the combined markets both books offer
  rush_rec_yds: {
    label: 'rush + rec yards', unit: 'yds',
    read: (c) => sum(num(c.rushing?.rushingYards), num(c.receiving?.receivingYards)),
  },
  pass_rush_yds: {
    label: 'pass + rush yards', unit: 'yds',
    read: (c) => sum(num(c.passing?.passingYards), num(c.rushing?.rushingYards)),
  },

  // A thrown touchdown is not a scored one, so passingTouchdowns is excluded.
  anytime_td: {
    label: 'anytime TD', unit: 'TD', binary: true,
    read: (c) => sum(
      num(c.rushing?.rushingTouchdowns),
      num(c.receiving?.receivingTouchdowns),
      num(c.kickReturns?.kickReturnTouchdowns),
      num(c.puntReturns?.puntReturnTouchdowns),
      num(c.defensive?.defensiveTouchdowns),
      num(c.interceptions?.interceptionTouchdowns),
    ),
  },

  // defence
  tackles:      { label: 'tackles',         unit: 'tkl',  read: (c) => num(c.defensive?.totalTackles) },
  solo_tackles: { label: 'solo tackles',    unit: 'tkl',  read: (c) => num(c.defensive?.soloTackles) },
  sacks:        { label: 'sacks',           unit: 'sack', read: (c) => num(c.defensive?.sacks) },
  tfl:          { label: 'tackles for loss', unit: 'TFL', read: (c) => num(c.defensive?.tacklesForLoss) },
  pass_def:     { label: 'passes defended', unit: 'PD',   read: (c) => num(c.defensive?.passesDefended) },
  def_int:      { label: 'interceptions',   unit: 'INT',  read: (c) => num(c.interceptions?.interceptions) },

  // kicking
  kick_pts:  { label: 'kicking points',  unit: 'pts', read: (c) => num(c.kicking?.totalKickingPoints) },
  fg_made:   { label: 'field goals made', unit: 'FG', read: (c) => part(c.kicking?.['fieldGoalsMade/fieldGoalAttempts'], 0) },
  fg_long:   { label: 'longest FG',      unit: 'yds', read: (c) => num(c.kicking?.longFieldGoalMade) },

  // returns
  return_yds: {
    label: 'return yards', unit: 'yds',
    read: (c) => sum(num(c.kickReturns?.kickReturnYards), num(c.puntReturns?.puntReturnYards)),
  },
};

// Markets keyed on a game rather than a player.
export const GAME_MARKETS = {
  game_total: { label: 'game total', unit: 'pts' },
  team_total: { label: 'team total', unit: 'pts' },
  spread:     { label: 'spread',     unit: 'pts' },
  moneyline:  { label: 'moneyline',  unit: '' },
};

export const isGameMarket = (market) => Object.prototype.hasOwnProperty.call(GAME_MARKETS, market);

export function marketLabel(market) {
  return MARKETS[market]?.label || GAME_MARKETS[market]?.label || market;
}

export function marketUnit(market) {
  return MARKETS[market]?.unit ?? GAME_MARKETS[market]?.unit ?? '';
}

/* ------------------------------------------------------------- comparison */

// Books write the same leg two ways: "40+ Receiving Yards" means at least 40,
// "Over 39.5" means more than 39.5. Identical for integers, different for a
// whole-number line, so which comparison was meant is stored on the leg.
function clears(current, line, cmp) {
  return cmp === 'gte' ? current >= line : current > line;
}

// How much more is needed to clear the line. "Over 39.5" from 26 needs 14, not
// 13.5, so this rounds the way a bettor counts.
function shortfall(current, line, cmp) {
  if (clears(current, line, cmp)) return 0;
  const target = cmp === 'gte' ? line
    : Number.isInteger(line) ? line + 1
    : Math.ceil(line);
  return Math.max(0, target - current);
}

/* -------------------------------------------------------------- progress */

// States, in the order a bettor cares about:
//   won / lost / push   - the game is final, this is settled
//   hit                 - past the line, game still going (books settle later)
//   busted              - an under that has already been exceeded
//   open                - live and undecided
//   pending             - the game has not kicked off
//   unknown             - no player or game matched; nothing can be said
export function legProgress(leg, ctx) {
  if (isGameMarket(leg.market)) return gameLegProgress(leg, ctx);

  const cats = leg.athleteId ? ctx.statsFor(leg.athleteId) : null;
  const game = ctx.gameFor(leg);
  const def = MARKETS[leg.market];

  if (!def) return bare('unknown', 'unsupported market');
  if (!game) return bare('unknown', leg.athleteId ? 'no game found' : 'player not matched');

  if (game.state === 'pre') {
    return { ...bare('pending', kickoffLabel(game)), line: leg.line, current: null, game };
  }
  if (!cats) {
    // The game is on but this player has no line yet - they have not touched
    // the ball. That is 0, not "unknown".
    return resolve(leg, 0, game, def);
  }
  const current = def.read(cats);
  return resolve(leg, current == null ? 0 : current, game, def);
}

function resolve(leg, current, game, def) {
  const final = game.state === 'post';
  const binary = !!def.binary;
  const line = binary ? 1 : Number(leg.line);
  const cmp = binary ? 'gte' : (leg.cmp || 'gt');
  const side = leg.side || 'over';

  // A push needs an exact landing on a whole-number line. Books price almost
  // everything at .5 precisely so this cannot happen, but alt lines are whole.
  const exact = !binary && current === line && Number.isInteger(line);

  let state;
  if (side === 'under' || side === 'no') {
    if (clears(current, line, cmp)) state = final ? 'lost' : 'busted';
    else if (final) state = exact ? 'push' : 'won';
    else state = 'open';
  } else {
    if (clears(current, line, cmp)) state = final ? 'won' : 'hit';
    else if (final) state = exact ? 'push' : 'lost';
    else state = 'open';
  }

  const need = shortfall(current, line, cmp);
  const unit = def.unit;

  return {
    state, current, line, side, final, game, unit,
    needed: need,
    pct: line > 0 ? Math.min(1, current / line) : (current > 0 ? 1 : 0),
    label: binary ? `${current} ${unit}` : `${fmt(current)} / ${fmt(line)} ${unit}`.trim(),
    detail: detailFor(state, need, current, line, unit, side, binary),
  };
}

function detailFor(state, need, current, line, unit, side, binary) {
  if (state === 'hit' || state === 'won') return binary ? 'scored' : 'cleared';
  if (state === 'busted') return 'already over the line';
  if (state === 'lost') return binary ? 'did not score' : `finished ${fmt(need)} short`;
  if (state === 'push') return 'landed exactly on the line';
  if (side === 'under' || side === 'no') {
    const room = Math.max(0, line - current);
    return binary ? 'no score yet' : `${fmt(room)} ${unit} of room left`;
  }
  return binary ? 'no score yet' : `${fmt(need)} ${unit} to go`;
}

function gameLegProgress(leg, ctx) {
  const game = ctx.gameFor(leg);
  if (!game) return bare('unknown', 'no game found');
  if (game.state === 'pre') return { ...bare('pending', kickoffLabel(game)), game, line: leg.line, current: null };

  const final = game.state === 'post';
  const home = Number(game.home?.score) || 0;
  const away = Number(game.away?.score) || 0;
  const line = Number(leg.line);
  const cmp = leg.cmp || 'gt';
  const side = leg.side || 'over';

  // Which side of the game this leg is about, when it names a team.
  const mine = leg.teamAbbr && sameAbbr(game.home?.abbr, leg.teamAbbr) ? home
    : leg.teamAbbr && sameAbbr(game.away?.abbr, leg.teamAbbr) ? away
    : null;
  const theirs = mine == null ? null : (mine === home ? away : home);

  if (leg.market === 'game_total' || leg.market === 'team_total') {
    const current = leg.market === 'game_total' ? home + away : (mine ?? 0);
    return resolve({ ...leg, side, cmp }, current, game,
      { unit: 'pts', read: () => current });
  }

  if (leg.market === 'moneyline') {
    if (mine == null) return bare('unknown', 'team not matched');
    const state = !final ? 'open'
      : mine > theirs ? 'won' : mine === theirs ? 'push' : 'lost';
    return {
      state, current: mine, line: theirs, side: 'yes', final, game, unit: 'pts',
      needed: final ? 0 : Math.max(0, theirs - mine + 1),
      pct: mine + theirs > 0 ? mine / (mine + theirs) : 0,
      label: `${fmt(mine)} - ${fmt(theirs)}`,
      detail: final ? (mine > theirs ? 'won outright' : mine === theirs ? 'tied' : 'lost')
        : mine > theirs ? `leading by ${fmt(mine - theirs)}` : mine === theirs ? 'tied' : `trailing by ${fmt(theirs - mine)}`,
    };
  }

  // spread: the team covers when its score plus the line beats the opponent.
  if (mine == null) return bare('unknown', 'team not matched');
  const margin = mine + line - theirs;
  const state = !final ? 'open' : margin > 0 ? 'won' : margin === 0 ? 'push' : 'lost';
  return {
    state, current: margin, line: 0, side: 'over', final, game, unit: 'pts',
    // Points are whole, so a margin of -0.5 needs one point, not 1.5.
    needed: margin > 0 ? 0 : Math.floor(-margin) + 1,
    pct: margin > 0 ? 1 : 0,
    label: `${margin > 0 ? '+' : ''}${fmt(margin)} vs the line`,
    detail: final
      ? (margin > 0 ? 'covered' : margin === 0 ? 'pushed' : 'did not cover')
      : margin > 0 ? `covering by ${fmt(margin)}`
        : `${fmt(Math.floor(-margin) + 1)} ${Math.floor(-margin) + 1 === 1 ? 'point' : 'points'} from covering`,
  };
}

const bare = (state, detail) => ({
  state, current: null, line: null, side: null, final: false, game: null,
  unit: '', needed: null, pct: 0, label: '—', detail,
});

function kickoffLabel(game) {
  if (!game?.date) return 'not started';
  const d = new Date(game.date);
  return Number.isNaN(d.getTime()) ? 'not started'
    : `kicks off ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

const sameAbbr = (a, b) => !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase();

export const fmt = (n) => {
  if (n == null) return '—';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/* ----------------------------------------------------------- bet rollups */

// 'busted' is an under that has already been exceeded. It is not official
// until the game ends, but yards never go down, so for the purpose of "is this
// bet alive" it counts as dead - showing "at risk" there would be optimism the
// bettor does not share. The leg itself still reads "busted" rather than
// "lost", so the distinction stays visible where it belongs.
const DEAD = new Set(['lost', 'busted']);
const DONE = new Set(['won', 'push']);

// A parlay is only alive while every leg is. One dead leg kills it, however
// well the others are doing - which is the whole reason a parlay tracker is
// worth having.
export function betStatus(bet, ctx) {
  if (bet?.settled) return thawed(bet);

  const legs = (bet.legs || []).map((leg) => ({ leg, prog: legProgress(leg, ctx) }));
  const states = legs.map((l) => l.prog.state);

  const dead = states.some((s) => DEAD.has(s));
  const settled = states.every((s) => DONE.has(s));
  const hit = states.filter((s) => s === 'hit' || DONE.has(s)).length;

  let state;
  if (dead) state = 'lost';
  else if (settled) state = states.every((s) => s === 'push') ? 'push' : 'won';
  else if (hit === legs.length && legs.length) state = 'all hit';
  else state = 'open';

  return {
    state,
    legs,
    legsHit: hit,
    legsTotal: legs.length,
    // What is still actually in question, for the one-line summary.
    outstanding: legs.filter((l) => !DONE.has(l.prog.state) && l.prog.state !== 'lost'),
    toWin: profit(bet.stake, bet.odds),
    returned: state === 'won' ? (Number(bet.stake) || 0) + profit(bet.stake, bet.odds)
      : state === 'push' ? (Number(bet.stake) || 0) : 0,
  };
}

/* ------------------------------------------------------ frozen settlement */

// A decided bet has to stop being recomputed.
//
// legProgress resolves every leg against the CURRENT scoreboard. Once the week
// rolls over, ctx.gameFor can no longer find the event, so the leg takes the
// `!game` branch and reads 'unknown' - a state neither DEAD nor DONE contains.
// betStatus then falls through to 'open', and a bet you won in week 8 reads as
// still running in week 10, forever. The money summary is wrong with it: the
// stake goes back to counting as live exposure instead of a settled return.
//
// So the moment a bet is decided and the games it depends on are over, the
// settlement is written onto the record and read back from there. It is a
// snapshot of the progress the UI renders, not a second source of truth: the
// legs themselves are untouched.

const TERMINAL = new Set(['won', 'lost', 'push']);

// Everything legRow() draws, and nothing that holds a live game object.
const snapLeg = ({ leg, prog }) => ({
  id: leg.id,
  state: prog.state,
  label: prog.label || '',
  detail: prog.detail || '',
  current: prog.current ?? null,
  line: prog.line ?? null,
  side: prog.side || '',
  unit: prog.unit || '',
  pct: prog.pct ?? 0,
});

const gameOver = (l) => l.prog.game?.state === 'post';

// Final means final. An under that is already busted is arithmetically decided
// and the books would settle it, but ESPN revises stat lines during a game and
// a wrong freeze is permanent - so waiting for the whistle costs nothing.
export function freezable(bet, status) {
  if (bet?.settled) return false;
  if (!TERMINAL.has(status.state)) return false;
  if (!status.legs.length) return false;
  // One dead leg in a finished game decides the whole bet whatever the others
  // say, because a parlay cannot recover. A win needs all of them home.
  if (status.state === 'lost') {
    return status.legs.some((l) => DEAD.has(l.prog.state) && gameOver(l));
  }
  return status.legs.every(gameOver);
}

export function snapshot(bet, status, now = Date.now()) {
  return {
    state: status.state,
    returned: status.returned,
    legsHit: status.legsHit,
    legsTotal: status.legsTotal,
    at: now,
    legs: status.legs.map(snapLeg),
  };
}

// The snapshot read back out, in the exact shape betStatus returns, so nothing
// downstream needs to know a bet is frozen.
function thawed(bet) {
  const s = bet.settled;
  const byId = new Map((s.legs || []).map((l) => [l.id, l]));
  const legs = (bet.legs || []).map((leg) => {
    const f = byId.get(leg.id);
    return {
      leg,
      prog: f
        ? { ...f, final: true, game: null }
        : { ...bare('unknown', 'not recorded'), line: null, current: null, game: null },
    };
  });

  return {
    state: s.state,
    legs,
    legsHit: s.legsHit ?? legs.filter((l) => DONE.has(l.prog.state)).length,
    legsTotal: s.legsTotal ?? legs.length,
    outstanding: [],
    toWin: profit(bet.stake, bet.odds),
    returned: s.returned ?? 0,
    frozen: true,
    settledAt: s.at || null,
  };
}

/* ----------------------------------------------- live stats from a summary */

// ESPN's summary payload, flattened to athleteId -> { cats, eventId }.
//
// The site has a richer normaliser in espn.js that also keeps team splits and
// field-goal distances for fantasy scoring. This is the minimum the bet engine
// needs, and it lives here so the push Worker - which has none of the app -
// reads stats exactly the way the page does.
export function statsFromSummary(summary, eventId) {
  const out = {};
  for (const group of summary?.boxscore?.players || []) {
    for (const cat of group.statistics || []) {
      const keys = cat.keys || [];
      for (const a of cat.athletes || []) {
        const id = String(a.athlete?.id ?? '');
        if (!id) continue;
        const stats = a.stats || [];
        const byKey = {};
        // keys and stats can differ in length - 17 of 718 passing rows on a
        // measured slate had 8 keys and 7 values - so zip only what lines up.
        const n = Math.min(keys.length, stats.length);
        for (let i = 0; i < n; i += 1) byKey[keys[i]] = stats[i];
        if (!out[id]) out[id] = { cats: {}, eventId: String(eventId) };
        out[id].cats[cat.name] = byKey;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ leg diffing */

// How close to the line counts as "nearly there", as a fraction of it.
const NEAR = 0.9;

// Compare every leg against the last values seen and report what changed.
//
// Pure, and the state is passed in and handed back, so the page can keep it in
// a module variable while the Worker keeps it in KV - and both produce the
// same alerts from the same numbers.
export function diffLegs(betList, ctx, lastSeen = {}) {
  const events = [];
  const next = { ...lastSeen };

  for (const bet of betList || []) {
    const status = betStatus(bet, ctx);
    for (const { leg, prog } of status.legs) {
      const key = `${bet.id}:${leg.id}`;
      if (prog.current == null) continue;

      const prev = next[key];
      next[key] = prog.current;

      // No previous reading means this bet was only just added. Announcing the
      // yards it already had would be announcing history.
      if (prev == null || prog.current === prev) continue;

      const delta = Math.round((prog.current - prev) * 10) / 10;
      let kind = 'move';
      let priority = 0;

      if (prog.state === 'hit' || prog.state === 'won') { kind = 'hit'; priority = 2; }
      else if (prog.state === 'busted' || prog.state === 'lost') { kind = 'bust'; priority = 2; }
      else if (delta > 0 && prog.pct >= NEAR && !next[`near:${key}`]) {
        next[`near:${key}`] = 1;         // once per leg, not every carry
        kind = 'near';
        priority = 1;
      }

      events.push({ kind, priority, betId: bet.id, legId: leg.id, leg, prog, delta });
    }
  }
  return { events, next };
}

// "Ja'Marr Chase +13 - 26 / 40 receiving yards - 14 yds to go"
export function describeEvent(ev) {
  const who = ev.leg.playerName || ev.leg.teamAbbr || 'leg';
  const sign = ev.delta > 0 ? `+${fmt(ev.delta)}` : fmt(ev.delta);
  if (ev.kind === 'hit') return `${who} hit \u00b7 ${ev.prog.label}`;
  if (ev.kind === 'bust') return `${who} busted \u00b7 ${ev.prog.label}`;
  return `${who} ${sign} \u00b7 ${ev.prog.label} \u00b7 ${ev.prog.detail}`;
}

export function eventTitle(ev) {
  if (ev.kind === 'hit') return 'Bet leg hit';
  if (ev.kind === 'bust') return 'Bet leg busted';
  if (ev.kind === 'near') return 'Close to hitting';
  return 'Bet update';
}

/* ------------------------------------------------------------------ odds */

// American odds to profit on a winning stake.
export function profit(stake, odds) {
  const s = Number(stake), o = Number(odds);
  if (!Number.isFinite(s) || !Number.isFinite(o) || o === 0) return 0;
  const p = o > 0 ? s * (o / 100) : s * (100 / Math.abs(o));
  return Math.round(p * 100) / 100;
}

export const decimalOdds = (american) => {
  const o = Number(american);
  if (!Number.isFinite(o) || o === 0) return 1;
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
};

// Combined odds for a parlay built from leg prices, for when a slip gives the
// legs but not the total. Books round their own way, so this is an estimate
// and is only ever offered as a default the user can overwrite.
export function parlayOdds(legOdds) {
  const dec = legOdds.map(decimalOdds).reduce((a, b) => a * b, 1);
  if (dec <= 1) return 0;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

export const formatOdds = (o) => {
  const n = Number(o);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? `+${n}` : String(n);
};

/* ------------------------------------------------------- leg description */

export function describeLeg(leg) {
  if (isGameMarket(leg.market)) {
    if (leg.market === 'moneyline') return `${leg.teamAbbr} moneyline`;
    if (leg.market === 'spread') {
      const l = Number(leg.line);
      return `${leg.teamAbbr} ${l > 0 ? '+' : ''}${fmt(l)}`;
    }
    const who = leg.market === 'team_total' ? `${leg.teamAbbr} total` : 'game total';
    return `${who} ${leg.side === 'under' ? 'under' : 'over'} ${fmt(leg.line)}`;
  }
  const def = MARKETS[leg.market];
  const who = leg.playerName || leg.athleteId || 'player';
  if (def?.binary) return `${who} ${leg.side === 'no' ? 'no' : 'anytime'} TD`;
  const side = leg.side === 'under' ? 'under' : leg.cmp === 'gte' ? '' : 'over';
  const line = leg.cmp === 'gte' ? `${fmt(leg.line)}+` : fmt(leg.line);
  return `${who} ${side} ${line} ${def?.label || leg.market}`.replace(/\s+/g, ' ').trim();
}

/* --------------------------------------------------------- slip parsing */

// Both books write yards as "Yards" or "YDS", so every yardage pattern takes
// either. Learned from real slips, not guessed.
const YD = '(?:y(?:ar)?ds?)';

// Market phrases, most specific first: "rushing + receiving yards" has to be
// tested before "receiving yards", and "tackles for loss" before "tackles".
const MARKET_PATTERNS = [
  [new RegExp(`rush(?:ing)?\\s*(?:\\+|&|and)\\s*rec(?:eiving)?\\s*${YD}`, 'i'), 'rush_rec_yds'],
  [new RegExp(`pass(?:ing)?\\s*(?:\\+|&|and)\\s*rush(?:ing)?\\s*${YD}`, 'i'), 'pass_rush_yds'],
  [/(?:any\s*time|anytime)\s*(?:touchdown|td)|(?:td|touchdown)\s*scorer|to\s*score\s*a?\s*touchdown/i, 'anytime_td'],
  [/longest\s*reception/i, 'rec_long'],
  [/longest\s*rush/i, 'rush_long'],
  [/longest\s*field\s*goal/i, 'fg_long'],
  [/tackles?\s*for\s*loss/i, 'tfl'],
  [/passes?\s*defended/i, 'pass_def'],
  [/kicking\s*points?/i, 'kick_pts'],
  [/field\s*goals?\s*made/i, 'fg_made'],
  [new RegExp(`rec(?:eiving)?\\s*${YD}`, 'i'), 'rec_yds'],
  [new RegExp(`rush(?:ing)?\\s*${YD}`, 'i'), 'rush_yds'],
  [new RegExp(`pass(?:ing)?\\s*${YD}`, 'i'), 'pass_yds'],
  [new RegExp(`return\\s*${YD}`, 'i'), 'return_yds'],
  [/pass(?:ing)?\s*(?:touchdowns?|tds?)/i, 'pass_tds'],
  [/rush(?:ing)?\s*(?:touchdowns?|tds?)/i, 'rush_tds'],
  [/rec(?:eiving)?\s*(?:touchdowns?|tds?)/i, 'rec_tds'],
  [/pass(?:ing)?\s*attempts?/i, 'pass_att'],
  [/completions?/i, 'pass_comp'],
  [/receptions?/i, 'rec'],
  [/targets?/i, 'targets'],
  [/tackles?(?:\s*(?:\+|&|and)\s*assists?)?/i, 'tackles'],
  [/sacks?/i, 'sacks'],
  [/interceptions?/i, 'pass_int'],
  [/(?:total\s*points?|game\s*total|o\/u)/i, 'game_total'],
  [/money\s*line|to\s*win\s*(?:the\s*)?game/i, 'moneyline'],
  [/spread|handicap|point\s*spread/i, 'spread'],
];

// "1st Touchdown Scorer" is NOT "Anytime Touchdown Scorer". Settling one as
// the other turns a losing bet into a winner on screen, so it is refused out
// loud rather than approximated. Checked before any market match.
const FIRST_TD = /\b(?:1st|first)\s*(?:touchdown|td)\s*scorer/i;

// Whole lines carrying no bet information. Every one of these was observed in
// a real DraftKings or FanDuel page, not imagined.
const NOISE = new RegExp('^(?:cash\\s*out(?:\\s*unavailable)?|bet\\s*slip|betslip\\s*empty'
  + '|same\\s*game\\s*parlay|parlay|single|straight|open|settled|today|tomorrow|live|final'
  + '|finished|boost|profit\\s*boost|\\+?\\d+%\\s*(?:parlay\\s*)?boost'
  + '|\\d+\\s*(?:leg|pick)s?(?:\\s*sgp)?|sgpx?|share|copy|reuse|verify|hide\\s*picks'
  + '|box\\s*score|play-?by-?play|go\\s*to\\s*event|total\\s*wager|total\\s*payout'
  + '|to\\s*pay|wager|payout|returned?|won|bet\\s*id:.*|placed:.*|q1\\s*q2\\s*q3\\s*q4'
  + '|\\d+(?:st|nd|rd|th)\\s*(?:&|and)\\s*\\d+.*'
  + '|\\d{2}:\\d{2}\\s*\\d*(?:st|nd|rd|th)?\\s*quarter.*)$', 'i');

// A leading word decorating the market rather than naming anything.
const LEAD_NOISE = /^(?:live|alt|alternate|boosted)\s+/i;

// Money as a label and an amount on one line, either order:
// "Wager: $10.00 To Pay: $290.40", "TOTAL WAGER $25.00".
const MONEY_PAIR = /(wager|stake|risk|to\s*pay|payout|to\s*win|total\s*return|returned?|won|collect)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/gi;
const PAYOUT_WORD = /pay|win|return|won|collect/i;

// A bet-level price, alone or after a label: "+3958", "Same Game Parlay +104",
// "PARLAY +2156 +2804" (the second is the boosted price actually paid).
const PRICE_LINE = /^(?:(?:same\s*game\s*parlay|parlay|sgpx?|single|straight|total\s*odds|odds|\d+\s*(?:pick|leg)s?(?:\s*sgp)?)\s*[™®]?\s*)?((?:[+-]\d{3,5}\s*)+)$/i;

// "40+", "250+ Yards", "Ja'Marr Chase 50+ Yards" - a threshold, optionally
// carrying the player's name. DraftKings puts this on the line BEFORE the
// market; FanDuel does too, with the name attached.
const PLUS_LINE = /^(.*?)\b(\d+(?:\.\d+)?)\s*\+\s*(?:yards?|yds?|points?|pts?|receptions?|tackles?)?\s*$/i;

const NAME_SHAPE = /^[A-Za-z][A-Za-z.'’‐-― ]{2,40}$/;

function looksLikeName(s) {
  if (!NAME_SHAPE.test(s)) return false;
  const words = s.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4;
}

// "Bengals -3.5", "CIN +6.5 -110", "Bengals -140".
//
// A signed number is a spread or a price depending on its size: spreads live
// under about 30 and are usually a half point, American prices start at 100.
function bareTeamLeg(line, resolveTeam) {
  const m = /^([A-Za-z .'&]+?)\s*([+-]\d+(?:\.\d+)?)(?:\s+([+-]\d{3,5}))?\s*$/.exec(line.trim());
  if (!m) return null;
  const abbr = resolveTeam(m[1]);
  if (!abbr || typeof abbr !== 'string') return null;

  const first = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  const isPrice = Number.isInteger(first) && Math.abs(first) >= 100;

  if (isPrice && !m[3]) return { market: 'moneyline', teamAbbr: abbr, odds: first };
  return {
    market: 'spread', teamAbbr: abbr, line: first,
    cmp: 'gt', side: 'over', odds: second,
  };
}

function matchMarket(line) {
  for (const [re, market] of MARKET_PATTERNS) {
    const m = re.exec(line);
    if (m) return { market, at: m.index, len: m[0].length };
  }
  return null;
}

// A parlay's summary line lists every leg, comma separated. Split it only when
// it really is a list of legs, so an ordinary name with a comma survives.
function splitSummary(line) {
  if (!line.includes(',')) return [line];
  const parts = line.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [line];
  return parts.filter((p) => matchMarket(p)).length >= 2 ? parts : [line];
}

// Parse a pasted bet slip. Deliberately tolerant and deliberately not trusted:
// the caller shows every leg for review before anything is saved. The exact
// clipboard format differs by book and by app version, and guessing wrong
// silently would be worse than asking.
export function parseSlip(text, resolvers = {}) {
  const resolvePlayer = resolvers.player
    || (() => ({ athleteId: null, candidates: [], reason: 'no resolver' }));
  const resolveTeam = resolvers.team || (() => null);

  const raw = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/ /g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  const lines = [];
  for (const l of raw) for (const p of splitSummary(l)) lines.push(p);

  const warnings = [];
  const legs = [];
  let stake = 0;
  let odds = 0;
  let toWin = 0;
  let teamHint = null;

  // Carried between lines, because both books split one leg across two.
  let pendingValue = null;
  let pendingName = null;
  let pendingMoney = 0;

  const book = /fanduel|us-[a-z]{2}:|total\s*wager/i.test(text) ? 'fanduel'
    : /draft\s*kings|draftkings|to\s*pay:|\bDK\d{6,}/i.test(text) ? 'draftkings'
    : 'manual';

  for (const original of lines) {
    const line = original.replace(LEAD_NOISE, '').trim();
    if (!line) continue;

    // --- money, labelled inline ------------------------------------------
    MONEY_PAIR.lastIndex = 0;
    let pair;
    let tookMoney = false;
    while ((pair = MONEY_PAIR.exec(line))) {
      const amt = Number(pair[2].replace(/,/g, ''));
      if (PAYOUT_WORD.test(pair[1])) toWin = amt; else stake = amt;
      tookMoney = true;
    }
    if (tookMoney) { pendingMoney = 0; continue; }

    // --- money, amount on one line and its label on the next -------------
    const lone = /^\$\s*([\d,]+(?:\.\d{1,2})?)$/.exec(line);
    if (lone) {
      if (pendingMoney && !stake) stake = pendingMoney;
      pendingMoney = Number(lone[1].replace(/,/g, ''));
      continue;
    }
    if (pendingMoney) {
      if (/payout|to\s*pay|return|won|collect|to\s*win/i.test(line)) {
        toWin = pendingMoney; pendingMoney = 0; continue;
      }
      if (/wager|stake|risk/i.test(line)) { stake = pendingMoney; pendingMoney = 0; continue; }
      if (!stake) stake = pendingMoney;
      pendingMoney = 0;
    }

    // --- a bet-level price -----------------------------------------------
    const price = PRICE_LINE.exec(line);
    if (price) {
      const all = price[1].trim().split(/\s+/).map(Number).filter(Boolean);
      // Where a book prints the original and the boosted price, the boosted
      // one is what actually pays.
      if (all.length) odds = all[all.length - 1];
      continue;
    }

    if (FIRST_TD.test(line)) {
      warnings.push(`"${original}" is a first-touchdown bet, which this cannot `
        + 'settle. Add it by hand, or leave it off.');
      continue;
    }

    if (NOISE.test(line)) continue;

    // --- "CIN @ BAL" - context, and a hint for the names that follow -----
    // "@" may be written tight; "at" and "vs" must be surrounded by spaces,
    // or the AT inside JONATHAN makes the name look like a fixture.
    const matchup = /^([A-Za-z .']+?)(?:\s*@\s*|\s+(?:vs\.?|at)\s+)([A-Za-z .']+)$/i.exec(line);
    if (matchup && !matchMarket(line)) {
      const hint = resolveTeam(matchup[1]) || resolveTeam(matchup[2]);
      if (typeof hint === 'string') teamHint = hint;
      continue;
    }

    const hit = matchMarket(line);

    if (!hit) {
      // A threshold waiting for the market line that follows it.
      const plus = PLUS_LINE.exec(line);
      if (plus) {
        pendingValue = { value: Number(plus[2]), cmp: 'gte' };
        const who = plus[1].replace(/[‐-―|]/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (who && looksLikeName(who)) pendingName = who;
        continue;
      }
      // A name waiting for the market line that follows it.
      if (looksLikeName(line)) { pendingName = line; continue; }

      const bare = bareTeamLeg(line, resolveTeam);
      if (bare) { legs.push(bare); continue; }

      if (line.length > 3 && /\d/.test(line)) warnings.push(`Not understood: "${original}"`);
      continue;
    }

    const leg = parseLeg(line, {
      teamHint, resolvePlayer, resolveTeam, pendingValue, pendingName,
    });
    if (leg) {
      legs.push(leg);
      pendingValue = null;
      pendingName = null;
    } else if (line.length > 3) {
      warnings.push(`Not understood: "${original}"`);
    }
  }

  // The same leg appears twice when a parlay's summary line and its detail are
  // both copied. Keep the better-resolved one.
  const byKey = new Map();
  for (const l of legs) {
    const key = `${l.market}|${String(l.playerName || l.teamAbbr || '').toLowerCase()}|${l.line ?? ''}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.athleteId && l.athleteId)) byKey.set(key, l);
  }
  const unique = [...byKey.values()];

  // Stake and payout are printed by the book and are exact, so they beat a
  // price scraped off a header.
  if (stake && toWin && toWin > stake) {
    const ratio = toWin / stake;
    odds = ratio >= 2 ? Math.round((ratio - 1) * 100) : -Math.round(100 / (ratio - 1));
  } else if (!odds && unique.length === 1 && unique[0].odds) {
    odds = unique[0].odds;
  } else if (!odds && unique.length > 1) {
    const prices = unique.map((l) => l.odds).filter(Boolean);
    if (prices.length === unique.length) odds = parlayOdds(prices);
  }

  if (!unique.length) warnings.unshift('No legs recognised. Add them by hand below.');

  return { book, stake, odds, toWin, legs: unique, warnings };
}

function parseLeg(line, ctx) {
  const { teamHint, resolvePlayer, resolveTeam, pendingValue, pendingName } = ctx;
  const hit = matchMarket(line);
  if (!hit) return bareTeamLeg(line, resolveTeam);

  const market = hit.market;
  const inlineOdds = /([+-]\d{3,5})/.exec(line);

  // The line value, written as "Over 39.5", "40+", "40 or more", or carried
  // over from the line before.
  let side = 'over';
  let cmp = 'gt';
  let value = null;

  const plus = /(\d+(?:\.\d+)?)\s*\+/.exec(line);
  const ou = /\b(over|under|o|u)\s*(\d+(?:\.\d+)?)/i.exec(line);
  const alt = /\b(\d+(?:\.\d+)?)\s*(?:or\s*more)\b/i.exec(line);

  if (ou) {
    side = /^u/i.test(ou[1]) ? 'under' : 'over';
    value = Number(ou[2]);
    cmp = 'gt';
  } else if (plus) {
    value = Number(plus[1]);
    cmp = 'gte';
  } else if (alt) {
    value = Number(alt[1]);
    cmp = 'gte';
  } else if (pendingValue) {
    value = pendingValue.value;
    cmp = pendingValue.cmp;
  }

  if (isGameMarket(market)) {
    if (market === 'spread') {
      const sp = /([A-Za-z .']+?)\s*([+-]\d+(?:\.\d+)?)/.exec(line);
      const abbr = sp ? resolveTeam(sp[1]) : null;
      if (!abbr || typeof abbr !== 'string') return null;
      return {
        market, teamAbbr: abbr, line: Number(sp[2]),
        cmp: 'gt', side: 'over', odds: oddsFrom(inlineOdds),
      };
    }
    if (market === 'moneyline') {
      const abbr = resolveTeam(line.replace(/money\s*line|to\s*win\s*(?:the\s*)?game|[+-]\d{3,5}/gi, '').trim());
      if (!abbr || typeof abbr !== 'string') return null;
      return { market, teamAbbr: abbr, odds: oddsFrom(inlineOdds) };
    }
    const abbr = resolveTeam(line.replace(MARKET_PATTERNS.find(([, m]) => m === 'game_total')[0], '')
      .replace(/\b(over|under|o|u)\s*\d+(?:\.\d+)?/i, '').replace(/[+-]\d{3,5}/, '').trim());
    if (value == null) return null;
    return typeof abbr === 'string' && abbr
      ? { market: 'team_total', teamAbbr: abbr, line: value, side, cmp, odds: oddsFrom(inlineOdds) }
      : { market: 'game_total', line: value, side, cmp, odds: oddsFrom(inlineOdds) };
  }

  const binary = !!MARKETS[market]?.binary;
  if (!binary && value == null) return null;

  // Whatever is left once the market phrase, the line and the price are gone
  // is the player's name - or, when the book put the name on its own line,
  // nothing at all, and the name carried over from there.
  let name = line
    .slice(0, hit.at)
    .concat(' ', line.slice(hit.at + hit.len))
    .replace(/\b(over|under)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*\+?/g, '')
    .replace(/[+-]\d{3,5}/g, '')
    .replace(/\b(or\s*more|scorer|alt|alternate|player|yards?|yds?)\b/gi, '')
    .replace(/[|–—]/g, ' ')
    .replace(/[-•]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!name && pendingName) name = pendingName;
  if (!name) return null;

  const r = resolvePlayer(name, teamHint);
  return {
    market,
    playerName: r.candidates[0]?.name || name,
    rawName: name,
    athleteId: r.athleteId,
    team: r.candidates[0]?.team || teamHint || null,
    line: binary ? 1 : value,
    side: binary ? 'yes' : side,
    cmp,
    odds: oddsFrom(inlineOdds),
    unresolved: r.athleteId ? null : r.reason,
    candidates: r.athleteId ? undefined : r.candidates,
  };
}

// A matched price like "+600" or "-110" from a regex result.
const oddsFrom = (m) => (m ? Number(m[1] ?? m[0]) || 0 : 0);
