// The unified play feed: every live game merged into one reverse-chronological
// stream. New cards are inserted in place rather than rebuilding the list, so
// scroll position and the flash animation survive each poll.
import { state } from './state.js';
import { FEED_CAP } from './config.js';
import * as bridge from './bridge.js';
import * as alerts from './alerts.js';

const rendered = new Map();   // playId -> node

const isRedZonePlay = (p) =>
  (p.endYTE != null && p.endYTE <= 20) || (p.startYTE != null && p.startYTE <= 20);

function passes(p) {
  const f = state.filters;
  if (f.gameId && p.eventId !== f.gameId) return false;
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

function classesFor(p) {
  const c = ['p'];
  if (p.isTD) c.push('td');
  else if (p.isTurnover) c.push('turn');
  else if (p.scoringPlay) c.push('scoring');
  if (p.fan) c.push(p.fan.side);
  return c;
}

function tags(p) {
  const out = [];
  if (p.isTD) out.push('<span class="tag td">TD</span>');
  else if (p.scoringPlay && /field goal/i.test(p.type)) out.push('<span class="tag fg">FG</span>');
  else if (p.scoringPlay) out.push('<span class="tag fg">Score</span>');
  if (p.isTurnover) out.push('<span class="tag turn">Turnover</span>');
  if (isRedZonePlay(p) && !p.scoringPlay) out.push('<span class="tag rz">Red zone</span>');
  if (p.isPenalty && !p.scoringPlay) out.push('<span class="tag pen">Flag</span>');
  return out.join('');
}

function card(p, game, flash) {
  const node = document.createElement('article');
  node.className = classesFor(p).join(' ') + (flash ? ' flash' : '');
  node.dataset.ts = String(p.ts);
  node.dataset.seq = String(p.seq);

  const label = game ? `${game.away.abbr} @ ${game.home.abbr}` : '';
  const score = game ? `${p.awayScore}-${p.homeScore}` : '';
  const when = p.period ? `Q${p.period} ${p.clock || ''}` : '';

  let fan = '';
  if (p.fan) {
    const badge = p.fan.side === 'mine' ? 'YOUR STARTER' : 'OPPONENT';
    const who = p.fan.players.map((x) => {
      const pts = x.points != null ? `<span class="pt">${Number(x.points).toFixed(1)} pts</span>` : '';
      return `<span class="nm">${esc(x.name)}</span> ${pts}`;
    }).join(' &middot; ');
    fan = `<div class="p-fan"><span class="fan-badge">${badge}</span> ${who}</div>`;
  }

  node.innerHTML =
    `<div class="p-head">
       <span class="p-game">${esc(label)}</span>
       <span class="p-sc">${score}</span>
       <span class="p-clock">${esc(when)}</span>
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

function showEmptyIfNeeded(list) {
  const feed = document.getElementById('feed');
  const old = feed.querySelector('.empty');
  if (old) old.remove();
  if (list.children.length) return;

  const live = [...state.games.values()].filter((g) => g.state === 'in').length;
  const next = [...state.games.values()]
    .filter((g) => g.state === 'pre' && g.date)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  let msg;
  if (state.filters.mode !== 'all' || state.filters.gameId) {
    msg = 'No plays match this filter yet.';
  } else if (live) {
    msg = 'Waiting on the first plays&hellip;';
  } else if (next) {
    const d = new Date(next.date);
    msg = `<b>No games in progress.</b><br>Next kickoff ${d.toLocaleString([], {
      weekday: 'short', hour: 'numeric', minute: '2-digit' })} &mdash; ${esc(next.shortName)}`;
  } else {
    msg = '<b>No games scheduled.</b><br>Add <code>?week=9</code> to the URL to replay a past week.';
  }

  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = msg;
  feed.append(d);
}

export function wire() {
  const bar = document.getElementById('filters');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.filters.mode = btn.dataset.mode;
    for (const b of bar.children) b.classList.toggle('on', b === btn);
    rebuild();
  });
}
