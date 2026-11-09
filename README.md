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
and receiving yards, receptions, targets, touchdowns, completions and kicking —
and cuts any of them by fantasy position: **All · QB · RB · WR · TE · FLEX · K**.

The position had to come from somewhere other than the obvious place. ESPN's
box-score summaries carry **no athlete position at all**: measured on a full
Week 8 slate, 0 of 892 stat rows had one, so the `pos` field the aggregator had
always written was always the empty string. The team rosters the bridge already
fetches do carry it, and on the same slate they resolve **891 of 892 stat rows,
and 266 of 266 players with fantasy points** — nobody falls through. They are
normalised with the bridge's own `normPos`, so the board and the bridge group
players identically rather than each holding an opinion (ESPN says `PK` and
`FB`; fantasy says `K` and `RB`).

Because of that the rosters now load *before* the Sleeper player dictionary:
positions are useful with no league connected, and the old order left them
blank whenever Sleeper was slow or unreachable. There is no DEF chip — a team
defence is not an athlete, so it never enters the player table, and a chip that
could only ever show an empty board would read as a bug.

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

## Phones

The desktop layout is three columns. A phone gets one at a time, switched from
a bottom bar within thumb reach rather than a menu at the top of a tall screen:
**Games · Feed · Stats**. Tapping a game in Games filters the feed and moves
there, because that is what you tapped it for.

What the phone layout had to fix:

- **The breakpoint never applied.** `body.panel-closed main` is a desktop rule
  outside any media query, and it outranks a bare `main` inside one. Below
  820px the phone kept a 220px rail and a **155px feed**, which is why play
  text wrapped seven lines deep. Specificity, not the breakpoint, was the bug.
- **Chrome ate the screen.** Header plus the wrapped chip block came to 251px
  of 812 — 31% before a single play. Now 84px and one scrolling chip row; the
  feed gets 74% of the screen.
- **Held sideways**, a phone has 375px of height and the stacked header plus
  bottom bar took 40% of it. A short-viewport rule drops the brand, puts the
  score inline and shrinks the bar to recover it.
- The segmented filter is **moved** into the chip row rather than hidden.
  Dropping Scoring / Red zone / Mine on the device with the least screen would
  remove the feed's most useful controls exactly where they matter most.
- Phones keep **150 feed cards** rather than 400. The whole day stays in memory
  for filtering and stats; it is the DOM that is capped.

Between the phone breakpoint and 1180px the three columns stop fitting, so the
stats panel becomes an overlay and starts closed. That default was read as the
panel *vanishing*, for two reasons worth recording: the open state was never
persisted, so every reload shut it again whatever you had chosen, and the
header toggle carried no pressed state, which left a closed panel
indistinguishable from an app with no stats panel. The choice is now stored
(`gamezone:panelOpen`) and only the first visit gets the width default; the
button lights the same way a pressed chip does; and Escape dismisses the panel
while it is overlaying something. That Escape handler runs in the **capture**
phase on purpose — `main.js` also listens on `document` to dismiss its dialogs,
and in the bubble phase one Escape closed the settings dialog *and* the panel,
because the dialog was already hidden by the time the panel's check ran.

A phone is identified by shape, not width alone:

```css
@media (max-width: 700px), (max-height: 500px) and (max-width: 900px)
```

A narrow screen, or a short one that is not a desktop — which is how a phone
held sideways (812×375) reads. An iPad portrait (768×1024) is neither, so it
keeps the rail beside the feed with the stats panel overlaying. The same query
string lives in `main.js`; the two must stay identical.

Also handled: `env(safe-area-inset-*)` around the notch and home indicator,
16px on the one text input so Safari does not zoom the page and never zoom
back, `-webkit-text-size-adjust` so landscape does not inflate type, 38px
minimum on anything tappable, and dialogs that fill the screen instead of
floating in it.

## Bets

A bet tracker that reads the same box scores the leaders board does, so a leg
is scored off the actual stat line rather than off text in the feed. Paste a
slip, or type one in; each leg shows what it needs and how close it is.

```
2-leg parlay · FanDuel · +310                       ALL HIT
$20.00 → $82.00   2/2 legs
  ✓ CeeDee Lamb over 120.5 receiving yards   195 / 120.5 yds
  ✓ Chris Olave 5+ receptions                      6 / 5 rec
```

### Syncing from FanDuel and DraftKings is not possible

Neither book exposes a user's bets. There is no public API, no developer
programme, and no OAuth for account data — what the odds vendors sell is lines,
not anybody's bet history. The only route to a real sync would be driving the
books' internal endpoints with your login, which means handling sportsbook
credentials and breaking their terms, so this does not do that.

What it does instead is read a **pasted slip**. No credentials, nothing to
breach, and once the parser knows the shape it is about as quick. Every parsed
leg is shown for review before anything is saved, and anything it could not
read is listed rather than silently dropped.

The parser handles what both books write: `Over 39.5 Receiving Yards`, the
`40+` alt-line form, `Anytime Touchdown Scorer`, combined markets like
`Rushing + Receiving Yards`, `Tackles + Assists`, totals, and a bare
`Bengals -3.5`. Clipboard formats differ by app version, so if a slip of yours
does not parse, the fix is to paste it into an issue — the patterns live in one
table in `bets-core.js`.

### What it can track

Everything ESPN's box score carries, which is more than it sounds:

| | |
|---|---|
| Passing | yards, TDs, completions, attempts, interceptions, sacks taken |
| Rushing | yards, carries, TDs, longest rush |
| Receiving | yards, receptions, TDs, longest reception, targets |
| Combined | rush + rec yards, pass + rush yards |
| Scoring | anytime touchdown |
| Defence | tackles, solo tackles, sacks, TFL, passes defended, interceptions |
| Kicking | kicking points, field goals made, longest field goal |
| Returns | return yards |
| Game | spread, moneyline, game total, team total |

