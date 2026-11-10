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

  // Tracked bets, loaded from localStorage by bets.js. Legs hold an ESPN
  // athlete id, so progress is a box-score lookup rather than text matching.
  bets: [],

  boxscores: new Map(),     // eventId -> normalized box score
  playerStats: new Map(),   // espn athleteId -> aggregated line + fantasy points

  // Flattened out of the box scores so the feed can ask about one play
  // without knowing which game it came from.
  winProb: new Map(),       // playId  -> { home, swing }  (0..1)
  drives: new Map(),        // eventId -> drive[] in order

  // "What did I miss." awayAt is the newest play the feed had rendered when
  // the tab was last hidden; everything newer than it is marked unread until
  // the divider is dismissed. null means there is nothing to catch up on.
  away: { at: null, count: 0 },

  panel: { open: true, tab: 'leaders', leaderCat: 'fpts', leaderPos: 'all', userPicked: false },

  // Season-long fantasy numbers, summed from Sleeper's weekly stat files.
  // `weeks` is week number -> { sleeperPlayerId: leaguePoints }; `through` is
  // the last week it holds. Loaded on first open of the Players view, not at
  // boot - the live feed does not need it and it is ~600 KB.
  // `rulesTag` records which scoring settings these points were computed
  // under, so a league connecting mid-session can tell that what is already
  // loaded is now wrong.
  season: {
    weeks: new Map(), through: 0, loaded: false, loading: false,
    error: null, rulesTag: null,
  },

  // The Players view: a full-window sortable table of every fantasy-relevant
  // player, with ownership from the connected league. `week` null = season.
  players: { week: null, pos: 'all', own: 'all', q: '', sort: 'pts', dir: 'desc' },

  // 'feed' (the live three-column dashboard) or 'players'.
  view: 'feed',

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
