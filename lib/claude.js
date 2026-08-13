const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

// Every call goes through here so retries and error handling live in
// one place. Never called from the browser -- the key must stay server-side.
async function callClaude({ system, messages, maxTokens = 2000 }) {
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

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude API ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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
// properties, or use Python's True/False/None instead of JSON's
// true/false/null -- all despite instructions. Clean up all of those,
// then fall back to extracting the first balanced JSON value rather
// than failing the run. If it's still invalid, throw the parser's own
// reason plus a snippet of what it choked on -- a bare native error
// here otherwise gives no clue which of several JSON-producing calls
// (rank, write, chat) failed or why.
//
// Deliberately NOT handled: single-quoted strings, an unescaped quote
// or newline inside a string value. Each of those needs to know where a
// string is actually meant to start/end to fix safely, which a
// find-and-replace can't determine without risking corruption of
// legitimate content (an apostrophe, a quoted remark, a real line
// break) -- better to fail with a clear error than guess wrong.
function parseJson(text) {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/"(\s+)"([^"]+)":/g, '",$1"$2":')
    .replace(/([:,[]\s*)(True|False|None)(\s*[,\]}])/g, (m, pre, lit, post) => (
      `${pre}${lit === 'None' ? 'null' : lit.toLowerCase()}${post}`
    ))
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

// Relative age string for the ranking prompt -- the model has no other
// way to know how old a story is, since only the headline and summary
// were shown before.
function formatAge(publishedAt) {
  const ms = publishedAt ? Date.now() - new Date(publishedAt).getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------
// STAGE 1: rank
// Sends only titles and short summaries, so even 80 stories is a
// couple of thousand tokens. Returns the indexes to keep, in order.
// ---------------------------------------------------------------
export async function rankStories({ stories, rankingRules, wanted = 7 }) {
  const list = stories
    .map((s, i) => {
      const photo = s.imageUrl ? 'has photo' : 'no photo';
      return `${i}. [${s.sourceName}, ${formatAge(s.publishedAt)}, ${photo}] ${s.title}\n   ${s.summary.slice(0, 180)}`;
    })
    .join('\n');

  const system = `You select stories for a European football Instagram account.

${rankingRules}

You will get a numbered list of candidate stories. Choose the most newsworthy
ones, best first. Prefer at most ${wanted}, but return FEWER if the remaining
stories are weak — a short carousel of strong stories beats a padded one.
Never pad to reach a target count.

Each entry shows its age and whether a photo is available.
- Prefer fresher stories. Treat anything more than a day old as stale
  unless it's clearly the most newsworthy option on offer.
- Prefer stories with a photo over an equally newsworthy one without —
  this is a visual carousel, and a slide with no image is a worse post.
  Never choose a weaker "has photo" story over a clearly stronger
  "no photo" one purely for the image.

Respond with JSON only, no prose and no markdown fences:
{"selected":[{"index":3,"reason":"..."},{"index":11,"reason":"..."}]}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: list }],
    maxTokens: 2500,
  });

  const result = parseJson(text);
  return result.selected
    .filter((s) => stories[s.index])
    .map((s) => ({ ...stories[s.index], reason: s.reason }));
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
- Normally 2 to 3 sentences, 25 to 45 words. Plain declarative statements.
- Add the concrete detail the headline omits: fee, contract length,
  timeline, score, who it replaces.
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
