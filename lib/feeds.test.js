import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImage, MIN_USABLE_WIDTH, escapeBareAmpersands } from './feeds.js';

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

  await t.test('returns null (not a known-too-small candidate) when nothing confirmed-good or unconfirmed exists', () => {
    // Regression test for a real, shipped bug: a Guardian item whose
    // only image candidate was a feed-declared 140px thumbnail (Guardian
    // URLs are deliberately never upgraded to a larger size -- see
    // upgradeImageUrl() -- so 140px is genuinely the only size on offer)
    // landed on a slide instead of falling through to a real web image
    // search or the branded gradient. A confirmed-too-small candidate
    // should never be used, even as a last resort.
    const item = {
      mediaThumbnail: { $: { url: 'https://img.example.com/tiny.jpg', width: '100' } },
    };
    assert.equal(extractImage(item), null);
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

test('escapeBareAmpersands', async (t) => {
  await t.test('escapes a bare ampersand in text content', () => {
    // Regression test for a real, shipped bug: "Invalid character in
    // entity name" from a feed with unescaped "&" in an item's text.
    assert.equal(
      escapeBareAmpersands('<title>Fish & Chips</title>'),
      '<title>Fish &amp; Chips</title>'
    );
  });

  await t.test('leaves already-valid named entities untouched', () => {
    const xml = '<title>Fish &amp; Chips &lt;special&gt; &quot;deal&quot; &apos;today&apos;</title>';
    assert.equal(escapeBareAmpersands(xml), xml);
  });

  await t.test('leaves numeric entities (decimal and hex) untouched', () => {
    const xml = '<title>Caf&#233; &#x2019;s menu</title>';
    assert.equal(escapeBareAmpersands(xml), xml);
  });

  await t.test('escapes multiple bare ampersands in the same document', () => {
    assert.equal(
      escapeBareAmpersands('<a>Rock & Roll</a><b>Salt & Pepper</b>'),
      '<a>Rock &amp; Roll</a><b>Salt &amp; Pepper</b>'
    );
  });
});
