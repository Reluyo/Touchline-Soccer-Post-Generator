import { NextResponse } from 'next/server';
import { writeCaption } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// Save a finished draft into the review queue.
// Enforces the "keep at most 3 queued" rule by deleting the oldest.
export async function POST(request) {
  try {
    const { topicSlug, slides, kind = 'daily' } = await request.json();
    const db = supabaseAdmin();

    const { data: topic } = await db
      .from('topics').select('id, wordmark').eq('slug', topicSlug).single();

    const caption = await writeCaption({ slides, wordmark: topic.wordmark });

    const { data: post, error } = await db
      .from('posts')
      .insert({ topic_id: topic.id, status: 'queued', kind, caption })
      .select().single();
    if (error) throw error;

    const rows = slides.map((s, i) => ({
      post_id: post.id,
      position: i,
      role: s.role || (i === 0 ? 'cover' : 'story'),
      headline_parts: s.headline_parts,
      body: s.body,
      image_url: s.image_url,
      source_name: s.source_name,
      source_url: s.source_url,
      fingerprint: s.fingerprint || null,
    }));
    await db.from('slides').insert(rows);

    // Trim the queue to the three newest.
    const { data: queued } = await db
      .from('posts').select('id')
      .eq('topic_id', topic.id).eq('status', 'queued')
      .order('created_at', { ascending: false });

    const excess = (queued || []).slice(3).map((p) => p.id);
    if (excess.length) await db.from('posts').delete().in('id', excess);

    return NextResponse.json({ postId: post.id, caption });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

// List the queue and recent history for the dashboard.
export async function GET(request) {
  try {
    const slug = request.nextUrl.searchParams.get('topic') || 'soccer';
    const db = supabaseAdmin();

    const { data: topic } = await db
      .from('topics').select('*').eq('slug', slug).single();

    const { data: posts } = await db
      .from('posts')
      .select('*, slides(*)')
      .eq('topic_id', topic.id)
      .order('created_at', { ascending: false })
      .limit(8);

    const withSortedSlides = (posts || []).map((p) => ({
      ...p,
      slides: (p.slides || []).sort((a, b) => a.position - b.position),
    }));

    return NextResponse.json({
      topic,
      queue: withSortedSlides.filter((p) => p.status === 'queued'),
      history: withSortedSlides.filter((p) => p.status === 'approved').slice(0, 5),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

// Approve a post: mark it approved and record its stories as seen so
// they never come back in a future run.
export async function PATCH(request) {
  try {
    const { postId } = await request.json();
    const db = supabaseAdmin();

    const { data: post } = await db
      .from('posts').select('*, slides(*)').eq('id', postId).single();

    await db.from('posts')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', postId);

    // Record the STORY fingerprint (not the slide's own uuid) so a
    // future run can recognise the same story arriving from any outlet.
    // Cover and CTA slides have no fingerprint and are skipped.
    const seen = (post.slides || [])
      .filter((s) => s.fingerprint)
      .map((s) => ({
        topic_id: post.topic_id,
        fingerprint: s.fingerprint,
        headline: (s.headline_parts || []).map((p) => p.text).join(' '),
      }));
    if (seen.length) {
      await db.from('seen_stories').upsert(seen, { onConflict: 'topic_id,fingerprint' });
    }

    // Keep only the five most recent approved posts.
    const { data: approved } = await db
      .from('posts').select('id')
      .eq('topic_id', post.topic_id).eq('status', 'approved')
      .order('approved_at', { ascending: false });
    const excess = (approved || []).slice(5).map((p) => p.id);
    if (excess.length) await db.from('posts').delete().in('id', excess);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
