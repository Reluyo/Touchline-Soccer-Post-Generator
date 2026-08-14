import { supabaseAdmin } from './supabase';

const SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
// Same public bucket AI-generated images use -- both are "we sourced
// this ourselves and need a stable URL to point a slide at", just from
// a different origin. See schema.sql for the bucket's storage policy.
const BUCKET = 'generated-images';

const MIN_BYTES = 8_000; // filters out tracking pixels and broken thumbnails
const MAX_BYTES = 15 * 1024 * 1024;

// Downloads one candidate image and sanity-checks it before we commit to
// re-hosting it. Returns null (never throws) so the caller can just try
// the next search result -- a single bad URL shouldn't sink the search.
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

// Searches Brave Search API for relevant web content matching `query`,
// extracts image URLs from the results, downloads and re-hosts the first
// candidate that works, and returns its new public URL -- or null if nothing
// usable turned up. Never throws for "no results"; only throws for a genuine
// API failure (bad/missing credentials, quota exhausted, network error),
// so the caller can tell "nothing found" apart from "search is broken".
//
// These are real, copyrighted press photos with no license for this
// use -- a deliberate tradeoff the user accepted knowingly, same as the
// AI-generation tradeoffs documented in lib/images.js and the README.
export async function searchStoryImage(query) {
  if (!query) return null;

  const params = new URLSearchParams({
    q: query,
    count: '10',
    safesearch: 'moderate',
  });

  const response = await fetch(`${SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Brave search ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();

  // Log response structure for debugging (remove after verified working)
  if (!data.web?.results?.length && !data.images?.results?.length) {
    console.warn(`[imageSearch] Brave returned no results for "${query}":`, {
      hasWeb: !!data.web?.results?.length,
      hasImages: !!data.images?.results?.length,
      keys: Object.keys(data),
    });
  }

  const results = data.web?.results || [];
  const imageResults = data.images?.results || [];

  // Try image results first if available
  for (const img of imageResults) {
    if (!img.url) continue;
    console.log(`[imageSearch] Trying image result: ${img.url.slice(0, 50)}...`);
    const candidate = await downloadCandidate(img.url);
    if (candidate) return upload(candidate.buf, candidate.contentType);
  }

  // Fallback to web results (try to use any image metadata or og:image tags)
  for (const result of results) {
    // Some results may have an associated image
    if (result.image?.url) {
      console.log(`[imageSearch] Trying web result image: ${result.image.url.slice(0, 50)}...`);
      const candidate = await downloadCandidate(result.image.url);
      if (candidate) return upload(candidate.buf, candidate.contentType);
    }
  }

  console.log(`[imageSearch] Search found no usable images for "${query}"`);
  return null;
}
