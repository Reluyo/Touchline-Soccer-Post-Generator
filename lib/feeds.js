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
const MIN_USABLE_WIDTH = 400;

// BBC serves thumbnails at whatever width sits in the URL path; the
// Guardian's image CDN takes width as a "?width=" query param instead
// (RSS hands us a 140px thumbnail with no larger alternative offered,
// so upgrading the URL is the only way to get a usable size); WordPress
// (most of the rest of our feeds) appends "-WIDTHxHEIGHT" to a resized
// copy's filename, with the full-size original at the same path minus
// that suffix. Ask each for the largest render they offer.
function upgradeImageUrl(url) {
  if (!url) return null;
  if (url.includes('ichef.bbci.co.uk')) {
    return url.replace(/\/(?:ace\/)?standard\/\d+\//, '/news/1024/');
  }
  if (url.includes('i.guim.co.uk')) {
    return url.replace(/([?&])width=\d+/, '$1width=1900');
  }
  return url.replace(/-\d{2,4}x\d{2,4}(?=\.\w+(?:$|\?))/, '');
}

// Feeds disagree about where the image lives, and about whether they tell
// us how big it is. Collect every candidate with whatever size hint is
// available, then pick the first one that isn't known to be too small --
// silently accepting a tiny thumbnail just because it was the first
// candidate is how a blurry, upscaled photo ends up on a slide.
function extractImage(item) {
  const candidates = [];

  const thumb = item.mediaThumbnail?.$;
  if (thumb?.url) candidates.push({ url: thumb.url, width: Number(thumb.width) || null });

  const media = item.mediaContent?.$;
  if (media?.url) candidates.push({ url: media.url, width: Number(media.width) || null });

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

  const usable = candidates.find((c) => !c.width || c.width >= MIN_USABLE_WIDTH);
  const chosen = usable || candidates[0];
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
