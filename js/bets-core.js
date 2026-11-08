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

// Market phrases, most specific first: "rushing + receiving yards" has to be
// tested before "receiving yards", and "tackles for loss" before "tackles".
const MARKET_PATTERNS = [
  [/rush(?:ing)?\s*(?:\+|&|and)\s*rec(?:eiving)?\s*yards?/i, 'rush_rec_yds'],
  [/pass(?:ing)?\s*(?:\+|&|and)\s*rush(?:ing)?\s*yards?/i, 'pass_rush_yds'],
  [/(?:any\s*time|anytime)\s*(?:touchdown|td)|td\s*scorer|touchdown\s*scorer|to\s*score\s*a?\s*touchdown/i, 'anytime_td'],
  [/longest\s*reception/i, 'rec_long'],
  [/longest\s*rush/i, 'rush_long'],
  [/longest\s*field\s*goal/i, 'fg_long'],
  [/tackles?\s*for\s*loss/i, 'tfl'],
  [/passes?\s*defended/i, 'pass_def'],
  [/kicking\s*points?/i, 'kick_pts'],
  [/field\s*goals?\s*made/i, 'fg_made'],
  [/rec(?:eiving)?\s*yards?/i, 'rec_yds'],
  [/rush(?:ing)?\s*yards?/i, 'rush_yds'],
  [/pass(?:ing)?\s*yards?/i, 'pass_yds'],
  [/return\s*yards?/i, 'return_yds'],
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

const NOISE = /^(?:cash\s*out|bet\s*slip|same\s*game\s*parlay|parlay|single|straight|open|settled|today|tomorrow|live|final|boost|profit\s*boost|\d+\s*leg|share|copy)$/i;

// "Bengals -3.5", "CIN +6.5 -110", "Bengals -140".
//
// A signed number is a spread or a price depending on its size: spreads live
// under about 30 and are usually a half point, American prices start at 100.
function bareTeamLeg(line, resolveTeam) {
  const m = /^([A-Za-z .'&]+?)\s*([+-]\d+(?:\.\d+)?)(?:\s+([+-]\d{3,5}))?\s*$/.exec(line.trim());
  if (!m) return null;
  const abbr = resolveTeam(m[1]);
  if (!abbr) return null;

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

// Parse a pasted bet slip. Deliberately tolerant and deliberately not trusted:
// the caller shows every leg for review before anything is saved. The exact
// clipboard format differs by book and by app version, and guessing wrong
// silently would be worse than asking.
export function parseSlip(text, resolvers = {}) {
  const resolvePlayer = resolvers.player
    || (() => ({ athleteId: null, candidates: [], reason: 'no resolver' }));
  const resolveTeam = resolvers.team || (() => null);
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/ /g, ' ').trim())
    .filter((s) => s && !NOISE.test(s));

  const warnings = [];
  const legs = [];
  let stake = 0;
  let odds = 0;
  let toWin = 0;
  let teamHint = null;

  const book = /fanduel/i.test(text) ? 'fanduel'
    : /draft\s*kings|draftkings/i.test(text) ? 'draftkings'
    : 'manual';

  for (const line of lines) {
    // Money and price lines.
    const money = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(line);
    if (money) {
      const amt = Number(money[1].replace(/,/g, ''));
      if (/to\s*(?:win|return|collect)|payout|total\s*return/i.test(line)) { toWin = amt; continue; }
      if (/wager|stake|bet|risk/i.test(line) || !stake) { stake = amt; continue; }
    }

    // A bare price on its own line belongs to the bet, not a leg.
    const bare = /^([+-]\d{3,5})$/.exec(line);
    if (bare) { odds = Number(bare[1]); continue; }

    // "CIN @ BAL" or "Bengals vs Ravens" - context, and a hint for the names
    // that follow it.
    const matchup = /^([A-Za-z .']+?)\s*(?:@|vs\.?|at)\s*([A-Za-z .']+)$/i.exec(line);
    if (matchup && !matchMarket(line)) {
      teamHint = resolveTeam(matchup[1]) || resolveTeam(matchup[2]) || teamHint;
      continue;
    }

    const leg = parseLeg(line, teamHint, resolvePlayer, resolveTeam);
    if (leg) {
      legs.push(leg);
      // Remember the price if it was written inline on the leg.
      continue;
    }
    if (line.length > 3 && /\d/.test(line)) warnings.push(`Not understood: "${line}"`);
  }

  // A single-leg slip often prints only the leg price, which is the bet price.
  if (!odds && legs.length === 1 && legs[0].odds) odds = legs[0].odds;
  if (!odds && legs.length > 1) {
    const prices = legs.map((l) => l.odds).filter(Boolean);
    if (prices.length === legs.length) odds = parlayOdds(prices);
  }
  if (!odds && stake && toWin) {
    const ratio = toWin / stake;
    odds = ratio >= 2 ? Math.round((ratio - 1) * 100) : -Math.round(100 / (ratio - 1));
  }

  if (!legs.length) warnings.unshift('No legs recognised. Add them by hand below.');

  return { book, stake, odds, toWin, legs, warnings };
}

function parseLeg(line, teamHint, resolvePlayer, resolveTeam) {
  const hit = matchMarket(line);
  // Books write a spread and a moneyline with no market word at all - just
  // "Bengals -3.5" or "Bengals -140" - so those shapes are tried first.
  if (!hit) return bareTeamLeg(line, resolveTeam);

  const market = hit.market;
  const inlineOdds = /([+-]\d{3,5})/.exec(line);

  // The line value, written either as "Over 39.5" / "Under 39.5" or "40+".
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
  }

  if (isGameMarket(market)) {
    if (market === 'spread') {
      const sp = /([A-Za-z .']+?)\s*([+-]\d+(?:\.\d+)?)/.exec(line);
      const abbr = sp ? resolveTeam(sp[1]) : null;
      if (!abbr || !sp) return null;
      return { market, teamAbbr: abbr, line: Number(sp[2]), cmp: 'gt', side: 'over', odds: oddsFrom(inlineOdds) };
    }
    if (market === 'moneyline') {
      const abbr = resolveTeam(line.replace(/money\s*line|to\s*win\s*(?:the\s*)?game|[+-]\d{3,5}/gi, '').trim());
      if (!abbr) return null;
      return { market, teamAbbr: abbr, odds: oddsFrom(inlineOdds) };
    }
    // game or team total
    const abbr = resolveTeam(line.replace(MARKET_PATTERNS.find(([, m]) => m === 'game_total')[0], '')
      .replace(/\b(over|under|o|u)\s*\d+(?:\.\d+)?/i, '').replace(/[+-]\d{3,5}/, '').trim());
    if (value == null) return null;
    return abbr
      ? { market: 'team_total', teamAbbr: abbr, line: value, side, cmp, odds: oddsFrom(inlineOdds) }
      : { market: 'game_total', line: value, side, cmp, odds: oddsFrom(inlineOdds) };
  }

  const binary = !!MARKETS[market]?.binary;
  if (!binary && value == null) return null;

  // Whatever is left once the market phrase, the line and the price are gone
  // is the player's name.
  const name = line
    .slice(0, hit.at)
    .concat(' ', line.slice(hit.at + hit.len))
    .replace(/\b(over|under)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*\+?/g, '')
    .replace(/[+-]\d{3,5}/g, '')
    .replace(/\b(or\s*more|scorer|alt|alternate|player)\b/gi, '')
    .replace(/[|–—]/g, ' ')
    .replace(/[-•]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

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
