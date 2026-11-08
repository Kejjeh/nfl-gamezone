// The live fantasy matchup strip in the header.
//
// These numbers come straight from Sleeper's matchups endpoint, computed under
// the league's own scoring settings, so they agree with the Sleeper app exactly.
// Nothing here recomputes scoring.
import { state } from './state.js';

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
        <span class="mu-label">${escapeHtml(s.myName || 'You')}</span>
        <span class="mu-pts ${leading ? 'lead' : ''}">${me.toFixed(1)}</span>
      </div>
      <div class="mu-bar"><i style="width:${pct}%"></i></div>
      <div class="mu-side">
        <span class="mu-pts">${opp == null ? '&mdash;' : opp.toFixed(1)}</span>
        <span class="mu-label">${escapeHtml(s.oppName || 'Opponent')}</span>
      </div>
      <span class="mu-meta">${escapeHtml(s.league?.name || '')} &middot; Wk ${state.week ?? '?'}</span>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
