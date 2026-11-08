# NFL GameZone

A desktop version of Sleeper's SleeperZone: every play from every live NFL game
in one feed, with your Sleeper starters flagged and your fantasy matchup running
in the header.

Static site. No build step, no server, no API key, no dependencies. Push it to
GitHub Pages and the browser talks to ESPN and Sleeper directly.

![layout](docs/screenshot.jpg)

*Live Sunday slate. The fantasy overlay — starter badges and the matchup strip —
is not shown here because it renders a personal lineup; connect a Sleeper
account and it appears in the header and on matching plays.*

## Run it locally

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>. Any static file server works; `file://` does
not, because ES modules are blocked there.

## Deploy to GitHub Pages

```bash
git remote add origin git@github.com:<you>/nfl-gamezone.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.

`.nojekyll` is already committed, which stops Jekyll from ignoring `js/`.

## How it works

| Source | Used for | Interval |
|---|---|---|
| `site.api.espn.com/.../scoreboard` | scores, clock, down/distance, red zone | 6 s |
| `sports.core.api.espn.com/.../plays` | play-by-play text | 10 s per live game |
| `api.sleeper.app/v1/league/.../matchups` | live fantasy points | 25 s |
| `site.api.espn.com/.../teams/{t}/roster` | player ID bridge | once a day |
| `api.sleeper.app/v1/players/nfl` | player names and positions | once a day |

Roughly **6–7 KB/s** with a full Sunday slate, about 23 MB an hour.

### Two things worth knowing

**Fantasy points are not computed here.** Sleeper's `matchups` endpoint already
returns live per-player points under your league's own scoring settings (43 of
them, in this case). Those numbers are read as truth, so the header always
agrees with the Sleeper app exactly. ESPN supplies the narrative; Sleeper
supplies the numbers.

**Sleeper's `espn_id` field is not a usable player bridge.** It is populated for
only 221 of 864 active fantasy-relevant players — about 26%. Ja'Marr Chase,
Evan McPherson, Jaylen Waddle, Breece Hall and Brandon Aubrey all return
`espn_id: null`. Building on it looks like it works and then silently fails to
flag your best players.

So `js/bridge.js` pulls all 32 ESPN team rosters and matches on normalized
name + team + position, with `espn_id` as a fast path only. Measured on the
live slate: **2,509 of 2,567 ESPN athletes linked** (601 via `espn_id`, 1,908 via
name match), and **96 of 96 starters across all 12 league rosters resolved**.

Settings → Diagnostics runs that coverage check live and names any starter that
failed to link. If it ever says anything other than "all league starters
linked", the name matcher needs a new case — add it to the index in
`bridge.js`.

## Developing when nothing is live

Pin a finished week:

```
http://localhost:8765/?week=8
```

Completed games are pulled in full and the feed assembles exactly as it would on
a Sunday. `?seasontype=1|2|3` selects pre / regular / post season.

## Layout

```
js/config.js    endpoints, intervals, team-abbreviation aliases
js/teams.js     the 32 franchises, baked in (see note below)
js/store.js     localStorage with TTL, failure-tolerant
js/state.js     one state object plus a minimal pub/sub
js/espn.js      scoreboard, play tail paging, team rosters
js/sleeper.js   league, rosters, live matchup, slim player cache
js/bridge.js    ESPN athlete id  ->  Sleeper player id
js/poller.js    interval scheduler with exponential backoff
js/feed.js      cross-game merge, dedupe, filters, rendering
js/rail.js      the game rail
js/matchup.js   the header score strip
js/alerts.js    WebAudio chimes, flash, desktop notifications
js/main.js      boot and wiring
```

`js/teams.js` is generated rather than fetched because
`site.api.espn.com/.../teams` is the one ESPN path tested that omits
`Access-Control-Allow-Origin`, so a browser cannot read it. Every other
endpoint used here sends `*`.

## Known limitations

- **About 30 seconds behind the broadcast.** Measured against play `wallclock`.
  ESPN's public feed is not a low-latency wire. Sleeper will feel similar.
- **Undocumented endpoints.** ESPN publishes no public API and offers no SLA.
  These paths can change without notice; parsing here is defensive throughout.
- **Sleeper's API is free for non-commercial use only.** Personal dashboard is
  fine. Do not ship this as a product.
- **Desktop notifications need the tab open.** A static host cannot push.
- **Audio needs one click first.** Browsers block WebAudio until a user gesture.

## Privacy

Your Sleeper username and settings live in this browser's `localStorage` and are
never committed or transmitted anywhere except to Sleeper's own public API.
Nothing is stored server-side because there is no server.
