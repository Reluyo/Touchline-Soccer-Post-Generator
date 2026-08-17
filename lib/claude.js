const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

// 429 (rate limit), 500/502/503 (transient server-side), and 529
// (Anthropic's own "overloaded") are worth a quick retry -- a 400 (bad
// request) or 401 (bad key) will fail identically every time, so
// retrying those would just delay the same error.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [400, 1200]; // between attempts 1->2 and 2->3

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every call goes through here so retries and error handling live in
// one place. Never called from the browser -- the key must stay server-side.
//
// The comment above used to say retries "live in one place" while there
// weren't actually any -- a single transient blip on any Claude call
// (rank, write, caption, chat, translate) used to abort whatever it was
// part of, discarding any spend already committed earlier in that run.
// Kept intentionally light (2 short, capped retries) since several
// callers run inside a per-story loop with no serverless timeout to
// spare for a slow backoff.
async function callClaude({ system, messages, maxTokens = 2000 }) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // Adaptive thinking is Sonnet 5's default and disabling it outright
        // makes the model prone to leaking stray content after the JSON it
        // was told to output. Keep thinking on but cheap instead -- low
        // effort barely uses the budget and avoids both failure modes.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system,
        messages,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    }

    const detail = await response.text();
    lastError = new Error(`Claude API ${response.status}: ${detail.slice(0, 300)}`);

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }

  throw lastError;
}

