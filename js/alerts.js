// Sound, flash and desktop notifications.
//
// Audio is synthesised with WebAudio rather than shipped as files: nothing to
// host, no codec or autoplay-format issues. Browsers still refuse to start an
// AudioContext before a user gesture, so it is created lazily on first click.
import { state } from './state.js';

let ctx = null;

export function unlockAudio() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (err) {
    console.warn('[alerts] no audio', err);
  }
  return ctx;
}

function tone({ freq, start = 0, dur = 0.16, gain = 0.16, type = 'triangle' }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Bright ascending three-note figure.
export function chimeTD() {
  if (!state.settings.sound || !unlockAudio()) return;
  tone({ freq: 587.33, start: 0.00, dur: 0.14, gain: 0.17 });
  tone({ freq: 783.99, start: 0.10, dur: 0.14, gain: 0.17 });
  tone({ freq: 1046.5, start: 0.20, dur: 0.30, gain: 0.19 });
}

// Softer, lower single note so it is clearly not a score.
export function chimeRedZone() {
  if (!state.settings.sound || !unlockAudio()) return;
  tone({ freq: 440, start: 0, dur: 0.22, gain: 0.10, type: 'sine' });
  tone({ freq: 554.37, start: 0.11, dur: 0.24, gain: 0.09, type: 'sine' });
}

// Neutral tick for a play involving one of your starters.
export function chimeMine() {
  if (!state.settings.sound || !unlockAudio()) return;
  tone({ freq: 880, start: 0, dur: 0.11, gain: 0.08, type: 'sine' });
}

/* ---------- desktop notifications ---------- */

export function notifySupported() {
  return typeof Notification !== 'undefined';
}

export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch (err) {
    return 'denied';
  }
}

export function notify(title, body) {
  if (!state.settings.notify || !notifySupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: title + body, silent: true });
    setTimeout(() => n.close(), 8000);
  } catch (err) {
    /* some browsers require a service worker; fail quietly */
  }
}

/* ---------- dispatch ---------- */

// Called for each newly ingested play. Suppressed entirely until the backlog
// has been primed, otherwise loading the page mid-afternoon fires twenty
// touchdown chimes at once.
export function onNewPlay(play, game) {
  if (!state.primed) return;

  const label = game ? `${game.away.abbr} ${play.awayScore}-${play.homeScore} ${game.home.abbr}` : '';

  if (play.isTD) {
    chimeTD();
    notify(`Touchdown - ${label}`, play.shortText || play.text);
    return;
  }
  if (play.fan && play.fan.side === 'mine') {
    chimeMine();
    const who = play.fan.players.map((p) => p.name).join(', ');
    notify(`${who} - ${label}`, play.shortText || play.text);
  }
}

export function onRedZoneEntry(game) {
  if (!state.primed) return;
  chimeRedZone();

  // Which team is driving is the whole point of a red-zone alert, and the
  // score line alone does not say. ESPN leaves possessionTeamId and
  // downDistance null often enough - seen live on a game reading
  // isRedZone: true - that each part has to stand on its own.
  const pid = game.possessionTeamId;
  const driving = pid === game.home.id ? game.home.abbr
    : pid === game.away.id ? game.away.abbr : null;

  const body = [driving && `${driving} driving`, game.downDistance]
    .filter(Boolean).join(' · ') || 'Inside the 20';

  notify(
    `Red zone - ${game.away.abbr} ${game.away.score}-${game.home.score} ${game.home.abbr}`,
    body
  );
}
