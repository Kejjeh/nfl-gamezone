// Fitted constants for the live fantasy win probability (live_pwin_v1).
//
// Copied from Kejjeh/gridiron, where they were fitted and tested:
// `data/reference/live_pwin_v1.json`, study in `docs/research/LIVE_PWIN.md`,
// handoff in `docs/handoff/GAMEZONE_LIVE_PWIN.md`. The unmodified source file
// is kept at `docs/live_pwin_v1.json` in this repo so the numbers below can be
// checked against it without leaving the repo; this module carries only what
// the model needs, because everything in `js/` ships to the browser.
//
// A JS module rather than the JSON it came from, for two reasons: the browser
// would otherwise have to fetch it (this app has no build step), and
// `node --check js/*.js` - the repo's CI syntax gate - reads .js only.
//
// Fitted on this league's 2023-2024 seasons, tested on 2025-2026, which the
// fit never saw: 1,884 held-out matchup x checkpoint states.
//
//   log loss        live 0.424   pre-game frozen 0.680   points-share bar 1.153
//   (coin flip 0.693; lower is better)
//
//   by share of projected points still to come:
//     late (<25%)    0.215      early (60-90%)  0.573
//     mid (25-60%)   0.455      pre (>90%)      0.663
//
// The last row is the one to say out loud in the UI: before kickoff this is
// barely better than a coin flip, because Sleeper's pre-game projections are
// weak in this league. It sharpens as games are played.
export const CONSTS = {
  version: 'live_pwin_v1',

  // sd_i = f^(g/2) * (a[pos] + b[pos] * proj)
  // The near-zero values are the fit's floor, not a missing number: an RB's
  // spread is essentially all proportional to his projection, a kicker's
  // essentially all fixed.
  a: {
    QB: 4.02143864447464,
    RB: 0.006737946999085467,
    WR: 0.006737946999085467,
    TE: 4.493370419661157,
    K: 4.929100969863983,
    DEF: 3.468049151057294,
  },
  b: {
    QB: 0.18479214510602693,
    RB: 0.5867645840366357,
    WR: 0.6067590743163365,
    TE: 0.1490236362681573,
    K: 0.006737946999085467,
    DEF: 0.39386201311013036,
  },

  // The spread shrinks as f^(g/2) = f^0.39. The study's prose says this is
  // "faster early in a game than sqrt(f) would" - that is backwards, and the
  // arithmetic is not ambiguous: an exponent below 0.5 keeps MORE spread at
  // every f < 1 (at half a game, 0.762 of it against a square root's 0.707).
  // The fitted value is what matters and it is used as fitted; only the
  // sentence describing it is wrong.
  g: 0.7828429400781572,

  // Scale on the combined spread. The 2023-24 argmin was 0.85, but across
  // 0.85-1.10 the training log loss moves by under 0.003 - noise. 1.0 wins on
  // the held-out seasons and is what gridiron's pre-game board already uses,
  // so the two agree at kickoff. Do not "optimise" this back to 0.85 without
  // beating v1 on held-out seasons.
  k: 1.0,
};

// Overtime: regulation is over, so almost nothing is left to project. The
// study did not fit overtime separately (it is rare and the history has no
// clean marker for it), so this is a small fixed stub rather than a fitted
// value.
export const OT_FRACTION = 0.02;

// Sleeper tags that mean a starter will score nothing more this week. Compared
// case-insensitively; anything else (Questionable, Probable, null) is ignored,
// because those players usually do play.
export const OUT_TAGS = ['out', 'ir', 'doubtful', 'inactive', 'sus', 'pup', 'dnr', 'na'];
