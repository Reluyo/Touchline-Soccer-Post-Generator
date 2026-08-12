import crypto from 'crypto';

// Never post these, no matter what else the headline mentions.
// A quiz about the Premier League is still a quiz.
const HARD_EXCLUDE = [
  'women', 'wsl', 'u21', 'u20', 'under-20', 'under-21', 'youth cup',
  'podcast', 'quiz', 'guess the', 'who am i', 'vote for', 'football daily',
  'live text', 'watch:', 'highlights:', 'best moments', 'ask me anything',
];

// Off-topic competitions. Dropped unless the headline also mentions
// something from the big-five list, which catches cases like
// "Bayern target Championship striker".
const SOFT_EXCLUDE = [
  'championship', 'league one', 'league two', 'efl',
  'scottish', 'celtic', 'rangers', 'hibernian', 'hearts', 'dundee',
  'mls', 'saudi pro league', 'a-league', 'eredivisie',
];

const BIG_FIVE = [
  'premier league', 'la liga', 'laliga', 'serie a', 'bundesliga', 'ligue 1',
  'champions league', 'europa league', 'transfer', 'signing', 'signs',
  'arsenal', 'chelsea', 'liverpool', 'manchester', 'tottenham', 'newcastle',
  'aston villa', 'everton', 'west ham', 'crystal palace', 'nottingham forest',
  'real madrid', 'barcelona', 'atletico', 'sevilla', 'valencia', 'betis',
  'juventus', 'inter', 'milan', 'napoli', 'roma', 'lazio', 'atalanta',
  'bayern', 'dortmund', 'leverkusen', 'leipzig', 'frankfurt',
  'psg', 'paris saint-germain', 'marseille', 'monaco', 'lyon', 'lille',
];

function hasAny(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'for', 'of', 'in', 'on', 'at',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'with', 'from', 'by',
  'over', 'after', 'before', 'his', 'her', 'their', 'its', 'it', 'he', 'she',
  'say', 'said', 'could', 'would', 'will', 'set', 'new', 'up', 'out',
  'that', 'this', 'who', 'what', 'how', 'why', 'can', 'do', 'doe', 'not',
]);

// Crude stemmer. We only need "signs" and "sign" to collide --
// a real stemmer would be overkill and slower.
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[\u2018\u2019']/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(stem)
      .filter((w) => !STOPWORDS.has(w))
  );
}

// Overlap coefficient rather than Jaccard: shared words divided by the
// SMALLER set. Two headlines about one story often differ a lot in
// length, and Jaccard penalises that unfairly -- a short headline can
// never score highly against a long one even when fully contained.
function overlap(a, b) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const smaller = Math.min(a.size, b.size);
  return { score: smaller === 0 ? 0 : shared / smaller, shared };
}

export function fingerprint(title) {
  const sorted = [...tokenize(title)].sort().join(' ');
  return crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 16);
}

export function filterItems(items, { maxAgeHours = 36 } = {}) {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  return items.filter((item) => {
    if (!item.title || !item.link) return false;

    if (item.publishedAt) {
      const published = new Date(item.publishedAt).getTime();
      if (Number.isFinite(published) && published < cutoff) return false;
    }

    const haystack = `${item.title} ${item.summary}`;

    // Hard excludes win over everything.
    if (hasAny(haystack, HARD_EXCLUDE)) return false;

    const onTopic = hasAny(haystack, BIG_FIVE);
    if (hasAny(haystack, SOFT_EXCLUDE) && !onTopic) return false;

    return true;
  });
}

// Cluster the same story reported by several outlets.
// Requires both a high overlap ratio AND at least two shared words,
// so two short unrelated headlines cannot accidentally merge.
export function dedupe(items, { threshold = 0.45, minShared = 2 } = {}) {
  const ranked = [...items].sort((a, b) => {
    if (!!b.imageUrl !== !!a.imageUrl) return b.imageUrl ? 1 : -1;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });

  const clusters = [];

  for (const item of ranked) {
    const tokens = tokenize(item.title);

    const match = clusters.find((c) => {
      const { score, shared } = overlap(c.tokens, tokens);
      return score >= threshold && shared >= minShared;
    });

    if (match) {
      match.alsoReportedBy.push(item.sourceName);
      if (!match.item.imageUrl && item.imageUrl) match.item.imageUrl = item.imageUrl;
    } else {
      clusters.push({ tokens, item, alsoReportedBy: [] });
    }
  }

  return clusters.map((c) => ({
    ...c.item,
    fingerprint: fingerprint(c.item.title),
    alsoReportedBy: c.alsoReportedBy,
  }));
}

export function removeSeen(items, seenFingerprints) {
  const seen = new Set(seenFingerprints);
  return items.filter((item) => !seen.has(item.fingerprint));
}
