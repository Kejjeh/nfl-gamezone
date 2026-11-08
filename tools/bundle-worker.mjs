// Flatten the Worker's three ES modules into one file.
//
//   node tools/bundle-worker.mjs
//
// The Cloudflare dashboard editor takes a single file, so deploying by
// browser instead of by wrangler needs the imports resolved up front. There
// are three modules and no npm dependencies, so this does it by hand rather
// than pulling in esbuild - and it fails loudly on anything it cannot prove
// safe, because a bundler that quietly drops a function would be worse than
// no bundler at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const DECL = /^(?:export\s+)?(?:async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const EXPORTED = /^export\s+(?:async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

const names = (src, re) =>
  src.split('\n').map((l) => (l.match(re) || [])[1]).filter(Boolean);

// Strip `export ` from declarations, drop import lines. `export default` stays.
const flatten = (src) => src
  .split('\n')
  .filter((l) => !/^import\s/.test(l))
  .map((l) => (/^export\s+default\b/.test(l) ? l : l.replace(/^export\s+/, '')))
  .join('\n')
  .trim();

const files = {
  'js/bets-core.js': read('js/bets-core.js'),
  'worker/src/vapid.js': read('worker/src/vapid.js'),
  'worker/src/index.js': read('worker/src/index.js'),
};

// A name defined twice would silently shadow. Refuse rather than guess.
const seen = new Map();
const clashes = [];
for (const [file, src] of Object.entries(files)) {
  for (const n of names(src, DECL)) {
    if (seen.has(n)) clashes.push(`${n}  (${seen.get(n)} and ${file})`);
    else seen.set(n, file);
  }
}
if (clashes.length) {
  console.error('Top-level name collisions - cannot flatten safely:');
  for (const c of clashes) console.error(`  ${c}`);
  process.exit(1);
}

// index.js reaches bets-core through a namespace import, so rebuild it.
const coreNames = names(files['js/bets-core.js'], EXPORTED);
const used = [...new Set(
  [...files['worker/src/index.js'].matchAll(/\bcore\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
)].filter((n) => n !== 'js');                      // 'bets-core.js' in a comment

// Everything the two Worker modules exported has to come back out, or the
// test harness - and anything else importing the bundle - loses it silently.
const reExport = [
  ...names(files['worker/src/vapid.js'], EXPORTED),
  ...names(files['worker/src/index.js'], EXPORTED),
];

const missing = used.filter((n) => !coreNames.includes(n));
if (missing.length) {
  console.error(`index.js uses core.${missing.join(', core.')} which bets-core does not export.`);
  process.exit(1);
}

const out = `// GENERATED FILE - do not edit. Regenerate with:
//
//   node tools/bundle-worker.mjs
//
// js/bets-core.js + worker/src/vapid.js + worker/src/index.js, flattened into
// one module so it can be pasted into the Cloudflare dashboard editor, which
// takes a single file. Deploying with wrangler does NOT need this - wrangler
// bundles the three modules itself. Edit the sources, never this.
//
// Built ${new Date().toISOString().slice(0, 10)} from ${coreNames.length} bets-core exports.

/* ---------------------------------------------------- js/bets-core.js */

${flatten(files['js/bets-core.js'])}

// The namespace index.js imported as \`core\`.
const core = { ${coreNames.join(', ')} };

/* ------------------------------------------------- worker/src/vapid.js */

${flatten(files['worker/src/vapid.js'])}

/* ------------------------------------------------- worker/src/index.js */

${flatten(files['worker/src/index.js'])}

export { ${reExport.join(', ')} };
`;

// Nothing may remain that a single-file environment cannot resolve.
const bad = out.split('\n').filter((l) => /^import\s/.test(l) || /^export\s+\{[^}]*\}\s+from/.test(l));
if (bad.length) {
  console.error('Unresolved module syntax left in the bundle:');
  for (const l of bad) console.error(`  ${l}`);
  process.exit(1);
}

const dest = path.join(root, 'worker', 'dist', 'gamezone-push.bundle.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);

const kb = (fs.statSync(dest).size / 1024).toFixed(1);
console.log(`wrote worker/dist/gamezone-push.bundle.js  ${kb} KB`);
console.log(`  ${coreNames.length} bets-core exports, ${used.length} used by the Worker: ${used.join(', ')}`);
console.log(`  ${seen.size} top-level names, no collisions`);
console.log(`  re-exported: ${reExport.join(', ')}`);
