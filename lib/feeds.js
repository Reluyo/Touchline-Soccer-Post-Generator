import Parser from 'rss-parser';

// The parser needs to be told about non-standard tags we care about.
// media:thumbnail is how BBC ships its images; enclosure is how most
// WordPress feeds do it.
const parser = new Parser({
  timeout: 8000,
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

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
// order -- landing a genuinely low-res image on a slide. A confirmed-
// small candidate is still skipped outright; an unconfirmed one is only
// used if nothing better exists, and the original priority order (feeds
// usually list their best photo first) still breaks ties within each tier.
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
  const chosen = knownGood || unknownSize || candidates[0];
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
export async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = (parsed.items || []).map((item) => ({
      title: stripHtml(item.title),
      summary: stripHtml(item.contentSnippet || item.content || '').slice(0, 400),
      link: item.link,
      publishedAt: item.isoDate || item.pubDate || null,
      imageUrl: extractImage(item),
      sourceName: feed.name,
      lang: feed.lang,
      league: feed.league,
    }));
    return { ok: true, source: feed.name, items };
  } catch (error) {
    return { ok: false, source: feed.name, items: [], error: String(error.message || error) };
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
