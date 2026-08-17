const API_URL = 'https://api.football-data.org/v4/matches';

// The same big-five-plus-Champions-League scope as lib/filter.js's
// BIG_FIVE keyword list, expressed as football-data.org's competition
// codes. Europa/Conference League are left out -- not confirmed to be
// included on football-data.org's free tier, and the existing ranking
// rules don't treat them as must-cover either.
const COMPETITIONS = 'PL,PD,SA,BL1,FL1,CL';

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Fetches finished matches from the last `days` days across the
// competitions above. One call, not resilient per-competition like
// lib/feeds.js's RSS fetching -- football-data.org serves all
// competitions in a single request, so a bad request fails the whole
// step.
export async function fetchResults({ days = 7 } = {}) {
  if (!process.env.FOOTBALL_DATA_API_KEY) {
    // Fails loud rather than sending an empty X-Auth-Token and waiting
    // on football-data.org's own 401 for the same answer.
    throw new Error('FOOTBALL_DATA_API_KEY is not set -- Results posts are unavailable.');
  }

  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - days * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    competitions: COMPETITIONS,
    dateFrom: isoDate(dateFrom),
    dateTo: isoDate(dateTo),
    status: 'FINISHED',
  });

  const response = await fetch(`${API_URL}?${params}`, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text();
    // football-data.org's free tier is 10 requests/minute. This app only
    // calls this once per "Find results" click (no loop, no polling), so
    // hitting that limit should be rare -- but if it happens, surface
    // their rate-limit headers instead of a generic error.
    if (response.status === 429) {
      const resetIn = response.headers.get('X-RequestCounter-Reset');
      throw new Error(
        `football-data.org rate limit hit${resetIn ? ` -- resets in ${resetIn}s` : ''}. `
        + 'Wait a moment and try again.'
      );
    }
    throw new Error(`football-data.org ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const matches = (data.matches || [])
    .filter((m) => m.score?.fullTime?.home != null && m.score?.fullTime?.away != null)
    .map((m) => ({
      id: String(m.id),
      competition: m.competition?.name || 'Football',
      homeTeam: m.homeTeam?.shortName || m.homeTeam?.name || 'Home',
      awayTeam: m.awayTeam?.shortName || m.awayTeam?.name || 'Away',
      homeScore: m.score.fullTime.home,
      awayScore: m.score.fullTime.away,
      utcDate: m.utcDate,
      matchday: m.matchday,
    }));
  return rankMatches(matches);
}

// Clubs that get a "marquee" bump when ranking finished matches, so the
// picker can surface the biggest games first instead of showing all of a
// week's results in raw chronological order. Deliberately narrower and
// club-only, unlike BIG_FIVE in lib/filter.js (that list also matches
// league/competition names and generic transfer words -- useful for
// judging whether a News headline is on-topic at all, not for comparing
// which of two already-on-topic finished matches is the bigger game).
const MARQUEE_CLUBS = [
  'real madrid', 'barcelona', 'atletico madrid', 'atletico', 'manchester city',
  'manchester united', 'liverpool', 'arsenal', 'chelsea', 'tottenham',
  'bayern münchen', 'bayern munich', 'bayern', 'borussia dortmund', 'dortmund',
  'juventus', 'inter', 'ac milan', 'milan', 'napoli', 'psg', 'paris saint-germain',
];

// A deterministic, no-Claude-call importance score -- same design
// principle as buildResultSlide() above (results are templated, not
// written), so ranking them stays a static formula rather than another
// paid API call. Higher is more important. Three cheap, self-contained
// signals rather than any that need extra data this app doesn't already
// have (current table position, derby pairings, etc.):
//   - competition prestige: Champions League outranks a normal league game
//   - marquee clubs involved: 0, 1, or 2 (two is a genuine "clash of
//     titans" game, worth more than either club playing a smaller side)
//   - a close, high-scoring scoreline reads as a more eventful game than
//     a routine one-sided result
export function matchImportance(match) {
  let score = 0;

  if (/champions league/i.test(match.competition)) score += 3;

  // Some clubs have more than one matching entry above (e.g. "bayern" and
  // "bayern munich" both match "Bayern Munich") -- count each *team* as
  // marquee at most once, not once per matching synonym.
  const home = match.homeTeam.toLowerCase();
  const away = match.awayTeam.toLowerCase();
  if (MARQUEE_CLUBS.some((c) => home.includes(c))) score += 1;
  if (MARQUEE_CLUBS.some((c) => away.includes(c))) score += 1;

  const diff = Math.abs(match.homeScore - match.awayScore);
  const total = match.homeScore + match.awayScore;
  if (diff <= 1 && total >= 3) score += 1;

  return score;
}

// Orders matches most-important first; ties fall back to most-recent
// first (fetchResults()'s previous, only sort). Ranking only reorders
// what the picker shows -- same manual-curation approach as the News
// picker's rankStories(), nothing here selects or trims anything.
export function rankMatches(matches) {
  return [...matches].sort((a, b) => {
    const byImportance = matchImportance(b) - matchImportance(a);
    if (byImportance !== 0) return byImportance;
    return new Date(b.utcDate) - new Date(a.utcDate);
  });
}

// Turns a result into slide copy directly -- no Claude call needed,
// the "content" is just the scoreline. Team names carry the news
// (key: true), the score sits between them in white for rhythm.
export function buildResultSlide(match) {
  return {
    headline_parts: [
      { text: match.homeTeam, key: true },
      { text: `${match.homeScore}-${match.awayScore}`, key: false },
      { text: match.awayTeam, key: true },
    ],
    body: `Full-time result from the ${match.competition}${
      match.matchday ? `, matchday ${match.matchday}` : ''
    }.`,
    source_name: match.competition,
    source_url: null,
    fingerprint: null,
  };
}
