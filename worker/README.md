# gamezone-push

The part GitHub Pages cannot be.

## Why this exists

Three facts, each checked rather than assumed:

- **iOS only delivers web push to a web app added to the Home Screen**, from
  iOS 16.4. A page open in a Safari tab cannot receive push at all.
- **Web Push is server-initiated by definition.** Something has to hold a VAPID
  private key and send a request to `*.push.apple.com`. GitHub Pages serves
  static files; it cannot send anything.
- **iOS has neither Background Sync nor Periodic Background Sync**, so an
  installed web app cannot wake itself up to check the score either.

So without something always-on, phone alerts can only fire while the app is
open in front of you — which is no use, because that is exactly when you are
already looking. This Worker is the smallest thing that fixes it: a cron, a
poll, and a push.

It imports **the same `js/bets-core.js` the site uses**, rather than
reimplementing settlement, so the phone and the browser can never disagree
about whether a leg has hit.

## Cost

Cloudflare's free plan covers it. Cron Triggers are included, the limit is
100,000 requests a day against a few hundred here, and each run makes about 16
subrequests against a free-plan ceiling of 50. KV's free tier allows 1,000
writes a day; a four-hour slate at one run a minute is 240.

Nothing here needs a paid plan, and nothing bills by usage. If you would rather
not create a Cloudflare account, skip the whole directory — the site works
exactly as before, with alerts while it is open.

## Setup

**1. Generate the keys.** From the project root:

```bash
node tools/vapid-keygen.mjs
```

It prints the **public** key and writes it into `push-config.json`. It writes
the **private** key to `worker/.vapid-private.json`, which is gitignored, and
never prints it.

**2. Create the KV namespace** and put its id in `wrangler.toml`:

```bash
cd worker && npx wrangler kv namespace create GZ
```

**3. Set the three secrets**, then delete the local private key:

```bash
npx wrangler secret put VAPID_PRIVATE_JWK < .vapid-private.json
```

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
```

```bash
npx wrangler secret put VAPID_SUBJECT
```

```bash
rm .vapid-private.json
```

`VAPID_SUBJECT` is a `mailto:` address a push service can reach you at, which
the spec requires — `mailto:you@example.com`, with the `mailto:` prefix
included. It is a secret rather than a `wrangler.toml` var for one reason only:
that file is committed to a public repo, and this is an email address.

**4. Check `ALLOWED_ORIGIN`** in `wrangler.toml` matches where the site is
served from. It is the only thing left in that file worth changing.

**5. Deploy**, then put the URL it prints into `push-config.json` as `api`:

```bash
npx wrangler deploy
```

**6. Commit `push-config.json`** and let Pages redeploy. Only the public key
and the Worker URL are in it; both are meant to be public.

**7. On the iPhone**: open the site in Safari, Share → **Add to Home Screen**,
open it from the Home Screen icon, then Settings → **Phone alerts**. It will
refuse to turn on from a Safari tab, and say so.

Check it is alive:

```bash
curl https://gamezone-push.<your-subdomain>.workers.dev/health
```

`{"ok":true,"configured":true,"missing":[]}` means every secret and the KV
binding are in place. Anything listed in `missing` is a step that did not
take - the Worker will still answer and still run its cron, it just will not
get a push accepted.

## How it works

```
cron (1 min)
  └─ ESPN scoreboard ──> live games
        └─ summary per live game ──> statsFromSummary()  [bets-core]
              └─ per subscription: diffLegs(bets, ctx, lastSeen)  [bets-core]
                    └─ something worth saying?
                          ├─ store the message under the subscription
                          └─ send an EMPTY push
                                └─ service worker wakes, POSTs /pending,
                                   gets the message, shows the notification
```

**The push carries no payload.** Encrypting one (RFC 8291) means ECDH against
the subscription key, then HKDF, then AES-GCM — a lot of crypto whose failure
mode is a message that silently never arrives. An empty push needs only the
VAPID signature, so `sw.js` fetches the text instead. One more round trip on
the device, far less that can break.

The first tick after subscribing only records where everything stands, so
switching alerts on mid-afternoon does not immediately announce every leg that
already hit.

## Routes

| | |
|---|---|
| `POST /subscribe` | `{subscription, bets}` — store a new subscription |
| `POST /bets` | `{endpoint, bets}` — the site calls this whenever bets change |
| `POST /pending` | `{endpoint}` — the service worker fetches, and clears, the message |
| `POST /unsubscribe` | `{endpoint}` |
| `GET /health` | whether the secrets are set |

A `404`/`410` from the push service means the subscription is dead, and it is
deleted.

## Testing

```bash
node tools/worker-test.mjs
```

Runs against live ESPN data with a fake KV and an intercepted push endpoint. It
generates a real VAPID key pair, signs a real JWT and **verifies the signature
against the public key**; checks the JWT is cached per push origin; builds a bet
on a player who already has yards, rewinds the baseline, and asserts a push goes
out with a VAPID `Authorization` header and the right message; checks the
message is consumed so it cannot show twice; and checks a `410` drops the
subscription.

What it cannot cover is the last hop. Whether an iPhone actually buzzes is
something only an iPhone can tell you.
