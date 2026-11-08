// The game rail: one row per game, live first. Rebuilt on every scoreboard
// poll - 15 rows is far too cheap to bother diffing.
import { state, emit } from './state.js';
import * as espn from './espn.js';

const ORDER = { in: 0, pre: 1, post: 2 };

export function sortedGames() {
  return [...state.games.values()].sort((a, b) => {
    const d = (ORDER[a.state] ?? 3) - (ORDER[b.state] ?? 3);
    if (d) return d;
    // Among live games, red zone floats to the top: that is where something
    // is about to happen.
    if (a.state === 'in' && a.isRedZone !== b.isRedZone) return a.isRedZone ? -1 : 1;
    return (a.date || '').localeCompare(b.date || '');
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function kickoff(g) {
  if (!g.date) return g.detail || '';
  return new Date(g.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function teamRow(g, t, mine, other, live) {
  const decided = g.state !== 'pre' && mine !== other;
  const trail = decided && mine < other;
  const poss = live && g.possessionTeamId === t.id;
  const colour = espn.colorForAbbr(t.abbr) || 'var(--fg-3)';
  return `<div class="g-team${trail ? ' trail' : ''}">
      <span class="g-bar" style="--team:${colour}"></span>
      <span class="g-abbr">${esc(t.abbr)}</span>
      <span class="g-poss${poss ? '' : ' hide'}"></span>
      <span class="g-score num">${g.state === 'pre' ? '' : mine}</span>
    </div>`;
}

function row(g) {
  const live = g.state === 'in';
  const sel = state.filters.gameId === g.id;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `g${g.state === 'post' ? ' final' : ''}`;
  btn.dataset.game = g.id;
  btn.setAttribute('aria-pressed', String(sel));

  const hs = g.home.score;
  const as = g.away.score;

  let foot;
  if (live) {
    foot = `<div class="g-foot">
        <span class="g-live${g.isRedZone ? ' rz' : ''}"></span>
        <span>Q${g.period || ''} ${esc(g.clock || '')}</span>
        ${g.downDistance ? `<span class="dd">${esc(g.downDistance)}</span>` : ''}
      </div>`;
  } else if (g.state === 'pre') {
    foot = `<div class="g-foot"><span>${esc(kickoff(g))}</span></div>`;
  } else {
    foot = `<div class="g-foot"><span>${esc(g.detail || 'Final')}</span></div>`;
  }

  btn.innerHTML = teamRow(g, g.away, as, hs, live) + teamRow(g, g.home, hs, as, live) + foot;

  const label = `${g.away.abbr} ${as}, ${g.home.abbr} ${hs}` +
    (live ? `, live, ${g.downDistance || ''}` : g.state === 'pre' ? ', not started' : ', final');
  btn.setAttribute('aria-label', label.trim());
  return btn;
}

export function render() {
  const el = document.getElementById('rail');
  if (!el) return;

  const games = sortedGames();
  el.replaceChildren();

  if (!games.length) {
    el.innerHTML = Array.from({ length: 5 }, () =>
      `<div class="skel-row">
         <div class="skel skel-line" style="width:76%"></div>
         <div class="skel skel-line" style="width:58%"></div>
       </div>`).join('');
    return;
  }

  let last = null;
  const frag = document.createDocumentFragment();
  for (const g of games) {
    if (g.state !== last) {
      const lbl = document.createElement('div');
      lbl.className = 'sec-label';
      lbl.textContent = g.state === 'in' ? 'Live' : g.state === 'pre' ? 'Upcoming' : 'Final';
      frag.append(lbl);
      last = g.state;
    }
    frag.append(row(g));
  }
  el.append(frag);
}

export function wire() {
  document.getElementById('rail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (!btn) return;
    const id = btn.dataset.game;
    state.filters.gameId = state.filters.gameId === id ? null : id;
    render();
    document.getElementById('feed').scrollTop = 0;
    emit('filters');
  });
}
