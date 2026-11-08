// NFL GameZone - iOS lock screen and home screen widget
//
// Runs in Scriptable (https://scriptable.app), which executes JavaScript as a
// real WidgetKit widget. No Mac, no Xcode, no Apple Developer account.
//
// WHAT A WIDGET CAN AND CANNOT DO
//
// It cannot show a live play feed. Apple's WidgetKit docs are explicit: a
// frequently viewed widget gets "from 40 to 70 refreshes" a day, "roughly
// ... every 15 to 60 minutes", and timeline entries must be "at least about
// 5 minutes apart". Nothing written here changes that. So this widget shows
// what still reads true at that cadence - your matchup, who is yet to play,
// scores, and the latest play from each live game - rather than pretending to
// be the 10-second feed that the web app is.
//
// Setup is in ios/README.md. Put your Sleeper username in the widget's
// Parameter field when you add it to the screen.

/* ------------------------------------------------------------------ config */

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const SLEEPER = 'https://api.sleeper.app/v1';
const WEB_APP = 'https://kejjeh.github.io/nfl-gamezone/';

// Positions fetched separately. The whole player dictionary is 14.6 MB, which
// a widget extension has nowhere near the memory to parse; per position the
// largest (WR) is 2.1 MB and each is reduced to a slim record before the next
// request is made.
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

const CACHE_PLAYERS = 'gz-players.json';
const CACHE_LEAGUE = 'gz-league.json';
const CACHE_DATA = 'gz-last.json';

// A week, not a day. Names, positions and teams barely move, and a rebuild
// costs 5 MB of parsing - so it is worth doing rarely and in the app.
const PLAYERS_TTL = 7 * 24 * 3600 * 1000;
const LEAGUE_TTL = 6 * 3600 * 1000;

// Same noise filter as the web app: measured over a full game, 26 of 174 plays
// are timeouts or the coin toss, and "Official Timeout at 03:09" is not worth
// one of the three lines a lock screen widget has.
const DROP_PLAY = /^\s*(official timeout|timeout|coin toss|end quarter|two-minute warning)/i;

// ESPN and Sleeper disagree on a few abbreviations.
const TEAM_ALIASES = {
  WSH: 'WAS', WAS: 'WSH', JAX: 'JAC', JAC: 'JAX', LV: 'LVR', LVR: 'LV',
};

/* ------------------------------------------------------------------- store */

// Resolved on first use, not at import: the Node harness in tools/ installs its
// stubs around this file, and an eager FileManager call would run before them.
let _fm = null;
const fm = () => (_fm = _fm || FileManager.local());
const pathFor = (name) => fm().joinPath(fm().documentsDirectory(), name);

function readCache(name, maxAge) {
  try {
    const p = pathFor(name);
    if (!fm().fileExists(p)) return null;
    const raw = JSON.parse(fm().readString(p));
    if (maxAge && Date.now() - (raw.at || 0) > maxAge) return null;
    return raw.value;
  } catch (e) {
    return null;
  }
}

function writeCache(name, value) {
  try {
    fm().writeString(pathFor(name), JSON.stringify({ at: Date.now(), value }));
  } catch (e) {
    /* a full disk should not take the widget down */
  }
}

async function getJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  return req.loadJSON();
}

/* -------------------------------------------------------------------- data */

const sameTeam = (a, b) => {
  if (!a || !b) return false;
  const x = String(a).toUpperCase(), y = String(b).toUpperCase();
  return x === y || TEAM_ALIASES[x] === y || TEAM_ALIASES[y] === x;
};

