import { NextResponse } from 'next/server';
import { editChat } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

// The edit conversation for one slide. History comes from the browser
// so nothing extra needs storing -- it is discarded once you approve.
export async function POST(request) {
  try {
    const { slideId, history = [], message } = await request.json();
    const db = supabaseAdmin();

    const { data: slide, error } = await db
      .from('slides').select('*').eq('id', slideId).single();
    if (error || !slide) {
      return NextResponse.json({ error: 'Slide not found' }, { status: 404 });
    }

    const result = await editChat({ slide, history, message });

    // Only write to the database when the model actually made an edit.
    // An "ask" turn is just a question back to you.
    if (result.action === 'update') {
      await db.from('slides').update({
        headline_parts: result.headline_parts ?? slide.headline_parts,
        body: result.body ?? slide.body,
      }).eq('id', slideId);
    }

    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
