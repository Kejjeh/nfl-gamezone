// The unified play feed: every live game merged into one reverse-chronological
// stream. New cards are inserted in place rather than rebuilding the list, so
// scroll position and the entrance animation survive each poll.
//
// Plays are tiered by significance. A full Sunday pushes well over a thousand
// plays through here and most are a 4-yard run; if they all render identically
// the feed is unreadable. Only plays that matter get visual weight.
import { state } from './state.js';
import { FEED_CAP } from './config.js';
import * as espn from './espn.js';
import * as bridge from './bridge.js';
import * as alerts from './alerts.js';

const rendered = new Map();   // playId -> node

const BIG_GAIN = 20;

// Measured over a full game: 26 of 174 plays are timeouts or the coin toss.
// "Official Timeout at 11:12" carries no information for a viewer, and at 15%
// of the feed it is the single biggest source of noise. Dropped outright.
const DROP = /^(official timeout|timeout|coin toss)$/i;

// Clock and structure markers. Worth keeping for orientation, but they are
// never significant, whatever the field position.
const ADMIN = /^(end period|end of half|end of game|two-minute warning)$/i;

// Punts and kickoffs travel 40-60 yards by definition, so the big-gain rule
// would promote every single one of them.
const LONG_BY_NATURE = /^(kickoff|punt)$/i;

const isRedZonePlay = (p) =>
  (p.endYTE != null && p.endYTE <= 20) || (p.startYTE != null && p.startYTE <= 20);

// Play-type chips. ESPN's type vocabulary is granular (Rush, Pass Reception,
// Pass Incompletion, Sack, Pass Interception Return, ...), so these group it
// into the categories a viewer actually thinks in.
export const PLAY_TYPES = {
  rush: { label: 'Rush', test: (p) => /^(rush|rushing touchdown)$/i.test(p.type) },
  pass: {
    label: 'Pass',
    test: (p) => /^(pass reception|pass incompletion|passing touchdown)$/i.test(p.type),
  },
  sack: { label: 'Sack', test: (p) => /sack/i.test(p.type) },
  turnover: {
    label: 'Turnover',
    test: (p) => p.isTurnover || /interception|fumble recovery \(opponent\)/i.test(p.type),
  },
  scoring: { label: 'Score', test: (p) => p.scoringPlay },
  penalty: { label: 'Penalty', test: (p) => p.isPenalty || /^penalty$/i.test(p.type) },
  special: {
    label: 'Special',
    test: (p) => /punt|kickoff|field goal|extra point|kick return/i.test(p.type),
  },
};

function matchesTypes(p) {
  const sel = state.filters.types;
  if (!sel || !sel.size) return true;
  for (const key of sel) if (PLAY_TYPES[key]?.test(p)) return true;
  return false;
}

// log < note < key < score
function tierOf(p) {
  if (p.scoringPlay) return 'score';
  if (p.isTurnover) return 'key';
  if (p.fan) return 'key';
  if (ADMIN.test(p.type)) return 'log';
  if (isRedZonePlay(p)) return 'note';
  if (!LONG_BY_NATURE.test(p.type) && Math.abs(p.yards) >= BIG_GAIN) return 'note';
  if (p.isPenalty) return 'note';
  return 'log';
}

