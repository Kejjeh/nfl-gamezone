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
    pointsByPlayer: new Map(),
    error: null,
  },

  bridge: { athleteToSleeper: new Map(), ready: false, unresolved: [] },

  filters: { mode: 'all', gameId: null },
  settings: { sound: true, visual: true, notify: false },

  primed: false,           // suppress alerts until the backlog is ingested
  status: { scoreboard: null, plays: null, sleeper: null, lastUpdate: 0, errors: 0 },
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(what) { for (const fn of subs) { try { fn(what); } catch (e) { console.error(e); } } }
