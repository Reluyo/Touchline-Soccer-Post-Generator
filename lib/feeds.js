import Parser from 'rss-parser';

// rss-parser's own default User-Agent is the literal string
// "rss-parser" -- about as obvious a scraper signature as exists, and
// exactly the kind of thing WordPress bot-protection (Wordfence,
// Cloudflare, etc.) tends to challenge or block outright. Seen in
// production as two previously-working WordPress feeds (Get French
// Football News, Get Italian Football News) both failing the same
// session -- "not recognized as RSS 1 or 2" is consistent with getting
// back a challenge/interstitial HTML page instead of the real feed, not
// a genuinely broken feed. A realistic browser UA can only help here;
// it can't break a feed that was already working with the default one.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The parser needs to be told about non-standard tags we care about.
// media:thumbnail is how BBC ships its images; enclosure is how most
// WordPress feeds do it.
const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': USER_AGENT },
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

// A bare "&" that isn't part of a real entity reference (&amp; &lt; etc,
// or a numeric &#123;/&#x1F;) is invalid XML but a common real-world feed
// bug -- seen in production as "Invalid character in entity name" on a
// feed that was working the same week. Escaping it is a safe, narrow
// repair: a genuinely well-formed entity is left untouched (the
// negative lookahead), and this can only turn an unparseable feed into
// a parseable one, never the reverse.
//
// Exported for lib/feeds.test.js -- otherwise unused outside this file.
export function escapeBareAmpersands(xml) {
  return xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
}

// A slide is 1080px wide. Anything the feed hands us below this is going
// to look visibly soft once stretched to full width -- better to fall
// through to the next candidate (or no image at all) than post a blurry one.
// Exported for lib/feeds.test.js -- otherwise unused outside this file.
export const MIN_USABLE_WIDTH = 400;

// BBC serves thumbnails at whatever width sits in the URL path; WordPress
// (most of the rest of our feeds) appends "-WIDTHxHEIGHT" to a resized
// copy's filename, with the full-size original at the same path minus
// that suffix. Ask each for the largest render they offer.
//
// The Guardian USED to get the same treatment (its CDN takes width as a
// "?width=" query param), but that param sits alongside a trailing
// "&s=<hash>" that's almost certainly a signature over the original
// request -- rewriting width while leaving that hash untouched produces
// a URL whose signature no longer matches, and the Guardian's CDN
// appears to reject it outright rather than just re-deriving a new
// image at the requested size. In production this meant every single
// Guardian-sourced slide silently rendered with no photo at all (a
// black background -- see Slide.jsx's onerror fallback, added at the
// same time as this fix, for what happens when any host does this for
// any reason). Left alone, the un-upgraded URL's signature stays valid
// and the (smaller, feed-default) photo actually loads -- a real photo
// at a lower resolution beats a guaranteed-blank slide.
function upgradeImageUrl(url) {
  if (!url) return null;
  if (url.includes('ichef.bbci.co.uk')) {
    return url.replace(/\/(?:ace\/)?standard\/\d+\//, '/news/1024/');
  }
  return url.replace(/-\d{2,4}x\d{2,4}(?=\.\w+(?:$|\?))/, '');
}

// Feeds disagree about where the image lives, and about whether they tell
// us how big it is. Collect every candidate with whatever size hint is
// available, then prefer one a feed actually confirmed is big enough
// over one with no size hint at all -- an earlier version picked the
// first candidate that merely *wasn't confirmed too small*, which treats
// "no width reported" as a green light. In production this meant a
// candidate with no width metadata (frequently the enclosure or the
// last-resort HTML <img>) got used ahead of a later, verified-large
// media:content candidate purely because it came first in priority
// order -- landing a genuinely low-res image on a slide. The original
// priority order (feeds usually list their best photo first) still
// breaks ties within each tier.
//
// A candidate every source confirmed is too small is no longer used at
// all -- returning null here (same as "this item has no photo") lets
// the caller try a real web image search instead of a feed thumbnail
// it already knows is too small to look good stretched to 1080px. Seen
// in production: a Guardian item whose only candidate was a
// feed-declared 140px thumbnail (Guardian URLs are deliberately never
// upgraded -- see upgradeImageUrl() above -- so this is the only size
// the feed ever offers) landed on a slide instead of a real search
// result or the branded gradient.
//
// Exported for lib/feeds.test.js -- otherwise unused outside this file.
export function extractImage(item) {
  const candidates = [];

  const thumb = item.mediaThumbnail?.$;
  if (thumb?.url) candidates.push({ url: thumb.url, width: Number(thumb.width) || null });

  // media:content isn't always a photo -- AS.com's feed uses it for
  // video clips too (medium="video"), with the actual still image
  // nested inside as a child <media:thumbnail> the parser doesn't
  // surface at the item level. Grabbing the video URL here would silently
  // fail later: a .mp4 doesn't render via CSS background-image, so the
  // slide would just come out blank with no error anywhere.
  const media = item.mediaContent?.$;
  if (media?.url && media.medium !== 'video') {
    candidates.push({ url: media.url, width: Number(media.width) || null });
  }

  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
    candidates.push({ url: item.enclosure.url, width: null });
  }

  // Last resort: first <img> inside the article HTML. This is the
  // fallback most likely to grab something that isn't the article's own
  // photo -- a site-wide ad banner or a related-posts thumbnail embedded
  // in the same content field -- so it's tried last and has no size hint.
  const html = item.contentEncoded || item.content || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) candidates.push({ url: match[1], width: null });

  const knownGood = candidates.find((c) => c.width && c.width >= MIN_USABLE_WIDTH);
  const unknownSize = candidates.find((c) => !c.width);
  const chosen = knownGood || unknownSize;
  return chosen ? upgradeImageUrl(chosen.url) : null;
}

