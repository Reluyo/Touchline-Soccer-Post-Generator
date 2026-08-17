import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImage, MIN_USABLE_WIDTH } from './feeds.js';

test('extractImage', async (t) => {
  await t.test('prefers a confirmed-large candidate over an earlier-priority unknown-size one', () => {
    // Regression test for a real, shipped bug: a low-res image landed on
    // a slide because the first candidate (mediaThumbnail, no width
    // reported) was treated as automatically fine, ahead of a later
    // media:content candidate the feed explicitly confirmed was big
    // enough. Priority order should only break ties within a size tier,
    // not override a confirmed-good candidate.
    const item = {
      mediaThumbnail: { $: { url: 'https://img.example.com/thumb.jpg' } }, // no width
      mediaContent: { $: { url: 'https://img.example.com/full.jpg', width: '1600' } },
    };
    assert.equal(extractImage(item), 'https://img.example.com/full.jpg');
  });

  await t.test('skips a confirmed-small candidate in favour of a later, larger one', () => {
    const item = {
      mediaThumbnail: { $: { url: 'https://img.example.com/small.jpg', width: '150' } },
      mediaContent: { $: { url: 'https://img.example.com/large.jpg', width: '1200' } },
    };
    assert.equal(extractImage(item), 'https://img.example.com/large.jpg');
  });

  await t.test('falls back to an unknown-size candidate when nothing confirmed-good exists', () => {
    const item = {
      enclosure: { url: 'https://img.example.com/enclosure.jpg', type: 'image/jpeg' },
    };
    assert.equal(extractImage(item), 'https://img.example.com/enclosure.jpg');
  });

  await t.test('falls back to the first candidate at all when every one is confirmed too small', () => {
    const item = {
      mediaThumbnail: { $: { url: 'https://img.example.com/tiny.jpg', width: '100' } },
    };
    assert.equal(extractImage(item), 'https://img.example.com/tiny.jpg');
  });

  await t.test('a width exactly at the threshold counts as confirmed-good', () => {
    const item = {
      mediaThumbnail: { $: { url: 'https://img.example.com/exact.jpg', width: String(MIN_USABLE_WIDTH) } },
    };
    assert.equal(extractImage(item), 'https://img.example.com/exact.jpg');
  });

  await t.test('returns null when there is no image candidate at all', () => {
    assert.equal(extractImage({}), null);
  });
});
