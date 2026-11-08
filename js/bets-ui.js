// The Bets panel tab, and the dialog for getting bets in.
//
// Rendering only: storage and parsing are in bets.js, settlement in
// bets-core.js. This module owns the markup and the event wiring.
import { state } from './state.js';
import * as bets from './bets.js';
import * as core from './bets-core.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  return `${v < 0 ? '-' : ''}$${s.replace('-', '')}`;
};

// What each state looks like at a glance. The glyph carries the meaning for
// anyone who cannot pick the colours apart.
const LEG_STATE = {
  won:     { cls: 'won',   mark: '✓', word: 'won' },
  hit:     { cls: 'hit',   mark: '✓', word: 'hit' },
  lost:    { cls: 'lost',  mark: '✕', word: 'lost' },
  busted:  { cls: 'lost',  mark: '✕', word: 'busted' },
  push:    { cls: 'push',  mark: '=',      word: 'push' },
  open:    { cls: 'open',  mark: '◐', word: 'live' },
  pending: { cls: 'pend',  mark: '○', word: 'not started' },
  unknown: { cls: 'unk',   mark: '?',      word: 'not tracked' },
};

const BET_STATE = {
  won: 'won', lost: 'lost', push: 'push', 'all hit': 'all hit', open: 'live',
};

/* ------------------------------------------------------------------ list */

export function render() {
  const rows = bets.allStatuses();

  const actions = `
    <div class="bt-actions">
      <button type="button" id="bt-add" class="primary">Add a bet</button>
      ${rows.length ? '<button type="button" id="bt-clear-settled">Clear decided</button>' : ''}
    </div>`;

  if (!rows.length) {
    return `${actions}
      <p class="t-msg">No bets yet. Paste a slip from FanDuel or DraftKings, or
      enter one by hand.</p>
      <p class="bt-note">Neither book lets anything read your bets - there is no
      public API and no account access for third parties - so a pasted slip is
      the closest thing to a sync. Everything stays on this device.</p>`;
  }

  const live = rows.filter((r) => !isSettled(r.status.state));
  const done = rows.filter((r) => isSettled(r.status.state));

  return `${actions}
    ${summary(rows)}
    ${live.length ? `<h3 class="bt-h">Open</h3>${live.map(card).join('')}` : ''}
    ${done.length ? `<h3 class="bt-h">Decided</h3>${done.map(card).join('')}` : ''}`;
}

const isSettled = (s) => s === 'won' || s === 'lost' || s === 'push';

function summary(rows) {
  let staked = 0, atStake = 0, returned = 0;
  for (const { bet, status } of rows) {
    const stake = Number(bet.stake) || 0;
    staked += stake;
    if (isSettled(status.state)) returned += status.returned;
    else atStake += stake;
  }
  // Only settled bets have moved money. An open bet is not a loss yet, so the
  // figure shown is what is decided so far, with the live exposure separate.
  const settledStake = staked - atStake;
  const net = returned - settledStake;

  return `<div class="bt-sum">
    <div><span>staked</span><b>${money(staked)}</b></div>
    <div><span>live</span><b>${money(atStake)}</b></div>
    <div><span>decided</span><b class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${net >= 0 ? '+' : ''}${money(net)}</b></div>
  </div>`;
}

function card({ bet, status }) {
  const word = BET_STATE[status.state] || status.state;
  const cls = status.state === 'won' ? 'won'
    : status.state === 'lost' ? 'lost'
    : status.state === 'all hit' ? 'hit' : 'open';

  const head = [
    bet.legs.length > 1 ? `${bet.legs.length}-leg parlay` : 'single',
    bet.book !== 'manual' ? bookName(bet.book) : null,
    core.formatOdds(bet.odds),
  ].filter(Boolean).join(' · ');

  const paid = `${money(bet.stake)} → ${money((Number(bet.stake) || 0) + status.toWin)}`;

  return `<article class="bt bt--${cls}" data-bet="${esc(bet.id)}">
    <header>
      <div class="bt-meta">${esc(head)}</div>
      <div class="bt-state">${esc(word)}</div>
    </header>
    <div class="bt-line">
      <span class="bt-paid">${esc(paid)}</span>
      ${bet.legs.length > 1 ? `<span class="bt-legs">${status.legsHit}/${status.legsTotal} legs</span>` : ''}
      <button type="button" class="bt-del" data-del="${esc(bet.id)}"
        aria-label="Delete bet">×</button>
    </div>
    <ol class="bt-leglist">${status.legs.map(legRow).join('')}</ol>
  </article>`;
}