function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch one feed. Never throws — a dead feed shouldn't kill the run,
// it should just contribute nothing and report why.
function itemsFromParsed(parsed, feed) {
  return (parsed.items || []).map((item) => ({
    title: stripHtml(item.title),
    summary: stripHtml(item.contentSnippet || item.content || '').slice(0, 400),
    link: item.link,
    publishedAt: item.isoDate || item.pubDate || null,
    imageUrl: extractImage(item),
    sourceName: feed.name,
    lang: feed.lang,
    league: feed.league,
  }));
}

export async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return { ok: true, source: feed.name, items: itemsFromParsed(parsed, feed) };
  } catch (error) {
    // One retry: re-fetch the raw XML ourselves and repair a bare "&"
    // before parsing. Doesn't distinguish parse failures from a plain
    // HTTP/timeout error first time round -- a genuine HTTP failure just
    // fails the same way again here too, which is harmless, only a
    // wasted second request. Report the ORIGINAL error if this fails as
    // well -- it's almost always the more informative one (e.g. "not
    // recognized as RSS 1 or 2" says more than whatever this retry's
    // own fetch produces for the same broken response).
    try {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) throw error;
      const raw = await response.text();
      const parsed = await parser.parseString(escapeBareAmpersands(raw));
      return { ok: true, source: feed.name, items: itemsFromParsed(parsed, feed) };
    } catch {
      return { ok: false, source: feed.name, items: [], error: String(error.message || error) };
    }
  }
}

// A real article photo essentially never repeats verbatim across two
// unrelated stories. When the same image URL turns up on multiple items,
// it's almost always a shared promo banner, section logo, or ad that our
// html-fallback in extractImage grabbed instead of the actual photo --
// strip it from every item that has it rather than let two different
// slides end up wearing the same picture.
function dropSharedImages(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item.imageUrl) continue;
    counts.set(item.imageUrl, (counts.get(item.imageUrl) || 0) + 1);
  }
  return items.map((item) => (
    item.imageUrl && counts.get(item.imageUrl) > 1
      ? { ...item, imageUrl: null }
      : item
  ));
}

// Fetch every feed at the same time rather than one after another.
// Ten feeds sequentially at ~1s each would blow the Vercel timeout;
// in parallel the whole thing takes about as long as the slowest one.
export async function fetchAllFeeds(feeds) {
  const results = await Promise.all(feeds.map(fetchFeed));
  return {
    items: dropSharedImages(results.flatMap((r) => r.items)),
    failed: results.filter((r) => !r.ok).map((r) => ({ source: r.source, error: r.error })),
  };
}
