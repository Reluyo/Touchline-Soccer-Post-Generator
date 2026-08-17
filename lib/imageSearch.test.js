import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFromResult } from './imageSearch.js';

test('candidateFromResult', async (t) => {
  await t.test('prefers properties.url (the original full-res image) over the thumbnail', () => {
    const result = {
      properties: { url: 'https://cdn.example.com/full.jpg', width: 1920, height: 1080 },
      thumbnail: { src: 'https://imgproxy.brave.com/thumb.jpg', width: 500 },
    };
    assert.deepEqual(candidateFromResult(result), { url: 'https://cdn.example.com/full.jpg', width: 1920 });
  });

  await t.test('falls back to thumbnail.src when properties.url is missing', () => {
    const result = { thumbnail: { src: 'https://imgproxy.brave.com/thumb.jpg', width: 500 } };
    assert.deepEqual(candidateFromResult(result), { url: 'https://imgproxy.brave.com/thumb.jpg', width: 500 });
  });

  await t.test('tolerates the old web/search result shape (image.url) as a last resort', () => {
    const result = { image: { url: 'https://example.com/photo.jpg' } };
    assert.deepEqual(candidateFromResult(result), { url: 'https://example.com/photo.jpg', width: null });
  });

  await t.test('returns null width when no size is reported anywhere', () => {
    const result = { properties: { url: 'https://cdn.example.com/full.jpg' } };
    assert.deepEqual(candidateFromResult(result), { url: 'https://cdn.example.com/full.jpg', width: null });
  });

  await t.test('returns null when there is no usable URL at all', () => {
    assert.equal(candidateFromResult({}), null);
  });
});
