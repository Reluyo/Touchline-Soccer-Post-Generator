import { NextResponse } from 'next/server';
import { fetchAllFeeds } from '@/lib/feeds';
import { filterItems, dedupe, removeSeen } from '@/lib/filter';
import { supabaseAdmin } from '@/lib/supabase';

// Stage 1 of a run. Fetches every feed in parallel, filters, dedupes,
// and drops anything already posted. Returns candidates to the browser,
// which passes them to /api/rank next.
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
    const fresh = removeSeen(deduped, (seen || []).map((s) => s.fingerprint));

    return NextResponse.json({
      topic: { id: topic.id, name: topic.name, wordmark: topic.wordmark, style: topic.style },
      candidates: fresh,
      stats: { fetched: items.length, afterFilter: filtered.length,
               afterDedupe: deduped.length, afterSeen: fresh.length },
      failedFeeds: failed,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
