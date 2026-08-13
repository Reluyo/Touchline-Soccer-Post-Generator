'use client';

import { toPng } from 'html-to-image';

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

export async function captureSlide(node) {
  if (!node) throw new Error('captureSlide called without a node');

  await waitForFonts();
  await waitForImages(node);

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
