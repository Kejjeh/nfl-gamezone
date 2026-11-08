// Boot and wiring.
import { INTERVALS } from './config.js';
import { state, emit, subscribe } from './state.js';
import * as store from './store.js';
import * as espn from './espn.js';
import * as sleeper from './sleeper.js';
import * as bridge from './bridge.js';
import * as feed from './feed.js';
import * as rail from './rail.js';
import * as matchup from './matchup.js';
import * as alerts from './alerts.js';
import * as boxscore from './boxscore.js';
import * as panel from './panel.js';
import { createPoller } from './poller.js';

const $ = (sel) => document.querySelector(sel);

/* ---------- helpers ---------- */

const liveGames = () => [...state.games.values()].filter((g) => g.state === 'in');
const anyLive = () => liveGames().length > 0;
const pace = (key) => (anyLive() ? INTERVALS[key] : INTERVALS.idle);

async function pool(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

/* ---------- polling ---------- */

async function pollScoreboard() {
  const { games, week } = await espn.fetchScoreboard({
    week: state.weekOverride,
    seasonType: state.seasonType,
  });

  if (week) state.week = week;

  for (const g of games) {
    state.games.set(g.id, g);

    // Red-zone entry: rising edge only.
    const prev = state.redZone.get(g.id);
    const now = g.state === 'in' && g.isRedZone;
    if (now && prev === false) alerts.onRedZoneEntry(g);
    state.redZone.set(g.id, now);
  }

  state.status.lastUpdate = Date.now();
  rail.render();
  renderStatus();
}

// Which games to pull plays for. Normally just the live ones. When a week is
// pinned via ?week=N the slate is usually finished, so completed games are
// pulled too - once each, since their plays will never change again.
const backfilled = new Set();

function playTargets() {
  const live = liveGames();
  if (!state.weekOverride) return live;
  const done = [...state.games.values()]
    .filter((g) => g.state === 'post' && !backfilled.has(g.id));
  for (const g of done) backfilled.add(g.id);
  return [...live, ...done];
}

async function pollPlays() {
  const games = playTargets();
  if (!games.length) return;

  const batches = [];
  await pool(games, 4, async (g) => {
    try {
      // A finished game gets pulled whole, once; a live one only its tail.
      const plays = g.state === 'post'
        ? await espn.fetchAllPlays(g.id)
        : await espn.fetchPlaysTail(g.id);
      batches.push(plays);
    } catch (err) {
      console.warn('[plays] failed', g.shortName, err);
    }
  });

  const all = batches.flat();
  if (all.length) feed.ingest(all);
  state.status.lastUpdate = Date.now();
  renderStatus();
}

async function pollMatchups() {
  if (!state.sleeper.leagueId) return;
  const week = state.sleeperWeek || state.week;
  try {
    await sleeper.refreshMatchups(week);
    state.sleeper.error = null;
  } catch (err) {
    state.sleeper.error = err.message;
  }
  matchup.render();
  if (state.bridge.ready) feed.rebuild();   // points and lineups changed
}

async function pollLeague() {
  if (!state.sleeper.leagueId) return;
  try {
    state.sleeper.rosters = await sleeper.getRosters(state.sleeper.leagueId);
  } catch (err) {
    console.warn('[sleeper] roster refresh failed', err);
  }
}

// Box scores are ~19 KB gzipped per game. Live games refresh on a slower
// cadence than plays; finished games are pulled once and then left alone,
// since their stats will never change again.
const boxDone = new Set();

async function pollBoxscores() {
  const live = liveGames().map((g) => g.id);
  const finishedOnce = [...state.games.values()]
    .filter((g) => g.state === 'post' && !boxDone.has(g.id))
    .map((g) => g.id);
  for (const id of finishedOnce) boxDone.add(id);

  const targets = [...live, ...finishedOnce];
  if (!targets.length) return;

  await boxscore.refresh(targets);
  panel.render();
}

const pollers = {
  scoreboard: createPoller('scoreboard', pollScoreboard, () => pace('scoreboard')),
  boxscores: createPoller('boxscores', pollBoxscores, () => pace('boxscores')),
  plays: createPoller('plays', pollPlays, () => pace('plays')),
  matchups: createPoller('matchups', pollMatchups, () => pace('matchups')),
  league: createPoller('league', pollLeague, () => INTERVALS.league),
};

/* ---------- status ---------- */

function renderStatus() {
  const el = $('#conn');
  const dot = $('#brand-dot');
  if (!el) return;

  const failing = pollers.scoreboard.failures + pollers.plays.failures;
  const live = anyLive();
  dot?.classList.toggle('live', live && !failing);

  if (failing) {
    el.className = 'num bad';
    el.textContent = 'reconnecting';
    return;
  }
  const age = Math.round((Date.now() - state.status.lastUpdate) / 1000);
  el.className = 'num';
  el.textContent = live ? `${age}s` : 'idle';
}
setInterval(renderStatus, 1000);

/* ---------- Sleeper ---------- */

async function connectSleeper(username, leagueId) {
  const league = await sleeper.connect(username, leagueId);
  store.set('sleeperUser', state.sleeper.username);
  store.set('sleeperLeague', state.sleeper.leagueId);

  try {
    const st = await sleeper.getNflState();
    state.sleeperWeek = st?.week || null;
  } catch (err) { /* fall back to ESPN's week */ }

  await pollMatchups();
  pollers.league.start();
  return league;
}

async function initSleeper() {
  const saved = store.get('sleeperUser');
  if (!saved) {
    if (!store.get('sleeperSkipped')) openSetup();
    matchup.render();
    return;
  }
  try {
    await connectSleeper(saved, store.get('sleeperLeague'));
  } catch (err) {
    state.sleeper.error = err.message;
    matchup.render();
  }
}

// The bridge needs ~950 KB of ESPN rosters and the Sleeper player dictionary.
// Both load in the background: the play feed is already running without them.
async function initBridge() {
  try {
    await sleeper.loadPlayers();
    await bridge.build((done, total) => {
      state.bridge.progress = `${done}/${total}`;
    });
    feed.rebuild();
    renderDiag();
  } catch (err) {
    console.warn('[bridge] build failed', err);
    state.bridge.error = err.message;
  }
}

/* ---------- setup modal ---------- */

function openSetup() {
  const saved = store.get('sleeperUser');
  if (saved) $('#su-name').value = saved;
  $('#setup').hidden = false;
  $('#su-name').focus();
}

function wireSetup() {
  const err = $('#su-err');

  $('#su-go').addEventListener('click', async () => {
    const name = $('#su-name').value.trim();
    if (!name) { err.textContent = 'Enter your Sleeper username.'; return; }
    err.textContent = 'Connecting…';
    try {
      const league = await connectSleeper(name);
      err.textContent = '';
      $('#setup').hidden = true;
      store.del('sleeperSkipped');
      matchup.render();
      renderSleeperInfo();
      console.log('[sleeper] connected to', league.name);
    } catch (e) {
      err.textContent = e.message;
    }
  });

  $('#su-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#su-go').click();
  });

  $('#su-skip').addEventListener('click', () => {
    store.set('sleeperSkipped', true);
    $('#setup').hidden = true;
    matchup.render();
  });

  // Clicking "Connect Sleeper" in the header strip.
  document.addEventListener('click', (e) => {
    if (e.target.id === 'mu-connect') openSetup();
  });
}

