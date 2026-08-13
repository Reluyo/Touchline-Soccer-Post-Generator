import { NextResponse } from 'next/server';
import { fetchAllFeeds } from '@/lib/feeds';
import { filterItems, dedupe, removeSeen } from '@/lib/filter';
import { translateCandidates } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// Candidates feed the picker screen, not an automatic ranker -- cap it
// well above what anyone would actually pick so the list stays
// readable, freshest first.
const MAX_CANDIDATES = 50;

// Stage 1 of a run. Fetches every feed in parallel, filters, dedupes,
// and drops anything already posted. Returns candidates to the browser
// for manual selection.
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

    const filtered = filterItems(items);
    const deduped = dedupe(filtered);
    const fresh = removeSeen(deduped, (seen || []).map((s) => s.fingerprint))
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, MAX_CANDIDATES);

    // The picker shows title/summary as-is (no per-story AI polish, to
    // keep this cheap) -- but an untranslated German or French snippet
    // isn't something you can actually skim and pick from. One batched
    // call over just the non-English candidates fixes that without
    // paying for 50 individual translations.
    const nonEnglish = fresh.filter((c) => c.lang && c.lang !== 'en');
    const translated = nonEnglish.length ? await translateCandidates(nonEnglish) : [];
    const byOriginal = new Map(nonEnglish.map((c, i) => [c, translated[i]]));
    const localized = fresh.map((c) => byOriginal.get(c) || c);

    return NextResponse.json({
      topic: { id: topic.id, name: topic.name, wordmark: topic.wordmark, style: topic.style },
      candidates: localized,
      stats: { fetched: items.length, afterFilter: filtered.length,
               afterDedupe: deduped.length, afterSeen: fresh.length },
      failedFeeds: failed,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
