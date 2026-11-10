// The unified play feed: every live game merged into one reverse-chronological
// stream. New cards are inserted in place rather than rebuilding the list, so
// scroll position and the entrance animation survive each poll.
//
// Plays are tiered by significance. A full Sunday pushes well over a thousand
// plays through here and most are a 4-yard run; if they all render identically
// the feed is unreadable. Only plays that matter get visual weight.
import { state } from './state.js';
import { FEED_CAP, FEED_CAP_SMALL } from './config.js';

// A phone renders the same cards on a fraction of the hardware, and a card it
// has to scroll a thousand rows to reach is a card nobody reads. Cap lower
// there; the whole day is still in state.plays for filtering and stats.
const cap = () => (window.innerWidth <= 700 ? FEED_CAP_SMALL : FEED_CAP);
import * as espn from './espn.js';
import * as bridge from './bridge.js';
import * as alerts from './alerts.js';
import * as box from './boxscore.js';

const rendered = new Map();   // playId -> node

const BIG_GAIN = 20;

// How far a play has to move the game to count as a big one on its own.
// 5 points of win probability. Measured over a full 197-play game: 13 plays
// clear it, 2 of them by more than 20 - selective enough to stay a tier
// rather than swallow the feed.
const BIG_SWING = 0.05;

// A kickoff's swing belongs to the play before it. ESPN's entry for a scoring
// play carries the number from before the score, so the jump lands on
// whatever follows - which is the kickoff. Measured on a Week 8 slate: 12 of
// the 160 plays this rule promoted were kickoffs, one of them a touchback
// wearing a 46% tag. Punts keep the rule; a shank on a close possession
// really does move a game.
const INHERITS_SWING = /^kickoff$/i;

// Win probability is only ever as complete as the last box-score poll, and a
// play that arrived seconds ago will not have an entry yet. Absent means
// "unknown", never "no swing", so callers fall through to the other rules
// instead of treating a missing number as a quiet play.
const swingOf = (p) => (INHERITS_SWING.test(p.type)
  ? null
  : state.winProb.get(String(p.id))?.swing ?? null);

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
  // A play can decide a game without scoring, turning the ball over or
  // gaining twenty yards: a fourth-down stop, a missed field goal, a sack on
  // third and goal. Nothing else in this function can see those, which is the
  // whole reason win probability is worth carrying.
  if (swingOf(p) >= BIG_SWING) return 'key';
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
    // Scores, turnovers, your starters, and anything that moved the game by
    // five points of win probability.
    //
    // The first cut here was "not the log tier", which measured 1,233 of
    // 2,604 plays on a full slate - 47%, which is not a filter. The note tier
    // is broad by design (every red-zone snap, every 20-yard gain, every
    // flag), so it belongs in the feed's colour, not behind this chip. Score
    // plus key is 496, or 19%.
    case 'big': { const t = tierOf(p); return t === 'score' || t === 'key'; }
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
  const sw = swingOf(p);
  if (sw >= BIG_SWING) {
    out.push(`<span class="tag tag--wp" title="Win probability moved this much">`
      + `${Math.round(sw * 100)}% swing</span>`);
  }
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
  applyAwayMarker(list);
  showEmptyIfNeeded(list);
  return fresh.length;
}

function trim(list) {
  const max = cap();
  // Count and remove only play cards. The away divider is a child too, and
  // trimming it off the bottom would silently lose the mark.
  const cards = () => list.querySelectorAll('article.p');
  while (cards().length > max) {
    const last = list.querySelector('article.p:last-of-type');
    if (!last) break;
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
    .slice(0, cap());

  const frag = document.createDocumentFragment();
  for (const p of all) {
    const node = card(p, state.games.get(p.eventId), false);
    rendered.set(p.id, node);
    frag.append(node);
  }
  list.append(frag);
  applyAwayMarker(list);
  showEmptyIfNeeded(list);
}

/* ---------- what you missed ---------- */

// Ordering is (ts, seq), the same pair insert() sorts the list by, so the
// boundary a divider sits on is exactly the boundary the list already has.
const isNewer = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.seq > b.seq);

function newestPlay() {
  let best = null;
  for (const p of state.plays.values()) if (!best || isNewer(p, best)) best = p;
  return best ? { ts: best.ts, seq: best.seq } : null;
}

// Marked from every play we hold, not from what is on screen: a filter that
// happened to be on while you were away must not change what counts as missed.
export function markAway() {
  if (state.away.at) return;          // already away - keep the earlier mark
  state.away.at = newestPlay();
}

export function markBack() {
  if (!state.away.at) return;
  applyAwayMarker(listEl());
  if (!state.away.count) clearAway();
}