/* ---------- settings ---------- */

function loadSettings() {
  const s = store.get('settings');
  if (s) Object.assign(state.settings, s);
  if (state.settings.notify && typeof Notification !== 'undefined'
      && Notification.permission !== 'granted') {
    state.settings.notify = false;   // permission was revoked since last visit
  }
}

function saveSettings() { store.set('settings', state.settings); }

function renderToggles() {
  for (const btn of document.querySelectorAll('[data-setting]')) {
    btn.setAttribute('aria-pressed', String(!!state.settings[btn.dataset.setting]));
  }
}

function renderSleeperInfo() {
  const el = $('#set-sleeper');
  if (!el) return;
  const s = state.sleeper;
  el.textContent = s.leagueId
    ? `${s.username} — ${s.league?.name}\nroster ${s.myRosterId} · week ${state.sleeperWeek || state.week}`
    : 'not connected';
}

function renderDiag() {
  const el = $('#set-diag');
  if (!el) return;
  const b = state.bridge;
  const missing = bridge.coverageReport();
  const lines = [
    `games ${state.games.size} · plays ${state.plays.size}`,
    b.ready
      ? `bridge ${b.athleteToSleeper.size} athletes linked, ${b.unresolved.length} unresolved`
      : `bridge loading ${b.progress || ''}`,
  ];
  if (missing) {
    lines.push(missing.length
      ? `UNLINKED STARTERS (${missing.length}):\n  ` +
        missing.map((m) => `${m.name} (${m.pos} ${m.team})`).join('\n  ')
      : 'all league starters linked');
  }

  lines.push(`box scores ${state.boxscores.size} games · ${state.playerStats.size} stat lines`);

  // Fantasy points on the leaders board are computed here from box-score
  // totals, unlike the matchup strip which reads Sleeper's own numbers.
  // Cross-check the two so a scoring bug shows up as a number, not a guess.
  const v = boxscore.validate();
  if (!v) {
    lines.push('scoring check: needs Sleeper connected and box scores loaded');
  } else {
    const line = (label, b) => !b.n ? `  ${label}: none yet`
      : `  ${label}: ${b.exact}/${b.n} exact` +
        (b.off.length
          ? '\n' + b.off.map((r) => `    ${r.name} ours ${r.mine} vs Sleeper ${r.theirs} (${r.diff > 0 ? '+' : ''}${r.diff})`).join('\n')
          : '');
    lines.push(
      'scoring check vs Sleeper',
      line('final games', v.final),
      line('live games', v.live),
      '  (live gaps are sampling lag — ESPN’s box score runs ahead of Sleeper’s tally)',
    );
  }

  el.textContent = lines.join('\n');
}

