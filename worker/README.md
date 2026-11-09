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

Cloudflare's free plan covers it, but only because of the order the tick does
things in. The ceilings that matter are per operation type per day, and they
reset at 00:00 UTC - 7pm ET during the season, so a Sunday's afternoon slate
and Sunday Night Football draw on two different days' budgets.

| Operation | Free plan | A full Sunday here |
|---|---|---|
| KV list | 1,000/day | **none at all** |
| KV write | 1,000/day | one per minute in which a tracked number moved: tens, not hundreds |
| KV read | 100,000/day | one per live minute, about 650 |
| Worker requests | 100,000/day | 1,440 cron runs plus a few route calls |
| Subrequests per run | 50 | about 16 on a full slate |

Two things keep it there, and both are load-bearing:

- **The scoreboard is fetched before KV is touched at all**, so a tick with
  nothing live costs nothing. Monday through Saturday is free.
- **Every subscription lives in one KV record**, written only when a tracked
  number actually moved. A second phone costs nothing.

The first version got this wrong, and it is worth recording why. It called
`list()` to find the subscriptions *before* checking whether any game was live,
spending 1,440 list operations a day against a ceiling of 1,000 - games or not.
List operations ran out at 16:40 UTC every day, `list()` then failed, and the
cron did nothing until the quota reset. It also wrote once per subscription per
live minute whether anything had changed or not. The note that used to sit here
read "a four-hour slate at one run a minute is 240", which counted only writes,
only during games, and only for one device.

`tools/worker-test.mjs` now asserts the operation counts rather than only that
a push goes out, so this cannot come back quietly.

Nothing here needs a paid plan, and nothing bills by usage. If you would rather
not create a Cloudflare account, skip the whole directory — the site works
exactly as before, with alerts while it is open.

## Setup

Two routes. The CLI one below, or **[DEPLOY-BY-BROWSER.md](DEPLOY-BY-BROWSER.md)**
to do it through the Cloudflare dashboard with no CLI and no API token - which
is also the brief to hand a browser-driving agent. That route pastes
`dist/gamezone-push.bundle.js`, the three modules flattened into one file,
since the dashboard editor takes only one. Regenerate it with
`node tools/bundle-worker.mjs` after any change to the Worker or to
`js/bets-core.js`.

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
  └─ ESPN scoreboard ──> live games       [no KV yet: a quiet tick costs nothing]
        └─ every subscription, from ONE KV record                     [1 read]
              └─ summary per live game ──> statsFromSummary()  [bets-core]
                    └─ per subscription: diffLegs(bets, ctx, lastSeen)  [bets-core]
                          └─ did a tracked number move?
                                ├─ one KV write covering every subscription
                                └─ send an EMPTY push to each one with news
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
| `POST /test` | `{endpoint}` - send one alert now, to a subscription already stored |
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