function normalizeGames(json) {
  const out = [];
  for (const ev of json.events || []) {
    const comp = (ev.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === 'home') || cs[0] || {};
    const away = cs.find((c) => c.homeAway === 'away') || cs[1] || {};
    const st = ev.status || {};
    const sit = comp.situation || {};
    const last = (sit.lastPlay || {}).text || '';

    out.push({
      id: ev.id,
      state: (st.type || {}).state || 'pre',
      detail: (st.type || {}).shortDetail || '',
      period: st.period || 0,
      clock: st.displayClock || '',
      date: ev.date,
      isRedZone: !!sit.isRedZone,
      downDistance: sit.downDistanceText || '',
      lastPlay: DROP_PLAY.test(last) ? '' : last.trim(),
      home: { abbr: (home.team || {}).abbreviation || '??', score: Number(home.score) || 0 },
      away: { abbr: (away.team || {}).abbreviation || '??', score: Number(away.score) || 0 },
    });
  }
  return out;
}

// Slim player map: id -> [name, position, team]. Built one position at a time
// so peak memory stays near the largest single response rather than the sum.
async function buildPlayerMap() {
  const map = {};
  for (const pos of POSITIONS) {
    let chunk;
    try {
      chunk = await getJSON(`${SLEEPER}/players/nfl?position=${pos}`);
    } catch (e) {
      continue;
    }
    for (const id of Object.keys(chunk)) {
      const p = chunk[id];
      if (!p || !p.team) continue;            // free agents are not playing today
      map[id] = [p.full_name || p.last_name || id, p.position || pos, p.team];
    }
    chunk = null;
  }
  return map;
}

async function loadPlayers() {
  const fresh = readCache(CACHE_PLAYERS, PLAYERS_TTL);
  if (fresh) return fresh;

  const stale = readCache(CACHE_PLAYERS, 0);      // any age

  // Measured: the six position requests total 5.00 MB, the largest single one
  // 2.1 MB (WR). That is comfortable in the app and a gamble in a widget
  // extension, which gets a small fraction of an app's memory. So a widget
  // prefers a stale map over rebuilding, and only rebuilds when there is
  // nothing at all to fall back on.
  if (stale && config.runsInWidget) return stale;

  const map = await buildPlayerMap();
  if (Object.keys(map).length) {
    writeCache(CACHE_PLAYERS, map);
    return map;
  }
  return stale || {};
}

async function resolveLeague(username) {
  const cached = readCache(CACHE_LEAGUE, LEAGUE_TTL);
  if (cached && cached.username === username) return cached;

  const user = await getJSON(`${SLEEPER}/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) throw new Error(`No Sleeper user "${username}"`);

  let week = 1;
  try {
    const st = await getJSON(`${SLEEPER}/state/nfl`);
    week = st.week || 1;
  } catch (e) { /* fall through with week 1 */ }

  const season = new Date().getFullYear();
  const leagues = await getJSON(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${season}`);
  if (!leagues || !leagues.length) throw new Error('No leagues this season');
  const league = leagues[0];

  const rosters = await getJSON(`${SLEEPER}/league/${league.league_id}/rosters`);
  const mine = (rosters || []).find((r) => r.owner_id === user.user_id);

  const value = {
    username,
    leagueId: league.league_id,
    leagueName: league.name,
    rosterId: mine ? mine.roster_id : null,
    week,
  };
  writeCache(CACHE_LEAGUE, value);
  return value;
}

async function loadFantasy(username, games, players) {
  const cfg = await resolveLeague(username);
  if (!cfg.rosterId) return null;

  const matchups = await getJSON(`${SLEEPER}/league/${cfg.leagueId}/matchups/${cfg.week}`);
  const mine = (matchups || []).find((m) => m.roster_id === cfg.rosterId);
  if (!mine) return { leagueName: cfg.leagueName, week: cfg.week, noMatchup: true };

  const opp = mine.matchup_id != null
    ? (matchups || []).find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== cfg.rosterId)
    : null;

  const starters = (mine.starters || []).filter(Boolean);
  const pts = mine.players_points || {};

  // Which of my starters have not kicked off. This is the question a phone
  // glance is actually asking on a Sunday afternoon.
  const rows = [];
  let toPlay = 0;
  for (const pid of starters) {
    const rec = players[pid];
    const team = rec ? rec[2] : (/^[A-Z]{2,4}$/.test(pid) ? pid : null);
    const game = team ? games.find((g) => sameTeam(g.home.abbr, team) || sameTeam(g.away.abbr, team)) : null;
    const state = game ? game.state : null;
    if (state === 'pre') toPlay += 1;
    rows.push({
      id: pid,
      name: rec ? rec[0] : pid,
      pos: rec ? rec[1] : '',
      team: team || '',
      state,
      points: Number(pts[pid]) || 0,
      clock: game && game.state === 'in' ? `Q${game.period} ${game.clock}` : null,
    });
  }

  return {
    leagueName: cfg.leagueName,
    week: cfg.week,
    mine: Number(mine.points) || 0,
    opp: opp ? Number(opp.points) || 0 : null,
    starters: rows,
    toPlay,
    // knownNames is false when the player cache has not been built yet, so the
    // caller can show counts instead of a list of raw Sleeper ids.
    knownNames: rows.some((r) => r.name !== r.id),
  };
}

