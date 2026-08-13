import { supabaseAdmin } from './supabase';

const OPENAI_URL = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-1';
const BUCKET = 'generated-images';

// Cover, CTA, and any story slide that arrives with no usable photo all
// fall back to an AI-generated image instead of a black slide. Prompts
// deliberately name the real players, clubs, kits, crests, and sponsor
// branding involved, so the model attempts a photoreal likeness rather
// than a generic stand-in -- see README for the tradeoffs of prompting
// this directly (publicity rights, trademarks, OpenAI's own policy on
// real people and brand logos, which may refuse or alter these prompts).
const STYLE = 'Photorealistic editorial sports photography, dramatic '
  + 'floodlit stadium lighting at night, cinematic and moody, shallow '
  + 'depth of field, vertical portrait composition. No added text or '
  + 'graphic overlays.';

function storyPrompt(context) {
  return `${STYLE} The photograph illustrates this football story: `
    + `"${context}". Depict the real players, clubs, kits, crests, and `
    + 'sponsor branding involved, rendered as accurately and '
    + 'realistically as possible.';
}

const CTA_PROMPT = `${STYLE} Close-up of a soccer boot striking a match `
  + 'ball, motion blur, dirt and grass particles flying. Use real, '
  + 'recognizable football boot and match-ball branding.';

const FALLBACK_PROMPT = `${STYLE} A professional soccer match in `
  + 'progress on a floodlit pitch. Real club kits, crests, and sponsor '
  + 'branding visible on the players.';

// Generates one image with OpenAI, uploads it to Supabase Storage (the
// OpenAI URL/base64 is not something we can point a DB column at
// long-term), and returns the public URL to store as a slide's image_url.
//
// `context` is the headline + body of the story the image should
// illustrate -- used for the cover (the lead story) and any story slide
// generating a fallback. The CTA has no single story to tie to, so it
// always uses the generic prompt.
export async function generateSlideImage({ role, context }) {
  const prompt = role === 'cta'
    ? CTA_PROMPT
    : context ? storyPrompt(context) : FALLBACK_PROMPT;

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
