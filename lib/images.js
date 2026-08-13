import { supabaseAdmin } from './supabase';

const OPENAI_URL = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-1';
const BUCKET = 'generated-images';

// Cover, CTA, and any story slide that arrives with no usable photo all
// fall back to an AI-generated background instead of a black slide.
// Prompts stay generic on purpose: no named athletes, no club crests or
// sponsor logos, so nothing here trades on a real person's likeness or
// someone else's trademark -- just a photoreal football mood.
const PROMPTS = {
  cover: 'Photorealistic editorial sports photograph. A professional soccer '
    + 'player walking off a floodlit stadium pitch at night in the rain, '
    + 'dramatic silhouette lighting, stadium floodlights flaring in the '
    + 'background, crowd in soft focus, cinematic and moody, shallow depth '
    + 'of field, vertical composition. No text, no logos, no readable '
    + 'branding, no visible sponsor names, plain kit with no crest.',
  cta: 'Photorealistic close-up sports photograph of a soccer boot striking '
    + 'a ball on a floodlit night pitch, motion blur on the ball, dirt and '
    + 'grass particles flying, dramatic stadium lights in the background, '
    + 'cinematic and moody, vertical composition. No text, no logos, no '
    + 'readable branding, no visible sponsor names, plain kit with no crest.',
  fallback: [
    'Photorealistic editorial sports photograph. The silhouette of a '
      + 'soccer manager standing pitchside under floodlights at night, '
      + 'hands in coat pockets, rain in the air, crowd blurred in the '
      + 'stands behind, cinematic and moody, vertical composition. No '
      + 'text, no logos, no readable branding, no visible sponsor names.',
    'Photorealistic editorial sports photograph of an empty floodlit '
      + 'soccer stadium pitch at dusk, wet grass reflecting the stadium '
      + 'lights, dramatic sky, cinematic and moody, vertical composition. '
      + 'No text, no logos, no readable branding.',
    'Photorealistic sports photograph of a soccer player mid-sprint on a '
      + 'floodlit night pitch, motion blur, stadium lights flaring behind, '
      + 'cinematic and moody, vertical composition. No text, no logos, no '
      + 'readable branding, no visible sponsor names, plain kit with no '
      + 'crest.',
  ],
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Generates one image with OpenAI, uploads it to Supabase Storage (the
// OpenAI URL/base64 is not something we can point a DB column at
// long-term), and returns the public URL to store as a slide's image_url.
export async function generateSlideImage({ role }) {
  const prompt = role === 'cover' ? PROMPTS.cover
    : role === 'cta' ? PROMPTS.cta
    : pick(PROMPTS.fallback);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      size: '1024x1536',
      quality: 'medium',
      n: 1,
    }),
    signal: AbortSignal.timeout(55000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI image API ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI image API returned no image data');

  const bytes = Buffer.from(b64, 'base64');
  const path = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;

  const db = supabaseAdmin();
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
    contentType: 'image/png',
    cacheControl: '31536000',
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
  return pub.publicUrl;
}