export function clearAway() {
  state.away.at = null;
  state.away.count = 0;
  document.querySelector('.feed-divider')?.remove();
  renderAwayChip();
}

// Idempotent on purpose: drop any divider, then place one above the first
// card older than the boundary. Runs after every ingest and rebuild, so the
// mark survives new plays arriving and the filters changing under it.
// The count comes from the list, not from state.plays.
//
// Those are different numbers: state.plays holds every play of every game,
// while the list holds only what the current filters let through. Counting
// the former and drawing the line in the latter put "30 plays" above 21
// cards, which reads as a bug. Counting the cards above the line cannot
// disagree with the line, whatever the filters are doing.
// Divider and chip are one operation: the chip quotes the divider's count, so
// redrawing one without the other is how they drift apart as plays arrive.
function applyAwayMarker(list) {
  placeAwayDivider(list);
  renderAwayChip();
}

function placeAwayDivider(list) {
  list.querySelector('.feed-divider')?.remove();
  state.away.count = 0;
  const at = state.away.at;
  if (!at) return;

  let above = 0;
  for (const child of list.children) {
    if (!child.matches('article.p')) continue;
    const c = { ts: Number(child.dataset.ts || 0), seq: Number(child.dataset.seq || 0) };
    if (isNewer(c, at)) { above += 1; continue; }
    if (!above) return;                       // nothing new reached the list
    state.away.count = above;
    const div = document.createElement('div');
    div.className = 'feed-divider';
    div.innerHTML = `<span>${above} play${above === 1 ? '' : 's'} while you were away</span>`;
    list.insertBefore(div, child);
    return;
  }
  // Everything on screen is newer than the boundary - which happens on a
  // long absence, once the trim has dropped every play you had already seen.
  if (above) {
    state.away.count = above;
    const div = document.createElement('div');
    div.className = 'feed-divider';
    div.innerHTML = `<span>${above} play${above === 1 ? '' : 's'} while you were away</span>`;
    list.append(div);
  }
}

function renderAwayChip() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  feed.querySelector('.away-chip')?.remove();
  const n = state.away.count;
  if (!n) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'away-chip';
  chip.innerHTML = `<span>${n} new since you looked</span>`
    + `<span class="ax" aria-hidden="true">&times;</span>`;
  feed.prepend(chip);
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

// Following used to say only who. The whole line - team, position, the day's
// stats and the fantasy total - is already sitting in the player table, so
// the chip carries it rather than sending you to another tab to read it.
function renderFollowChip() {
  const el = document.getElementById('follow-chip');
  if (!el) return;
  const f = state.filters;
  if (!f.athleteId) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;

  const rec = state.playerStats.get(String(f.athleteId));
  const name = escAttr(rec?.short || rec?.name || f.athleteName || 'player');
  const colour = rec?.team ? (espn.colorForAbbr(rec.team) || 'var(--fg-3)') : 'var(--fg-3)';

  // No record means the player has not touched the ball yet today - the
  // follow still works, there is just nothing to total.
  const meta = rec
    ? [rec.pos, rec.team && rec.opp ? `${rec.team} vs ${rec.opp}` : rec.team,
       box.summaryLine(rec)].filter(Boolean).join(' \u00b7 ')
    : 'no stats yet';
  const pts = rec && Number.isFinite(rec.fpts)
    ? `<span class="fc-pts num">${rec.fpts.toFixed(1)}</span>` : '';

  el.innerHTML = `<span class="fc-bar" style="--team:${colour}"></span>
    <span class="fc-who">
      <span class="fc-name">${name}</span>
      <span class="fc-meta">${escAttr(meta)}</span>
    </span>${pts}
    <button type="button" class="fc-x" id="follow-clear"
      aria-label="Stop following ${name}">&times;</button>`;
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The one way the significance filter changes, so the click handler and the
// number keys cannot end up setting it differently.
export function setMode(mode) {
  state.filters.mode = mode;
  const bar = document.getElementById('filters');
  if (bar) {
    for (const b of bar.children) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
  }
  const feedEl = document.getElementById('feed');
  if (feedEl) feedEl.scrollTop = 0;
  rebuild();
}

export function wire() {
  const bar = document.getElementById('filters');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) setMode(btn.dataset.mode);
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

  // Leaving the tab is the signal that you stopped watching. Coming back with
  // plays you have not seen is the only moment the divider is worth drawing.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markAway();
    else markBack();
  });

  document.getElementById('feed')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.away-chip');
    if (!chip) return;
    // The cross dismisses; the chip itself takes you to where you left off.
    if (e.target.closest('.ax')) { clearAway(); return; }
    document.querySelector('.feed-divider')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}
