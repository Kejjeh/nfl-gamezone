// GENERATED FILE - do not edit. Regenerate with:
//
//   node tools/bundle-worker.mjs
//
// js/bets-core.js + worker/src/vapid.js + worker/src/index.js, flattened into
// one module so it can be pasted into the Cloudflare dashboard editor, which
// takes a single file. Deploying with wrangler does NOT need this - wrangler
// bundles the three modules itself. Edit the sources, never this.
//
// Built 2026-11-09 from 18 bets-core exports.

/* ---------------------------------------------------- js/bets-core.js */

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
const MARKETS = {
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
const GAME_MARKETS = {
  game_total: { label: 'game total', unit: 'pts' },
  team_total: { label: 'team total', unit: 'pts' },
  spread:     { label: 'spread',     unit: 'pts' },
  moneyline:  { label: 'moneyline',  unit: '' },
};

const isGameMarket = (market) => Object.prototype.hasOwnProperty.call(GAME_MARKETS, market);

function marketLabel(market) {
  return MARKETS[market]?.label || GAME_MARKETS[market]?.label || market;
}

function marketUnit(market) {
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
function legProgress(leg, ctx) {
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

const fmt = (n) => {
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
function betStatus(bet, ctx) {
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
function statsFromSummary(summary, eventId) {
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
function diffLegs(betList, ctx, lastSeen = {}) {
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
function describeEvent(ev) {
  const who = ev.leg.playerName || ev.leg.teamAbbr || 'leg';
  const sign = ev.delta > 0 ? `+${fmt(ev.delta)}` : fmt(ev.delta);
  if (ev.kind === 'hit') return `${who} hit \u00b7 ${ev.prog.label}`;
  if (ev.kind === 'bust') return `${who} busted \u00b7 ${ev.prog.label}`;
  return `${who} ${sign} \u00b7 ${ev.prog.label} \u00b7 ${ev.prog.detail}`;
}

function eventTitle(ev) {
  if (ev.kind === 'hit') return 'Bet leg hit';
  if (ev.kind === 'bust') return 'Bet leg busted';
  if (ev.kind === 'near') return 'Close to hitting';
  return 'Bet update';
}

/* ------------------------------------------------------------------ odds */

// American odds to profit on a winning stake.
function profit(stake, odds) {
  const s = Number(stake), o = Number(odds);
  if (!Number.isFinite(s) || !Number.isFinite(o) || o === 0) return 0;
  const p = o > 0 ? s * (o / 100) : s * (100 / Math.abs(o));
  return Math.round(p * 100) / 100;
}

const decimalOdds = (american) => {
  const o = Number(american);
  if (!Number.isFinite(o) || o === 0) return 1;
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
};

// Combined odds for a parlay built from leg prices, for when a slip gives the
// legs but not the total. Books round their own way, so this is an estimate
// and is only ever offered as a default the user can overwrite.
function parlayOdds(legOdds) {
  const dec = legOdds.map(decimalOdds).reduce((a, b) => a * b, 1);
  if (dec <= 1) return 0;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

const formatOdds = (o) => {
  const n = Number(o);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? `+${n}` : String(n);
};

/* ------------------------------------------------------- leg description */

function describeLeg(leg) {
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
function parseSlip(text, resolvers = {}) {
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

// The namespace index.js imported as `core`.
const core = { MARKETS, GAME_MARKETS, isGameMarket, marketLabel, marketUnit, legProgress, fmt, betStatus, statsFromSummary, diffLegs, describeEvent, eventTitle, profit, decimalOdds, parlayOdds, formatOdds, describeLeg, parseSlip };

/* ------------------------------------------------- worker/src/vapid.js */

// VAPID: the signature that lets a push service accept a message from us.
//
// This sends pushes with NO payload. Encrypting a payload (RFC 8291) needs
// ECDH against the subscription key, then HKDF, then AES-GCM - a lot of
// crypto whose failure mode is a silently undelivered message. A push with no
// body needs only this signature, and the service worker fetches the text
// itself. One more round trip on the device, far less that can go wrong.

const b64url = (bytes) => {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const utf8 = (s) => new TextEncoder().encode(s);
const b64urlJSON = (obj) => b64url(utf8(JSON.stringify(obj)));

let cachedKey = null;
let cachedFrom = null;

async function signingKey(privateJwk) {
  if (cachedKey && cachedFrom === privateJwk) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'jwk',
    typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  cachedFrom = privateJwk;
  return cachedKey;
}

// One JWT per push service origin, valid for hours, so this is cached too.
const jwtCache = new Map();

async function authHeaders(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 300) return headersFor(hit.jwt, env.VAPID_PUBLIC_KEY);

  const exp = now + 6 * 3600;                 // spec allows 24h; 6 is plenty
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: env.VAPID_SUBJECT || 'mailto:nobody@example.com' };
  const input = `${b64urlJSON(header)}.${b64urlJSON(payload)}`;

  const key = await signingKey(env.VAPID_PRIVATE_JWK);
  // WebCrypto returns ECDSA signatures as raw r||s, which is exactly what
  // JWS ES256 wants - no DER unwrapping needed.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));

  const jwt = `${input}.${b64url(sig)}`;
  jwtCache.set(aud, { jwt, exp });
  return headersFor(jwt, env.VAPID_PUBLIC_KEY);
}

const headersFor = (jwt, publicKey) => ({
  Authorization: `vapid t=${jwt}, k=${publicKey}`,
  TTL: '120',
  Urgency: 'high',
});

// Returns 'ok', 'gone' (the subscription is dead and should be dropped), or
// 'error'. Apple and Mozilla both answer 404/410 for a subscription that no
// longer exists, which is the only case worth acting on.
async function sendPush(endpoint, env) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: await authHeaders(endpoint, env) });
  } catch (err) {
    return { state: 'error', detail: String(err) };
  }
  if (res.status === 404 || res.status === 410) return { state: 'gone', detail: res.status };
  if (res.ok) return { state: 'ok', detail: res.status };
  return { state: 'error', detail: `${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}` };
}

/* ------------------------------------------------- worker/src/index.js */

// gamezone-push: the part GitHub Pages cannot be.
//
// The site is static, and iOS gives an installed web app no way to wake itself
// (no Background Sync, no Periodic Background Sync). Web Push is
// server-initiated by definition, so something has to sit on a cron, watch the
// box scores, and send. This is that something, and it is deliberately the
// smallest thing that can do the job.
//
// It evaluates bets with the SAME js/bets-core.js the page uses, imported
// directly rather than reimplemented, so the phone and the browser can never
// disagree about whether a leg has hit.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

/* ------------------------------------------------------------------ http */

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
});

const json = (body, env, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(env) },
  });

// Subscription endpoints are long and contain a token, so they are hashed
// rather than used as identifiers directly.
async function idFor(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every subscription lives in ONE record, keyed by endpoint hash inside it.
//
// It used to be one KV key each, which meant a list() on every cron tick to
// find them. The free plan allows 1,000 list requests a day and the cron fires
// 1,440 times, so list operations ran out at 16:40 UTC every day and the
// Worker then did nothing at all until the quota reset. One key means one read
// per tick, no list, and a second phone that costs nothing.
const SUBS_KEY = 'subs:all';

async function loadSubs(env) {
  const all = await read(env, SUBS_KEY);
  if (all) return all;
  return migrateSubs(env);
}

// Deployments before 2026-11-09 stored one key per subscription. Fold them in,
// so nobody has to re-enable alerts on their phone. The list() below runs only
// while SUBS_KEY is absent, and the record is written even when it is empty, so
// the next tick reads it instead of listing again.
//
// A failure here throws on purpose. Writing an empty record because a list
// failed would silently discard a working subscription; the cron just tries
// again next minute.
async function migrateSubs(env) {
  const all = {};
  const legacy = [];
  let cursor;
  do {
    const page = await env.GZ.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const rec = await read(env, k.name);
      if (rec?.subscription?.endpoint) {
        all[await idFor(rec.subscription.endpoint)] = rec;
        legacy.push(k.name);
      }
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  await env.GZ.put(SUBS_KEY, JSON.stringify(all));
  for (const k of legacy) await env.GZ.delete(k);
  return all;
}

// Always write, even when the record is empty: an absent key would send the
// next tick back into migrateSubs and its list().
const saveSubs = (env, all) => env.GZ.put(SUBS_KEY, JSON.stringify(all));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (url.pathname === '/health') {
      // Name what is missing. A half-configured Worker still answers every
      // route and still runs its cron; it just never gets a push accepted,
      // which is a miserable thing to debug from a phone.
      const missing = [
        !env.VAPID_PRIVATE_JWK && 'VAPID_PRIVATE_JWK',
        !env.VAPID_PUBLIC_KEY && 'VAPID_PUBLIC_KEY',
        !env.VAPID_SUBJECT && 'VAPID_SUBJECT',
        !env.GZ && 'GZ (KV namespace)',
      ].filter(Boolean);
      return json({ ok: true, configured: missing.length === 0, missing }, env);
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, env, 405);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, env, 400); }

    if (url.pathname === '/subscribe') {
      const sub = body.subscription;
      if (!sub?.endpoint) return json({ error: 'no subscription' }, env, 400);
      const all = await loadSubs(env);
      all[await idFor(sub.endpoint)] = {
        subscription: sub,
        bets: Array.isArray(body.bets) ? body.bets : [],
        // Start from the current numbers, so switching alerts on does not
        // immediately announce everything that already happened today.
        lastSeen: {},
        primed: false,
        updated: Date.now(),
      };
      await saveSubs(env, all);
      return json({ ok: true }, env);
    }

    if (url.pathname === '/bets') {
      const all = await loadSubs(env);
      const rec = all[await idFor(body.endpoint || '')];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      rec.bets = Array.isArray(body.bets) ? body.bets : [];
      rec.updated = Date.now();
      await saveSubs(env, all);
      return json({ ok: true, bets: rec.bets.length }, env);
    }

    // Prove the whole chain - signature, push service, service worker,
    // notification - without waiting for a bet to move. It only ever sends to
    // an endpoint already in KV, so it cannot be pointed at a stranger.
    if (url.pathname === '/test') {
      const all = await loadSubs(env);
      const id = await idFor(body.endpoint || '');
      const rec = all[id];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      rec.pending = {
        title: 'GameZone test',
        body: 'Phone alerts are working. Real ones look like this.',
        tag: 'gz-test',
      };
      await saveSubs(env, all);
      const out = await sendPush(rec.subscription.endpoint, env);
      if (out.state === 'gone') {
        delete all[id];
        await saveSubs(env, all);
      }
      return json({ ok: out.state === 'ok', state: out.state, detail: out.detail },
        env, out.state === 'ok' ? 200 : 502);
    }

    // The service worker asks for the message that belongs to this push.
    if (url.pathname === '/pending') {
      const all = await loadSubs(env);
      const rec = all[await idFor(body.endpoint || '')];
      if (!rec) return json({ error: 'unknown subscription' }, env, 404);
      const pending = rec.pending || null;
      if (pending) {
        rec.pending = null;
        await saveSubs(env, all);
      }
      return json(pending || { title: 'GameZone', body: 'Your bets moved.' }, env);
    }

    if (url.pathname === '/unsubscribe') {
      const all = await loadSubs(env);
      delete all[await idFor(body.endpoint || '')];
      await saveSubs(env, all);
      return json({ ok: true }, env);
    }

    return json({ error: 'no such route' }, env, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

async function read(env, key) {
  const raw = await env.GZ.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ tick */

async function tick(env) {
  // The scoreboard comes FIRST, before any KV call. A tick on a Tuesday, or at
  // 3am on a Monday, has to cost nothing at all: the free plan allows 1,000
  // writes and 1,000 list requests a day, and this cron fires 1,440 times.
  const scoreboard = await fetchJSON(`${ESPN}/scoreboard`);
  const games = normalizeGames(scoreboard);
  const live = games.filter((g) => g.state === 'in');

  // Nothing is moving, so nothing can have changed.
  if (!live.length) return { skipped: 'no live games' };

  const all = await loadSubs(env);
  const ids = Object.keys(all);
  if (!ids.length) return { skipped: 'no subscriptions' };

  const stats = {};
  const eventOf = {};
  // Free plan allows 50 subrequests per invocation; a full slate is 16.
  for (const g of live.slice(0, 20)) {
    try {
      const summary = await fetchJSON(`${ESPN}/summary?event=${g.id}`);
      const flat = core.statsFromSummary(summary, g.id);
      for (const [id, v] of Object.entries(flat)) {
        stats[id] = v.cats;
        eventOf[id] = g.id;
      }
    } catch (err) {
      // One bad game must not cost everyone their alerts.
      console.log('summary failed', g.id, String(err));
    }
  }

  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const world = { stats, eventOf, byId, games };
  const before = JSON.stringify(all);
  const sending = [];
  const results = [];

  for (const id of ids) {
    try {
      const out = evaluate(all[id], world);
      results.push(out);
      if (out.push) sending.push(id);
    } catch (err) {
      console.log('sub failed', id, String(err));
    }
  }

  // One write for every device, and only when a tracked number actually moved.
  // This used to be an unconditional put() per subscription per live minute,
  // which is what emptied the daily write quota.
  const wrote = JSON.stringify(all) !== before;
  if (wrote) await saveSubs(env, all);

  // The message has to be stored before the push goes out: the service worker
  // wakes and immediately asks for it.
  let dropped = false;
  for (const id of sending) {
    const out = await sendPush(all[id].subscription.endpoint, env);
    if (out.state === 'gone') {
      delete all[id];
      dropped = true;
    }
  }
  if (dropped) await saveSubs(env, all);

  return { live: live.length, subs: ids.length, wrote, results };
}

// Decides what this subscription should be told and moves its baseline on.
// Deliberately free of KV: every operation for the whole tick lives in tick(),
// so the per-day budget can be read off one function.
function evaluate(rec, world) {
  const ctx = {
    statsFor: (athleteId) => world.stats[String(athleteId)] || null,
    gameFor: (leg) => {
      if (leg.eventId) return world.byId[String(leg.eventId)] || null;
      if (leg.athleteId) {
        const ev = world.eventOf[String(leg.athleteId)];
        if (ev) return world.byId[ev] || null;
      }
      const abbr = (leg.teamAbbr || leg.team || '').toUpperCase();
      return abbr ? world.games.find((g) => g.home.abbr === abbr || g.away.abbr === abbr) || null : null;
    },
  };

  const { events, next } = core.diffLegs(rec.bets || [], ctx, rec.lastSeen || {});
  rec.lastSeen = next;

  // The first run after subscribing only records where things stand.
  if (!rec.primed) {
    rec.primed = true;
    return { primed: true };
  }

  const worth = events.filter((e) => e.priority >= 1);
  if (!worth.length) return { events: events.length, sent: false };

  worth.sort((a, b) => b.priority - a.priority);
  const top = worth[0];
  const more = worth.length > 1 ? ` (+${worth.length - 1} more)` : '';

  rec.pending = {
    title: core.eventTitle(top),
    body: core.describeEvent(top) + more,
    tag: `gz-${top.betId}`,
  };
  return { push: true, body: rec.pending.body };
}

/* ------------------------------------------------------------------ espn */

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Only the fields the bet engine reads.
function normalizeGames(sb) {
  const out = [];
  for (const ev of sb?.events || []) {
    const comp = (ev.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const side = (ha) => {
      const t = cs.find((c) => c.homeAway === ha) || {};
      return { abbr: (t.team || {}).abbreviation || '??', score: Number(t.score) || 0 };
    };
    out.push({
      id: String(ev.id),
      state: (ev.status?.type || {}).state || 'pre',
      date: ev.date,
      home: side('home'),
      away: side('away'),
    });
  }
  return out;
}

export { authHeaders, sendPush, tick, normalizeGames };