const bookName = (b) => (b === 'fanduel' ? 'FanDuel' : b === 'draftkings' ? 'DraftKings' : b);

function legRow({ leg, prog }) {
  const s = LEG_STATE[prog.state] || LEG_STATE.unknown;
  const pct = Math.round((prog.pct || 0) * 100);

  // The bar is the point of the whole feature: 26 of 40 yards, seen at a
  // glance. It is meaningless for a market with no line, so it is left off.
  const bar = prog.state === 'pending' || prog.state === 'unknown' || prog.line == null
    ? ''
    : `<div class="bt-bar"><i style="width:${Math.min(100, pct)}%"></i></div>`;

  const follow = leg.athleteId
    ? ` data-follow="${esc(leg.athleteId)}" data-follow-name="${esc(leg.playerName || '')}" tabindex="0" role="button"`
    : '';

  const warn = leg.unresolved
    ? `<span class="bt-warn" title="${esc(leg.unresolved)}">not matched</span>` : '';

  return `<li class="bt-leg bt-leg--${s.cls}"${follow}>
    <span class="bt-mark" aria-hidden="true">${s.mark}</span>
    <span class="bt-desc">${esc(core.describeLeg(leg))} ${warn}</span>
    <span class="bt-prog">${esc(prog.label)}</span>
    ${bar}
    <span class="bt-detail">${esc(prog.detail || s.word)}</span>
  </li>`;
}

/* ----------------------------------------------------------- the dialog */

// Kept in module scope rather than the DOM so a half-finished bet survives a
// re-render while games keep polling underneath.
let draft = null;

export function openDialog() {
  draft = { book: 'manual', stake: '', odds: '', legs: [blankLeg()], warnings: [], text: '' };
  paint();
  show(true);
}

const blankLeg = () => ({
  market: 'rec_yds', side: 'over', line: '', cmp: 'gt',
  rawName: '', playerName: '', athleteId: null, teamAbbr: '', odds: 0,
});

function show(on) {
  const el = document.getElementById('betdlg');
  if (!el) return;
  el.hidden = !on;
  if (on) el.querySelector('#bt-paste')?.focus();
}

function paint() {
  const el = document.getElementById('betdlg');
  if (!el || !draft) return;
  el.querySelector('.card').innerHTML = dialogMarkup();
}

