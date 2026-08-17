import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, fingerprint, filterItems, dedupe, removeSeen } from './filter.js';

test('tokenize', async (t) => {
  await t.test('drops stopwords and short words', () => {
    const tokens = tokenize('Arsenal sign the new striker from Chelsea');
    assert.ok(!tokens.has('the'));
    assert.ok(!tokens.has('new'));
    assert.ok(!tokens.has('from'));
    assert.ok(tokens.has('arsenal'));
    assert.ok(tokens.has('chelsea'));
  });

  await t.test('stems so "signs" and "sign" collide', () => {
    const a = tokenize('Liverpool signs Wilson');
    const b = tokenize('Liverpool sign Wilson');
    assert.ok(a.has('sign'));
    assert.ok(b.has('sign'));
  });

  await t.test('strips a possessive apostrophe before tokenizing', () => {
    // "Rodri's" -> "Rodris" (apostrophe removed) -> stemmed like a
    // trailing-s plural -> "rodri", same as the bare name would tokenize.
    const tokens = tokenize("Rodri's future in doubt");
    assert.ok(tokens.has('rodri'));
    assert.ok(tokens.has('future'));
    assert.ok(tokens.has('doubt'));
    assert.ok(!tokens.has('in')); // stopword
  });
});

test('fingerprint', async (t) => {
  await t.test('is order-independent -- tokens are sorted before hashing', () => {
    const a = fingerprint('Real Madrid sign Mbappe');
    const b = fingerprint('Mbappe sign Real Madrid');
    assert.equal(a, b);
  });

  await t.test('differs for genuinely different stories', () => {
    const a = fingerprint('Arsenal sign Rodri from City');
    const b = fingerprint('Chelsea sign Palmer from Palace');
    assert.notEqual(a, b);
  });
});

test('filterItems', async (t) => {
  const now = Date.now();
  const recent = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  const stale = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

  await t.test('drops items with no title or link', () => {
    const items = [
      { title: '', link: 'https://x.com', publishedAt: recent, summary: '' },
      { title: 'Real news', link: '', publishedAt: recent, summary: '' },
    ];
    assert.equal(filterItems(items).length, 0);
  });

  await t.test('drops items with no publish date -- treated as stale, not passed through', () => {
    const items = [{ title: 'Arsenal sign someone', link: 'https://x.com', publishedAt: null, summary: '' }];
    assert.equal(filterItems(items).length, 0);
  });

  await t.test('drops items older than maxAgeHours', () => {
    const items = [{ title: 'Arsenal sign someone', link: 'https://x.com', publishedAt: stale, summary: '' }];
    assert.equal(filterItems(items, { maxAgeHours: 24 }).length, 0);
  });

  await t.test('keeps fresh items within the window', () => {
    const items = [{ title: 'Arsenal sign someone', link: 'https://x.com', publishedAt: recent, summary: '' }];
    assert.equal(filterItems(items, { maxAgeHours: 24 }).length, 1);
  });

  await t.test('hard-excludes a quiz regardless of topic', () => {
    const items = [{
      title: 'Arsenal transfer quiz: how much do you know?',
      link: 'https://x.com', publishedAt: recent, summary: '',
    }];
    assert.equal(filterItems(items).length, 0);
  });

  await t.test('soft-excludes lower-division stories unless a big-five club is also named', () => {
    const offTopic = [{
      title: 'Sunderland win in the Championship',
      link: 'https://x.com', publishedAt: recent, summary: '',
    }];
    assert.equal(filterItems(offTopic).length, 0);

    const rescued = [{
      title: 'Bayern target Championship striker',
      link: 'https://x.com', publishedAt: recent, summary: '',
    }];
    assert.equal(filterItems(rescued).length, 1);
  });
});

test('dedupe', async (t) => {
  await t.test('clusters near-identical headlines from different outlets', () => {
    const items = [
      { title: 'Arsenal agree deal for Rodri', sourceName: 'BBC', imageUrl: null, publishedAt: null },
      { title: 'Arsenal agree a deal for Rodri', sourceName: 'Guardian', imageUrl: null, publishedAt: null },
    ];
    const result = dedupe(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].alsoReportedBy.length, 1);
  });

  await t.test('keeps genuinely different stories separate', () => {
    const items = [
      { title: 'Arsenal agree deal for Rodri', sourceName: 'BBC', imageUrl: null, publishedAt: null },
      { title: 'Chelsea sack manager after poor run', sourceName: 'Sky', imageUrl: null, publishedAt: null },
    ];
    assert.equal(dedupe(items).length, 2);
  });

  await t.test('sorts image-bearing duplicates first, so the kept item carries a photo', () => {
    const items = [
      { title: 'Arsenal agree deal for Rodri', sourceName: 'BBC', imageUrl: null, publishedAt: null },
      { title: 'Arsenal agree a deal for Rodri', sourceName: 'Guardian', imageUrl: 'https://img', publishedAt: null },
    ];
    const result = dedupe(items);
    assert.equal(result[0].imageUrl, 'https://img');
  });

  await t.test('every result carries a fingerprint', () => {
    const items = [{ title: 'Arsenal agree deal for Rodri', sourceName: 'BBC', imageUrl: null, publishedAt: null }];
    const result = dedupe(items);
    assert.equal(result[0].fingerprint, fingerprint('Arsenal agree deal for Rodri'));
  });
});

test('removeSeen', () => {
  const items = [
    { title: 'a', fingerprint: 'aaa' },
    { title: 'b', fingerprint: 'bbb' },
  ];
  const result = removeSeen(items, ['aaa']);
  assert.equal(result.length, 1);
  assert.equal(result[0].fingerprint, 'bbb');
});
