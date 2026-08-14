import { NextResponse } from 'next/server';
import { searchStoryImage } from '@/lib/imageSearch';

// Downloading and re-uploading a candidate image can take a few seconds
// past a plain API call, same reasoning as /api/image.
export const maxDuration = 30;

// Called once per story slide that arrives with no feed photo, before
// falling back to AI generation. `image_url` is null (not an error) when
// the search ran fine but nothing usable turned up -- the browser treats
// that the same as a failure and moves on to /api/image.
export async function POST(request) {
  try {
    const { query } = await request.json();
    const image_url = await searchStoryImage(query);
    return NextResponse.json({ image_url });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
