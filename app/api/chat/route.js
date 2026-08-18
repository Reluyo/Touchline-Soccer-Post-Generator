import { NextResponse } from 'next/server';
import { editChat } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';
import { searchStoryImage, rehostImageUrl } from '@/lib/imageSearch';

// See app/api/write/route.js -- same reasoning, callClaude's retries
// need headroom beyond Vercel's ambiguous default. A little more
// headroom than that route since an image action here can also spend a
// few seconds downloading/re-hosting a photo, same budget as
// /api/image-search's own maxDuration for the same kind of work.
export const maxDuration = 30;

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

    let result = await editChat({ slide, history, message });

    // Only write to the database for an action that actually changes
    // something. An "ask" turn (from editChat() itself, or from a
    // failed image_url/image_search below) is just a question back to
    // you -- nothing to persist.
    if (result.action === 'update') {
      await db.from('slides').update({
        headline_parts: result.headline_parts ?? slide.headline_parts,
        body: result.body ?? slide.body,
      }).eq('id', slideId);
    } else if (result.action === 'image_url') {
      // A URL you pasted yourself -- re-host it (same as a search
      // result) rather than store the raw external URL directly, so it
      // survives the source disappearing and isn't blocked by
      // /api/image-proxy's host allowlist.
      const newUrl = await rehostImageUrl(result.url);
      result = newUrl
        ? { action: 'image_url', image_url: newUrl, note: result.note || 'Updated the photo.' }
        : { action: 'ask', question: "That URL doesn't look like a usable image (or it wouldn't download) — got a different one?" };
    } else if (result.action === 'image_search') {
      const newUrl = await searchStoryImage(result.query);
      result = newUrl
        ? { action: 'image_search', image_url: newUrl, note: result.note || `Found a new photo (searched "${result.query}").` }
        : { action: 'ask', question: `Couldn't find a usable photo for "${result.query}" — try different search terms?` };
    }

    // Any successful image action also clears image_urls -- otherwise a
    // cover slide's collage would keep rendering over the new single
    // photo (see Slide.jsx: collageUrls wins whenever it has 2+ entries).
    if (result.image_url) {
      await db.from('slides').update({ image_url: result.image_url, image_urls: [] }).eq('id', slideId);
    }

    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
