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
    // Cleared rather than left alone: the rows are reused between renders, and
    // compare mode looks players up by id instead of walking this list, so a
    // leftover `shown` from the previous scope would print a number from
    // another week beside a player who did not play this one.
    if (!r.byWeek.has(week)) { r.shown = null; continue; }
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

/* ---------- compare: your lineup against the free pool ---------- */

// Every row keyed by Sleeper id, which is also what a roster lists - team
// defences included, since Sleeper calls those by team abbreviation on both
// sides.
function rowsById() {
  const m = new Map();
  for (const r of rows()) m.set(r.id, r);
  return m;
}

function myRoster() {
  const s = state.sleeper;
  return (s.rosters || []).find((r) => r.roster_id === s.myRosterId) || null;
}

const SLOT_LABEL = { WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', SUPER_FLEX: 'SFLX', BN: 'BN' };
const slotName = (s) => SLOT_LABEL[s] || s;

// One lineup row, with what the best available player at that slot would add.
function compareRow(entry, i, all, selected) {
  const r = entry.row;
  const pos = positionsFor(entry);
  const cands = season.freeAgentsFor(all, pos, { minGames: state.players.minGames, limit: 1 });
  const gap = season.upgradeGap(r, cands);

  // A rostered player with no stats row has still to be named: he is someone
  // the manager is carrying, and "Not in the stats" is not who. The slim
  // player dictionary knows him even when no weekly file does.
  // A rostered player with no stats row has still to be named: he is someone
  // the manager is carrying, and "not in the stats" is not who. The slim
  // dictionary knows him even when no weekly file does - unless he is not on
  // an NFL team at all, which is what its own filter excludes
  // (`(p.active && p.team) || DEF` in sleeper.js) and which is itself the
  // thing worth knowing about a roster spot.
  const slim = !r && entry.id ? state.sleeper.players?.[entry.id] : null;
  const name = r ? r.name
    : slim ? slim[0]
    : entry.id ? 'Inactive or unsigned' : 'Empty';
  const sub = r ? `${r.pos} ${r.team}`
    : slim ? `${slim[1]} ${slim[2] || 'FA'} · no points yet`
    : entry.id ? `id ${entry.id} · not on an NFL team` : '';
  // Always a cell, even when empty: the gap column is one grid track across
  // both sides, and a missing span shortens the row by one.
  const badge = gap == null ? '<span class="cm-gap"></span>'
    : gap > 0 ? `<span class="cm-gap is-up" title="The best free agent is ${gap} points a game better">+${gap.toFixed(1)}</span>`
    : `<span class="cm-gap">${gap.toFixed(1)}</span>`;

  return `<li>
      <button type="button" class="cm-row${i === selected ? ' is-on' : ''}" data-slot="${i}"
              aria-pressed="${i === selected}">
        <span class="cm-slot">${esc(slotName(entry.slot))}</span>
        <span class="cm-who"><span class="cm-name">${esc(name)}</span>
          <span class="cm-sub">${esc(sub)}</span></span>
        <span class="cm-n num">${r ? n1(r.shown) : '·'}</span>
        <span class="cm-n num">${r ? n1(r.ppg) : '·'}</span>
        ${badge}
      </button>
    </li>`;
}

// A bench slot's position comes from whoever is standing in it, and the slim
// dictionary is the fallback for a player no weekly file has scored - a stash
// who has not played is the one most worth replacing, so leaving him with no
// candidates would hide the clearest upgrade on the roster.
function positionsFor(entry) {
  const pos = entry.row?.pos
    || (entry.id ? state.sleeper.players?.[entry.id]?.[1] : null)
    || null;
  return season.positionsForSlot(entry.slot, pos);
}

function renderCompare() {
  const host = $('#pl-compare');
  if (!host) return;

  if (!state.sleeper.myRosterId) {
    host.innerHTML = `<p class="pl-msg">Connect Sleeper to compare your lineup.
      <span class="pl-sub">This view needs to know which players are yours.</span></p>`;
    return;
  }

  const all = scoped();
  const byId = rowsById();
  const slots = (state.sleeper.league?.roster_positions || [])
    .filter((p) => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
  const { starters, bench } = season.lineupFor({ roster: myRoster(), slots, byId });
  const lineup = [...starters, ...bench];

  if (!lineup.length) {
    host.innerHTML = `<p class="pl-msg">No lineup for this week yet.</p>`;
    return;
  }

  const sel = Math.min(state.players.slot, lineup.length - 1);
  const picked = lineup[sel];
  const pos = positionsFor(picked);
  const cands = season.freeAgentsFor(all, pos, { minGames: state.players.minGames, limit: 14 });
  const mineRow = picked.row;

  const left = `<div class="cm-side">
      <div class="cm-head"><h3>My team</h3>
        <span class="cm-cols num"><span>Pts</span><span>PPG</span><span>Gap</span></span></div>
      <ol class="cm-list">${starters.map((e, i) => compareRow(e, i, all, sel)).join('')}</ol>
      ${bench.length ? `<div class="cm-sep">Bench</div>
        <ol class="cm-list">${bench.map((e, i) => compareRow(e, starters.length + i, all, sel)).join('')}</ol>` : ''}
    </div>`;

  const posLabel = [...pos].join('/') || '—';
  const right = `<div class="cm-side">
      <div class="cm-head"><h3>Best free agents · ${esc(posLabel)}</h3>
        <span class="cm-cols num"><span>Pts</span><span>PPG</span><span>vs</span></span></div>
      ${cands.length ? `<ol class="cm-list">${cands.map((c) => {
        const d = mineRow ? Math.round((c.ppg - (mineRow.ppg ?? 0)) * 100) / 100 : null;
        return `<li><span class="cm-row is-static">
            <span class="cm-slot num">${c.games}g</span>
            <span class="cm-who"><span class="cm-name">${esc(c.name)}</span>
              <span class="cm-sub">${esc(c.pos)} ${esc(c.team)}</span></span>
            <span class="cm-n num">${n1(c.shown)}</span>
            <span class="cm-n num">${n1(c.ppg)}</span>
            ${d == null ? '<span class="cm-gap"></span>'
              : `<span class="cm-gap${d > 0 ? ' is-up' : ''}">${d > 0 ? '+' : ''}${d.toFixed(1)}</span>`}
          </span></li>`;
      }).join('')}</ol>`
      : pos.size === 0
      ? `<p class="pl-msg">Nothing to compare against.
         <span class="pl-sub">This slot holds a player who is not on an NFL team, so
         there is no position to suggest a replacement at. The spot itself is the
         finding.</span></p>`
      : `<p class="pl-msg">No free agent at this position with ${state.players.minGames}
         game${state.players.minGames === 1 ? '' : 's'} or more.
         <span class="pl-sub">Lower the minimum to widen the pool.</span></p>`}
    </div>`;

  host.innerHTML = left + right;

  // Pts follows the scope chips; the ranking and the gap do not. A waiver
  // decision is about the rest of the season, so both sides are ordered by
  // season points per game however the points column is scoped.
  $('#pl-meta').textContent = [
    state.players.week == null
      ? `Season through week ${state.season.through}`
      : `Week ${state.players.week} points, season per-game ranking`,
    `${mineRow ? mineRow.name : 'an empty slot'} vs ${cands.length} free agent${cands.length === 1 ? '' : 's'}`,
    `at least ${state.players.minGames} game${state.players.minGames === 1 ? '' : 's'} played`,
    season.usingLeagueRules()
      ? `${state.sleeper.league?.name || 'your league'} scoring`
      : 'full-PPR defaults',
  ].join(' · ');
}

export function render() {
  const host = $('#pl-table');
  if (!host) return;

  syncControls();

  // Both halves of the view read the same rows; only the arrangement differs,
  // so the loading and error states below are shared and land in whichever
  // container is on screen.
  const compare = state.players.mode === 'compare';
  const cmp = $('#pl-compare');
  host.hidden = compare;                     // #pl-table is itself the .pl-wrap
  if (cmp) cmp.hidden = !compare;
  const place = (html) => {
    if (compare && cmp) cmp.innerHTML = html;
    else host.innerHTML = html;
    $('#pl-meta').textContent = '';
  };

  const s = state.season;
  if (s.error && !s.loaded) {
    place(`<p class="pl-msg">Could not load season stats.<br>
      <span class="pl-sub">${esc(s.error)}</span></p>`);
    return;
  }
  if (!s.loaded) {
    const got = s.weeks.size;
    place(`<p class="pl-msg">Loading the season…
      <span class="pl-sub">${got ? `${got} week${got === 1 ? '' : 's'} in` : 'one file per week'}</span></p>`);
    return;
  }

  if (compare) { renderCompare(); return; }

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
  const compare = p.mode === 'compare';

  for (const b of document.querySelectorAll('#pl-mode [data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode));
  }

  // Compare mode takes the position from the selected lineup slot and the
  // ownership from the two columns, so those two controls would be controls
  // that control nothing. The minimum-games control is the opposite: it only
  // means anything once a free agent is being judged as a replacement.
  const show = (sel, on) => { const el = $(sel); if (el) el.hidden = !on; };
  show('#pl-pos', !compare);
  show('#pl-own', !compare);
  show('#pl-min', compare);

  const min = $('#pl-min-n');
  if (min && min.value !== String(p.minGames)) min.value = String(p.minGames);

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

    const mode = e.target.closest('[data-mode]');
    if (mode) { state.players.mode = mode.dataset.mode; render(); return; }

    const slot = e.target.closest('[data-slot]');
    if (slot) { state.players.slot = Number(slot.dataset.slot); render(); return; }

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

  // How much of a sample counts as evidence is the manager's call, not a
  // constant: one 30-point week makes a waiver flyer top the per-game table.
  const min = $('#pl-min-n');
  min?.addEventListener('change', () => {
    const v = Math.max(1, Math.min(18, Number(min.value) || 1));
    state.players.minGames = v;
    min.value = String(v);
    render();
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