function dialogMarkup() {
  const marketOptions = (sel) => {
    const player = Object.entries(core.MARKETS)
      .map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
    const gameOpts = Object.entries(core.GAME_MARKETS)
      .map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
    return `<optgroup label="Player">${player}</optgroup><optgroup label="Game">${gameOpts}</optgroup>`;
  };

  const legs = draft.legs.map((leg, i) => {
    const isGame = core.isGameMarket(leg.market);
    const binary = !!core.MARKETS[leg.market]?.binary;
    const cands = leg.candidates && leg.candidates.length > 1;

    return `<div class="bl" data-leg="${i}">
      <div class="bl-row">
        <select data-f="market" aria-label="Market">${marketOptions(leg.market)}</select>
        <button type="button" class="bl-del" data-legdel="${i}" aria-label="Remove leg">×</button>
      </div>
      <div class="bl-row">
        ${isGame
          ? `<input type="text" data-f="teamAbbr" value="${esc(leg.teamAbbr || '')}" placeholder="Team (CIN)" aria-label="Team">`
          : cands
            ? `<select data-f="athleteId" aria-label="Which player">
                 <option value="">Pick the right player…</option>
                 ${leg.candidates.map((c) => `<option value="${esc(c.athleteId)}"${c.athleteId === leg.athleteId ? ' selected' : ''}>${esc(c.name)} · ${esc(c.team)} ${esc(c.pos)}</option>`).join('')}
               </select>`
            : `<input type="text" data-f="rawName" value="${esc(leg.playerName || leg.rawName || '')}" placeholder="Player name" aria-label="Player">`}
      </div>
      <div class="bl-row bl-row--line">
        ${binary ? '' : `
          <select data-f="side" aria-label="Over or under">
            <option value="over"${leg.side !== 'under' ? ' selected' : ''}>over</option>
            <option value="under"${leg.side === 'under' ? ' selected' : ''}>under</option>
          </select>
          <input type="text" inputmode="decimal" data-f="line" value="${esc(leg.line)}" placeholder="39.5" aria-label="Line">
          <label class="bl-chk"><input type="checkbox" data-f="cmp" ${leg.cmp === 'gte' ? 'checked' : ''}> "+" line</label>`}
        ${leg.unresolved && !cands ? `<span class="bt-warn">${esc(leg.unresolved)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
    <h2 id="bt-title">Add a bet</h2>
    <p class="sub">Paste a slip from the FanDuel or DraftKings app and it will be
      pulled apart below, or just fill it in. Nothing is saved until you press Save.</p>

    <label for="bt-paste">Paste a bet slip</label>
    <textarea id="bt-paste" rows="4" placeholder="Ja'Marr Chase Over 39.5 Receiving Yards&#10;+110&#10;Wager $10.00">${esc(draft.text)}</textarea>
    <div class="row">
      <button type="button" id="bt-parse">Read the slip</button>
    </div>

    ${draft.warnings.length ? `<ul class="bt-warnlist">${draft.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

    <div class="bl-head"><span>Legs</span><button type="button" id="bt-addleg">Add a leg</button></div>
    <div id="bt-legs">${legs}</div>

    <div class="bl-row bl-row--money">
      <label>Stake<input type="text" inputmode="decimal" id="bt-stake" value="${esc(draft.stake)}" placeholder="10"></label>
      <label>Odds<input type="text" inputmode="numeric" id="bt-odds" value="${esc(draft.odds)}" placeholder="+600"></label>
    </div>
    <p class="bt-note" id="bt-preview">${esc(previewLine())}</p>

    <div class="row">
      <button type="button" id="bt-cancel">Cancel</button>
      <button type="button" id="bt-save" class="primary">Save</button>
    </div>`;
}

function previewLine() {
  const stake = Number(draft.stake) || 0;
  const odds = Number(draft.odds) || 0;
  if (!stake || !odds) return 'Enter a stake and a price to see the return.';
  const p = core.profit(stake, odds);
  return `${money(stake)} at ${core.formatOdds(odds)} returns ${money(stake + p)} (${money(p)} profit).`;
}

/* ------------------------------------------------------------- wiring */

export function wire(onChange) {
  const dlg = document.getElementById('betdlg');
  if (!dlg) return;

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { show(false); return; }

    if (e.target.closest('#bt-cancel')) { show(false); return; }

    if (e.target.closest('#bt-parse')) {
      const text = dlg.querySelector('#bt-paste')?.value || '';
      const r = bets.parseSlip(text);
      draft = {
        book: r.book,
        stake: r.stake || '',
        odds: r.odds || '',
        legs: r.legs.length ? r.legs : [blankLeg()],
        warnings: r.warnings,
        text,
      };
      paint();
      return;
    }

    if (e.target.closest('#bt-addleg')) {
      readFields();
      draft.legs.push(blankLeg());
      paint();
      return;
    }

    const del = e.target.closest('[data-legdel]');
    if (del) {
      readFields();
      draft.legs.splice(Number(del.dataset.legdel), 1);
      if (!draft.legs.length) draft.legs.push(blankLeg());
      paint();
      return;
    }

    if (e.target.closest('#bt-save')) {
      readFields();
      const problem = validate();
      if (problem) {
        draft.warnings = [problem];
        paint();
        return;
      }
      bets.add({
        book: draft.book,
        stake: Number(draft.stake) || 0,
        odds: Number(draft.odds) || 0,
        legs: draft.legs.map(cleanLeg),
      });
      show(false);
      onChange?.();
    }
  });

  // Re-read on every change so the leg editor reshapes itself: switching to a
  // game market swaps the player field for a team field, and anytime TD has no
  // line at all.
  dlg.addEventListener('change', (e) => {
    if (!e.target.matches('select, input')) return;
    readFields();
    if (e.target.matches('[data-f="market"]')) paint();
    else {
      const prev = dlg.querySelector('#bt-preview');
      if (prev) prev.textContent = previewLine();
    }
  });
}

function readFields() {
  const dlg = document.getElementById('betdlg');
  if (!dlg || !draft) return;
  draft.stake = dlg.querySelector('#bt-stake')?.value ?? draft.stake;
  draft.odds = dlg.querySelector('#bt-odds')?.value ?? draft.odds;
  draft.text = dlg.querySelector('#bt-paste')?.value ?? draft.text;

  dlg.querySelectorAll('.bl').forEach((el) => {
    const leg = draft.legs[Number(el.dataset.leg)];
    if (!leg) return;
    el.querySelectorAll('[data-f]').forEach((f) => {
      const key = f.dataset.f;
      if (key === 'cmp') { leg.cmp = f.checked ? 'gte' : 'gt'; return; }
      const v = f.value;
      if (key === 'athleteId') {
        leg.athleteId = v || null;
        const pick = (leg.candidates || []).find((c) => c.athleteId === v);
        if (pick) { leg.playerName = pick.name; leg.teamAbbr = pick.team; leg.unresolved = null; }
        return;
      }
      leg[key] = v;
    });

    // A name typed by hand still has to be resolved to an athlete.
    if (!core.isGameMarket(leg.market) && leg.rawName && !leg.athleteId) {
      const r = bets.resolvePlayer(leg.rawName, leg.teamAbbr);
      leg.athleteId = r.athleteId;
      leg.candidates = r.athleteId ? undefined : r.candidates;
      leg.unresolved = r.athleteId ? null : r.reason;
      if (r.athleteId && r.candidates[0]) {
        leg.playerName = r.candidates[0].name;
        leg.teamAbbr = r.candidates[0].team;
      }
    }
    if (core.MARKETS[leg.market]?.binary) { leg.side = 'yes'; leg.line = 1; }
  });
}

function validate() {
  if (!draft.legs.length) return 'A bet needs at least one leg.';
  for (const leg of draft.legs) {
    const binary = !!core.MARKETS[leg.market]?.binary;
    if (core.isGameMarket(leg.market)) {
      if (leg.market !== 'game_total' && !leg.teamAbbr) return 'A team is needed for that market.';
      if (leg.market !== 'moneyline' && !Number.isFinite(Number(leg.line))) return 'That leg needs a line.';
      continue;
    }
    if (!leg.athleteId) return `Pick a player for "${leg.rawName || leg.playerName || 'the first leg'}".`;
    if (!binary && !Number.isFinite(Number(leg.line))) return 'That leg needs a line.';
  }
  if (!Number(draft.stake)) return 'A stake is needed.';
  return null;
}

// Drop the editor-only fields before anything is stored.
function cleanLeg(leg) {
  const out = {
    market: leg.market,
    side: core.MARKETS[leg.market]?.binary ? 'yes' : (leg.side || 'over'),
    cmp: leg.cmp || 'gt',
    line: Number(leg.line) || (core.MARKETS[leg.market]?.binary ? 1 : 0),
    odds: Number(leg.odds) || 0,
  };
  if (core.isGameMarket(leg.market)) out.teamAbbr = String(leg.teamAbbr || '').toUpperCase();
  else {
    out.athleteId = leg.athleteId;
    out.playerName = leg.playerName || leg.rawName || '';
    out.team = leg.teamAbbr || leg.team || null;
  }
  return out;
}
