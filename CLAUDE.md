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
```

- `.claude/launch.json` defines the same server as `gamezone` (port 8765) for the preview pane.
- `?week=8` pins a finished week so the feed assembles with nothing live; `?seasontype=1|2|3` = pre/regular/post.
- **There are no automated tests.** Proof of a change is the syntax check plus loading the page.
- Every page load hits ESPN and Sleeper public endpoints (free, unauthenticated, about 6-7 KB/s on a full slate). Nothing costs money.

## Architecture map

| File | Role |
|---|---|
| `index.html`, `app.css` | markup and all styles (desktop three columns; phone one pane + bottom bar) |
| `js/main.js` | boot, wiring, settings dialog, Diagnostics (bridge coverage + scoring check vs Sleeper) |
| `js/config.js` | endpoints, poll intervals, cache TTLs, feed caps, ESPN/Sleeper team-abbreviation aliases |
| `js/teams.js` | the 32 franchises, baked in (ESPN's teams endpoint has no CORS header); colours lifted in HLS |
| `js/espn.js` | scoreboard, whole-game play pull then tail paging, team rosters, box-score summaries |
| `js/sleeper.js` | league, rosters, live matchups, slim player cache |
| `js/bridge.js` | ESPN athlete id -> Sleeper player id (name + team + position; `espn_id` only as fast path) |
| `js/feed.js` | cross-game merge, dedupe, filters, player follow, `tierOf()` play tiers, rendering |
| `js/boxscore.js`, `js/scoring.js` | slate-wide stat table, leader ranking, fantasy points from box-score aggregates |
| `js/panel.js`, `js/rail.js`, `js/matchup.js` | stats panel, game rail with starter markers, header score strip |
| `js/poller.js`, `js/state.js`, `js/store.js` | backoff scheduler, one state object + pub/sub, localStorage with TTL |
| `js/alerts.js` | WebAudio chimes, flash, desktop notifications |

## Conventions and gotchas

- **The matchup total is never computed here.** Sleeper's `matchups` numbers are truth. Only the
  leaders board computes points (`scoring.js`), and Diagnostics checks that against Sleeper.
  Final games must read `N/N exact`; live games lag by one play and that is expected.
- **Do not bridge players on Sleeper's `espn_id`.** It is null for about 74% of players
  (Ja'Marr Chase among them). If Diagnostics names an unlinked starter, add a case to the
  name index in `bridge.js`.
- **Field-goal distance comes from `summary.scoringPlays`**, not the play feed. The play-feed
  version under-scored kickers (McPherson 4 vs Sleeper 13). Don't move it back.
- **Points come from box-score aggregates, never from parsing play text.**
- **The phone media query lives in two places** (`app.css` twice and `PHONE` in `js/main.js`);
  all copies must stay identical. Specificity bit once: `body.panel-closed main` outranked the
  phone rule. Check a phone change at 375x812 and sideways (812x375).
- ESPN endpoints are undocumented and can change without notice; keep parsing defensive
  (missing fields degrade, never throw the whole feed).
- Contrast is measured: all three text steps clear WCAG AA. Re-measure if you touch `--fg-*`.
- Sleeper's API is free for non-commercial use only. This stays a personal dashboard.
- No secrets exist. The user's Sleeper username lives in browser localStorage (`gamezone:` prefix); never commit one.
- `.claude/launch.json` is tracked even though `.gitignore` lists it. Leave it.
- Don't read `docs/screenshot.jpg` (binary).

## Skills for this repo

Load these with the Skill tool when the situation comes up; the user does not need to ask.

| Situation in this repo | Skill |
|---|---|
| A play is missing, a starter isn't flagged, Diagnostics shows a scoring mismatch on a final game, a poller stalls | `diagnosing-bugs` |
| Changing `scoring.js`, `bridge.js`, `boxscore.js` or ESPN/Sleeper parsing, where a wrong number or a silently unlinked player looks fine on screen | `sop-fail-loud` |
| Proving a feed, panel or phone-layout change works in the running page (`gamezone` launch config, `?week=8` when nothing is live) | `run` |
| Deciding how to add the repo's first automated tests (e.g. `scoring.js` against known Sleeper totals) | `engineering:testing-strategy` |
| Fixing a scoring or bridge bug once a test harness exists | `tdd` |
| Sketching a new panel tab, rail marker or feed treatment before building it | `prototype` |
| Adding a chart, stat tile or leaders view to the stats panel | `dataviz` |
| Any commit | `safe-commit` |
| Opening or merging a PR / independent review before merge | `sop-ship-pr` / `code-review` |
| A change makes this guide or the README's measured numbers untrue | `sop-project-guide` |

## Before you finish any task

1. `for f in js/*.js; do node --check "$f"; done` -> no output.
2. Serve (`gamezone` launch config or `python -m http.server 8765`), load `/` and `/?week=8`:
   the feed fills, the browser console shows no errors. For layout changes also check 375x812 and 812x375.
3. If you touched scoring or the bridge: Settings -> Diagnostics with a league connected reads
   "all league starters linked" and final games `N/N exact`. If you cannot connect a league, say so.
4. `git diff --stat` -> only files you meant to change.

## Model routing

Safe for Sonnet: CSS and copy tweaks, README updates, poll intervals and caps in `config.js`,
team aliases, new filter chips, rail/panel presentation.

Escalate to Opus: `scoring.js` and field-goal distance logic, `bridge.js` matching rules,
feed merge/dedupe and `tierOf()`, whole-game pull + tail paging in `espn.js`, poller backoff,
and the phone breakpoint (CSS specificity across two files).
