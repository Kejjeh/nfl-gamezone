# NFL GameZone

A desktop version of Sleeper's SleeperZone: every play from every live NFL game
in one feed, with your Sleeper starters flagged and your fantasy matchup running
in the header — plus a live stats panel with your lineup, league-wide leaders
and a fantasy-scored box score for whichever game you click.

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
| `sports.core.api.espn.com/.../plays` | play-by-play text | whole game once, then tail every 10 s |
| `api.sleeper.app/v1/league/.../matchups` | live fantasy points | 25 s |
| `site.api.espn.com/.../summary?event=` | box scores, scoring plays | 30 s per live game |
| `site.api.espn.com/.../teams/{t}/roster` | player ID bridge | once a day |
| `api.sleeper.app/v1/players/nfl` | player names and positions | once a day |

Roughly **6–7 KB/s** with a full Sunday slate, about 23 MB an hour.

### Two things worth knowing

**Your matchup total is never computed here.** Sleeper's `matchups` endpoint
already returns live per-player points under your league's own scoring settings
(43 of them, in this case). Those numbers are read as truth, so the header
always agrees with the Sleeper app exactly.

The leaders board is the one place points *are* computed, because Sleeper only
reports on players rostered in your league and the board covers every player in
the NFL. That calculation is checked against Sleeper's own numbers rather than
trusted — see [Stats and scoring](#stats-and-scoring).

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
js/feed.js      cross-game merge, dedupe, filters, player follow, rendering
js/boxscore.js  slate-wide player stat table and leader ranking
js/scoring.js   fantasy points from stat lines, under league settings
js/panel.js     the stats panel: My Team, leaders board, per-game box score
js/rail.js      the game rail, with per-game starter counts
js/matchup.js   the header score strip
js/alerts.js    WebAudio chimes, flash, desktop notifications
js/main.js      boot and wiring
```

`js/teams.js` is generated rather than fetched because
`site.api.espn.com/.../teams` is the one ESPN path tested that omits
`Access-Control-Allow-Origin`, so a browser cannot read it. Every other
endpoint used here sends `*`.

## Stats and scoring

Clicking a game swings the right-hand panel to that game's box score, with every
skill-position and kicking line scored into fantasy points. The Leaders tab
ranks the whole slate across nine categories — fantasy points, passing, rushing
and receiving yards, receptions, targets, touchdowns, completions and kicking.

Points come from **box-score aggregates, not play text**. A box score is already
reconciled: yards, receptions and touchdowns are single numbers, so mapping them
to scoring settings is arithmetic. Parsing the same information out of play
narrative means re-deriving totals that ESPN has already totalled, and getting
stat corrections wrong.

**Field-goal distance is the one thing a box score cannot give.** It reports
makes and attempts; most leagues, including this one, pay 3 points for a 25-yard
kick and 5 for a 52-yard one. The first implementation read distances out of the
play feed, where kicks read `N.Folk 31 yard field goal is GOOD` and carry a
participant tagged `kicker`. That was wrong, and the validation check caught it:
Evan McPherson scored 4 against Sleeper's 13. The feed only held a rolling tail
of each game, so any kick made before the page loaded was simply not in it.

The feed now pulls each game whole (see [The day's plays](#the-days-plays)), but
the fix stands on its own terms: distances come from `summary.scoringPlays`,
which covers the whole game, arrives in a payload already being fetched for box
scores, and does not depend on the play log being complete. Its field-goal entries carry
no athlete ID, so the kicker is matched by name against the team's kicking rows.
Misses need no distance at all, since `fgmiss` is flat: attempts minus makes is
exact.

**The scoring is checked, not assumed.** Settings → Diagnostics compares every
computed total against Sleeper's own number for that player, split by game
state:

```
scoring check vs Sleeper
  final games: 17/17 exact
  live games: 49/57 exact
```

Finished games are the real test. In a live game the two sources are sampled
seconds apart, so a player who just gained yards reads higher here until
Sleeper catches up.

A live gap is one play wide, which is not the same as small: a 60-yard catch
is seven points in PPR. Caught in the act during Week 9 — Denzel Boston read
10.1 here against Sleeper's 3.1, a 60-yard reception Sleeper had not credited
yet, and twenty seconds later Sleeper read 10.0. That is what sampling lag
looks like. A scoring bug would be a consistent offset that survived the
whistle, and none does.

Where no league is connected the board falls back to full-PPR defaults, so it
still shows something sensible.

## The fantasy layer

The app pulls a lot of fantasy data. For a long time it showed almost none of
it: 173 league players' live points and both full lineups sat in memory behind
two totals in the header.

**My Team** is the panel's default tab once a league is connected. It lists your
starters in Sleeper's own lineup order, each with live points and the state of
the game they are in — `Q3 9:51`, `Final`, or a kickoff time — plus the count
that matters most on a Sunday afternoon:

```
KEAGS POWDER PLAYBOOK                          75.2
2 yet to play
QB    Josh Allen        BUF @ MIN · 8:15 PM      0.0
RB    Devin Singletary  NYG @ PHI · Q3 10:47     3.2
WR    Ja'Marr Chase     CIN @ ATL · Final       31.5
...
```

Your opponent's lineup is listed underneath, which is the half of the matchup
the header never showed. Team defences resolve too: a Sleeper `DEF` slot is a
team abbreviation rather than a player, so it is matched to a game directly.

**Following a player** narrows the feed to one athlete across every game. Click
any row — a lineup slot, a leaders entry, a box-score line — and the feed shows
only their plays, matched on ESPN's `participants` rather than by searching the
text. A chip names who is being followed and clears it; a filter that silently
empties the feed with no visible cause is indistinguishable from a broken app.

**The game rail carries fantasy markers**: `★ 2` for your starters in a game,
`◆ 3` for your opponent's. The rail is the surface you scan to decide where to
look, and without these it said nothing about your team.

## The day's plays

Each game's play log is pulled **whole once, then tailed**. The tail alone is a
rolling window, so a game that kicked off before the page loaded contributed
only its last few plays: scrolling back through the day found nothing, and
anything derived from play text silently lost its history.

Measured on the Week 9 slate: the tail-only feed held **260 plays**, the full
pull holds **1,157**. Steady-state cost is unchanged — over 25 seconds of
polling, 14 tail requests and zero full pulls, since a game is only ever pulled
whole once. The one-time cost is about 37 KB gzipped per game.

Finished games are pulled too, so the morning slate is still in the feed when
you open the page in the evening.

## Design notes

The feed pushes well over a thousand plays through on a Sunday and almost all
of them are a 4-yard run. The design problem is not making plays look good, it
is making the handful that matter findable among the ones that do not.

**Plays are tiered, not uniform.** Four levels, in `tierOf()`:

| Tier | What | Treatment |
|---|---|---|
| `log` | routine play | inline one-liner, no chrome, recessive text |
| `note` | red zone, penalty, 20+ yard gain | gains a surface |
| `key` | turnover, or one of your players | surface, accent rule, full-contrast text |
| `score` | touchdown, field goal | team-colour wash, larger text, score shown |

**Timeouts are dropped.** Measured over a full game, 26 of 174 plays are
`Official Timeout`, `Timeout` or `Coin Toss` — 15% of the feed, and
"Official Timeout at 11:12" tells a viewer nothing. Clock markers like
`END QUARTER 1` are kept but forced to `log`, since field position should not
promote them.

**Punts and kickoffs are exempt from the big-gain rule**, because they travel
40–60 yards by definition and would otherwise all be promoted.

**The running score is hidden on routine plays.** It appears on every line
otherwise, which is pure repetition — the rail already shows it.

**Team colour instead of logos.** ESPN's logo assets are ~130 KB each and the
CDN ignores resize parameters, so 32 of them would be about 4 MB. A colour bar
in the rail and a coloured abbreviation on each play give the same at-a-glance
orientation for nothing. Many NFL primaries are near-black (`CHI #0b1c3a`,
`BAL #241773`) and invisible on a dark surface, so `js/teams.js` lifts
lightness in HLS space while preserving hue. Mixing toward white instead
destroys identity — a first pass turned Buffalo pink.

