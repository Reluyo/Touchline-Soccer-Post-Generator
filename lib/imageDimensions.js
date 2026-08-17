// Reads pixel width/height straight out of an image file's header,
// without a full decode -- covers JPEG and PNG, which between them
// account for the large majority of real press photos (both what RSS
// feeds ship and what a web image search turns up). Returns null (never
// throws) for anything else, or a header too short/malformed to read --
// callers already treat "unknown size" as "proceed cautiously, same as
// a source that never reported a size hint at all", so a parsing miss
// here can only fall back to today's behaviour, never make it worse.
//
// Deliberately hand-rolled instead of pulling in a general-purpose
// image-dimensions package: the obvious npm candidate (image-size) ships
// known, unpatched infinite-loop DoS advisories in its ICNS/JXL/HEIF
// parsers, and every one of its format sniffers runs on unmoderated
// bytes fetched from a web search result. Limiting this to formats with
// a simple, decades-stable header layout sidesteps that surface
// entirely, and the JPEG marker walk below is bounded by a strictly
// increasing offset, so it always terminates within the buffer's length.
//
// WebP deliberately NOT handled -- its three sub-formats (VP8/VP8L/VP8X)
// pack width/height into odd bit-widths rather than plain byte fields,
// which is real room to get subtly wrong with no way to verify against
// a real file in this sandbox (no network access to fetch a sample).
// Better to return "unknown" for it -- same safe fallback as any other
// unrecognized format -- than ship an unverified bit-packing guess.
export function getImageDimensions(buf) {
  if (!buf || buf.length < 12) return null;

  // PNG: 8-byte signature, then the IHDR chunk (4-byte length, 4-byte
  // type "IHDR") holds width and height as two big-endian uint32s right
  // after that -- always the very first chunk, always this shape.
  if (
    buf.length >= 24
    && buf.readUInt32BE(0) === 0x89504e47
    && buf.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: a sequence of 0xFF-prefixed markers. Walk them looking for a
  // Start-Of-Frame marker (0xC0-0xCF, excluding DHT/JPG/DAC at
  // 0xC4/0xC8/0xCC, which share the range but aren't SOF); its payload
  // carries height then width as big-endian uint16s. Standalone markers
  // (SOI, RST0-7, TEM) carry no length field and are skipped whole.
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 1 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      let marker = buf[offset + 1];
      while (marker === 0xff && offset + 2 < buf.length) {
        offset += 1;
        marker = buf[offset + 1];
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      if (offset + 4 > buf.length) break;
      const segmentLength = buf.readUInt16BE(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        if (offset + 9 > buf.length) break;
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      if (marker === 0xda) break; // start of scan -- no more headers follow
      offset += 2 + segmentLength;
    }
    return null;
  }

  return null;
}