function wireSettings() {
  $('#btn-settings').addEventListener('click', () => {
    renderToggles();
    renderSleeperInfo();
    renderDiag();
    $('#settings').hidden = false;
  });
  $('#set-close').addEventListener('click', () => { $('#settings').hidden = true; });

  $('#settings').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-setting]');
    if (!btn) return;
    const key = btn.dataset.setting;
    const next = !state.settings[key];

    if (key === 'notify' && next) {
      const perm = await alerts.requestNotifyPermission();
      if (perm !== 'granted') {
        state.settings.notify = false;
        renderToggles();
        $('#set-diag').textContent = `Notifications ${perm}. Allow them in your browser to enable this.`;
        return;
      }
    }
    if (key === 'sound' && next) alerts.unlockAudio();

    state.settings[key] = next;
    saveSettings();
    renderToggles();
  });

  $('#set-reset').addEventListener('click', () => {
    for (const k of ['espnTeams', 'espnRosters', 'sleeperPlayers']) store.del(k);
    location.reload();
  });

  // Dismiss overlays on backdrop click / Escape.
  for (const id of ['settings', 'setup']) {
    $(`#${id}`).addEventListener('click', (e) => {
      if (e.target.id === id) e.target.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('#settings').hidden = true;
    if (store.get('sleeperUser') || store.get('sleeperSkipped')) $('#setup').hidden = true;
  });

  // Any click is a user gesture: enough to let WebAudio start.
  document.addEventListener('click', () => { if (state.settings.sound) alerts.unlockAudio(); },
    { once: true });
}

/* ---------- boot ---------- */

function parseUrl() {
  const q = new URLSearchParams(location.search);
  const w = parseInt(q.get('week'), 10);
  if (w >= 1 && w <= 22) state.weekOverride = w;
  const t = parseInt(q.get('seasontype'), 10);
  if (t >= 1 && t <= 3) state.seasonType = t;
}

async function boot() {
  loadSettings();
  parseUrl();
  feed.wire();
  rail.wire();
  wireSetup();
  wireSettings();
  // Selecting a game in the rail filters the feed and swings the panel to
  // that game's box score; deselecting sends it back to the leaders board.
  subscribe((what) => {
    if (what !== 'filters') return;
    if (state.filters.gameId) state.panel.tab = 'game';
    else if (state.panel.tab === 'game') state.panel.tab = 'leaders';
    feed.rebuild();
    panel.render();
  });

  espn.loadTeams();
  panel.wire();
  // Three columns need room; below that the panel overlays, so start it closed.
  if (window.innerWidth < 1180) {
    state.panel.open = false;
    document.body.classList.add('panel-closed');
  }
  feed.showSkeleton();
  rail.render();            // renders its own skeleton while empty
  panel.render();

  // Ingest the existing backlog with alerts suppressed, then go live.
  try {
    await pollScoreboard();
    await pollPlays();
  } catch (err) {
    console.error('[boot] initial load failed', err);
  }
  feed.rebuild();
  state.primed = true;

  pollers.scoreboard.start();
  pollers.plays.start();
  pollers.matchups.start();
  pollers.boxscores.start();

  initSleeper();
  initBridge();

  window.gz = { state, pollers, feed, bridge, espn, sleeper };  // console access
}

boot();
