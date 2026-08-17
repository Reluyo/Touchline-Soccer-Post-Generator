import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getImageDimensions } from './imageDimensions.js';

function makePng(width, height) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // PNG signature, first 4 bytes
  buf.writeUInt32BE(0x0d0a1a0a, 4); // PNG signature, last 4 bytes
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeJpeg(width, height) {
  const app0Payload = Buffer.from([
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version
    0x00, // units
    0x00, 0x01, 0x00, 0x01, // x/y density
    0x00, 0x00, // thumbnail width/height
  ]);
  const app0Length = Buffer.alloc(2);
  app0Length.writeUInt16BE(app0Payload.length + 2, 0);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), app0Length, app0Payload]);

  const sof0Payload = Buffer.alloc(9);
  sof0Payload[0] = 8; // precision
  sof0Payload.writeUInt16BE(height, 1);
  sof0Payload.writeUInt16BE(width, 3);
  sof0Payload[5] = 1; // component count
  sof0Payload[6] = 1; // component id
  sof0Payload[7] = 0x11; // sampling factors
  sof0Payload[8] = 0; // quant table id
  const sof0Length = Buffer.alloc(2);
  sof0Length.writeUInt16BE(sof0Payload.length + 2, 0);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), sof0Length, sof0Payload]);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

test('getImageDimensions', async (t) => {
  await t.test('reads width/height from a PNG IHDR chunk', () => {
    assert.deepEqual(getImageDimensions(makePng(1920, 1080)), { width: 1920, height: 1080 });
  });

  await t.test('reads width/height from a JPEG SOF0 marker, skipping a preceding APP0', () => {
    assert.deepEqual(getImageDimensions(makeJpeg(800, 450)), { width: 800, height: 450 });
  });

  await t.test('handles a JPEG with no APP0 segment at all', () => {
    const sof0Payload = Buffer.alloc(9);
    sof0Payload[0] = 8;
    sof0Payload.writeUInt16BE(600, 1);
    sof0Payload.writeUInt16BE(400, 3);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(sof0Payload.length + 2, 0);
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0]), length, sof0Payload]);
    assert.deepEqual(getImageDimensions(buf), { width: 400, height: 600 });
  });

  await t.test('returns null for an unrecognized format', () => {
    assert.equal(getImageDimensions(Buffer.from('not an image, just some bytes here')), null);
  });

  await t.test('returns null for a buffer too short to hold a header', () => {
    assert.equal(getImageDimensions(Buffer.from([0x89, 0x50])), null);
  });

  await t.test('returns null rather than throwing on a truncated PNG signature', () => {
    assert.equal(getImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  });

  await t.test('returns null rather than hanging on a truncated JPEG with no terminating marker', () => {
    assert.equal(getImageDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
  });
});
