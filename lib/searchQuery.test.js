import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQuery } from './searchQuery.js';

function slide(...parts) {
  return { headline_parts: parts.map(([text, key]) => ({ text, key })) };
}

test('searchQuery', async (t) => {
  await t.test('drops a transfer fee and picks up a player name missed by the "key" flag', () => {
    // Regression test for a real, shipped bug: writeSlide() marked "Man
    // City" and "£120m" as key (not "Fernandez", bundled into a non-key
    // part), so the old key-based query was "Man City £120m" -- a
    // transfer fee polluting the query, and the actual player missing
    // entirely. The image search returned a barely-related photo.
    const s = slide(['Man City', true], ['eye', false], ['£120m', true], ['Fernandez move', false]);
    assert.equal(searchQuery(s), 'Man City Fernandez');
  });

  await t.test('a simple two-name headline', () => {
    const s = slide(['Rodri', true], ['lands in', false], ['Barcelona', true]);
    assert.equal(searchQuery(s), 'Rodri Barcelona');
  });

  await t.test('drops a bare percentage and a lowercase common noun bundled with a name', () => {
    const s = slide(['Bezos group', true], ['buys', false], ['40%', false], ['of', false], ['Liverpool', true]);
    assert.equal(searchQuery(s), 'Bezos Liverpool');
  });

  await t.test('keeps accented names intact instead of truncating at the accent', () => {
    const s = slide(['Mbappé', true], ['and', false], ['Haaland', true], ['top ratings', false]);
    assert.equal(searchQuery(s), 'Mbappé Haaland');
  });

  await t.test('a name split across "for" still yields both team names', () => {
    const s = slide(['Romero', true], ['set to leave', false], ['Tottenham', true], ['for', false], ['Atlético', true]);
    assert.equal(searchQuery(s), 'Romero Tottenham Atlético');
  });

  await t.test('returns an empty string when there is nothing capitalized at all', () => {
    const s = slide(['the deal', false], ['is done', false]);
    assert.equal(searchQuery(s), '');
  });

  await t.test('handles a slide with no headline_parts at all', () => {
    assert.equal(searchQuery({}), '');
  });
});
