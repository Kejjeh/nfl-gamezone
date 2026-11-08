// The game rail: one row per game, live first. Rebuilt on every scoreboard
// poll - 15 rows is far too cheap to bother diffing.
import { state, emit } from './state.js';

const ORDER = { in: 0, pre: 1, post: 2 };

export function sortedGames() {
  return [...state.games.values()].sort((a, b) => {
    const d = (ORDER[a.state] ?? 3) - (ORDER[b.state] ?? 3);
    if (d) return d;
    if (a.state === 'in') {
      // Red zone to the top, then by game clock.
      if (a.isRedZone !== b.isRedZone) return a.isRedZone ? -1 : 1;
    }
    return (a.date || '').localeCompare(b.date || '');
  });
}

function kickoffLabel(g) {
  if (!g.date) return g.detail || '';
  const d = new Date(g.date);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function row(g) {
  const sel = state.filters.gameId === g.id;
  const live = g.state === 'in';
  const btn = document.createElement('button');
  btn.className = `g${sel ? ' sel' : ''}${live && g.isRedZone ? ' rz' : ''}`;
  btn.dataset.game = g.id;

  const hs = g.home.score;
  const as = g.away.score;
  const decided = g.state !== 'pre' && hs !== as;

  const side = (t, mine, other) => {
    const lose = decided && mine < other;
    const poss = live && g.possessionTeamId === t.id;
    return `<div class="g-row${lose ? ' lose' : ''}">
        <span class="g-poss">${poss ? '&#9679;' : ''}</span>
        <span class="g-abbr">${t.abbr}</span>
        <span class="g-score">${g.state === 'pre' ? '' : mine}</span>
      </div>`;
  };

  let foot;
  if (live) {
    foot = `<div class="g-foot">
        <span class="g-dot${g.isRedZone ? ' rzd' : ''}"></span>
        <span>${g.clock || ''} Q${g.period || ''}</span>
        <span class="g-dd">${g.downDistance || ''}</span>
      </div>`;
  } else if (g.state === 'pre') {
    foot = `<div class="g-foot"><span class="g-dot off"></span><span>${kickoffLabel(g)}</span></div>`;
  } else {
    foot = `<div class="g-foot"><span class="g-dot off"></span><span>${g.detail || 'Final'}</span></div>`;
  }

  btn.innerHTML = side(g.away, as, hs) + side(g.home, hs, as) + foot;
  return btn;
}

export function render() {
  const el = document.getElementById('rail');
  if (!el) return;

  const games = sortedGames();
  el.replaceChildren();

  if (!games.length) {
    const d = document.createElement('div');
    d.className = 'sec-label';
    d.textContent = 'No games';
    el.append(d);
    return;
  }

  let lastState = null;
  for (const g of games) {
    if (g.state !== lastState) {
      const lbl = document.createElement('div');
      lbl.className = 'sec-label';
      lbl.textContent = g.state === 'in' ? 'Live' : g.state === 'pre' ? 'Upcoming' : 'Final';
      el.append(lbl);
      lastState = g.state;
    }
    el.append(row(g));
  }
}

export function wire() {
  document.getElementById('rail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (!btn) return;
    const id = btn.dataset.game;
    state.filters.gameId = state.filters.gameId === id ? null : id;
    render();
    emit('filters');
  });
}
