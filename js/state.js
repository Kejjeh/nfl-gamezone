// Single mutable app state plus the dumbest possible pub/sub.
export const state = {
  week: null,
  seasonType: 2,
  games: new Map(),        // eventId -> normalized game
  plays: new Map(),        // playId  -> normalized play
  playsMeta: new Map(),    // eventId -> { pageCount, count }
  teamsById: new Map(),    // espn team id -> { abbr, name, logo }
  redZone: new Map(),      // eventId -> bool (previous poll, for transitions)

  sleeper: {
    username: null, userId: null, league: null, leagueId: null,
    rosters: null, matchups: null, players: null,
    myRosterId: null, oppRosterId: null,
    myPoints: null, oppPoints: null,
    myStarters: new Set(), oppStarters: new Set(),
    // Sets answer "is this player mine"; the arrays keep Sleeper's own lineup
    // order, which is what the My Team tab lists by.
    myLineup: [], oppLineup: [], slotLabels: [],
    pointsByPlayer: new Map(),
    error: null,
  },

  bridge: { athleteToSleeper: new Map(), ready: false, unresolved: [] },

  boxscores: new Map(),     // eventId -> normalized box score
  playerStats: new Map(),   // espn athleteId -> aggregated line + fantasy points

  panel: { open: true, tab: 'leaders', leaderCat: 'fpts', userPicked: false },

  // mode = significance; types = play-type chips (empty set means no type filter)
  // athleteId follows one player across every game; athleteName is kept only
  // so the chip can name them without a lookup.
  filters: { mode: 'all', gameId: null, types: new Set(), athleteId: null, athleteName: null },
  settings: { sound: true, visual: true, notify: false },

  primed: false,           // suppress alerts until the backlog is ingested
  status: { scoreboard: null, plays: null, sleeper: null, lastUpdate: 0, errors: 0 },
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(what) { for (const fn of subs) { try { fn(what); } catch (e) { console.error(e); } } }