**Contrast is measured, not eyeballed.** All three text steps clear WCAG AA on
both background and surface (15.6:1, 7.1:1, 4.9:1). An earlier `--fg-3` of
`#626b7b` came in at 3.4:1, which fails for body text — and routine play text
is body text.

Motion respects `prefers-reduced-motion`. Filters and game rows are real
buttons carrying `aria-pressed`; the feed is an `aria-live="polite"` region so
new plays are announced without stealing focus.

## Known limitations

- **About 30 seconds behind the broadcast.** Measured against play `wallclock`.
  ESPN's public feed is not a low-latency wire. Sleeper will feel similar.
- **Undocumented endpoints.** ESPN publishes no public API and offers no SLA.
  These paths can change without notice; parsing here is defensive throughout.
- **Sleeper's API is free for non-commercial use only.** Personal dashboard is
  fine. Do not ship this as a product.
- **Desktop notifications need the tab open**, and the browser's permission.
  A static host cannot push. If the browser has blocked notifications for the
  site, the toggle refuses to turn on and says so; the grant has to be made in
  the browser's own site settings.
- **Audio needs one click first.** Browsers block WebAudio until a user gesture.
- **Defensive stats are not scored.** The box score and leaders board cover
  skill positions and kickers. Team defence scoring is a different shape - it is
  per-roster rather than per-player - and is not computed; your matchup total
  from Sleeper includes it regardless.
- **Live fantasy points run slightly ahead of Sleeper's.** The box score updates
  before Sleeper's tally does. The two agree exactly once a game is final.

## Privacy

Your Sleeper username and settings live in this browser's `localStorage` and are
never committed or transmitted anywhere except to Sleeper's own public API.
Nothing is stored server-side because there is no server.