async function loadData(username) {
  const scoreboard = await getJSON(`${ESPN}/scoreboard`);
  const games = normalizeGames(scoreboard);

  let players = {};
  let fantasy = null;
  let error = null;

  if (username) {
    try {
      players = await loadPlayers();
      fantasy = await loadFantasy(username, games, players);
    } catch (e) {
      error = e.message || String(e);
    }
  }

  const live = games.filter((g) => g.state === 'in');
  const plays = live
    .map((g) => {
      // Of 7 live games measured, 2 carried no usable lastPlay - either absent
      // or filtered as noise. A red-zone game is exactly the one you want to
      // see, so give it the down and distance rather than dropping it.
      const text = g.lastPlay
        || (g.isRedZone ? `red zone${g.downDistance ? `, ${g.downDistance}` : ''}` : '');
      if (!text) return null;
      return {
        away: g.away.abbr,
        home: g.home.abbr,
        text,
        redZone: g.isRedZone,
        clock: `Q${g.period} ${g.clock}`,
      };
    })
    .filter(Boolean);

  return {
    at: Date.now(),
    games,
    live,
    upcoming: games.filter((g) => g.state === 'pre'),
    finished: games.filter((g) => g.state === 'post'),
    plays,
    fantasy,
    error,
  };
}

/* ------------------------------------------------------------------ render */

const C = {
  bg: new Color('#0a0b0e'),
  surface: new Color('#181b22'),
  fg: new Color('#e9ecf1'),
  fg2: new Color('#98a1b0'),
  fg3: new Color('#7a8494'),
  mine: new Color('#46d17f'),
  rz: new Color('#ff5c5c'),
  accent: new Color('#5b9dff'),
  score: new Color('#ffb02e'),
};

const isAccessory = (family) => String(family || '').startsWith('accessory');

function addLine(parent, text, { font, color, limit = 1, scale = 0.7 } = {}) {
  const t = parent.addText(String(text));
  if (font) t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = limit;
  t.minimumScaleFactor = scale;
  return t;
}

// Lock screen widgets are rendered by the system in a single tinted colour, so
// hierarchy there has to come from weight and size, not from colour.
function tint(family, color) {
  return isAccessory(family) ? null : color;
}

function matchupLine(f) {
  if (!f) return null;
  if (f.noMatchup) return `${f.leagueName} - no matchup`;
  const opp = f.opp == null ? '--' : f.opp.toFixed(1);
  return `${f.mine.toFixed(1)} - ${opp}`;
}

