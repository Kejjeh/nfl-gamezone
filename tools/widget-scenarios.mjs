// The paths a live Sunday run never reaches.
//
// The happy path is easy to check on a game day: run tools/widget-preview.mjs
// and read the output. These four are the ones that only show up when something
// is wrong or when nothing is on, which is most of the week - so they get
// forced here rather than waited for.
//
//   node tools/widget-scenarios.mjs [sleeperUsername]
//
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'ios', 'gamezone-widget.js');
const username = (process.argv[2] || '').trim() || null;

const cacheDir = path.join(os.tmpdir(), 'gz-widget-scenarios');

/* ------------------------------------------------------------ the stubs */

let behaviour = { mode: 'live', transform: null };

class Request {
  constructor(url) { this.url = url; this.timeoutInterval = 60; }
  async loadJSON() {
    if (behaviour.mode === 'offline') throw new Error('The Internet connection appears to be offline.');
    const res = await fetch(this.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${this.url}`);
    const json = await res.json();
    return behaviour.transform ? behaviour.transform(this.url, json) : json;
  }
}

const FileManager = {
  local: () => ({
    documentsDirectory: () => cacheDir,
    joinPath: (a, b) => path.join(a, b),
    fileExists: (p) => fs.existsSync(p),
    readString: (p) => fs.readFileSync(p, 'utf8'),
    writeString: (p, s) => fs.writeFileSync(p, s),
  }),
};

class Color { constructor(hex) { this.hex = hex; } }
const Font = {
  systemFont: (n) => ({ size: n }), boldSystemFont: (n) => ({ size: n, bold: true }),
  mediumSystemFont: (n) => ({ size: n }),
};
class WidgetText { constructor(t) { this.kind = 'text'; this.text = t; } }
class WidgetStack {
  constructor(axis = 'v') { this.kind = 'stack'; this.axis = axis; this.children = []; }
  layoutHorizontally() { this.axis = 'h'; }
  layoutVertically() { this.axis = 'v'; }
  centerAlignContent() {}
  addText(t) { const n = new WidgetText(t); this.children.push(n); return n; }
  addStack() { const n = new WidgetStack(); this.children.push(n); return n; }
  addSpacer() {}
}
class ListWidget extends WidgetStack {
  constructor() { super('v'); this.kind = 'widget'; }
  setPadding() {}
  presentSmall() {} presentMedium() {} presentLarge() {}
}

let captured = null;
const Script = { setWidget: (w) => { captured = w; }, complete: () => {} };

function lines(node, out = []) {
  if (!node) return out;
  if (node.kind === 'text') { out.push(node.text); return out; }
  if (node.kind === 'stack' && node.axis === 'h') {
    const parts = [];
    const walk = (n) => {
      if (n.kind === 'text') parts.push(n.text);
      else if (n.kind === 'stack') (n.children || []).forEach(walk);
    };
    node.children.forEach(walk);
    const j = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (j) out.push(j);
    return out;
  }
  for (const c of node.children || []) lines(c, out);
  return out;
}

Object.assign(globalThis, {
  Request, FileManager, Color, Font, ListWidget, WidgetStack, Script,
  args: { widgetParameter: username },
  config: { widgetFamily: 'accessoryRectangular', runsInWidget: true, runsInApp: false },
});

const widget = createRequire(import.meta.url)(SCRIPT);

/* -------------------------------------------------------------- helpers */

const reset = () => { fs.rmSync(cacheDir, { recursive: true, force: true }); fs.mkdirSync(cacheDir, { recursive: true }); };

let failures = 0;

async function scenario(name, setup, expect) {
  captured = null;
  behaviour = { mode: 'live', transform: null };
  globalThis.args.widgetParameter = username;   // before setup, so setup can override it
  await setup();
  try {
    await widget.main();
  } catch (e) {
    console.log(`\n${name}\n  THREW: ${e.message}`);
    failures += 1;
    return;
  }
  const out = lines(captured);
  console.log(`\n${name}`);
  for (const l of out) console.log(`  | ${l}`);
  const problem = expect(out.join(' · '), out);
  if (problem) { console.log(`  FAIL: ${problem}`); failures += 1; } else { console.log('  ok'); }
}

/* ------------------------------------------------------------ scenarios */

// Every game moved to "scheduled", which is what a Tuesday looks like.
const noGames = (url, json) => {
  if (!url.includes('/scoreboard')) return json;
  for (const ev of json.events || []) {
    ev.status = { type: { state: 'pre', shortDetail: 'Sun 1:00 PM' }, period: 0, displayClock: '0:00' };
    for (const c of ev.competitions || []) { delete c.situation; for (const t of c.competitors || []) t.score = '0'; }
  }
  return json;
};

await scenario(
  '1. No games on (every event rescheduled)',
  () => { reset(); behaviour = { mode: 'live', transform: noGames }; },
  (joined) => {
    if (/\d+ games live/.test(joined) && !/0 games live/.test(joined)) return 'claims games are live';
    if (!/Next:|No games today/.test(joined)) return 'does not name the next kickoff';
    return null;
  }
);

await scenario(
  '2. Offline with nothing cached (worst case)',
  () => { reset(); behaviour = { mode: 'offline', transform: null }; },
  (joined) => (/GameZone/i.test(joined) ? null : 'no identifiable fallback widget')
);

await scenario(
  '3. Offline after a good run (should show stale data, not an error)',
  async () => {
    reset();
    behaviour = { mode: 'live', transform: null };
    await widget.main();                     // populates the gz-last.json cache
    behaviour = { mode: 'offline', transform: null };
  },
  (joined) => (/offline/i.test(joined)
    ? 'fell through to the error widget instead of the cache' : null)
);

await scenario(
  '4. Bad Sleeper username (scores must still render)',
  () => { reset(); globalThis.args.widgetParameter = 'definitely-not-a-real-user-zzz'; },
  (joined) => (/games live|Next:|No games today/.test(joined)
    ? null : 'lost the NFL scores because the fantasy lookup failed')
);

console.log(`\n${failures ? `${failures} scenario(s) failed` : 'all scenarios passed'}`);
process.exit(failures ? 1 : 0);
