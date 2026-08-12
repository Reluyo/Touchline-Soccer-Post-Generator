import { NextResponse } from 'next/server';
import { rankStories } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// Stage 2. One Claude call over the surviving candidates.
export async function POST(request) {
  try {
    const { topicSlug, candidates, wanted = 7 } = await request.json();
    const db = supabaseAdmin();

    const { data: topic } = await db
      .from('topics').select('ranking_rules').eq('slug', topicSlug).single();

    const selected = await rankStories({
      stories: candidates,
      rankingRules: topic?.ranking_rules || '',
      wanted,
    });

    return NextResponse.json({ selected });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
