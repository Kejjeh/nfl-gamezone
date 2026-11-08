// The right-hand stats panel: league leaders across the whole slate, or the
// box score for whichever game is selected.
import { state, emit } from './state.js';
import * as box from './boxscore.js';
import * as espn from './espn.js';
import * as scoring from './scoring.js';
import * as sleeper from './sleeper.js';
import * as bridge from './bridge.js';
import * as feed from './feed.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const num = (v) => {
  const x = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};

/* ---------- box score for one game ---------- */

// Columns per category: [label, key or deriver]. Kept tight on purpose; the
// full ESPN box score has far more than is worth reading at this width.
const VIEWS = {
  passing: {
    title: 'Passing',
    cols: [
      ['C/ATT', (s) => s['completions/passingAttempts'] || '0/0'],
      ['YDS', (s) => num(s.passingYards)],
      ['TD', (s) => num(s.passingTouchdowns)],
      ['INT', (s) => num(s.interceptions)],
    ],
  },
  rushing: {
    title: 'Rushing',
    cols: [
      ['CAR', (s) => num(s.rushingAttempts)],
      ['YDS', (s) => num(s.rushingYards)],
      ['TD', (s) => num(s.rushingTouchdowns)],
      ['LNG', (s) => num(s.longRushing)],
    ],
  },
  receiving: {
    title: 'Receiving',
    cols: [
      ['REC', (s) => num(s.receptions)],
      ['TGT', (s) => num(s.receivingTargets)],
      ['YDS', (s) => num(s.receivingYards)],
      ['TD', (s) => num(s.receivingTouchdowns)],
    ],
  },
  kicking: {
    title: 'Kicking',
    cols: [
      ['FG', (s) => s['fieldGoalsMade/fieldGoalAttempts'] || '0/0'],
      ['XP', (s) => s['extraPointsMade/extraPointAttempts'] || '0/0'],
      ['LNG', (s) => num(s.longFieldGoalMade)],
      ['PTS', (s) => num(s.totalKickingPoints)],
    ],
  },
};

function fptsFor(athleteId) {
  const rec = state.playerStats?.get(String(athleteId));
  return rec ? rec.fpts : null;
}

