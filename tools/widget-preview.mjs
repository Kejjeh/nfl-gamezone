// Run ios/gamezone-widget.js on a desktop, against the live APIs.
//
// Scriptable only exists on iOS, so the only way to check the widget's data and
// text without a phone in hand is to stand in for the parts of its API that the
// script touches - Request, FileManager, ListWidget, Color, Font, args, config,
// Script - and then print the widget tree it builds.
//
// This verifies the data layer and every string the widget renders. It does not
// verify pixel layout: whether three lines fit a lock screen rectangle is a
// question only the device answers.
//
//   node tools/widget-preview.mjs                      # all families, no league
//   node tools/widget-preview.mjs YOUR_SLEEPER_NAME    # all families, with Sleeper
//   node tools/widget-preview.mjs YOUR_SLEEPER_NAME accessoryRectangular
//
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'ios', 'gamezone-widget.js');

const FAMILIES = [
  'accessoryInline', 'accessoryCircular', 'accessoryRectangular',
  'small', 'medium', 'large',
];

/* ------------------------------------------------- Scriptable stand-ins */

let requests = 0;

class Request {
  constructor(url) { this.url = url; this.timeoutInterval = 60; }
  async loadJSON() {
    requests += 1;
    const res = await fetch(this.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${this.url}`);
    return res.json();
  }
}

const cacheDir = path.join(os.tmpdir(), 'gz-widget-preview');
fs.mkdirSync(cacheDir, { recursive: true });

const FileManager = {
  local: () => ({
    documentsDirectory: () => cacheDir,
    joinPath: (a, b) => path.join(a, b),
    fileExists: (p) => fs.existsSync(p),
    readString: (p) => fs.readFileSync(p, 'utf8'),
    writeString: (p, s) => fs.writeFileSync(p, s),
  }),
};

class Color {
  constructor(hex) { this.hex = hex; }
}

const Font = {
  systemFont: (n) => ({ size: n, weight: 'regular' }),
  boldSystemFont: (n) => ({ size: n, weight: 'bold' }),
  mediumSystemFont: (n) => ({ size: n, weight: 'medium' }),
};

// The widget tree, recorded rather than drawn.
class WidgetText {
  constructor(text) { this.kind = 'text'; this.text = text; }
}

class WidgetStack {
  constructor(axis = 'v') { this.kind = 'stack'; this.axis = axis; this.children = []; }
  layoutHorizontally() { this.axis = 'h'; }
  layoutVertically() { this.axis = 'v'; }
  centerAlignContent() { this.centered = true; }
  addText(t) { const n = new WidgetText(t); this.children.push(n); return n; }
  addStack() { const n = new WidgetStack(); this.children.push(n); return n; }
  addSpacer(n) { this.children.push({ kind: 'spacer', size: n ?? null }); }
  addImage() { return {}; }
  addDate() { return new WidgetText('<date>'); }
}

class ListWidget extends WidgetStack {
  constructor() { super('v'); this.kind = 'widget'; }
  setPadding(...p) { this.padding = p; }
}

let presented = null;
const Script = {
  setWidget: (w) => { presented = w; },
  complete: () => {},
};

/* ---------------------------------------------------- tree -> plain text */

// Horizontal stacks are joined on one line, which is what the device does, so
// the output reads the way the widget does.
function flatten(node, depth = 0, out = []) {
  if (node.kind === 'text') {
    out.push({ depth, text: node.text, font: node.font, inline: false });
    return out;
  }
  if (node.kind === 'spacer') return out;
  if (node.kind === 'stack' && node.axis === 'h') {
    const parts = [];
    const collect = (n) => {
      if (n.kind === 'text') parts.push(n.text);
      else if (n.kind === 'stack') (n.children || []).forEach(collect);
    };
    node.children.forEach(collect);
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) out.push({ depth, text: joined, inline: true });
    return out;
  }
  for (const c of node.children || []) flatten(c, depth, out);
  return out;
}

function show(family, widget) {
  const lines = flatten(widget);
  // The character budget the script allows for that family, counting the lines
  // a text view is permitted to wrap over - so "wider than" means genuinely
  // over budget rather than merely longer than one line.
  const width = { accessoryInline: 60, accessoryCircular: 10, accessoryRectangular: 68,
    small: 84, medium: 108, large: 112 }[family] || 62;

  console.log(`\n┌─ ${family} ${'─'.repeat(Math.max(2, width - family.length - 3))}`);
  if (!lines.length) console.log('│ (empty)');
  for (const l of lines) {
    const over = l.text.length > width ? `   ← ${l.text.length} chars, wider than ~${width}` : '';
    console.log(`│ ${l.text}${over}`);
  }
  console.log(`└${'─'.repeat(width + 1)}`);
  return lines;
}

/* ------------------------------------------------------------------ main */

const username = (process.argv[2] || '').trim() || null;
const only = process.argv[3] || null;

Object.assign(globalThis, {
  Request, FileManager, Color, Font, ListWidget, WidgetStack, Script,
  args: { widgetParameter: username },
  config: { widgetFamily: 'medium', runsInWidget: false, runsInApp: true },
});

const require_ = createRequire(import.meta.url);
const widget = require_(SCRIPT);

console.log(`Fetching live data${username ? ` for Sleeper user "${username}"` : ' (no league)'}…`);
const t0 = Date.now();
const data = await widget.loadData(username);
const ms = Date.now() - t0;

const f = data.fantasy;
console.log(`\n${requests} requests, ${ms} ms`);
console.log(`games: ${data.games.length}  live: ${data.live.length}  `
  + `upcoming: ${data.upcoming.length}  final: ${data.finished.length}`);
console.log(`plays available: ${data.plays.length}`
  + `  red zone: ${data.plays.filter((p) => p.redZone).length}`);
if (data.error) console.log(`fantasy error: ${data.error}`);
if (f) {
  console.log(`league: ${f.leagueName} week ${f.week}`);
  console.log(`matchup: ${f.mine} vs ${f.opp}   yet to play: ${f.toPlay}`
    + `   names resolved: ${f.knownNames}`);
  const unknown = (f.starters || []).filter((s) => !s.team);
  if (unknown.length) console.log(`starters with no NFL team: ${unknown.map((s) => s.id).join(', ')}`);
}

let longest = 0;
for (const family of only ? [only] : FAMILIES) {
  globalThis.config.widgetFamily = family;
  const w = widget.buildWidget(data, family);
  const lines = show(family, w);
  for (const l of lines) longest = Math.max(longest, l.text.length);
}

console.log(`\nlongest rendered line: ${longest} chars`);
console.log(`cache dir: ${cacheDir}`);
