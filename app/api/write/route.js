import { NextResponse } from 'next/server';
import { writeSlide } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// No explicit duration was ever set here, leaving this on Vercel's
// ambiguous default -- callClaude's retries (see lib/claude.js) need
// headroom beyond a single fast call's worth of time.
export const maxDuration = 30;

// Stage 3. Called once per story so each request stays well under
// the Vercel timeout. The browser loops over the selected stories.
export async function POST(request) {
  try {
    const { topicSlug, story } = await request.json();
    const db = supabaseAdmin();

    const { data: topic, error: topicError } = await db
      .from('topics').select('id').eq('slug', topicSlug).single();
    if (topicError || !topic) {
      return NextResponse.json({ error: `Unknown topic: ${topicSlug}` }, { status: 404 });
    }

    // Give the writer recent approved headlines so phrasing stays
    // varied and the account keeps a consistent voice.
    const { data: recent } = await db
      .from('slides')
      .select('headline_parts, posts!inner(topic_id, status)')
      .eq('posts.topic_id', topic.id)
      .eq('posts.status', 'approved')
      .order('created_at', { ascending: false })
      .limit(12);

    const previousHeadlines = (recent || [])
      .map((r) => (r.headline_parts || []).map((p) => p.text).join(' '))
      .filter(Boolean);

    const copy = await writeSlide({ story, previousHeadlines });

    return NextResponse.json({
      slide: {
        headline_parts: copy.headline_parts,
        body: copy.body,
        image_url: story.imageUrl,
        source_name: story.sourceName,
        source_url: story.link,
        fingerprint: story.fingerprint,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
