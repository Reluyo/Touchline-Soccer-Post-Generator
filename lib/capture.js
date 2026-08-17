'use client';

import { toPng, getFontEmbedCSS } from 'html-to-image';

// WHY html-to-image AND NOT html2canvas
// -----------------------------------------------------------------
// html2canvas does not implement `background-clip: text`. Our accent
// words are gradient-filled text, and html2canvas renders them as
// solid filled rectangles -- the headline becomes unreadable blocks.
// html-to-image reproduces the template essentially exactly.
// This was measured, not assumed. Do not swap the library.

// Fonts load over the network. If we capture before they arrive the
// slide renders in a fallback face and every PNG comes out wrong.
// document.fonts.ready resolves once all @font-face loads settle.
async function waitForFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await document.fonts.ready;
  // Belt and braces: ask explicitly for the two faces we depend on,
  // because `ready` only covers fonts the browser has decided to load.
  try {
    await Promise.all([
      document.fonts.load('400 104px Anton'),
      document.fonts.load('700 37px "Barlow Condensed"'),
    ]);
  } catch {
    // A failed load shouldn't abort the run; the fallback still renders.
  }
}

// Images set via CSS background-image must also be decoded before
// capture, otherwise the photo area comes out blank.
async function waitForImages(node) {
  const urls = [];
  const walk = (el) => {
    const bg = getComputedStyle(el).backgroundImage;
    const match = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (match) urls.push(match[1]);
    for (const child of el.children) walk(child);
  };
  walk(node);

  await Promise.all(
    urls.map(
      (url) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve; // resolve anyway; a missing photo is not fatal
          img.src = url;
        })
    )
  );
}

// document.fonts.ready (in waitForFonts above) only guarantees the font is
// loaded for the LIVE page -- html-to-image renders by serializing the DOM
// into an SVG <foreignObject> and rasterizing that separately, which does
// not automatically inherit the page's own loaded @font-face rules. Its
// built-in auto-discovery is supposed to find and inline them anyway, but
// in production this silently failed for Anton/Barlow Condensed: every
// exported PNG (correctly) showed the right words in the wrong, much wider
// fallback font, and a 3-line headline sized for Anton's narrow letterforms
// visually collided with the body text below it as a result.
// getFontEmbedCSS() pre-fetches and inlines the actual font files as base64
// once, up front, so toPng() doesn't depend on that auto-discovery at all.
// Computed once and reused for every slide in a run -- the fonts are the
// same for all of them, no reason to redo this per slide.
let cachedFontEmbedCSS = null;

async function fontEmbedCSSFor(node) {
  if (cachedFontEmbedCSS != null) return cachedFontEmbedCSS;
  try {
    // Racing against a timeout, not just try/catch, on purpose: a slow or
    // unreachable Google Fonts CDN doesn't reject fast, it just hangs --
    // discovered testing this fix, where a fully-blocked font host stalled
    // the fetch indefinitely rather than failing. Without this race, that
    // turns into "Download all slides" stuck on "Rendering slide 1 of N…"
    // forever, with no error and no way out short of reloading the page.
    cachedFontEmbedCSS = await Promise.race([
      getFontEmbedCSS(node),
      new Promise((_, reject) => setTimeout(() => reject(new Error('font embed timeout')), 4000)),
    ]);
    return cachedFontEmbedCSS;
  } catch {
    // toPng()'s own fontEmbedCSS option is checked with `!= null`, so an
    // empty string (unlike undefined) tells it "don't bother trying your
    // own internal font discovery either" -- that internal discovery is
    // exactly what hangs. Cache the empty string too: if the CDN is
    // unreachable once this run, it's not coming back for the next slide.
    cachedFontEmbedCSS = '';
    return cachedFontEmbedCSS;
  }
}

export async function captureSlide(node) {
  if (!node) throw new Error('captureSlide called without a node');

  await waitForFonts();
  await waitForImages(node);
  const fontEmbedCSS = await fontEmbedCSSFor(node);

  return toPng(node, {
    width: 1080,
    height: 1350,
    pixelRatio: 1,
    // true appends a cache-busting query string when html-to-image
    // fetches each image to embed it. Without this, downloading a
    // whole carousel in one sequence could end up embedding whichever
    // photo it cached earliest in the run on multiple later slides --
    // each slide's on-screen preview was always correct (a live <img>,
    // not subject to this cache), only the exported PNG was wrong.
    cacheBust: true,
    fontEmbedCSS,
    // The node is transform-scaled for on-screen preview. Cancel that
    // out so the PNG comes back at full resolution.
    style: { transform: 'none', transformOrigin: 'top left' },
  });
}

export async function captureAll(nodes, onProgress) {
  const results = [];
  for (let i = 0; i < nodes.length; i += 1) {
    onProgress?.(i, nodes.length);
    results.push(await captureSlide(nodes[i]));
  }
  return results;
}

// Turn a data URL into a file the browser downloads.
export function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
