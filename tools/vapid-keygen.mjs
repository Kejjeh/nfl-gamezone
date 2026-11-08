// Generate a VAPID key pair for the push Worker.
//
//   node tools/vapid-keygen.mjs
//
// The PUBLIC key is printed - it is meant to be public and goes in
// push-config.json, which is committed. The PRIVATE key is never printed; it
// is written to worker/.vapid-private.json, which is gitignored, and from
// there it goes straight into a Cloudflare secret:
//
//   cd worker
//   npx wrangler secret put VAPID_PRIVATE_JWK < .vapid-private.json
//
// Then delete the local file. Nothing prints it, pastes it, or commits it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(root, 'worker', '.vapid-private.json');

const b64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);

// The applicationServerKey the browser wants is the uncompressed public point,
// 65 bytes starting with 0x04 - which is exactly the raw export.
const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
const publicKey = b64url(raw);
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

if (fs.existsSync(out)) {
  console.error(`Refusing to overwrite ${out} - delete it first if you really mean to.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(privateJwk));

// Fill in push-config.json for them, since getting this string wrong is the
// most likely way for the whole thing to silently not work.
const cfgPath = path.join(root, 'push-config.json');
let cfg = { api: '', vapidPublicKey: '' };
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { /* first run */ }
cfg.vapidPublicKey = publicKey;
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

console.log('Public key (safe to commit, written to push-config.json):');
console.log(`  ${publicKey}`);
console.log('');
console.log(`Private key written to ${out} (gitignored). Next:`);
console.log('  cd worker');
console.log('  npx wrangler secret put VAPID_PRIVATE_JWK < .vapid-private.json');
console.log(`  npx wrangler secret put VAPID_PUBLIC_KEY   # paste the public key above`);
console.log('  rm .vapid-private.json');
console.log('');
console.log('Then put your Worker URL in push-config.json as "api".');
