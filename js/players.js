// The Players view: a full-window sortable table of every fantasy-relevant
// player, scored under the connected league's own settings, with ownership
// taken from the league's rosters so your team and the free-agent pool sit in
// one list and can be compared directly.
//
// This view shares no data path with the live feed. Its numbers come from
// Sleeper's weekly stat files (see season.js), which means no ESPN call, no
// box-score parsing and no athlete bridge - so nothing here can be wrong in
// the ways the live leaders board can be.
import { state } from './state.js';
import * as season from './season.js';

const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const n1 = (v) => (v == null ? '·' : v.toFixed(1));

// The table is a comparison surface, not a feed, but it is still DOM: 896
// relevant players at eight cells each is 8k nodes, which is twice what the
// capped play feed holds. The useful part of any sort is the top, so the rest
// is a note rather than markup. Search and the chips are how you reach past it.
const TABLE_CAP = 400;

let rowsCache = null;        // built rows, invalidated whenever inputs change
let builtFor = null;         // the season signature those rows were built from

/* ---------- row assembly ---------- */

function signature() {
  const s = state.season;
  return `${s.through}:${s.weeks.size}:${state.sleeper.leagueId || '-'}:${state.sleeper.myRosterId ?? '-'}`;
}

function rows() {
  const sig = signature();
  if (rowsCache && builtFor === sig) return rowsCache;

  rowsCache = season.buildRows({
    weeks: state.season.weeks,
    players: state.sleeper.players,
    owners: season.ownerIndex(),
  });
  builtFor = sig;
  return rowsCache;
}

export function invalidate() { rowsCache = null; builtFor = null; }

// What the points column shows, which is also what "sort by points" means.
// Selecting a week narrows the table to players who have a stats row that
// week - a player on a bye is absent rather than listed at zero, because zero
// would read as "played and did nothing".
function scoped() {
  const { week } = state.players;
  const all = rows();
  if (week == null) {
    for (const r of all) r.shown = r.pts;
    return all;
  }
  const out = [];
  for (const r of all) {
    if (!r.byWeek.has(week)) continue;
    r.shown = r.byWeek.get(week);
    out.push(r);
  }
  return out;
}

/* ---------- render ---------- */

const COLS = [
  { key: 'name',  label: 'Player', cls: 'pl-c-name' },
  { key: 'pos',   label: 'Pos',    cls: 'pl-c-pos' },
  { key: null,    label: 'Team',   cls: 'pl-c-team' },
  { key: 'owner', label: 'Owner',  cls: 'pl-c-own' },
  { key: 'pts',   label: 'Pts',    cls: 'pl-c-num num' },
  { key: 'games', label: 'G',      cls: 'pl-c-num num' },
  { key: 'ppg',   label: 'PPG',    cls: 'pl-c-num num' },
  { key: 'best',  label: 'Best',   cls: 'pl-c-num num' },
];

