# GameZone on the iPhone lock screen

`gamezone-widget.js` is a [Scriptable](https://scriptable.app) script. Scriptable
is a free app that runs JavaScript as a real iOS widget, so this needs **no Mac,
no Xcode and no Apple Developer account**.

## Read this first: what a widget can actually do

A widget cannot show a live play feed. This is not a limitation of this script,
and no amount of work on it would change the answer.

Apple's WidgetKit documentation states that a frequently viewed widget receives
**40 to 70 refreshes a day** — "roughly ... every 15 to 60 minutes" — and that
timeline entries must be at least about five minutes apart. The budget belongs to
the system, not to the app. A widget asking for more is simply not reloaded.

So a widget showing the newest play would be showing you a play from somewhere
between fifteen minutes and an hour ago, with no way to tell which. That is worse
than useless during a game, because it looks current.

This widget therefore shows what is **still true at that cadence**:

- your live matchup total against your opponent's
- how many of your starters have not kicked off yet
- live scores, with a dot on any game in the red zone
- the latest play from each live game, as context rather than as a feed

For the actual 10-second feed, tap the widget. It opens
<https://kejjeh.github.io/nfl-gamezone/>, which is the real thing.

The only iOS feature that *is* genuinely live is a **Live Activity**, and it
needs a native app, an Apple Developer account ($99/yr) and a server to push
updates. That is a different project; see "If you ever want the live version"
below.

## Install

**1. Install Scriptable** from the App Store (free).

**2. Get the script onto your phone.** Either:

- On the phone, open
  <https://github.com/Kejjeh/nfl-gamezone/blob/main/ios/gamezone-widget.js>,
  tap the raw/copy button, and copy all of it. Then in Scriptable tap **+**
  (top right), paste, and name the script `GameZone`.
- Or, if Scriptable's iCloud sync is on, drop `gamezone-widget.js` into
  `iCloud Drive/Scriptable/` and it appears in the app.

**3. Run it once inside Scriptable** (the ▶ button). Two reasons:

- it tells you immediately whether the data is flowing, and
- it builds the player-name cache, which is 5 MB of parsing. Doing it once in
  the app keeps the widget from ever having to attempt it with an extension's
  much smaller memory budget.

A script run from inside Scriptable gets no Parameter, so this first run shows
scores and plays but not your matchup — that is expected, and it still builds
the cache. Once the widget has run with your username, the script remembers it,
so later in-app runs show your matchup too.

**4. Add the widget.**

- *Lock screen:* long-press the lock screen → **Customise** → tap the widget
  area → choose **Scriptable** → pick **Rectangular** (the useful one; Inline
  and Circular also work).
- *Home screen:* long-press the home screen → **+** → **Scriptable** → pick a
  size. Medium is the best fit.

**5. Configure it.** Tap the newly added widget and set:

| Field | Value |
|---|---|
| Script | `GameZone` |
| Parameter | your Sleeper username |
| When Interacting | *Open URL* — the script supplies the GameZone address |

The **Parameter** field is the important one. Without it the widget still works
and shows live NFL scores and plays; with it you also get your fantasy matchup,
your lineup and the yet-to-play count.

Scriptable's menu wording has changed between versions, and these steps were
written from its documentation rather than from a device — if a label differs,
the field you want is still the one that sets the script's *parameter*.

## What each size shows

| Family | Content |
|---|---|
| `accessoryRectangular` | matchup total, yet-to-play count, one play over two lines |
| `accessoryInline` | `77.3 - 86.9 · 7 live · 2 to play` |
| `accessoryCircular` | your total over your opponent's |
| `small` | matchup, yet-to-play, latest play |
| `medium` | matchup, two latest plays (red zone first) |
| `large` | the above, plus live scores and your starting lineup with points |

Red-zone games sort to the top, because that is where something is about to
happen. A live game with no usable play text still gets a line showing its down
and distance rather than being dropped — of seven live games measured, two had
no `lastPlay`.

## Checking it without a phone

Scriptable only exists on iOS, so the script is written so its data and text
layers can be exercised from a desktop. `tools/` holds two harnesses that stub
Scriptable's globals (`Request`, `FileManager`, `ListWidget`, `Color`, `Font`,
`args`, `config`, `Script`) and run the real file against the live APIs:

```bash
node tools/widget-preview.mjs                 # all six sizes, no league
node tools/widget-preview.mjs YOUR_SLEEPER_NAME    # with your Sleeper data
node tools/widget-scenarios.mjs YOUR_SLEEPER_NAME  # the four failure paths
```

`widget-preview` prints the widget tree as text and flags any line that runs
over its family's character budget. `widget-scenarios` forces the four states a
live Sunday never reaches: no games on, offline with an empty cache, offline
after a good run (must show stale data, not an error), and a bad Sleeper
username (must keep the NFL scores).

This verifies every string the widget renders. It does **not** verify layout —
whether three lines fit a lock-screen rectangle is a question only the device
answers. Expect to nudge the font sizes in `renderAccessoryRectangular` once you
see it in place.

## Cost

| | |
|---|---|
| Requests per widget refresh | 1 when warm (ESPN scoreboard), 5 with fantasy |
| Cold start | 12 requests, ~350 ms |
| Player map | 5.00 MB across 6 position requests → a 32 KB cache, rebuilt weekly |
| Refreshes per day | 40–70, decided by iOS |

The player map is fetched one position at a time on purpose. The unfiltered
`players/nfl` endpoint is **14.0 MB**; the six position-filtered requests total
5.00 MB and, more importantly, peak at **2.1 MB** for any single parse.

## If you ever want the live version

A real live feed on the lock screen means a **Live Activity**, which needs:

- a native iOS app (Swift, Xcode, so a Mac or a hosted macOS build service)
- an Apple Developer account, $99/yr
- a small server holding an APNs key, pushing each play to the device

Live Activities run for up to 8 hours and are push-driven, so they genuinely
update within seconds. Everything else about this project — no server, no key,
no cost — would stop being true.
