import { supabaseAdmin } from './supabase.js';
import { getImageDimensions } from './imageDimensions.js';
import { MIN_USABLE_WIDTH } from './feeds.js';

// Brave's dedicated Image Search endpoint -- NOT the plain Web Search
// endpoint this used to call. The web/search endpoint only returns an
// "images" mixin when the account's plan/query enables it; on this
// account it came back empty essentially every time, so search silently
// fell straight through to plain web results (mostly pages with no
// image metadata at all) and from there to the AI fallback almost every
// run -- the opposite of the "prefer a real photo" goal this feature
// was built for. The dedicated endpoint returns actual image results
// directly, plus real width/height for most of them via `properties`.
//
// Not live-tested against the real API from this sandbox (no network
// egress to Brave from here -- see CLAUDE.md) -- confirmed against
// Brave's own docs and independent references, but worth watching the
// first real run against this to make sure `results`/`properties`/
// `thumbnail` come back shaped as expected.
const SEARCH_URL = 'https://api.search.brave.com/res/v1/images/search';
// Same public bucket AI-generated images use -- both are "we sourced
// this ourselves and need a stable URL to point a slide at", just from
// a different origin. See schema.sql for the bucket's storage policy.
const BUCKET = 'generated-images';

const MIN_BYTES = 8_000; // filters out tracking pixels and broken thumbnails
const MAX_BYTES = 15 * 1024 * 1024;

// Downloads one candidate image and sanity-checks it before we commit to
// re-hosting it -- including, now, its actual pixel width, not just its
// file size. A search result with no width metadata (or metadata we
// don't trust) could still be a tiny thumbnail; byte size alone doesn't
// catch that (a heavily-detailed small JPEG can easily clear MIN_BYTES).
// Returns null (never throws) so the caller can just try the next result
// -- a single bad URL shouldn't sink the search.
async function downloadCandidate(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SixYardBoxBot/1.0)' },
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) return null;

    // getImageDimensions() only recognizes JPEG/PNG -- an unrecognized
    // format (WebP, AVIF, ...) reads as null and is let through, same
    // "unknown, proceed cautiously" posture as a feed image with no
    // declared width. A *confirmed* too-small image is rejected outright.
    const dims = getImageDimensions(buf);
    if (dims && dims.width < MIN_USABLE_WIDTH) return null;

    return { buf, contentType: contentType.split(';')[0] };
  } catch {
    return null;
  }
}

async function upload(buf, contentType) {
  const ext = contentType.split('/')[1] || 'jpg';
  const path = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const db = supabaseAdmin();
  const { error } = await db.storage.from(BUCKET).upload(path, buf, {
    contentType,
    cacheControl: '31536000',
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
  return pub.publicUrl;
}

// These are real, copyrighted press photos with no license for this
// use -- a deliberate tradeoff the user accepted knowingly, same as the
// AI-generation tradeoffs documented in lib/images.js and the README.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

// One quick retry on a fast-failing rate limit or server error -- the
// 10s timeout below leaves plenty of room for this within /api/image-
// search's 30s budget, unlike a request that hangs to the timeout itself.
async function fetchBrave(url, { retried = false } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
  });

  if (!response.ok && !retried && RETRYABLE_STATUS.has(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return fetchBrave(url, { retried: true });
  }

  return response;
}

// Pulls the best download URL and any known width out of one Brave
// image result, tolerating a few different field names/nesting --
// cheap insurance against a schema detail (or endpoint) this wasn't
// verified live against turning out slightly different in practice.
//
// Exported for lib/imageSearch.test.js -- otherwise unused outside this file.
export function candidateFromResult(result) {
  const url = result.properties?.url || result.thumbnail?.src || result.image?.url || result.img;
  if (!url) return null;
  const width = Number(result.properties?.width) || Number(result.thumbnail?.width) || null;
  return { url, width };
}

// Searches Brave's Image Search API for `query`, downloads and re-hosts
// the first candidate that's actually usable, and returns its new public
// URL -- or null if nothing usable turned up. Never throws for "no
// results"; only throws for a genuine API failure (bad/missing
// credentials, quota exhausted, network error), so the caller can tell
// "nothing found" apart from "search is broken".
export async function searchStoryImage(query) {
  if (!query) return null;

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.warn('[imageSearch] BRAVE_SEARCH_API_KEY is not set');
    return null;
  }

  // Confirmed live (2026-08-18): the Image Search endpoint's safesearch
  // is a 2-value enum ("off"/"strict"), not the 3-value "off"/"moderate"/
  // "strict" the plain Web Search endpoint takes -- sending "moderate"
  // (carried over from the old endpoint) got a 422 "Unable to validate
  // request parameter(s)" on every real call, meaning search never
  // returned a single result no matter what. Just omit it and take the
  // documented default ("strict") rather than guess at a second value
  // this sandbox can't verify live either.
  const params = new URLSearchParams({
    q: query,
    count: '20',
  });

  const response = await fetchBrave(`${SEARCH_URL}?${params}`);

  if (!response.ok) {
    const detail = await response.text();
    console.error(`[imageSearch] Brave API ${response.status}: ${detail.slice(0, 200)}`);
    throw new Error(`Brave search ${response.status}: ${detail.slice(0, 300)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    const text = await response.text();
    console.error(`[imageSearch] Failed to parse Brave response as JSON: ${text.slice(0, 200)}`);
    throw new Error(`Brave returned non-JSON: ${text.slice(0, 100)}`);
  }

  // The dedicated Image Search endpoint returns `results` at the top
  // level; `images.results`/`web.results` are kept as a fallback in
  // case that assumption turns out wrong on a real call.
  const rawResults = data.results || data.images?.results || data.web?.results || [];
  const candidates = rawResults.map(candidateFromResult).filter(Boolean);

  console.log(`[imageSearch] "${query}": ${candidates.length} candidate images`);

  // Same tiered preference as lib/feeds.js's extractImage(): try a
  // candidate Brave already confirmed is big enough before one with no
  // width reported, so a verified-large photo further down the results
  // isn't skipped in favour of an earlier, unverified thumbnail. A
  // candidate Brave confirmed is too small is dropped outright rather
  // than attempted -- downloadCandidate() would just reject it anyway
  // (it re-checks real pixel dimensions after downloading regardless of
  // what the metadata claimed), so trying it first only wastes a
  // request against the 20 candidates available.
  const knownGood = candidates.filter((c) => c.width && c.width >= MIN_USABLE_WIDTH);
  const unknownSize = candidates.filter((c) => !c.width);

  for (const { url } of [...knownGood, ...unknownSize]) {
    const candidate = await downloadCandidate(url);
    if (candidate) return upload(candidate.buf, candidate.contentType);
  }

  console.log(`[imageSearch] "${query}": no usable images found`);
  return null;
}
