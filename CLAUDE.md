# Agent guide

## What this is

A desktop (and phone) take on Sleeper's SleeperZone: every play from every live NFL game in one
feed, the user's Sleeper starters flagged on matching plays, the fantasy matchup in the header,
and a stats panel (My Team, league-wide leaders, fantasy-scored box score per game). Plain static
site: ES modules, no build step, no dependencies, no server, no API key. The browser calls ESPN
and Sleeper directly; GitHub Pages serves `main` / root. **Current state: working.** There is no
HANDOFF.md or glossary; `README.md` is the design record (measured numbers, why each choice was made).
Read the relevant README section before changing the behaviour it describes.

## Commands (all verified from repo root)

```bash
python -m http.server 8765              # serve; open http://localhost:8765 (file:// does NOT work: ES modules)
for f in js/*.js; do node --check "$f"; done   # syntax check; expect no output
node tools/bets-test.mjs                        # bet settlement; offline. expect: 102 passed, 0 failed
node tools/season-test.mjs                      # season scoring + compare; offline. expect: 104 passed, 0 failed
node tools/worker-test.mjs                      # push Worker; calls LIVE ESPN (free). expect: 0 failed
npm test                                        # runs all three
```

- CI (`.github/workflows/tests.yml`) runs the syntax check, `bets-test.mjs` and `season-test.mjs` on every push to `main` and every PR - every offline, deterministic check there is. It leaves out `worker-test.mjs` alone, because that one calls live ESPN. A new test harness belongs in CI unless it needs the network.
- `.claude/launch.json` defines the same server as `gamezone` (port 8765) for the preview pane.
- `?week=8` pins a finished week so the feed assembles with nothing live; `?seasontype=1|2|3` = pre/regular/post.
- Tests are plain Node scripts in `tools/` (no dependencies; `package.json` exists only so Node loads `js/*.js` as ES modules). `worker-test.mjs` needs the network; it intercepts the final push to Apple, so it never buzzes a phone. `season-test.mjs` is offline: `tools/season-fixtures.mjs` holds ten real Sleeper week-9 stat records paired with the points Sleeper's own matchups endpoint awarded. Regenerate it only against a completed week, and keep the pairing - a fixture without its upstream truth tests nothing. `season-test.mjs` and `bets-test.mjs` are both deterministic, so their counts are fixed. **`worker-test.mjs`'s is not** - it branches on whether any game is live, so only `0 failed` is the expectation there (42 on a finished slate, 30 on another). Anything else is proved by the syntax check plus loading the page.
- Every page load hits ESPN and Sleeper public endpoints (free, unauthenticated, about 6-7 KB/s on a full slate). Nothing costs money.

## Architecture map