// A widget line is 30-70 characters. ESPN's play text is routinely 120 and
// spends a third of it on things nobody glances at a phone to read: the
// formation, the tackler, and a penalty clause bolted onto the end.
function compressPlay(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();

  // Leading parentheticals: a clock, a formation, or both, as in
  // "(14:52) (No Huddle) J.Love scrambles right end for 3 yards".
  let t = raw;
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/^\([^)]*\)\s*/, '');
    if (next === t || !next) break;          // never strip the whole string away
    t = next;
  }

  t = t
    .replace(/\s*\.?\s*PENALTY\b.*$/i, '')   // "... PENALTY on DAL-71, Holding, 10 yards"
    // "... field goal is GOOD, Center-Z.Wood, Holder-R.Wright" - 32 characters
    // of long snapper, on a line that has 68 to spend.
    .replace(/,\s*(?:Center|Holder|Snapper|Kicker)-[^,]*/gi, '')
    .replace(/\s*\[[^\]]*\]/g, '')           // "[D.Trader]" - the tackler
    .replace(/\s*\([^)]*\)\s*\.?\s*$/, '')   // "(D.Tranquill)." - also the tackler
    .replace(/\s+/g, ' ')
    .replace(/\s*\.\s*$/, '')
    .trim();

  // Some plays are nothing but a parenthetical - "(Brandon Aubrey Kick)" - and
  // compressing one of those to nothing left the widget showing a bare
  // "DAL-IND" with no play at all. Unwrap rather than drop.
  if (t) return t;
  return raw.replace(/^\s*\(|\)\s*$/g, '').trim() || raw;
}

