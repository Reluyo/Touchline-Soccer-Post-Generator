import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchImportance, rankMatches, buildResultSlide } from './results.js';

function match(overrides = {}) {
  return {
    id: '1',
    competition: 'Premier League',
    homeTeam: 'Fulham',
    awayTeam: 'Brentford',
    homeScore: 1,
    awayScore: 0,
    utcDate: '2026-08-15T15:00:00Z',
    matchday: 2,
    ...overrides,
  };
}

test('matchImportance', async (t) => {
  await t.test('a routine game between non-marquee clubs scores 0', () => {
    assert.equal(matchImportance(match()), 0);
  });

  await t.test('one marquee club adds 1', () => {
    assert.equal(matchImportance(match({ homeTeam: 'Arsenal' })), 1);
  });

  await t.test('two marquee clubs adds 2 -- a bigger bump than just one', () => {
    const score = matchImportance(match({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' }));
    assert.equal(score, 2);
  });

  await t.test('is case-insensitive on team names', () => {
    assert.equal(matchImportance(match({ homeTeam: 'arsenal' })), 1);
  });

  await t.test('Champions League adds 3, regardless of the clubs involved', () => {
    assert.equal(matchImportance(match({ competition: 'UEFA Champions League' })), 3);
  });

  await t.test('a close, high-scoring game adds 1', () => {
    assert.equal(matchImportance(match({ homeScore: 2, awayScore: 2 })), 1);
  });

  await t.test('a one-sided blowout does not get the close-game bump', () => {
    assert.equal(matchImportance(match({ homeScore: 4, awayScore: 0 })), 0);
  });

  await t.test('a low-scoring 1-0 does not get the close-game bump either -- needs total >= 3', () => {
    assert.equal(matchImportance(match({ homeScore: 1, awayScore: 0 })), 0);
  });

  await t.test('signals stack: Champions League clash between two marquee clubs, decided by one goal', () => {
    const score = matchImportance(match({
      competition: 'UEFA Champions League',
      homeTeam: 'Real Madrid',
      awayTeam: 'Bayern Munich',
      homeScore: 2,
      awayScore: 1,
    }));
    assert.equal(score, 3 + 2 + 1);
  });
});

test('rankMatches', async (t) => {
  await t.test('orders most-important first', () => {
    const routine = match({ id: 'a', utcDate: '2026-08-16T00:00:00Z' });
    const marquee = match({ id: 'b', homeTeam: 'Liverpool', awayTeam: 'Manchester City', utcDate: '2026-08-14T00:00:00Z' });
    const ranked = rankMatches([routine, marquee]);
    assert.deepEqual(ranked.map((m) => m.id), ['b', 'a']);
  });

  await t.test('ties on importance fall back to most-recent first', () => {
    const older = match({ id: 'older', utcDate: '2026-08-10T00:00:00Z' });
    const newer = match({ id: 'newer', utcDate: '2026-08-16T00:00:00Z' });
    const ranked = rankMatches([older, newer]);
    assert.deepEqual(ranked.map((m) => m.id), ['newer', 'older']);
  });

  await t.test('does not mutate or drop the input array', () => {
    const input = [match({ id: 'a' }), match({ id: 'b' })];
    const ranked = rankMatches(input);
    assert.equal(input.length, 2);
    assert.equal(ranked.length, 2);
    assert.notEqual(ranked, input);
  });
});

test('buildResultSlide still works for a ranked match', () => {
  const slide = buildResultSlide(match({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' }));
  assert.equal(slide.headline_parts[0].text, 'Arsenal');
  assert.equal(slide.headline_parts[2].text, 'Chelsea');
});
