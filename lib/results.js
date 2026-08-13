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
  return (data.matches || [])
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
    }))
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
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
