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
import * as bets from './bets.js';
import * as betsUI from './bets-ui.js';
import * as push from './push.js';
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
// Games whose full play log has been pulled. Every game is fetched whole
// exactly once and tailed thereafter.
//
// The tail alone is not enough. It is a rolling window, so a game that
// kicked off before the page loaded contributes only its last few plays:
// scrolling back through the day finds nothing, and anything derived from
// play text silently loses its history - which is how field-goal distances
// went missing and a kicker scored 4 instead of 13. One full pull is ~37 KB
// gzipped, paid once per game.
const fullyLoaded = new Set();

function playTargets() {
  const seen = new Set();
  const out = [];
  for (const g of liveGames()) { out.push(g); seen.add(g.id); }

  // Finished games are worth one pull each so the morning slate is still in
  // the feed when you open the page in the evening.
  for (const g of state.games.values()) {
    if (g.state === 'post' && !fullyLoaded.has(g.id) && !seen.has(g.id)) out.push(g);
  }
  return out;
}

async function pollPlays() {
  const games = playTargets();
  if (!games.length) return;

  const batches = [];
  await pool(games, 4, async (g) => {
    try {
      const whole = !fullyLoaded.has(g.id);
      const plays = whole
        ? await espn.fetchAllPlays(g.id)
        : await espn.fetchPlaysTail(g.id);
      if (whole && plays.length) fullyLoaded.add(g.id);
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
  rail.render();                            // starter counts per game
  panel.render();                           // My Team points and game states
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
  announceBets();
}

// Bets move when the box score does, so this is the only place that needs to
// look. Alerts stay suppressed until the backlog has been ingested, otherwise
// opening the page mid-afternoon replays every leg that already hit.
function announceBets() {
  const events = bets.pollAlerts();
  if (!state.primed || !events.length) return;

  // Loudest first, and only one notification per poll - a parlay whose six
  // legs all tick at once should be one buzz, not six.
  events.sort((a, b) => b.priority - a.priority);
  const top = events[0];

  if (top.priority >= 1) {
    if (state.settings.sound) {
      if (top.kind === 'hit') alerts.chimeTD();
      else if (top.kind === 'bust') alerts.chimeRedZone();
      else alerts.chimeMine();
    }
    const more = events.length > 1 ? ` (+${events.length - 1} more)` : '';
    alerts.notify(bets.eventTitle(top), bets.describeEvent(top) + more);
  }

  for (const ev of events) console.log('[bets]', bets.describeEvent(ev));
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

  // Once a league is connected, your own lineup is the most useful thing the
  // panel can show, so open on it - unless the tab was chosen by hand.
  if (!state.panel.userPicked) state.panel.tab = 'team';

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
  // The rosters are also the only source of player positions - the box-score
  // summaries carry none - so they load first and the player table is rebuilt
  // the moment they land. Doing this ahead of Sleeper means the leaders
  // board's position filter works even when no league is connected.
  try {
    await espn.loadRosters((done, total) => {
      state.bridge.progress = `${done}/${total}`;
    });
    boxscore.rebuildPlayerTable();
    panel.render();
  } catch (err) {
    console.warn('[bridge] rosters failed', err);
  }

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

/* ---------- phone layout ---------- */

// One pane at a time on a phone, switched from the bottom bar. The breakpoint
// matches the CSS so the two can never disagree about what "phone" means.
// Mirrors the phone query in app.css - a narrow screen, or a short one that is
// not a desktop. Changing one without the other splits the layout from the
// behaviour that drives it.
const PHONE = window.matchMedia('(max-width: 700px), (max-height: 500px) and (max-width: 900px)');

function setMobileView(view) {
  document.body.dataset.mview = view;
  for (const b of document.querySelectorAll('#mnav [data-mview]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mview === view));
  }
  // Each pane keeps its own scroll position, so a switch starts at the top of
  // whatever was just opened rather than halfway down it.
  const pane = view === 'games' ? document.getElementById('rail')
             : view === 'stats' ? document.getElementById('panel')
             : document.getElementById('feed');
  pane?.scrollTo?.(0, 0);
}

// The segmented filter lives in the header on a desktop and in the chip row on
// a phone. Moving the element keeps one set of buttons and one handler.
function placeFilters() {
  const filters = document.getElementById('filters');
  const chips = document.getElementById('type-filters');
  const headerSlot = document.querySelector('.hdr-right');
  if (!filters || !chips || !headerSlot) return;

  if (PHONE.matches) {
    if (filters.parentElement !== chips) chips.prepend(filters);
  } else if (filters.parentElement !== headerSlot) {
    headerSlot.prepend(filters);
  }
}

let wasPhone = null;

function applyLayout() {
  placeFilters();

  // The feed keeps fewer cards on a phone, so crossing the breakpoint has to
  // rebuild it for the new ceiling to mean anything. Only on an actual
  // crossing: this runs on every resize tick.
  if (wasPhone !== null && wasPhone !== PHONE.matches) feed.rebuild();
  wasPhone = PHONE.matches;

  if (PHONE.matches) {
    if (!document.body.dataset.mview) setMobileView('feed');
    // The phone shows one pane at a time, so the desktop's "panel closed"
    // state is meaningless here and would hide the stats view outright.
    document.body.classList.remove('panel-closed');
  } else {
    delete document.body.dataset.mview;
    document.body.classList.toggle('panel-closed', !state.panel.open);
  }
  panel.syncToggle();
}

function wireMobile() {
  document.getElementById('mnav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mview]');
    if (btn) setMobileView(btn.dataset.mview);
  });

  // Three signals for one event. matchMedia is the correct one, but iOS has a
  // long history of reporting stale dimensions through a rotation, and the
  // handler is idempotent, so the cheap belt-and-braces is worth more than the
  // tidiness of a single listener.
  let pending = null;
  const relayout = () => {
    clearTimeout(pending);
    pending = setTimeout(applyLayout, 80);
  };
  PHONE.addEventListener('change', relayout);
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);
}

// Registering the service worker is what makes the app installable; it is
// worth doing whether or not push is ever switched on, because it is also what
// gives the app an offline shell.
async function initPush() {
  if (!window.isSecureContext) return;          // file:// has no service worker
  await push.registerWorker();
  await push.loadConfig();
  await paintPush();
  push.syncBets();
}

async function paintPush() {
  const btn = document.getElementById('push-toggle');
  const msg = document.getElementById('push-msg');
  if (!btn || !msg) return;

  const st = await push.status();
  btn.setAttribute('aria-pressed', String(st.subscribed));
  btn.disabled = !st.supported || !st.configured;

  let text = '';
  if (!st.supported) text = 'This browser has no push support.';
  else if (!st.configured) {
    text = 'Not set up. Deploy the sender in worker/ and put its address in '
      + 'push-config.json. Until then, alerts only fire while this is open.';
  } else if (st.needsInstall) {
    text = 'On iPhone: Share → Add to Home Screen first. iOS will not '
      + 'deliver push to a Safari tab.';
  } else if (st.permission === 'denied') {
    text = 'Notifications are blocked for this site in your browser settings.';
  } else if (st.subscribed) text = 'On. Your phone will buzz when a leg hits or busts.';

  msg.textContent = text;
  msg.hidden = !text;

  // Only offer the test once there is somewhere to send it.
  const test = document.getElementById('push-test');
  if (test) test.hidden = !st.subscribed;
}

function wireSettings() {
  document.getElementById('push-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const msg = document.getElementById('push-msg');
    const say = (s) => { if (msg) { msg.textContent = s; msg.hidden = false; } };
    btn.disabled = true;
    say('Sending...');
    try {
      await push.sendTest();
      say('Sent. If nothing arrives, the phone is not receiving - check that '
        + 'you opened this from the Home Screen icon, not a Safari tab.');
    } catch (err) {
      say(String(err.message || err));
    }
    btn.disabled = false;
  });

  document.getElementById('push-toggle')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.disabled = true;
    try {
      if (on) await push.disable();
      else await push.enable();
    } catch (err) {
      const msg = document.getElementById('push-msg');
      if (msg) { msg.textContent = String(err.message || err); msg.hidden = false; }
    }
    btn.disabled = false;
    paintPush();
  });

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

    const msg = $('#notify-msg');

    if (key === 'notify' && next) {
      const perm = await alerts.requestNotifyPermission();
      if (perm !== 'granted') {
        state.settings.notify = false;
        renderToggles();
        // Next to the switch that was just clicked. This used to write into
        // the diagnostics box, which sits in another section and is rebuilt
        // every time settings opens, so the explanation vanished.
        msg.textContent = perm === 'denied'
          ? 'Your browser is blocking notifications for this site. Allow them in the site settings, then try again.'
          : perm === 'unsupported'
            ? 'This browser does not support desktop notifications.'
            : 'Notification permission was not granted.';
        msg.hidden = false;
        return;
      }
    }
    if (msg) { msg.hidden = true; msg.textContent = ''; }
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
    // On a phone the rail is its own screen, so selecting a game there should
    // move to the thing you selected it for rather than leave you in a list.
    if (PHONE.matches && state.filters.gameId) setMobileView('feed');
  });

  espn.loadTeams();
  bets.load();
  betsUI.wire(() => { panel.render(); push.syncBets(); });
  panel.wire();
  wireMobile();
  // Three columns need room; between the phone breakpoint and that, the panel
  // overlays the feed, so it starts closed - but only until you say otherwise.
  // Once you have opened or closed it yourself, that choice is what loads, at
  // any width: the panel re-closing itself on every reload read as the panel
  // disappearing. A phone ignores all of this - applyLayout() decides there.
  const savedPanel = store.get('panelOpen');
  if (typeof savedPanel === 'boolean') state.panel.open = savedPanel;
  else if (window.innerWidth < 1180) state.panel.open = false;
  applyLayout();
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

  // Prime the bet baseline from the first box-score pull, so a leg that was
  // already at 26 yards when the page opened does not announce itself as a
  // 26-yard gain.
  try {
    await pollBoxscores();
  } catch (err) {
    console.warn('[boot] first box score pull failed', err);
  }
  bets.resetAlertBaseline();
  state.primed = true;

  pollers.scoreboard.start();
  pollers.plays.start();
  pollers.matchups.start();
  pollers.boxscores.start();

  initSleeper();
  initBridge();
  initPush();

  // console access, and the hook the layout is checked through
  window.gz = { state, pollers, feed, bridge, espn, sleeper, bets, betsUI,
    applyLayout, setMobileView };
}

boot();
