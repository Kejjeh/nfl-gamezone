# Deploying gamezone-push with browser control

Instructions for an agent driving a browser (Claude Cowork, Claude in Chrome)
to deploy this Worker through the Cloudflare dashboard, with no CLI and no API
token.

Paste this whole file to that agent as the brief.

---

## Goal

A Cloudflare Worker named **gamezone-push** running on a one-minute cron,
which polls ESPN and sends web-push alerts to an iPhone when a bet leg hits or
busts. Done when `GET <worker-url>/health` returns:

```json
{"ok":true,"configured":true,"missing":[]}
```

Then report the Worker's `*.workers.dev` URL back. That URL is the only output
that matters; everything else is setup.

## Before you start — two things you must not do

**1. Do not type the VAPID private key, and do not open the file holding it.**
Two of the five values below are the user's to enter. Navigate to the field,
then stop and ask them to type it. The private key is the one credential that,
if it leaks, lets anyone send notifications to their phone.

**2. Do not create anything on a paid plan.** Everything here is on
Cloudflare's free tier: Workers, Cron Triggers and KV all have free
allowances this uses a fraction of. If the dashboard asks for payment details
at any point, stop and report it — you have gone down the wrong path.

## The values

| What | Value | Who enters it |
|---|---|---|
| Worker name | `gamezone-push` | you |
| KV binding variable name | `GZ` | you — **exactly** `GZ`, the code reads `env.GZ` |
| Plain-text variable | `ALLOWED_ORIGIN` = `https://kejjeh.github.io` | you |
| Secret | `VAPID_PUBLIC_KEY` = (below) | you — this one is public |
| Secret | `VAPID_PRIVATE_JWK` | **the user** |
| Secret | `VAPID_SUBJECT` | **the user** |
| Cron expression | `* * * * *` | you |

`VAPID_PUBLIC_KEY`, safe to paste — it is already published in this repo:

```
BG-AjofPT9Hv9_WV8uGj2SYEKIkxDgJ9-3Lpck_YTIZArPdLZC7suk3WEJqedelWPLoSrjxpwC7Dkkjofx0mpEM
```

`VAPID_PRIVATE_JWK` is the entire one-line contents of
`worker/.vapid-private.json` in this project. Ask the user to open that file
and paste it. It is about 200 characters of JSON starting `{"key_ops"` or
`{"crv"`.

`VAPID_SUBJECT` is `mailto:` plus an email address the user is willing to give
a push service — the spec requires one. **The `mailto:` prefix is part of the
value.** Ask them for it; do not guess from anything you find on the machine.

## Steps

**1. Sign in** at `https://dash.cloudflare.com`. If the user has no account,
ask them to create one — free, no card. If a sign-in or 2FA prompt appears,
hand control back to them rather than entering credentials.

**2. Create the KV namespace.** In the left nav, **Storage & Databases → KV**,
then **Create a namespace**, named `gamezone-push-GZ`. (The namespace's own
name is free-form; the *binding* name in step 5 is the one that must be `GZ`.)

**3. Create the Worker.** **Compute (Workers) → Workers & Pages → Create →
Workers → Start with Hello World!** Name it `gamezone-push` and deploy it. It
will deploy the placeholder — that is expected, you replace the code next.

**4. Replace the code.** Open the Worker → **Edit code** (or **< > Edit**).

The file to paste is `worker/dist/gamezone-push.bundle.js` — about 41 KB.
**Do not type it.** Read the file, put its contents on the clipboard, click
into the editor, select all (`ctrl+a`), paste (`ctrl+v`), then **Deploy**.

That bundle is three ES modules flattened into one, because the dashboard
editor takes a single file. If you see `import` or `require` errors after
pasting, the paste truncated — check the last line is `export { authHeaders,
sendPush, tick, normalizeGames };` and redo it.

**5. Bind the KV namespace.** Worker → **Settings → Bindings → Add → KV
namespace**. Variable name `GZ`, namespace the one from step 2. Save.

If the variable name is anything but `GZ`, every route returns an error and
the cron does nothing. This is the most common way to get a Worker that looks
deployed and works for nobody.

**6. Add the variable and the secrets.** Worker → **Settings → Variables and
Secrets**.

- `ALLOWED_ORIGIN` as **Text**, value `https://kejjeh.github.io`
- `VAPID_PUBLIC_KEY` as **Secret**, value above
- `VAPID_PRIVATE_JWK` as **Secret** — *stop and let the user type it*
- `VAPID_SUBJECT` as **Secret** — *stop and let the user type it*

Choose the **Secret** type, not Text, for the three `VAPID_*` values, so they
are encrypted and not readable back out of the dashboard. Deploy to apply.

**7. Add the cron trigger.** Worker → **Settings → Triggers → Cron Triggers →
Add**, expression `* * * * *` (every minute). Save.

Every minute all week sounds heavy and is not: with no live games the Worker
returns after a single ESPN request, well inside the free allowance.

**8. Check the workers.dev route is on.** Worker → **Settings → Domains &
Routes**. There should be a `gamezone-push.<subdomain>.workers.dev` entry,
enabled. Enable it if not — without it there is no URL for the phone to reach.

**9. Verify.** Open `https://gamezone-push.<subdomain>.workers.dev/health`.

- `{"ok":true,"configured":true,"missing":[]}` — done.
- `"missing":["VAPID_SUBJECT"]` or similar — that step did not take; redo it.
  The list names exactly what is absent, KV binding included.
- A Cloudflare error page — the code did not deploy; go back to step 4.

**10. Report** the full `*.workers.dev` URL.

## When the dashboard does not match these steps

Cloudflare moves this UI around. Treat the labels above as hints, not gospel —
navigate by what is on screen toward the named goal (a KV namespace, a
binding called `GZ`, three secrets, a one-minute cron, a workers.dev route).

If a step genuinely is not there, say which one and what you saw instead
rather than improvising a different mechanism. In particular: do not switch to
a paid plan, do not connect a GitHub repository, and do not grant any OAuth
app access to the user's accounts to get around a missing button.

## Afterwards

The user should then:

1. Delete `worker/.vapid-private.json`. Cloudflare has it; the local copy is
   now just a liability. Regenerating instead would invalidate any phone
   already subscribed.
2. Put the URL into `push-config.json` as `api` and push, so the live site
   knows where to subscribe.
3. On the iPhone: Safari → Share → **Add to Home Screen**, open it from the
   icon, then Settings → **Phone alerts**. iOS will not deliver push to a
   Safari tab, and the toggle says so.