function head() {
  const { sort, dir } = state.players;
  return COLS.map((c) => {
    if (!c.key) return `<th class="${c.cls}">${c.label}</th>`;
    const active = c.key === sort;
    const aria = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="${c.cls} pl-sort${active ? ' is-on' : ''}" aria-sort="${aria}">
        <button type="button" data-sort="${c.key}">${c.label}<span class="pl-arrow" aria-hidden="true">${
          active ? (dir === 'asc' ? '▴' : '▾') : ''
        }</span></button>
      </th>`;
  }).join('');
}

function ownerCell(r) {
  if (!r.owner) return `<span class="pl-fa">Free agent</span>`;
  if (r.owner.mine) return `<span class="pl-mine">You</span>`;
  return `<span class="pl-taken">${esc(r.owner.label)}</span>`;
}

function body(list) {
  if (!list.length) {
    return `<tr><td colspan="${COLS.length}" class="pl-none">
        No players match those filters.</td></tr>`;
  }
  return list.slice(0, TABLE_CAP).map((r) => `<tr${r.owner?.mine ? ' class="is-mine"' : ''}>
      <td class="pl-c-name">${esc(r.name)}</td>
      <td class="pl-c-pos"><span class="pl-pos">${esc(r.pos)}</span></td>
      <td class="pl-c-team">${esc(r.team)}</td>
      <td class="pl-c-own">${ownerCell(r)}</td>
      <td class="pl-c-num num pl-pts">${n1(r.shown)}</td>
      <td class="pl-c-num num">${r.games}</td>
      <td class="pl-c-num num">${n1(r.ppg)}</td>
      <td class="pl-c-num num">${n1(r.best)}</td>
    </tr>`).join('');
}

function meta(total, listed) {
  const s = state.season;
  const bits = [];

  if (state.players.week == null) {
    bits.push(s.through ? `Season through week ${s.through}` : 'Season');
  } else {
    bits.push(`Week ${state.players.week}`);
  }

  bits.push(listed >= total
    ? `${total} player${total === 1 ? '' : 's'}`
    : `${listed} of ${total} shown — search or filter to narrow`);

  // Which rules produced these numbers is not a detail. Without a league the
  // table is still useful, but it is not the user's scoring.
  bits.push(season.usingLeagueRules()
    ? `${esc(state.sleeper.league?.name || 'your league')} scoring`
    : 'full-PPR defaults — connect Sleeper for your own scoring');

  return bits.join(' · ');
}

export function render() {
  const host = $('#pl-table');
  if (!host) return;

  syncControls();

  const s = state.season;
  if (s.error && !s.loaded) {
    host.innerHTML = `<p class="pl-msg">Could not load season stats.<br>
      <span class="pl-sub">${esc(s.error)}</span></p>`;
    $('#pl-meta').textContent = '';
    return;
  }
  if (!s.loaded) {
    const got = s.weeks.size;
    host.innerHTML = `<p class="pl-msg">Loading the season…
      <span class="pl-sub">${got ? `${got} week${got === 1 ? '' : 's'} in` : 'one file per week'}</span></p>`;
    $('#pl-meta').textContent = '';
    return;
  }

  const all = scoped();
  const filtered = season.filterRows(all, state.players);
  const sorted = season.sortRows(filtered, state.players.sort, state.players.dir);

  host.innerHTML = `<table class="pl-table">
      <thead><tr>${head()}</tr></thead>
      <tbody>${body(sorted)}</tbody>
    </table>`;
  $('#pl-meta').textContent = meta(sorted.length, Math.min(sorted.length, TABLE_CAP));
}

// The chips and the scope button live in the markup so that typing in the
// search box never rebuilds the box it is typed into.
function syncControls() {
  const p = state.players;

  for (const b of document.querySelectorAll('#pl-pos [data-pos]')) {
    b.setAttribute('aria-pressed', String(b.dataset.pos === p.pos));
  }
  for (const b of document.querySelectorAll('#pl-own [data-own]')) {
    b.setAttribute('aria-pressed', String(b.dataset.own === p.own));
  }

  const scope = $('#pl-scope');
  if (scope) {
    const wk = state.weekOverride || state.week || state.season.through;
    scope.querySelector('[data-scope="season"]')?.setAttribute('aria-pressed', String(p.week == null));
    const weekBtn = scope.querySelector('[data-scope="week"]');
    if (weekBtn) {
      weekBtn.setAttribute('aria-pressed', String(p.week != null));
      weekBtn.textContent = wk ? `Week ${wk}` : 'Week';
      weekBtn.disabled = !wk;
    }
  }
}

/* ---------- loading ---------- */

// Called on first open rather than at boot: the live feed never needs these
// files, and nine of them is ~600 KB.
export async function ensureLoaded() {
  const s = state.season;
  if (s.loaded || s.loading) return;
  s.loading = true;
  s.error = null;
  render();

  try {
    await season.loadSeason(() => { invalidate(); render(); });
  } catch (e) {
    console.error('[players] season load failed', e);
    s.error = e.message || String(e);
  } finally {
    s.loading = false;
    invalidate();
    render();
  }
}

/* ---------- wiring ---------- */

export function wire() {
  const root = $('#players');
  if (!root) return;

  root.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      const p = state.players;
      // Same column twice flips direction; a new column starts in the
      // direction that column is interesting in.
      if (p.sort === key) p.dir = p.dir === 'desc' ? 'asc' : 'desc';
      else { p.sort = key; p.dir = (key === 'name' || key === 'pos' || key === 'owner') ? 'asc' : 'desc'; }
      render();
      return;
    }

    const pos = e.target.closest('[data-pos]');
    if (pos) { state.players.pos = pos.dataset.pos; render(); return; }

    const own = e.target.closest('[data-own]');
    if (own) { state.players.own = own.dataset.own; render(); return; }

    const scope = e.target.closest('[data-scope]');
    if (scope) {
      state.players.week = scope.dataset.scope === 'season'
        ? null
        : (state.weekOverride || state.week || state.season.through || null);
      render();
    }
  });

  const q = $('#pl-q');
  q?.addEventListener('input', () => { state.players.q = q.value; render(); });
  // Escape clears the search rather than leaving a filter you cannot see the
  // cause of; it does not close the view, which Escape does nowhere else here.
  q?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !q.value) return;
    q.value = '';
    state.players.q = '';
    render();
    e.stopPropagation();
  });
}

// Called by main.js when the Sleeper layer settles. A league arriving changes
// two things at once: who owns each player, and - if it arrived after the
// weekly files were already scored - which rules those points were computed
// under. The second is compared against the tag the season was actually loaded
// with rather than against the last thing this function saw, because the first
// connect races the first load and a guard on "what changed since last time"
// cannot see a race it was never told about.
export function onSleeperChange() {
  invalidate();                               // ownership, at minimum

  const tag = season.rulesTag();
  if (state.season.loaded && state.season.rulesTag !== tag) {
    state.season.weeks = new Map();
    state.season.loaded = false;
    state.season.through = 0;
  }
  season.pruneCache(tag);

  if (state.view === 'players') ensureLoaded();
  render();
}