Two details that are easy to get wrong and are tested:

- **`40+` and `over 39.5` are not the same comparison.** The first means *at
  least* 40, the second means *more than* 39.5. They agree on integers and
  disagree on a whole-number line, so which one was meant is stored per leg.
- **An over can settle live; an under cannot.** Yards only go up, so clearing
  the line is decisive the moment it happens, while staying under is only known
  at the whistle. An under that has already been passed is marked dead rather
  than "at risk" — it is not coming back.

A parlay is alive only while every leg is, which is the whole reason to track
one: a dead leg kills it however well the rest are doing.

### Alerts

Bet alerts ride the box-score poll, since that is where the numbers move. A leg
hitting or busting chimes and notifies; a leg crossing 90% of its line notifies
once, not on every carry. A six-leg parlay ticking at once is one buzz, not six.

Adding a bet mid-game never announces the yards that player already had — the
baseline is taken when the bet appears, not from zero.

## Phone alerts, and what iOS actually allows

The app is installable: `manifest.json`, a service worker, and an
`apple-touch-icon`, so Share → Add to Home Screen gives a real icon and a
full-screen app with an offline shell.

Notifications are the harder half, and the constraint is worth stating plainly:

- iOS delivers web push **only to a Home Screen web app**, from iOS 16.4. A
  Safari tab gets nothing.
- Web Push is **server-initiated by definition** — something must hold a VAPID
  private key and send to `*.push.apple.com`. A static host cannot.
- iOS supports **neither Background Sync nor Periodic Background Sync**, so an
  installed web app cannot wake itself to check either.

So GitHub Pages alone can never push. `worker/` is the answer: a Cloudflare
Worker on a one-minute cron that polls ESPN, evaluates bets with the same
`bets-core.js`, and sends. Free plan, about 16 subrequests a run against a
ceiling of 50. Setup is in [`worker/README.md`](worker/README.md). Until it is
deployed, the toggle stays off and says why rather than pretending.

The push carries **no payload**: encrypting one needs ECDH, HKDF and AES-GCM in
the sender, and gets silently dropped when wrong. An empty push needs only the
VAPID signature, and `sw.js` fetches the message. The signature is generated and
verified against its own public key in `tools/worker-test.mjs`.

The service worker is **network-first for same-origin**. A cache-first shell
would load faster, but this project lost time twice to a browser serving a stale
ES module while the file on disk was correct, so the cache is a fallback for
being offline rather than a shortcut when online.

## The iPhone lock screen

`ios/gamezone-widget.js` is a [Scriptable](https://scriptable.app) script that
puts the matchup on the lock or home screen. Scriptable runs JavaScript as a
real WidgetKit widget, so this needs no Mac, no Xcode and no Apple Developer
account. Setup is in [`ios/README.md`](ios/README.md).

It is deliberately **not** a play feed. Apple's WidgetKit documentation gives a
frequently viewed widget 40 to 70 refreshes a day — roughly every 15 to 60
minutes — and requires timeline entries about five minutes apart. The budget is
the system's. A widget showing "the latest play" would be showing a play from
somewhere in the last hour while looking current, which is worse than showing
nothing. So it shows what survives that cadence: your matchup total, how many
starters have not kicked off, live scores, and the newest play from each live
game as context. Tapping it opens this site, which is the real feed.

Two things shaped the code more than the layout did:

- **Memory.** The widget needs player names and teams, and Sleeper's
  `players/nfl` is **14.0 MB**. Fetched one position at a time it is 5.00 MB
  across six requests and, the number that matters, peaks at **2.1 MB** for a
  single parse. Even so a widget extension gets a fraction of an app's memory,
  so the widget prefers a stale map over rebuilding one and only builds from
  cold if there is nothing cached at all. Running the script once inside
  Scriptable after install does the build where there is room for it.
- **Text length.** A lock-screen line is about 34 characters; ESPN play text is
  routinely 120, and spends a third of that on things nobody glances at a phone
  to read. `compressPlay` strips the formation, the tackler in brackets or
  trailing parentheses, the penalty clause bolted on the end, and the long
  snapper — `"C.Smyth 48 yard field goal is GOOD, Center-Z.Wood,
  Holder-R.Wright"` is 66 characters and becomes 34. It also never compresses a
  play to nothing, which a text that is entirely a parenthetical
  (`"(Brandon Aubrey Kick)"`) otherwise did, leaving a bare `DAL-IND`.

Scriptable only exists on iOS, so `tools/widget-preview.mjs` and
`tools/widget-scenarios.mjs` stub its globals and run the real script file from
Node against the live APIs — the first printing every size as text and flagging
any line over its budget, the second forcing the four states a live Sunday never
reaches. That covers the data and every rendered string. It does not cover
layout; only the device answers that.

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

Your Sleeper username, your settings and your bets live in this browser's
`localStorage`. They are never committed, and nothing goes anywhere except
Sleeper's and ESPN's own public APIs.

Two things to know if you switch on phone alerts:

- Turning them on sends your **bets** and your push subscription to the Worker
  you deployed, because it has to evaluate them to know when to buzz. That is
  your own Cloudflare account, not a third party, and it holds nothing else —
  no Sleeper account, no league, no play history.
- Everything else stays local. With phone alerts off, nothing leaves the
  browser at all.

Your sportsbook credentials are never involved, because nothing here logs in to
a sportsbook. Pasted slips are parsed in the browser.

The VAPID private key is written to a gitignored file by the key generator,
goes straight into a Cloudflare secret, and is never printed or committed. Only
the public key is in the repository, which is what it is for.
