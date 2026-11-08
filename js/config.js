// Endpoints and tuning constants. No keys, no secrets — every host below
// serves Access-Control-Allow-Origin: * so the browser calls it directly.

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
export const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
export const SLEEPER   = 'https://api.sleeper.app/v1';

export const SEASON = 2026;

// Poll intervals (ms). Scoreboard beats its own max-age=4 cache.
export const INTERVALS = {
  scoreboard: 6000,
  plays:     10000,
  matchups:  25000,
  league:   600000,
  idle:      60000,   // used for every poller when nothing is live
};

// How many plays to pull per tail page. Far more than can appear in one
// poll interval, so the newest page always contains every new play.
export const PLAYS_PAGE_SIZE = 25;

// Cache lifetimes (ms)
export const TTL = {
  espnTeams:    7 * 864e5,
  espnRosters:  1 * 864e5,
  sleeperPlayers: 1 * 864e5,
};

export const LS_PREFIX = 'gamezone:';

// Max play cards kept in the DOM.
export const FEED_CAP = 400;

// ESPN uses a few team abbreviations that differ from Sleeper's.
export const TEAM_ALIASES = {
  WSH: 'WAS', WAS: 'WSH',
  LAR: 'LAR', LAC: 'LAC',
  JAX: 'JAC', JAC: 'JAX',
  LV: 'LVR',  LVR: 'LV',
};