// Finds the first balanced top-level {...} or [...] in text and returns
// its substring, ignoring anything before or after it (stray prose,
// leaked tags, a second JSON value). A greedy regex can't do this
// correctly -- it grabs everything up to the LAST bracket in the text,
// which breaks the moment trailing content contains one of its own.
function extractJsonSubstring(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  const stack = [];
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Models sometimes wrap JSON in markdown fences, add stray content
// before/after it, leave a trailing comma before a closing bracket, drop
// the quotes around a property name, drop the comma between two
// properties, drop a property name entirely (seen in production as
// {"text":"Leao",true} instead of {"text":"Leao","key":true}), or use
// Python's True/False/None instead of JSON's true/false/null -- all
// despite instructions. Clean up all of those, then fall back to
// extracting the first balanced JSON value rather than failing the run.
// If it's still invalid, throw the parser's own reason plus a snippet of
// what it choked on -- a bare native error here otherwise gives no clue
// which of several JSON-producing calls (rank, write, chat) failed or why.
//
// Deliberately NOT handled: single-quoted strings, an unescaped quote
// or newline inside a string value. Each of those needs to know where a
// string is actually meant to start/end to fix safely, which a
// find-and-replace can't determine without risking corruption of
// legitimate content (an apostrophe, a quoted remark, a real line
// break) -- better to fail with a clear error than guess wrong.
//
// Exported for lib/claude.test.js -- otherwise unused outside this file.
export function parseJson(text) {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/"(\s+)"([^"]+)":/g, '",$1"$2":')
    .replace(/([:,[]\s*)(True|False|None)(\s*[,\]}])/g, (m, pre, lit, post) => (
      `${pre}${lit === 'None' ? 'null' : lit.toLowerCase()}${post}`
    ))
    // A bare true/false/null straight after a string value, with no
    // property name in between, is never valid JSON inside an object --
    // the only place this app's own schemas put a lone boolean next to a
    // string is headline_parts' "key" flag, so a dropped property name
    // can only mean "key" was omitted. Restrict to right after a quoted
    // string (not any comma) so this can't misfire inside a plain array.
    .replace(/("(?:[^"\\]|\\.)*")\s*,\s*(true|false|null)\b/g, '$1,"key":$2')
    // Remove trailing method calls Claude sometimes adds: .map(...), .filter(...), etc
    .replace(/(\]|\})\s*\.\s*[a-z_$][a-z0-9_$]*\s*\([^)]*\)/gi, '$1')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const extracted = extractJsonSubstring(cleaned);
    if (!extracted) {
      throw new Error(`Could not parse JSON (${err.message}) from: ${cleaned.slice(0, 300)}`);
    }
    try {
      return JSON.parse(extracted);
    } catch (err2) {
      throw new Error(`Could not parse JSON (${err2.message}) from: ${extracted.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------
// Translate candidate titles/summaries for the picker screen
// One batched call for every non-English candidate rather than one
// call each -- the picker can show up to 50 candidates, and only a
// couple of feeds (kicker, L'Equipe) aren't already in English.
// Story selection still writes its own English copy separately
// (writeSlide translates too); this only makes the picker readable.
// ---------------------------------------------------------------
export async function translateCandidates(items) {
  if (!items.length) return items;

  const nonEnglish = items.filter((it) => it.lang && it.lang !== 'en');
  if (!nonEnglish.length) return items;

  // Translate in small batches (5 at a time) so one bad story doesn't
  // break the whole batch. Each translation call gets its own Claude request.
  const BATCH_SIZE = 5;

  // Keyed by object reference to the original item -- the only reliable
  // way to map a translation back to its source, since the translated
  // text can never equal the original (that was the bug: matching by
  // text equality against ITSELF instead of using the index Claude
  // already returns for exactly this purpose).
  const byOriginal = new Map();

  for (let i = 0; i < nonEnglish.length; i += BATCH_SIZE) {
    const batch = nonEnglish.slice(i, i + BATCH_SIZE);
    const list = batch
      .map((it, j) => `${j}. TITLE: ${it.title}\nSUMMARY: ${it.summary}`)
      .join('\n\n');

    const system = `Translate each numbered story's TITLE and SUMMARY into
natural English. Keep names, clubs, and numbers exact -- this is for a
human skimming a list to decide what to cover, not final copy.

Respond with JSON only, no prose and no markdown fences:
{"translations":[{"index":0,"title":"...","summary":"..."}]}`;

    try {
      const text = await callClaude({
        system,
        messages: [{ role: 'user', content: list }],
        maxTokens: 2000,
      });
      const result = parseJson(text);
      for (const t of result.translations || []) {
        const original = batch[t.index];
        if (original) byOriginal.set(original, t);
      }
    } catch (err) {
      // Covers both a failed Claude call and a failed parse -- either way,
      // leave this batch untranslated instead of failing the whole request.
      // byOriginal simply has no entry for these items, so the map below
      // passes them through unchanged.
      console.warn(`[translateCandidates] Batch ${i / BATCH_SIZE + 1} failed: ${err.message.slice(0, 80)}`);
    }
  }

  return items.map((it) => {
    const t = byOriginal.get(it);
    return t ? { ...it, title: t.title, summary: t.summary } : it;
  });
}

// Relative age string for the ranking prompt -- the model has no other
// way to know how old a story is, since only the headline and summary
// are shown otherwise.
function formatAge(publishedAt) {
  const ms = publishedAt ? Date.now() - new Date(publishedAt).getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------
// Rank candidates for the picker screen
// Runs after fetch/filter/dedupe, before the picker is shown. This only
// orders (and, via `wanted`, trims) a larger candidate pool -- the user
// still picks manually from what's returned. Nothing here auto-selects
// or builds a post; that's still entirely up to the human.
// ---------------------------------------------------------------
export async function rankStories({ stories, rankingRules, wanted }) {
  if (!stories.length) return stories;

  const rules = rankingRules || 'Rank by general newsworthiness for a '
    + 'football audience: bigger clubs and completed news outrank smaller '
    + 'clubs and rumours.';

  const list = stories
    .map((s, i) => {
      const photo = s.imageUrl ? 'has photo' : 'no photo';
      return `${i}. [${s.sourceName}, ${formatAge(s.publishedAt)}, ${photo}] ${s.title}\n   ${(s.summary || '').slice(0, 180)}`;
    })
    .join('\n');

  const system = `You rank candidate stories for a European football
Instagram account's story picker. A human will manually choose which ones
to actually post from your ranking -- this only orders the list for them,
it never selects or drops stories on its own.

${rules}

You will get a numbered list of candidate stories spanning the last 7
days. Rank ALL of them, most newsworthy first, and return every index
you were given, just reordered -- never drop one, the human decides what
to skip.

Each entry shows its age and whether a photo is available.
- A genuinely major story from a few days ago should still outrank a
  minor one from the last hour -- don't let recency alone dominate the
  ranking now that the pool spans a full week, not just a few hours.
- Prefer stories with a photo over an equally newsworthy one without --
  this is a visual carousel, and a slide with no image is a worse post.
  Never rank a weaker "has photo" story over a clearly stronger
  "no photo" one purely for the image.

Respond with JSON only, no prose and no markdown fences:
{"ranked":[3,11,0,...]}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: list }],
    maxTokens: 8000,
  });

  const result = parseJson(text);
  const order = (result.ranked || []).filter((i) => stories[i]);

  // The model was told to return every index, but don't lose a story to
  // a parsing quirk if it drops one anyway -- put anything missing back
  // on the end in its original order rather than silently discarding it.
  const seen = new Set(order);
  const rest = stories.map((_, i) => i).filter((i) => !seen.has(i));
  const ranked = [...order, ...rest].map((i) => stories[i]);

  return wanted ? ranked.slice(0, wanted) : ranked;
}

