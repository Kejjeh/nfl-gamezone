// Generated from ESPN. The site.api /teams list endpoint is the one ESPN
// path that omits CORS headers, so this is baked in rather than fetched.
//
// Accent = the official team colour with its hue preserved and lightness
// moved into a band that reads against the dark app surface. Many NFL
// primaries are near-black (CHI #0b1c3a, BAL #241773, NYJ #115740) and
// are invisible if used as-is. Lightening in HLS keeps identity intact;
// mixing toward white does not - it turned Buffalo pink in a first pass.
// [espnId, abbr, shortName, accent]
export const TEAMS = [
  ['1', 'ATL', 'Falcons', '#e23c57'],
  ['2', 'BUF', 'Bills', '#1f70ff'],
  ['3', 'CHI', 'Bears', '#427adb'],
  ['4', 'CIN', 'Bengals', '#fb5a22'],
  ['5', 'CLE', 'Browns', '#e89635'],
  ['6', 'DAL', 'Cowboys', '#1f85ff'],
  ['7', 'DEN', 'Broncos', '#3c85e2'],
  ['8', 'DET', 'Lions', '#1fb0ff'],
  ['9', 'GB', 'Packers', '#51cd81'],
  ['10', 'TEN', 'Titans', '#4a98d3'],
  ['11', 'IND', 'Colts', '#1f90ff'],
  ['12', 'KC', 'Chiefs', '#ea3450'],
  ['13', 'LV', 'Raiders', '#b6bdc8'],
  ['14', 'LAR', 'Rams', '#1f6fff'],
  ['15', 'MIA', 'Dolphins', '#1ff2ff'],
  ['16', 'MIN', 'Vikings', '#8751cd'],
  ['17', 'NE', 'Patriots', '#1f85ff'],
  ['18', 'NO', 'Saints', '#dabd81'],
  ['19', 'NYG', 'Giants', '#1f89ff'],
  ['20', 'NYJ', 'Jets', '#43daa9'],
  ['21', 'PHI', 'Eagles', '#2fd1ef'],
  ['22', 'ARI', 'Cardinals', '#fc2153'],
  ['23', 'PIT', 'Steelers', '#b6bdc8'],
  ['24', 'LAC', 'Chargers', '#1fb0ff'],
  ['25', 'SF', '49ers', '#ff1f1f'],
  ['26', 'SEA', 'Seahawks', '#1f85ff'],
  ['27', 'TB', 'Buccaneers', '#e23c56'],
  ['28', 'WSH', 'Commanders', '#d64747'],
  ['29', 'CAR', 'Panthers', '#1fb2ff'],
  ['30', 'JAX', 'Jaguars', '#1fdfff'],
  ['33', 'BAL', 'Ravens', '#663ee0'],
  ['34', 'HOU', 'Texans', '#30a9ee'],
];