function passes(p) {
  if (DROP.test(p.type)) return false;
  const f = state.filters;
  if (f.gameId && p.eventId !== f.gameId) return false;
  if (f.athleteId && !(p.athleteIds || []).includes(f.athleteId)) return false;
  if (!matchesTypes(p)) return false;
  switch (f.mode) {
    case 'scoring': return p.scoringPlay;
    case 'redzone': return isRedZonePlay(p);
    case 'mine': return !!(p.fan && p.fan.side === 'mine');
    default: return true;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function tags(p) {
  const out = [];
  if (p.isTD) out.push('<span class="tag tag--td">TD</span>');
  else if (p.scoringPlay && /field goal/i.test(p.type)) out.push('<span class="tag tag--fg">FG</span>');
  else if (p.scoringPlay) out.push('<span class="tag tag--fg">Score</span>');
  if (p.isTurnover) out.push('<span class="tag tag--turn">Turnover</span>');
  // A clock marker that happens to sit inside the 20 is not a red-zone event.
  if (isRedZonePlay(p) && !p.scoringPlay && !ADMIN.test(p.type)) {
    out.push('<span class="tag tag--rz">Red zone</span>');
  }
  if (p.isPenalty && !p.scoringPlay) out.push('<span class="tag tag--pen">Flag</span>');
  return out.join('');
}

function card(p, game, isNew) {
  const tier = tierOf(p);
  const node = document.createElement('article');

  const cls = ['p', `p--${tier}`];
  if (p.fan) cls.push(p.fan.side === 'mine' ? 'p--mine' : 'p--opp');
  else if (p.isTurnover) cls.push('p--turnover');
  if (isNew) cls.push('is-new');
  node.className = cls.join(' ');

  node.dataset.ts = String(p.ts);
  node.dataset.seq = String(p.seq);

  // Team colour drives the accent rule and the score card wash, so a glance
  // tells you whose play it was without reading the abbreviation.
  const colour = p.teamId ? espn.teamColor(p.teamId) : null;
  if (colour) node.style.setProperty('--team', colour);

  const offense = p.teamId ? espn.teamAbbr(p.teamId) : null;
  let matchup = '';
  if (game) {
    const a = game.away.abbr;
    const h = game.home.abbr;
    matchup = offense === h
      ? `<span class="p-vs">${esc(a)} @</span> <span class="p-team">${esc(h)}</span>`
      : `<span class="p-team">${esc(a)}</span> <span class="p-vs">@ ${esc(h)}</span>`;
  }

  // The running score on a routine 3-yard run is pure repetition - the rail
  // already shows it, and it appears on every single line. Show it only where
  // it changed or matters.
  const score = game && tier !== 'log' ? `${p.awayScore}&ndash;${p.homeScore}` : '';
  const when = p.period ? `Q${p.period}${p.clock ? ' ' + p.clock : ''}` : '';

  let fan = '';
  if (p.fan) {
    const badge = p.fan.side === 'mine' ? 'Your starter' : 'Opponent';
    const who = p.fan.players.map((x) => {
      const pts = x.points != null
        ? `<span class="pt">${Number(x.points).toFixed(1)}</span>` : '';
      return `<span class="nm">${esc(x.name)}</span> ${pts}`;
    }).join('');
    fan = `<div class="p-fan"><span class="fan-badge">${badge}</span>${who}</div>`;
  }

  node.innerHTML =
    `<div class="p-head">
       ${matchup}
       <span class="p-sc num">${score}</span>
       <span class="p-clock num">${esc(when)}</span>
       ${tags(p)}
     </div>
     <div class="p-text">${esc((p.text || p.shortText || '').trim())}</div>
     ${fan}`;
  return node;
}

// Newest first. Plays from different games can arrive out of order, so insert
// by timestamp rather than always prepending.
function insert(list, node, ts, seq) {
  for (const child of list.children) {
    const cts = Number(child.dataset.ts || 0);
    if (ts > cts || (ts === cts && seq > Number(child.dataset.seq || 0))) {
      list.insertBefore(node, child);
      return;
    }
  }
  list.append(node);
}

function listEl() {
  const feed = document.getElementById('feed');
  let list = feed.querySelector('.feed-list');
  if (!list) {
    feed.replaceChildren();
    list = document.createElement('div');
    list.className = 'feed-list';
    // Screen readers announce new plays without stealing focus.
    list.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-relevant', 'additions');
    feed.append(list);
  }
  return list;
}

// Attach the fantasy classification. Done at render time because the bridge
// and the lineups load asynchronously, after the first plays are already in.
function annotate(p) {
  p.fan = state.bridge.ready ? bridge.classifyPlay(p) : null;
  return p;
}

export function ingest(plays, { flash = true } = {}) {
  const list = listEl();
  const fresh = [];

  for (const p of plays) {
    const seen = state.plays.get(p.id);
    state.plays.set(p.id, p);
    if (!seen) fresh.push(p);
  }

  // Oldest first so each insertion lands above the previous one.
  fresh.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  for (const p of fresh) {
    annotate(p);
    const game = state.games.get(p.eventId);
    alerts.onNewPlay(p, game);
    if (!passes(p)) continue;
    const node = card(p, game, flash && state.primed && state.settings.visual);
    rendered.set(p.id, node);
    insert(list, node, p.ts, p.seq);
  }

  trim(list);
  showEmptyIfNeeded(list);
  return fresh.length;
}

function trim(list) {
  while (list.children.length > FEED_CAP) {
    const last = list.lastElementChild;
    for (const [id, n] of rendered) if (n === last) { rendered.delete(id); break; }
    last.remove();
  }
}

// Full rebuild. Used on filter changes and once the bridge or lineups arrive,
// so badges appear on plays that were ingested before they were available.
export function rebuild() {
  const list = listEl();
  list.replaceChildren();
  rendered.clear();

  const all = [...state.plays.values()]
    .map(annotate)
    .filter(passes)
    .sort((a, b) => b.ts - a.ts || b.seq - a.seq)
    .slice(0, FEED_CAP);

  const frag = document.createDocumentFragment();
  for (const p of all) {
    const node = card(p, state.games.get(p.eventId), false);
    rendered.set(p.id, node);
    frag.append(node);
  }
  list.append(frag);
  showEmptyIfNeeded(list);
}

export function showSkeleton() {
  const feed = document.getElementById('feed');
  const rows = Array.from({ length: 7 }, (_, i) => {
    const w = [72, 54, 83, 61, 77, 48, 68][i];
    return `<div class="skel-row">
        <div class="skel skel-line" style="width:${w > 65 ? 110 : 90}px"></div>
        <div class="skel skel-line" style="width:${w}%;height:11px"></div>
      </div>`;
  }).join('');
  feed.innerHTML = `<div class="feed-list">${rows}</div>`;
}

function showEmptyIfNeeded(list) {
  const feed = document.getElementById('feed');
  feed.querySelector('.empty')?.remove();
  if (list.children.length) return;

  const live = [...state.games.values()].filter((g) => g.state === 'in').length;
  const next = [...state.games.values()]
    .filter((g) => g.state === 'pre' && g.date)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  let msg;
  if (state.filters.mode !== 'all' || state.filters.gameId) {
    msg = '<b>Nothing matches yet</b>Plays will appear here as they happen.';
  } else if (live) {
    msg = '<b>Waiting on the first plays</b>Games are under way.';
  } else if (next) {
    const d = new Date(next.date);
    msg = `<b>No games in progress</b>Next kickoff ${d.toLocaleString([], {
      weekday: 'long', hour: 'numeric', minute: '2-digit' })} &middot; ${esc(next.shortName)}`;
  } else {
    msg = '<b>No games scheduled</b>Add <code>?week=9</code> to the URL to replay a past week.';
  }

  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = msg;
  feed.append(d);
}

/* ---------- following one player ---------- */

// Following narrows the feed to a single athlete across every game. It has to
// announce itself: a filter that silently empties the feed with no visible
// cause is indistinguishable from the app being broken.
export function setFollow(athleteId, name) {
  const id = athleteId == null ? null : String(athleteId);
  const f = state.filters;
  const same = f.athleteId === id;
  f.athleteId = same ? null : id;
  f.athleteName = same ? null : (name || '');
  renderFollowChip();
  const feedEl = document.getElementById('feed');
  if (feedEl) feedEl.scrollTop = 0;
  rebuild();
  return f.athleteId;
}

export function clearFollow() {
  state.filters.athleteId = null;
  state.filters.athleteName = null;
  renderFollowChip();
  rebuild();
}

function renderFollowChip() {
  const el = document.getElementById('follow-chip');
  if (!el) return;
  const f = state.filters;
  if (!f.athleteId) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="fc-label">Following</span>
    <span class="fc-name">${escAttr(f.athleteName || 'player')}</span>
    <button type="button" class="fc-x" id="follow-clear"
      aria-label="Stop following ${escAttr(f.athleteName || 'player')}">&times;</button>`;
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function wire() {
  const bar = document.getElementById('filters');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.filters.mode = btn.dataset.mode;
    for (const b of bar.children) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    document.getElementById('feed').scrollTop = 0;
    rebuild();
  });

  // Play-type chips: multi-select, none selected means no type filter.
  const types = document.getElementById('type-filters');
  types.innerHTML = '<span class="follow-chip" id="follow-chip" hidden></span>'
    + Object.entries(PLAY_TYPES).map(([k, t]) =>
    `<button type="button" class="chip" data-type="${k}" aria-pressed="false">${t.label}</button>`
  ).join('') + '<button type="button" class="chip chip-clear" id="type-clear" hidden>Clear</button>';

  types.addEventListener('click', (e) => {
    if (e.target.closest('#follow-clear')) { clearFollow(); return; }
    const clear = e.target.closest('#type-clear');
    if (clear) {
      state.filters.types.clear();
    } else {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      const k = btn.dataset.type;
      if (state.filters.types.has(k)) state.filters.types.delete(k);
      else state.filters.types.add(k);
    }
    for (const b of types.querySelectorAll('[data-type]')) {
      b.setAttribute('aria-pressed', String(state.filters.types.has(b.dataset.type)));
    }
    document.getElementById('type-clear').hidden = state.filters.types.size === 0;
    document.getElementById('feed').scrollTop = 0;
    rebuild();
  });
}