| File | Role |
|---|---|
| `index.html`, `app.css` | markup and all styles (desktop three columns; phone one pane + bottom bar) |
| `js/main.js` | boot, wiring, settings dialog, Diagnostics (bridge coverage + scoring check vs Sleeper) |
| `js/config.js` | endpoints, poll intervals, cache TTLs, feed caps, ESPN/Sleeper team-abbreviation aliases |
| `js/teams.js` | the 32 franchises, baked in (ESPN's teams endpoint has no CORS header); colours lifted in HLS |
| `js/espn.js` | scoreboard, whole-game play pull then tail paging, team rosters, box-score summaries, win probability, drives |
| `js/sleeper.js` | league, rosters, live matchups, slim player cache |
| `js/bridge.js` | ESPN athlete id -> Sleeper player id (name + team + position; `espn_id` only as fast path) |
| `js/feed.js` | cross-game merge, dedupe, filters, player follow, `tierOf()` play tiers, rendering |
| `js/boxscore.js`, `js/scoring.js` | slate-wide stat table, leader ranking, fantasy points from box-score aggregates |
| `js/season.js`, `js/players.js` | season-long layer: Sleeper's weekly stat files scored under the league's settings, plus the lineup/free-pool helpers (`season.js`, tested by `tools/season-test.mjs`), and the full-window view - sortable table with ownership, or Compare mode pairing your lineup against each slot's free agents (`players.js`). Shares no data path with the live feed - no ESPN, no bridge |
| `js/panel.js`, `js/rail.js`, `js/matchup.js` | stats panel (incl. the per-game drive strip), game rail with starter markers, header score strip |
| `js/poller.js`, `js/state.js`, `js/store.js` | backoff scheduler, one state object + pub/sub, localStorage with TTL |
| `js/alerts.js` | WebAudio chimes, flash, desktop notifications |
| `js/bets-core.js`, `js/bets.js`, `js/bets-ui.js` | bet tracking: pure settlement logic incl. the frozen-settlement record (tested by `tools/bets-test.mjs`), state, UI |
| `js/push.js` | web-push subscription for the Home Screen app (iOS 16.4+) |
| `worker/` | `gamezone-push`: Cloudflare Worker (cron + poll + VAPID push), deployed with `wrangler`; see `worker/README.md`. Deploying is the user's call |
| `ios/gamezone-widget.js` | Scriptable lock/home-screen widget (matchup, not a play feed) |
| `tools/` | `bets-test.mjs`, `worker-test.mjs`, `vapid-keygen.mjs`, widget preview/scenario harnesses |

## Conventions and gotchas

- **The matchup total is never computed here.** Sleeper's `matchups` numbers are truth. Only the
  leaders board computes points (`scoring.js`), and Diagnostics checks that against Sleeper.
  Final games must read `N/N exact`; live games lag by one play and that is expected.
- **Do not bridge players on Sleeper's `espn_id`.** It is null for about 74% of players
  (Ja'Marr Chase among them). If Diagnostics names an unlinked starter, add a case to the
  name index in `bridge.js`.
- **Field-goal distance comes from `summary.scoringPlays`**, not the play feed. The play-feed
  version under-scored kickers (McPherson 4 vs Sleeper 13). Don't move it back.
- **Points come from box-score aggregates, never from parsing play text** - with
  two measured exceptions that are in no stat line at all: field-goal distance
  and **two-point conversions**, both read from `summary.scoringPlays`. A 2pt
  conversion gains no yard and no TD the box score admits to, so without it a
  converting QB reads exactly 2.00 low (caught by Diagnostics: 132/134 exact,
  both misses QBs). 104 games measured; four text forms, successes always carry
  a name and failures never do, so requiring the name is the whole test.
- **A team defence has four counts and every obvious source for them is wrong.**
  Sacks sum the `defensive` group's player rows; takeaways are the *opponent's*
  team-stat `fumblesLost` (a team's own `fumblesRecovered` includes falling on
  its own fumble, and disagreed on 3 of 10 team-sides); defensive touchdowns and
  safeties come from `scoringPlays` by type text. Do **not** use the team-stat
  `defensiveTouchdowns`: LV reads 2 having scored none, because a kickoff return
  lands in it. Verified 10/10 against Sleeper on Week 8 - see `teamDefence()` in
  `espn.js`. Blocked kicks and return TDs are deliberately uncounted (no sample).
- **A settled bet is frozen onto its record, never recomputed.** `legProgress`
  resolves against the *current* scoreboard, so once the week rolls over the
  game is gone, every leg reads `unknown` and a won bet reads `open` forever.
  `freezable()`/`snapshot()` in `bets-core.js` write it; do not add a code path
  that recomputes a bet carrying `settled`.
- **Win probability joins on the play's own id, and it is free.** It rides in the
  `summary` payload the box-score poll already fetches, and `winprobability[].playId`
  matches the play feed exactly - measured 2,604 of 2,604 on a full slate. Drives come
  from the same payload. Neither needs a fetch of its own; do not add one.
- **A summary is ~55 KB gzipped, not the ~19 KB an old comment claimed** (measured:
  five finished Week 8 games, 49-59 KB). It is three quarters of the network budget
  (~34 KB/s on a full slate), so `INTERVALS.boxscores` is the lever that matters.
- **The "while you were away" count is derived from the rendered list, never from
  `state.plays`.** Those differ by whatever the filters drop, and counting the latter
  put "30 plays" above 21 cards.
- **League fantasy points are a dot product**, not a reimplementation:
  `Σ stats[key] × scoring_settings[key]` over Sleeper's weekly stat files,
  whose fields are named in the same vocabulary as the scoring settings.
  Verified 1390/1390 player-weeks across nine weeks, defences included. No
  ESPN and no bridge is involved, so `bridge.js` cannot affect these numbers.
  Use the league's settings **unmerged** - `scoring.rules()` layers full-PPR
  defaults underneath, which is right for the live leaders board and wrong
  here, because a default weight for a key the league omits pays points
  Sleeper never awarded. (This league's weights match the defaults on every
  shared key but it scores nine more: `st_ff`, `st_fum_rec`, `fum_rec_td` and
  friends. Eleven week-9 players score differently between the two.)
- **Never read `/stats/nfl/regular/2026`** (the season aggregate). It lags by a
  whole game for the teams that played most recently - 28 rows adrift on
  2026-11-10, all MIN or BUF, Josh Allen 13.9 points short. Sum the weekly
  files, which were each checked against Sleeper.
- **The weekly cache key carries a fingerprint of the scoring rules**
  (`wkpts:2026:9:<tag>`). The files are stored already scored, so an entry
  written under one rule set is wrong under another. Invalidating when a league
  connects does not cover it - the first connect races the first load. Do not
  "simplify" the tag out of the key.
- **`state.week` from Sleeper is the transaction week, not the last played
  one.** On a Tuesday it is already the next week, with no stats and no points.
  `display_week` is the one with results, but it lags into a Thursday game.
  The matchup and the season table both follow the week the dashboard shows.
- **Games played is counted, never read from `gp` or `gms_active`.** Over the
  535 players who score more than a point, `gp` agreed with the counted truth
  on 370 and `gms_active` on 474.
- **Do not validate a season total against summed `players_points`.** A matchup
  carries only the players on that roster that week, so a mid-season pickup is
  undercounted - one player read 81.8 against 30.4 that way. Compare per week.
- **`hidden` does not hide an element a class gives a `display` to.** The
  browser's own `[hidden] { display: none }` loses to any author rule, so
  `.pl-chips`, `.pl-compare` and friends each need their own `[hidden]`
  selector (one line next to `.pl-chips button:disabled`); `.overlay[hidden]`
  is the same pattern. Setting `el.hidden = true` on a flex or grid element and
  seeing it stay on screen is this, not a logic bug.
- **How many games a free agent needs before he counts as an upgrade is the
  manager's call**, not a constant - `state.players.minGames` starts at 3 and
  is a control in the Compare bar. One thirty-point week tops any per-game
  ranking, and which sample is enough depends on the league. Do not bake it in.
- **Compare mode ranks by season points per game whatever the Pts column is
  scoped to**, because a waiver claim is about the rest of the season. The meta
  line says so when a week is selected; keep them in step.
- **The phone media query lives in two places** (`app.css` twice and `PHONE` in `js/main.js`);
  all copies must stay identical. Specificity bit once: `body.panel-closed main` outranked the
  phone rule. Check a phone change at 375x812 and sideways (812x375).
- ESPN endpoints are undocumented and can change without notice; keep parsing defensive
  (missing fields degrade, never throw the whole feed).
- Contrast is measured: all three text steps clear WCAG AA. Re-measure if you touch `--fg-*`.
- Sleeper's API is free for non-commercial use only. This stays a personal dashboard.
- Secrets: the push Worker's VAPID private key. `tools/vapid-keygen.mjs` writes it to `worker/.vapid-private.json` (gitignored); it belongs only in the Worker as `wrangler secret` `VAPID_PRIVATE_JWK`, and the local file is deleted afterwards (`worker/README.md`). Never commit, print or paste it. The user's Sleeper username lives in browser localStorage (`gamezone:` prefix); never commit one.
- `.claude/launch.json` is tracked even though `.gitignore` lists it. Leave it.
- Don't read `docs/screenshot.jpg` (binary).

## Skills for this repo

Load these with the Skill tool when the situation comes up; the user does not need to ask.

| Situation in this repo | Skill |
|---|---|
| A play is missing, a starter isn't flagged, Diagnostics shows a scoring mismatch on a final game, a poller stalls | `diagnosing-bugs` |
| Changing `scoring.js`, `bridge.js`, `boxscore.js` or ESPN/Sleeper parsing, where a wrong number or a silently unlinked player looks fine on screen | `sop-fail-loud` |
| Touching the slip parser in `bets-core.js`, or adding a sportsbook format | `sop-parse-real-samples` |
| Changing what ESPN or Sleeper endpoints are relied on, or the bridge's matching key | `sop-verify-upstream` |
| Touching `season.js` scoring, the weekly cache key, or the player table's columns, where a wrong number ranks a waiver pickup and looks fine | `sop-fail-loud`, then re-run the per-week check against Sleeper |
| Anything in `worker/` or `js/push.js`, where only the phone can confirm it worked | `sop-prove-remote-delivery` |
| Proving a feed, panel or phone-layout change works in the running page (`gamezone` launch config, `?week=8` when nothing is live) | `run` |
| Extending tests beyond bets/worker (e.g. `scoring.js` against known Sleeper totals) | `engineering:testing-strategy` |
| Fixing a scoring or bridge bug once a test harness exists | `tdd` |
| Sketching a new panel tab, rail marker or feed treatment before building it | `prototype` |
| Adding a chart, stat tile or leaders view to the stats panel | `dataviz` |
| Any commit | `safe-commit` |
| Opening or merging a PR / independent review before merge | `sop-ship-pr` / `code-review` |
| A change makes this guide or the README's measured numbers untrue | `sop-project-guide` |

## Before you finish any task

1. `for f in js/*.js; do node --check "$f"; done` -> no output. Touched bets, the season layer or the Worker? `npm test` -> all three scripts `0 failed`.
2. Serve (`gamezone` launch config or `python -m http.server 8765`), load `/` and `/?week=8`:
   the feed fills, the browser console shows no errors. For layout changes also check 375x812 and 812x375
   (reload after resizing - the emulated device metrics do not re-run otherwise).
3. Touched the season layer? Open the table (`t`), confirm the meta line names your league rather
   than "full-PPR defaults", and re-run the per-week check against Sleeper - it must read `1390/1390`
   or whatever the full count is for the weeks played.
4. If you touched scoring or the bridge: Settings -> Diagnostics with a league connected reads
   "all league starters linked" and final games `N/N exact`. If you cannot connect a league, say so.
5. `git diff --stat` -> only files you meant to change.

## Model routing

Safe for Sonnet: CSS and copy tweaks, README updates, poll intervals and caps in `config.js`,
team aliases, new filter chips, rail/panel presentation.

Escalate to Opus: `scoring.js` and field-goal distance logic, `bridge.js` matching rules,
feed merge/dedupe and `tierOf()`, whole-game pull + tail paging in `espn.js`, poller backoff,
the phone breakpoint (CSS specificity across two files), `season.js` scoring and cache keying,
and `goToWeek()` in `main.js` (it tears down every game-keyed map and re-primes the alert
baseline; getting it wrong merges two weeks into one feed or replays a week of touchdowns).
