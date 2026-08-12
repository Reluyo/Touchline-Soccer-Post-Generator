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

// BBC serves thumbnails at whatever width sits in the URL path.
// The feed gives us 240px, which is useless for a 1080px slide,
// so we rewrite the path to ask for the largest render they offer.
function upgradeImageUrl(url) {
  if (!url) return null;
  if (url.includes('ichef.bbci.co.uk')) {
    return url.replace(/\/(?:ace\/)?standard\/\d+\//, '/news/1024/');
  }
  return url;
}

// Feeds disagree about where the image lives. Check every place
// it might be, in rough order of quality.
function extractImage(item) {
  const thumb = item.mediaThumbnail?.$?.url;
  if (thumb) return upgradeImageUrl(thumb);

  const media = item.mediaContent?.$?.url;
  if (media) return upgradeImageUrl(media);

  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
    return upgradeImageUrl(item.enclosure.url);
  }

  // Last resort: first <img> inside the article HTML.
  const html = item.contentEncoded || item.content || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? upgradeImageUrl(match[1]) : null;
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

// Fetch every feed at the same time rather than one after another.
// Ten feeds sequentially at ~1s each would blow the Vercel timeout;
// in parallel the whole thing takes about as long as the slowest one.
export async function fetchAllFeeds(feeds) {
  const results = await Promise.all(feeds.map(fetchFeed));
  return {
    items: results.flatMap((r) => r.items),
    failed: results.filter((r) => !r.ok).map((r) => ({ source: r.source, error: r.error })),
  };
}
