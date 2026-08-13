import { NextResponse } from 'next/server';
import { generateSlideImage } from '@/lib/images';

// Image generation runs long (10-30s+), well past Vercel's 10s default,
// so this route needs the extended duration explicitly.
export const maxDuration = 60;

// Called once per image needed: the cover, the CTA, or a story slide
// whose feed item had no usable photo. One call per image keeps this
// consistent with the rest of the run -- see /api/write.
export async function POST(request) {
  try {
    const { role } = await request.json();
    const image_url = await generateSlideImage({ role });
    return NextResponse.json({ image_url });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