function renderGame(eventId) {
  const game = state.games.get(eventId);
  const bs = state.boxscores.get(eventId);
  if (!game) return '<div class="panel-empty">Game not found.</div>';
  if (!bs) return '<div class="panel-empty">Loading box score&hellip;</div>';

  const colour = (abbr) => espn.colorForAbbr(abbr) || 'var(--fg-3)';

  let html = `<div class="bx-score">
      ${[game.away, game.home].map((t) => `
        <div class="bx-team">
          <span class="bx-bar" style="--team:${colour(t.abbr)}"></span>
          <span class="bx-abbr">${esc(t.abbr)}</span>
          <span class="bx-pts num">${t.score}</span>
        </div>`).join('')}
      <div class="bx-state">${esc(game.state === 'in'
        ? `Q${game.period || ''} ${game.clock || ''}`
        : game.detail || '')}</div>
    </div>`;

  for (const [catName, view] of Object.entries(VIEWS)) {
    const blocks = [];
    for (const team of bs.teams) {
      const cat = team.categories[catName];
      if (!cat || !cat.rows.length) continue;

      // ESPN includes a totals row with no athlete id; drop it.
      const rows = cat.rows.filter((r) => r.id && r.name);
      if (!rows.length) continue;

      blocks.push(`
        <div class="bx-sub" style="--team:${colour(team.abbr)}">${esc(team.abbr)}</div>
        <table class="bx-table">
          <thead><tr>
            <th class="nm"></th>
            ${view.cols.map(([l]) => `<th>${l}</th>`).join('')}
            <th class="fp">FPTS</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => {
              const fp = fptsFor(r.id);
              const following = state.filters.athleteId === String(r.id);
              return `<tr class="${following ? 'following' : ''}"
                data-follow="${esc(r.id)}" data-follow-name="${esc(r.name)}"
                tabindex="0" role="button">
                <td class="nm" title="${esc(r.name)}">${esc(r.short || r.name)}</td>
                ${view.cols.map(([, f]) => `<td class="num">${esc(f(r.stats))}</td>`).join('')}
                <td class="fp num">${fp == null ? '—' : fp.toFixed(1)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`);
    }
    if (blocks.length) {
      html += `<section class="bx-cat"><h3>${view.title}</h3>${blocks.join('')}</section>`;
    }
  }

  // FPTS is the player's whole-game total, so a player who both ran and caught
  // shows the same number in two tables. Say so, rather than leave a reader to
  // conclude that two rushing yards were worth five points.
  html += `<p class="bx-note">FPTS is each player&rsquo;s total for the game
    under ${state.sleeper.leagueId ? 'your league&rsquo;s' : 'full-PPR'} scoring,
    not that category&rsquo;s share.</p>`;

  return html;
}


/* ---------- my team ---------- */

// What a lineup row needs to answer: has this player played, are they playing
// now, or have they not kicked off yet - and what are they worth so far.
function lineupRow(pid, slot) {
  const s = state.sleeper;
  const name = sleeper.playerName(pid);
  const pos = sleeper.playerPos(pid) || slot || '';
  const nfl = sleeper.playerTeam(pid) || (/^[A-Z]{2,3}$/.test(pid) ? pid : '');
  const pts = s.pointsByPlayer?.get(pid);
  const game = espn.gameForTeam(nfl);

  let status, cls;
  if (!game) { status = 'Bye'; cls = 'bye'; }
  else if (game.state === 'in') {
    status = `Q${game.period || ''} ${game.clock || ''}`.trim();
    cls = 'live';
  } else if (game.state === 'pre') {
    status = game.date
      ? new Date(game.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : 'Upcoming';
    cls = 'pre';
  } else { status = 'Final'; cls = 'done'; }

  const opp = game
    ? (espn.sameTeam(game.home.abbr, nfl) ? `vs ${game.away.abbr}` : `@ ${game.home.abbr}`)
    : '';

  const aid = bridge.toAthleteId(pid);
  const colour = espn.colorForAbbr(nfl) || 'var(--fg-3)';

  return `<li class="lu-row lu--${cls}"${aid ? ` data-follow="${esc(aid)}" data-follow-name="${esc(name)}" tabindex="0" role="button"` : ''}>
      <span class="lu-slot">${esc(slot || pos)}</span>
      <span class="lu-bar" style="--team:${colour}"></span>
      <span class="lu-main">
        <span class="lu-name">${esc(name)}</span>
        <span class="lu-meta">${esc(nfl)}${opp ? ' ' + esc(opp) : ''} · <span class="lu-status">${esc(status)}</span></span>
      </span>
      <span class="lu-pts num">${pts == null ? '—' : Number(pts).toFixed(1)}</span>
    </li>`;
}

function yetToPlay(ids) {
  return ids.filter((pid) => {
    const g = espn.gameForTeam(sleeper.playerTeam(pid) || pid);
    return g && g.state === 'pre';
  }).length;
}

function lineupBlock(title, ids, slots, total) {
  if (!ids.length) return '';
  const left = yetToPlay(ids);
  return `<section class="lu-block">
      <div class="lu-head">
        <h3>${esc(title)}</h3>
        <span class="lu-total num">${total == null ? '—' : Number(total).toFixed(1)}</span>
      </div>
      <div class="lu-sub">${left ? `${left} yet to play` : 'all players under way or done'}</div>
      <ol class="lu">${ids.map((pid, i) => lineupRow(pid, slots[i])).join('')}</ol>
    </section>`;
}

function renderTeam() {
  const s = state.sleeper;
  if (!s.leagueId) {
    return `<div class="panel-empty">Connect Sleeper to see your lineup here.</div>`;
  }
  if (!s.myLineup?.length) {
    return `<div class="panel-empty">No lineup for week ${state.week ?? '?'}.</div>`;
  }
  const slots = s.slotLabels || [];
  return lineupBlock(s.myName || 'Your lineup', s.myLineup, slots, s.myPoints)
       + lineupBlock(s.oppName || 'Opponent', s.oppLineup, slots, s.oppPoints);
}

/* ---------- leaders ---------- */

function renderLeaders() {
  const key = state.panel.leaderCat;
  const cat = box.CATEGORIES[key];
  const rows = box.leaders(key, 15);

  const chips = Object.entries(box.CATEGORIES).map(([k, c]) =>
    `<button type="button" class="chip" data-leadercat="${k}"
       aria-pressed="${k === key}">${esc(c.label)}</button>`).join('');

  let list;
  if (!rows.length) {
    list = `<div class="panel-empty">No stats yet.<br>They appear once games are under way.</div>`;
  } else {
    list = `<ol class="ld">` + rows.map(({ row, v }, i) => {
      const colour = espn.colorForAbbr(row.team) || 'var(--fg-3)';
      const following = state.filters.athleteId === String(row.id);
      return `<li class="ld-row${following ? ' following' : ''}"
          data-follow="${esc(row.id)}" data-follow-name="${esc(row.name)}"
          tabindex="0" role="button">
          <span class="ld-rank num">${i + 1}</span>
          <span class="ld-bar" style="--team:${colour}"></span>
          <span class="ld-main">
            <span class="ld-name">${esc(row.short || row.name)}</span>
            <span class="ld-meta">${esc(row.team)}${row.opp ? ` vs ${esc(row.opp)}` : ''} · ${esc(cat.detail(row))}</span>
          </span>
          <span class="ld-val num">${esc(cat.fmt(v))}</span>
        </li>`;
    }).join('') + `</ol>`;
  }

  return `<div class="ld-chips">${chips}</div>${list}`;
}

/* ---------- shell ---------- */

export function render() {
  const el = document.getElementById('panel');
  if (!el) return;

  const gameId = state.filters.gameId;
  const game = gameId ? state.games.get(gameId) : null;

  // Selecting a game switches the panel to it; deselecting falls back. The
  // team tab only exists once a league is connected.
  const hasTeam = !!state.sleeper.leagueId;
  let tab = state.panel.tab;
  if (tab === 'game' && !game) tab = 'leaders';
  if (tab === 'team' && !hasTeam) tab = 'leaders';

  const tabs = `
    <div class="panel-tabs" role="group" aria-label="Panel view">
      ${hasTeam ? `<button type="button" data-tab="team" aria-pressed="${tab === 'team'}">My Team</button>` : ''}
      <button type="button" data-tab="leaders" aria-pressed="${tab === 'leaders'}">Leaders</button>
      ${game ? `<button type="button" data-tab="game" aria-pressed="${tab === 'game'}">${esc(game.away.abbr)} @ ${esc(game.home.abbr)}</button>` : ''}
    </div>`;

  const body = tab === 'game' ? renderGame(gameId)
             : tab === 'team' ? renderTeam()
             : renderLeaders();

  el.innerHTML = `<div class="panel-head">${tabs}</div>
    <div class="panel-body">${body}</div>`;
}

export function wire() {
  const el = document.getElementById('panel');

  el.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.panel.tab = tabBtn.dataset.tab;
      state.panel.userPicked = true;
      render();
      return;
    }
    const catBtn = e.target.closest('[data-leadercat]');
    if (catBtn) {
      state.panel.leaderCat = catBtn.dataset.leadercat;
      render();
      el.querySelector('.panel-body')?.scrollTo(0, 0);
      return;
    }

    const follow = e.target.closest('[data-follow]');
    if (follow) {
      feed.setFollow(follow.dataset.follow, follow.dataset.followName || '');
      render();
    }
  });

  // Lineup and leader rows are focusable, so they have to answer the keyboard
  // the way the button they behave like would.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const follow = e.target.closest('[data-follow]');
    if (!follow) return;
    e.preventDefault();
    feed.setFollow(follow.dataset.follow, follow.dataset.followName || '');
    render();
  });

  document.getElementById('btn-panel')?.addEventListener('click', () => {
    state.panel.open = !state.panel.open;
    document.body.classList.toggle('panel-closed', !state.panel.open);
    emit('panel');
  });
}