function shortPlay(p, max) {
  const line = `${p.away}-${p.home} ${compressPlay(p.text)}`;
  return max && line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function renderAccessoryInline(w, d) {
  const f = d.fantasy;
  const bits = [];
  if (f && !f.noMatchup) bits.push(matchupLine(f));
  bits.push(`${d.live.length} live`);
  if (f && !f.noMatchup && f.knownNames && f.toPlay) bits.push(`${f.toPlay} to play`);
  addLine(w, bits.join(' · '));
}

function renderAccessoryCircular(w, d) {
  const f = d.fantasy;
  const stack = w.addStack();
  stack.layoutVertically();
  stack.addSpacer();
  if (f && !f.noMatchup) {
    addLine(stack, f.mine.toFixed(1), { font: Font.boldSystemFont(16), scale: 0.5 });
    addLine(stack, f.opp == null ? '--' : f.opp.toFixed(1), { font: Font.systemFont(11), scale: 0.5 });
  } else {
    addLine(stack, String(d.live.length), { font: Font.boldSystemFont(18) });
    addLine(stack, 'live', { font: Font.systemFont(10) });
  }
  stack.addSpacer();
}

function renderAccessoryRectangular(w, d) {
  const f = d.fantasy;

  if (f && !f.noMatchup) {
    const head = w.addStack();
    head.layoutHorizontally();
    head.centerAlignContent();
    addLine(head, matchupLine(f), { font: Font.boldSystemFont(15), scale: 0.6 });
    head.addSpacer();
    if (f.knownNames && f.toPlay) {
      addLine(head, `${f.toPlay} to play`, { font: Font.systemFont(10) });
    }
  } else {
    addLine(w, `${d.live.length} games live`, { font: Font.boldSystemFont(14) });
  }

  // The rectangle is about 34 characters wide and has room for three lines of
  // 11pt text. Two plays clipped at 34 each say less than one play allowed to
  // wrap over the two remaining lines, so show one. Red zone first: that is
  // where something is about to happen.
  const ordered = d.plays.slice().sort((a, b) => (b.redZone ? 1 : 0) - (a.redZone ? 1 : 0));
  const p = ordered[0];
  if (!p) {
    addLine(w, d.live.length ? 'Waiting for a play…' : nextKickoffLabel(d), {
      font: Font.systemFont(11), limit: 2,
    });
    return;
  }
  addLine(w, (p.redZone ? '● ' : '') + shortPlay(p, 68), {
    font: Font.systemFont(11), limit: 2, scale: 0.6,
  });
}

function slateLine(d) {
  const rz = d.plays.filter((p) => p.redZone).length;
  const bits = [];
  if (rz) bits.push(`${rz} in the red zone`);
  if (d.finished.length) bits.push(`${d.finished.length} final`);
  if (d.upcoming.length) bits.push(`${d.upcoming.length} to come`);
  return bits.join(' · ') || 'Games under way';
}

function nextKickoffLabel(d) {
  if (d.live.length) return `${d.live.length} live`;
  const next = d.upcoming.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  if (!next) return 'No games today';
  const t = new Date(next.date);
  const when = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Next: ${next.away.abbr} @ ${next.home.abbr} ${when}`;
}

function scoreRow(parent, g, family) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.spacing = 4;

  if (g.isRedZone) addLine(row, '●', { font: Font.systemFont(9), color: tint(family, C.rz) });

  addLine(row, `${g.away.abbr} ${g.away.score}`, {
    font: Font.systemFont(12), color: tint(family, C.fg),
  });
  addLine(row, '–', { font: Font.systemFont(12), color: tint(family, C.fg3) });
  addLine(row, `${g.home.score} ${g.home.abbr}`, {
    font: Font.systemFont(12), color: tint(family, C.fg),
  });
  row.addSpacer();
  addLine(row, g.state === 'in' ? `Q${g.period} ${g.clock}` : g.detail, {
    font: Font.systemFont(10), color: tint(family, C.fg3), scale: 0.6,
  });
}

function renderHome(w, d, family) {
  const f = d.fantasy;
  w.backgroundColor = C.bg;

  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  addLine(head, 'GAMEZONE', { font: Font.boldSystemFont(10), color: C.fg3 });
  head.addSpacer();
  addLine(head, `${d.live.length} live`, { font: Font.systemFont(10), color: C.mine });
  w.addSpacer(6);

  if (f && !f.noMatchup) {
    const score = w.addStack();
    score.layoutHorizontally();
    score.centerAlignContent();
    addLine(score, f.mine.toFixed(1), {
      font: Font.boldSystemFont(family === 'small' ? 22 : 26),
      color: f.opp != null && f.mine >= f.opp ? C.mine : C.fg,
      scale: 0.6,
    });
    addLine(score, '  –  ', { font: Font.systemFont(13), color: C.fg3 });
    addLine(score, f.opp == null ? '--' : f.opp.toFixed(1), {
      font: Font.systemFont(family === 'small' ? 20 : 24), color: C.fg2, scale: 0.6,
    });
    score.addSpacer();

    addLine(w, f.knownNames
      ? (f.toPlay ? `${f.toPlay} yet to play` : 'all players under way or done')
      : `Week ${f.week}`,
      { font: Font.systemFont(10), color: C.fg3 });
  } else if (d.error) {
    addLine(w, d.error, { font: Font.systemFont(11), color: C.fg2, limit: 2 });
  } else {
    // nextKickoffLabel leads with the live count when games are on, which the
    // header has already said - so ask it only when nothing is live. With no
    // league connected there is no week number either, so say something that
    // is actually known.
    addLine(w, d.live.length ? slateLine(d) : nextKickoffLabel(d),
      { font: Font.systemFont(12), color: C.fg2, limit: 2 });
  }

  w.addSpacer(8);

  if (family === 'small') {
    // Room for one thing only, and the latest play is the one that changes.
    const p = d.plays[0];
    if (p) addLine(w, shortPlay(p, 84), { font: Font.systemFont(10), color: C.fg2, limit: 3 });
    w.addSpacer();
    return;
  }

  // medium and large: recent plays, then scores if there is room
  const playCount = family === 'large' ? 4 : 2;
  const ordered = d.plays.slice().sort((a, b) => (b.redZone ? 1 : 0) - (a.redZone ? 1 : 0));
  for (const p of ordered.slice(0, playCount)) {
    const row = w.addStack();
    row.layoutHorizontally();
    addLine(row, p.redZone ? '● ' : '  ', { font: Font.systemFont(9), color: C.rz });
    addLine(row, shortPlay(p, family === 'large' ? 112 : 108), {
      font: Font.systemFont(10), color: C.fg2, limit: 2,
    });
    w.addSpacer(3);
  }

  if (family === 'large') {
    w.addSpacer(6);
    addLine(w, 'LIVE', { font: Font.boldSystemFont(9), color: C.fg3 });
    w.addSpacer(3);
    for (const g of d.live.slice(0, 6)) scoreRow(w, g, family);

    if (f && f.knownNames && f.starters && f.starters.length) {
      w.addSpacer(6);
      addLine(w, 'YOUR LINEUP', { font: Font.boldSystemFont(9), color: C.fg3 });
      w.addSpacer(3);
      for (const s of f.starters.slice(0, 5)) {
        const row = w.addStack();
        row.layoutHorizontally();
        row.centerAlignContent();
        addLine(row, s.pos, { font: Font.systemFont(9), color: C.fg3 });
        row.addSpacer(5);
        addLine(row, s.name, { font: Font.systemFont(11), color: C.fg });
        row.addSpacer();
        addLine(row, s.state === 'pre' ? '--' : s.points.toFixed(1), {
          font: Font.systemFont(11),
          color: s.state === 'pre' ? C.fg3 : C.fg,
        });
      }
    }
  }

  w.addSpacer();
}

function buildWidget(d, family) {
  const w = new ListWidget();
  w.url = WEB_APP;

  // Ask for a refresh sooner when games are live. The system is free to ignore
  // this - the budget is theirs, not ours - but asking costs nothing.
  const mins = d.live.length ? 15 : 60;
  w.refreshAfterDate = new Date(Date.now() + mins * 60 * 1000);

  if (isAccessory(family)) {
    try { w.addAccessoryWidgetBackground = true; } catch (e) { /* older Scriptable */ }
    if (family === 'accessoryInline') renderAccessoryInline(w, d);
    else if (family === 'accessoryCircular') renderAccessoryCircular(w, d);
    else renderAccessoryRectangular(w, d);
    return w;
  }

  w.setPadding(12, 12, 12, 12);
  renderHome(w, d, family || 'medium');
  return w;
}

function errorWidget(message, family) {
  const w = new ListWidget();
  w.url = WEB_APP;
  if (isAccessory(family)) {
    try { w.addAccessoryWidgetBackground = true; } catch (e) { /* older Scriptable */ }
    addLine(w, 'GameZone', { font: Font.boldSystemFont(13) });
    addLine(w, message, { font: Font.systemFont(11), limit: 2 });
    return w;
  }
  w.backgroundColor = C.bg;
  w.setPadding(12, 12, 12, 12);
  addLine(w, 'GameZone', { font: Font.boldSystemFont(13), color: C.fg });
  w.addSpacer(4);
  addLine(w, message, { font: Font.systemFont(11), color: C.fg2, limit: 4 });
  return w;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const family = config.widgetFamily || 'medium';
  const username = (args.widgetParameter || '').trim() || null;

  let data;
  try {
    data = await loadData(username);
    writeCache(CACHE_DATA, data);
  } catch (e) {
    // A widget that goes blank the moment the network hiccups is worse than
    // one showing a number from twenty minutes ago, clearly labelled.
    const stale = readCache(CACHE_DATA, 6 * 3600 * 1000);
    if (!stale) {
      const w = errorWidget(String((e && e.message) || e), family);
      return finish(w);
    }
    data = stale;
    data.stale = true;
  }

  const w = buildWidget(data, family);
  return finish(w);
}

function finish(w) {
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else {
    // Previewing from inside Scriptable.
    const family = config.widgetFamily || 'medium';
    if (family === 'small') w.presentSmall();
    else if (family === 'large') w.presentLarge();
    else if (isAccessory(family)) w.presentSmall();
    else w.presentMedium();
  }
  Script.complete();
}

// Scriptable defines module.exports itself, so the usual "am I a module?" check
// is the wrong way round here - it would be true on the device and the widget
// would never run. Detect Node instead, which is what the harness in
// tools/widget-preview.mjs is. No top-level await: this file has to stay
// loadable by CommonJS, and Scriptable keeps running until Script.complete().
const IN_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

if (IN_NODE) {
  module.exports = {
    main, finish, loadData, buildWidget, errorWidget,
    normalizeGames, shortPlay, compressPlay, sameTeam,
  };
} else {
  main().catch((err) => {
    const w = errorWidget(String((err && err.message) || err), config.widgetFamily || 'medium');
    finish(w);
  });
}
