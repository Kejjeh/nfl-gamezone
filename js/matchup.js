// The live fantasy matchup strip in the header.
//
// These numbers come straight from Sleeper's matchups endpoint, computed under
// the league's own scoring settings, so they agree with the Sleeper app exactly.
// Nothing here recomputes scoring. The player counts below are not scoring:
// they classify each starter's GAME, which is what tells you whether a lead is
// safe.
import { state } from './state.js';
import * as espn from './espn.js';
import * as sleeper from './sleeper.js';

// Three states, not two. "Hasn't kicked off" and "on the field right now" are
// completely different positions to be in when you are reading a scoreline, and
// a single "yet to play" count collapsed them together.
// Exported because the My Team panel shows the same breakdown.
export function lineupStates(ids) {
  const out = { pre: 0, live: 0, done: 0, unknown: 0 };
  for (const pid of ids || []) {
    // Team defences carry the team abbreviation as their id, so fall back to it.
    const g = espn.gameForTeam(sleeper.playerTeam(pid) || pid);
    if (!g) out.unknown += 1;
    else if (g.state === 'pre') out.pre += 1;
    else if (g.state === 'in') out.live += 1;
    else out.done += 1;
  }
  return out;
}

// Only the non-zero parts, so a finished week reads "9 done" rather than
// "0 to play - 0 live - 9 done".
export function statesLabel(st) {
  if (!st) return '';
  if (!st.pre && !st.live && !st.done) return st.unknown ? 'no games on the board' : '';
  const parts = [];
  if (st.pre) parts.push(`${st.pre} to play`);
  if (st.live) parts.push(`${st.live} live`);
  if (st.done) parts.push(`${st.done} done`);
  // Bye weeks, inactives, and anything the scoreboard does not carry. Counting
  // only the players we resolved would quietly report 7 of 9 starters as the
  // whole lineup; those slots are worth nothing this week and should say so.
  if (st.unknown) parts.push(`${st.unknown} no game`);
  return parts.join(' \u00b7 ');
}

export function render() {
  const el = document.getElementById('matchup');
  if (!el) return;
  const s = state.sleeper;

  if (s.error) {
    el.innerHTML = `<div class="mu-empty">Sleeper: ${escapeHtml(s.error)}
      <button id="mu-connect">Retry</button></div>`;
    return;
  }
  if (!s.leagueId) {
    el.innerHTML = `<div class="mu-empty">Play feed only
      <button id="mu-connect">Connect Sleeper</button></div>`;
    return;
  }
  if (s.myPoints == null) {
    el.innerHTML = `<div class="mu-empty">${escapeHtml(s.league?.name || 'League')}
      &mdash; no matchup for week ${state.week ?? '?'}</div>`;
    return;
  }

  const me = Number(s.myPoints) || 0;
  const opp = s.oppPoints == null ? null : Number(s.oppPoints) || 0;
  const total = opp == null ? me : me + opp;
  const pct = total > 0 ? Math.round((me / total) * 100) : 50;
  const leading = opp != null && me >= opp;

  el.innerHTML = `
    <div class="mu">
      <div class="mu-side">
        <span class="mu-who">
          <span class="mu-label">${escapeHtml(s.myName || 'You')}</span>
          <span class="mu-left">${statesLabel(lineupStates(s.myLineup))}</span>
        </span>
        <span class="mu-pts ${leading ? 'lead' : ''}">${me.toFixed(1)}</span>
      </div>
      <div class="mu-bar"><i style="width:${pct}%"></i></div>
      <div class="mu-side">
        <span class="mu-pts">${opp == null ? '&mdash;' : opp.toFixed(1)}</span>
        <span class="mu-who">
          <span class="mu-label">${escapeHtml(s.oppName || 'Opponent')}</span>
          <span class="mu-left">${statesLabel(lineupStates(s.oppLineup))}</span>
        </span>
      </div>
      <span class="mu-meta">${escapeHtml(s.league?.name || '')} &middot; Wk ${state.week ?? '?'}</span>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