// ---------------------------------------------------------------
// STAGE 2: write one slide
// Also handles translation: a German or French article goes in,
// English copy comes out, no separate translation step needed.
// ---------------------------------------------------------------
export async function writeSlide({ story, styleGuide, previousHeadlines = [] }) {
  const system = `You write copy for slides on a European football Instagram account.

HEADLINE RULES
- 3 to 8 words. It must fit three lines of very large condensed type.
- Present tense, no full stop, no clickbait questions.
- Split into parts. Parts carrying the news (club names, players, the
  event itself) get "key": true and render in the accent colour.
  Connecting words ("and", "in", "of the", "agree") get "key": false.
  Alternate so the line has visual rhythm — never make every part key.

BODY RULES
- Always write a body — never leave it empty, even for a thin source.
- Normally 2 sentences, 20 to 32 words total. This is a fixed-height
  image, not a page that scrolls — going over the top of this range
  risks the text being cut off, so treat 32 words as a hard ceiling,
  not a target to reach for.
- Add the concrete detail the headline omits: fee, contract length,
  timeline, score, who it replaces. Pick the single most important
  one rather than listing several if that's what it takes to stay short.
- Never invent facts not present in the source material. If the source
  is thin, write one plain sentence restating the headline's news with
  whatever real detail is available (source outlet, timing) rather than
  nothing at all.

If the source material is not in English, write the output in English.

${styleGuide || ''}

Respond with JSON only, no prose and no markdown fences:
{"headline_parts":[{"text":"Liverpool","key":true},{"text":"agree","key":false}],
 "body":"..."}`;

  const avoid = previousHeadlines.length
    ? `\n\nRecent headlines on this account — vary the phrasing from these:\n${previousHeadlines.map((h) => `- ${h}`).join('\n')}`
    : '';

  const content = `Source: ${story.sourceName}
Headline: ${story.title}
Summary: ${story.summary}${avoid}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content }],
    maxTokens: 1600,
  });

  return parseJson(text);
}

// ---------------------------------------------------------------
// STAGE 3: caption
// ---------------------------------------------------------------
export async function writeCaption({ slides, wordmark }) {
  const summary = slides
    .map((s) => `- ${s.headline_parts.map((p) => p.text).join(' ')}: ${s.body}`)
    .join('\n');

  const sources = [...new Set(slides.map((s) => s.source_name).filter(Boolean))];

  const system = `You write Instagram captions for a European football account.

Structure, in this order:
1. A one-line hook telling people to swipe, ending with one or two emoji.
2. One or two short paragraphs summarising the stories in flowing prose.
   Do not bullet them. Do not repeat the headlines word for word.
3. A line: "Sources: " followed by the outlet names joined by " · ".
4. Four or five lowercase hashtags on one line.

Respond with the caption text only. No JSON, no markdown, no preamble.`;

  return callClaude({
    system,
    messages: [{ role: 'user', content: `Account: ${wordmark}\n\nStories:\n${summary}\n\nSources: ${sources.join(', ')}` }],
    maxTokens: 1400,
  });
}

// ---------------------------------------------------------------
// STAGE 4: edit chat
// Holds conversation history so follow-ups like "make it shorter"
// know what "it" refers to. History is per-post and discarded on approval.
// ---------------------------------------------------------------
export async function editChat({ slide, history, message }) {
  const system = `You help edit one slide of a football Instagram carousel.

Current slide:
Headline: ${JSON.stringify(slide.headline_parts)}
Body: ${slide.body}

If the request is ambiguous — you cannot tell which part to change, or how
far to go — ask one short clarifying question instead of guessing.

When you are confident, respond with JSON only:
{"action":"update","headline_parts":[...],"body":"...","note":"what you changed"}

When you need to ask first, respond with JSON only:
{"action":"ask","question":"..."}

Keep the same headline and body rules as the original: 3-8 word headline
split into key/non-key parts, 2-3 sentence body, no invented facts.`;

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const text = await callClaude({ system, messages, maxTokens: 1600 });
  return parseJson(text);
}
