const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

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
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
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

// Models sometimes wrap JSON in markdown fences despite instructions.
// Strip them rather than failing the whole run.
function parseJson(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost {...} or [...] in the response.
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!match) throw new Error(`Could not parse JSON from: ${cleaned.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

// ---------------------------------------------------------------
// STAGE 1: rank
// Sends only titles and short summaries, so even 80 stories is a
// couple of thousand tokens. Returns the indexes to keep, in order.
// ---------------------------------------------------------------
export async function rankStories({ stories, rankingRules, wanted = 7 }) {
  const list = stories
    .map((s, i) => `${i}. [${s.sourceName}] ${s.title}\n   ${s.summary.slice(0, 180)}`)
    .join('\n');

  const system = `You select stories for a European football Instagram account.

${rankingRules}

You will get a numbered list of candidate stories. Choose the most newsworthy
ones, best first. Prefer at most ${wanted}, but return FEWER if the remaining
stories are weak — a short carousel of strong stories beats a padded one.
Never pad to reach a target count.

Respond with JSON only, no prose and no markdown fences:
{"selected":[{"index":3,"reason":"..."},{"index":11,"reason":"..."}]}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: list }],
    maxTokens: 1200,
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
- 2 to 3 sentences, 25 to 45 words total. Plain declarative statements.
- Add the concrete detail the headline omits: fee, contract length,
  timeline, score, who it replaces.
- Never invent facts not present in the source material. If the source
  is thin, write less.

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
    maxTokens: 800,
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
    maxTokens: 700,
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

  const text = await callClaude({ system, messages, maxTokens: 800 });
  return parseJson(text);
}
