// Run real pasted slips through the parser and print what comes out.
//
//   node tools/slip-probe.mjs
//
// The fixtures below are the ACTUAL line formats DraftKings and FanDuel use,
// taken from real saved pages - not invented. The first version of the parser
// was written against guessed formats and got six of six wrong, so these stay
// here as the record of what the books really emit.
import * as core from '../js/bets-core.js';

// Identity resolver: we are testing parsing, not player lookup.
const resolvers = {
  player: (name) => ({ athleteId: `id:${name}`, candidates: [], reason: null }),
  team: (name) => ({ abbr: name.slice(0, 3).toUpperCase() }),
};

const CASES = {
  'FD — the SGP summary line (what you would actually copy)': `Same Game Parlay +3958
Rhamondre Stevenson Any Time Touchdown Scorer, Josh Jacobs Any Time Touchdown Scorer, Demario Douglas Any Time Touchdown Scorer, Matthew Golden Any Time Touchdown Scorer
Green Bay Packers
New England Patriots
$10.00
TOTAL WAGER
$405.90
TOTAL PAYOUT`,

  'FD — card detail, name then market on separate lines': `Ja'Marr Chase
ANY TIME TOUCHDOWN SCORER
Ja'Marr Chase 50+ Yards
JA'MARR CHASE - ALT RECEIVING YDS
$25.00
TOTAL WAGER`,

  'FD — alt rushing, two players': `Javonte Williams
ANY TIME TOUCHDOWN SCORER
MarShawn Lloyd
ANY TIME TOUCHDOWN SCORER
MarShawn Lloyd 10+ Yards
MARSHAWN LLOYD - ALT RUSHING YDS
Javonte Williams 25+ Yards
JAVONTE WILLIAMS - ALT RUSHING YDS
$25.00
TOTAL WAGER`,

  'DK — name line then market line': `RHAMONDRE STEVENSON
Anytime TD Scorer
JOSH JACOBS
Anytime TD Scorer
Wager: $10.00 To Pay: $290.40`,

  'DK — line BEFORE the market line': `RASHEE RICE
Anytime TD Scorer
40+
Rashee Rice Receiving Yards
JONATHAN TAYLOR
Anytime TD Scorer
70+
Jonathan Taylor Rushing Yards`,

  'DK — Live prefix, real ordering': `STEFON DIGGS
Live Anytime TD Scorer
50+
Live Stefon Diggs Receiving Yards`,

  'name containing AT (JONATHAN) must not look like a fixture': `JONATHAN TAYLOR
Anytime TD Scorer
MATTHEW GOLDEN
Anytime TD Scorer`,

  'a first-TD bet must be refused, not settled as anytime': `Ja'Marr Chase
1st Touchdown Scorer`,
};

for (const [label, text] of Object.entries(CASES)) {
  const r = core.parseSlip(text, resolvers);
  console.log(`\n${'='.repeat(72)}\n${label}`);
  console.log(`  book=${r.book}  stake=${r.stake}  odds=${r.odds}  toWin=${r.toWin}`);
  console.log(`  legs: ${r.legs.length}`);
  for (const l of r.legs) {
    console.log(`    - ${String(l.playerName || l.teamAbbr || '?').padEnd(22)} ${String(l.market).padEnd(12)} ${l.side || ''} ${l.cmp || ''} ${l.line ?? ''}`);
  }
  if (r.warnings?.length) for (const w of r.warnings) console.log(`    ! ${w}`);
}
