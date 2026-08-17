import { NextResponse } from 'next/server';
import { fetchAllFeeds } from '@/lib/feeds';
import { filterItems, dedupe, removeSeen } from '@/lib/filter';
import { translateCandidates, rankStories } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// Ranking the full week's pool (potentially a few hundred stories) is
// slower than a plain fetch -- translation batches + Claude ranking can
// easily exceed 60s on busy news days. 120s gives enough headroom.
export const maxDuration = 120;

// Look back a full week, not just a day -- a freshness-only sort was
// burying real stories under whatever happened to break in the last few
// hours. Ranking (below) is what keeps a week's worth of volume useful
// rather than overwhelming.
const MAX_AGE_HOURS = 24 * 7;

// Candidates feed the picker screen, not an automatic ranker -- the user
// still picks manually. This just caps how many of the (now much larger)
// weekly pool are worth showing.
const MAX_CANDIDATES = 100;

// Stage 1 of a run. Fetches every feed in parallel, filters, dedupes,
// drops anything already posted, then ranks what's left by newsworthiness
// so the picker's top of the list is the best of the week, not just the
// most recent. Returns candidates to the browser for manual selection.
export async function POST(request) {
  try {
    const { topicSlug } = await request.json();
    const db = supabaseAdmin();

    const { data: topic, error } = await db
      .from('topics').select('*').eq('slug', topicSlug).single();
    if (error || !topic) {
      return NextResponse.json({ error: `Unknown topic: ${topicSlug}` }, { status: 404 });
    }

    const { items, failed } = await fetchAllFeeds(topic.feeds);

    const { data: seen } = await db
      .from('seen_stories').select('fingerprint').eq('topic_id', topic.id);

    const filtered = filterItems(items, { maxAgeHours: MAX_AGE_HOURS });
    const deduped = dedupe(filtered);
    const fresh = removeSeen(deduped, (seen || []).map((s) => s.fingerprint));

    // Never let a ranking failure kill the whole run -- fall back to a
    // plain freshest-first sort so the picker still loads with something.
    let ranked;
    try {
      ranked = await rankStories({
        stories: fresh,
        rankingRules: topic.ranking_rules,
        wanted: MAX_CANDIDATES,
      });
    } catch {
      ranked = [...fresh]
        .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
        .slice(0, MAX_CANDIDATES);
    }

    // The picker shows title/summary as-is (no per-story AI polish, to
    // keep this cheap) -- but an untranslated German or French snippet
    // isn't something you can actually skim and pick from. One batched
    // call over just the non-English candidates fixes that without
    // paying for 100 individual translations.
    const nonEnglish = ranked.filter((c) => c.lang && c.lang !== 'en');
    const translated = nonEnglish.length ? await translateCandidates(nonEnglish) : [];
    const byOriginal = new Map(nonEnglish.map((c, i) => [c, translated[i]]));
    const localized = ranked.map((c) => byOriginal.get(c) || c);

    // Last-mile guard: the picker keys each candidate by its fingerprint
    // (app/page.jsx's candidateKey), so two candidates that ever ended up
    // sharing one -- rankStories() repeating an index was one real,
    // shipped way this happened -- silently select and build together
    // when only one card is clicked. Cheap to double-check here rather
    // than trust every upstream step got uniqueness right.
    const seenFingerprints = new Set();
    const candidates = localized.filter((c) => {
      if (seenFingerprints.has(c.fingerprint)) return false;
      seenFingerprints.add(c.fingerprint);
      return true;
    });

    return NextResponse.json({
      topic: { id: topic.id, name: topic.name, wordmark: topic.wordmark, style: topic.style },
      candidates,
      stats: { fetched: items.length, afterFilter: filtered.length,
               afterDedupe: deduped.length, afterSeen: fresh.length,
               afterRank: ranked.length },
      failedFeeds: failed,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
