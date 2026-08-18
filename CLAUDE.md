# Touchline — working notes for Claude Code

Read `README.md` first for setup and architecture. This file is session-to-session
state: decisions made, what's deployed, and what's still open. Update it as things
change — don't let it go stale. (This file was fully rewritten 2026-08-13; the
previous version predated the News/Results picker rework below and had drifted
badly out of sync with reality — if you're tempted to just append to a stale
CLAUDE.md instead of correcting it, don't.)

## Working agreement with the user

- **Commit and push directly to `main`.** The user has no ability to review code
  themselves, so hold a higher bar before pushing: run `npm run build` after every
  change and actually read the diff, don't just assume it works. Flag anything
  risky (schema changes, deleted data, config touching the live deploy) before
  pushing, not after.
- **This sandbox has no general network access.** Not just the production Vercel
  URL — `curl`, `WebFetch`, and even unrelated third-party sites are blocked by
  the egress proxy. `WebSearch` still works (returns snippets), but its summaries
  are sometimes the model *guessing* a URL fits a pattern rather than confirming
  it — treat anything not explicitly quoted from a search result as unverified.
  The only way to actually verify a URL is live is to have the user check it in
  their own browser and paste back what they see. This has been the single
  biggest source of wasted round-trips this session (see RSS feed section below)
  — don't guess-swap a feed URL a second time without the user confirming it.
- Supabase MCP tools are connected and are the fast path for reading/writing
  `topics.feeds`, checking `posts`/`slides`, or altering schema — use them
  directly rather than asking the user to run SQL by hand.

## Naming: app is "SixYardBox", infra is still named "Touchline"

2026-08-14 (third session): the app was rebranded from Touchline to
**SixYardBox** — page title, the `topics.wordmark` value that actually gets
stamped onto every generated slide image, `package.json`'s name, and the
image-proxy's user-agent string were all updated (Supabase's live
`topics.wordmark` row too, not just `schema.sql`'s seed). The user
deliberately scoped this to app-facing branding only — the GitHub repo
name, the Vercel project/production URL, and the Supabase project name
all still say "Touchline" below, and that's intentional, not something
left over to finish. Don't rename those without the user asking.

## Current deployment

- **Repo**: `Reluyo/Touchline-Soccer-Post-Generator`, production branch is `main`.
- **Hosting**: Vercel, auto-deploys on push to `main`.
  Production URL: https://touchline-soccer-post-generator.vercel.app/
- **Database**: Supabase project **Touchline** (`bnasaybdlczxfbifezxz`, us-east-2,
  org "Boriapps"). RLS enabled with no policies (deny-all) on all tables — safe
  because the app only ever talks to Supabase server-side via the `service_role`
  key, which bypasses RLS; the browser never calls Supabase directly. This was
  only ever set live in Supabase, not captured in `schema.sql` — fixed
  2026-08-17, see that session's notes below.
- **Env vars** (all set in Vercel already — don't ask the user to re-paste
  secrets into chat; if a new one is ever needed, have them add it directly in
  Vercel's/Supabase's own UI):
  - `APP_PASSWORD` — gates every route via Basic Auth (`middleware.js`),
    added 2026-08-17. **Confirmed set in Vercel 2026-08-17** (user confirmed
    directly). This is the one env var that actually matters for security,
    not just for a feature to work — fails open (no prompt at all) if
    unset, so check this first if the password prompt ever stops
    appearing after a deploy.
  - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `ANTHROPIC_API_KEY` — writing/chat/translation (`lib/claude.js`)
  - `OPENAI_API_KEY` — `gpt-image-1` image generation (`lib/images.js`)
  - `FOOTBALL_DATA_API_KEY` — Results posts (`lib/results.js`), free tier,
    10 req/min. Added 2026-08-13, not yet live-tested with real match data
    since the big-five leagues + Champions League haven't kicked off this
    season yet — `fetchResults()` correctly returned an empty list, which at
    least confirms auth + parsing work.
  - `BRAVE_SEARCH_API_KEY` — web image search for News story
    slides with no feed photo (`lib/imageSearch.js`), free tier 100
    queries/month (paid available). Added 2026-08-14, fifth session,
    pivoted to Brave Search 2026-08-15 when Google closed JSON API to
    new customers — see "Web image search" below. **Confirmed set in
    Vercel 2026-08-17** (user confirmed directly). Still not live-tested
    (see open items) — if search ever silently stops finding anything,
    check this key first before assuming the feature broke some other
    way (the code treats missing/invalid credentials as "search failed"
    and falls straight through to AI generation, so a bad key fails
    silent, not loud).
- **Model**: `claude-sonnet-5` (see `lib/claude.js`). Deliberately not Opus —
  cost-sensitive app. Uses `thinking: {type: 'adaptive'}` + `output_config:
  {effort: 'low'}` — disabling thinking outright was tried and reverted, it
  made the model leak stray content after the JSON it was told to output
  cleanly.
- `posts`, `slides`, `seen_stories` were cleared in Supabase (2026-08-13) as
  part of the `kind` column rename (`daily`/`weekend` → `news`/`results`) —
  clean slate to retest the new workflow.

## Current workflow (News / Results picker — NOT auto-generate)

This replaced the old "click one button, Claude auto-ranks and builds the
whole carousel" flow. Full detail in README; short version:

1. Pick **News** or **Results**, click **Find stories**/**Find results**.
   - News: `/api/feeds` fetches everything from the last 7 days (filtered,
     deduped, freshness-checked), ranks the whole pool by newsworthiness via
     `rankStories()` (2026-08-14 change — see below), and returns the top
     100, non-English ones auto-translated for display.
   - Results: `/api/results` returns finished matches from the last 7 days
     across `PL,PD,SA,BL1,FL1,CL` (football-data.org competition codes).
2. Manually check which candidates to use — ranking only orders/trims the
   list the picker shows; it never selects or builds anything by itself.
3. Click **Build post**: News stories go through `/api/write` (Claude writes
   headline+body) same as before; Results slides are templated directly from
   the scoreline in `lib/results.js`'s `buildResultSlide()` — no Claude call,
   the "content" is just team names and a score.
4. A News story slide with no feed photo tries `/api/image-search` (Brave
   Search, real photo, re-hosted in Supabase Storage) before
   `/api/image` (AI generation) — search first, AI only if search finds
   nothing or isn't configured (2026-08-14, fifth session; pivoted to
   Brave 2026-08-15 — see "Web image search" below). Cover shows a
   collage (up to 4, via `image_urls` — see `Slide.jsx`'s grid layouts)
   of the real photos gathered from the picked News stories (feed *or*
   search, never AI); falls back to a single image (the AI fallback, if
   that's the only photo available) or the branded gradient (Results, or
   a News run where every story needed AI) when there's fewer than 2 real
   photos to collage. Neither search nor AI generation ever runs for the
   cover directly, and neither runs for Results, which has no photo
   source at all. **CTA is one fixed, hand-picked image**
   (`CTA_IMAGE_URL` constant in `app/page.jsx`) — not regenerated per
   run, the user asked for visual consistency on the closing slide.
5. Caption + save, same as before.

The standalone `/api/rank` endpoint from the old auto-generate flow is still
gone. `rankStories()` was reintroduced in `lib/claude.js` (2026-08-14,
fourth session — see below) but only as a step inside `/api/feeds`, not a
separate call the browser makes — it's still the human picking from
`/api/feeds`'s output, never an automatic build.

## Web image search for photo-less stories (2026-08-14, fifth session; pivoted to Brave 2026-08-15)

User reported the AI fallback producing two nearly-black images with
garbled text baked in, and asked to add web search as an option for
stories with no feed photo. Two separate fixes:

- **Prompt fix (immediate, no new dependency)**: `lib/images.js`'s
  `STYLE` string now explicitly demands a well-exposed (not underexposed
  "moody night") frame and forbids any readable text/scoreboards/ad
  boards/signage, only allowing club crests as plain shapes. Ad boards,
  scoreboards, and jersey text are a known failure mode for diffusion
  models asked for photorealistic stadium scenes — that's almost
  certainly what the "black images with text" were.
- **Web search tier (new)**: asked the user first, since this needed a
  new third-party API key and — more importantly — carries a materially
  different risk than AI generation: a search result is someone's actual
  copyrighted press photo with no license for this use, not a novel
  generated image. User chose to proceed anyway. Initially implemented
  with Google Custom Search, but Google closed that API to new customers
  before user could set it up. Pivoted to **Brave Search API** (2026-08-15),
  which has a free tier (100 calls/month, with paid options for higher
  limits). New `lib/imageSearch.js` / `/api/image-search`: queries Brave
  Search API using just the slide's "key" headline words (club/player
  names, not the full sentence — see `searchQuery()` in `app/page.jsx`),
  attempts to download image results or web results with image metadata,
  and re-uploads the first that works to the `generated-images` Supabase
  bucket (so the existing image-proxy allowlist needs no changes — it
  already trusts that bucket's host). `app/page.jsx`'s `buildPost()` now
  tries search first for any News story slide with no feed photo, only
  calling `/api/image` (AI generation) if search finds nothing usable or
  throws. Needs `BRAVE_SEARCH_API_KEY` set in Vercel (see `.env.example`)
  — not yet confirmed set; if search never seems to find anything, check
  there first, since a missing/invalid key fails silently through to the
  AI fallback rather than erroring visibly.

Real photos found this way (feed *or* search) now both count toward the
cover collage; only AI-generated ones are excluded from it (`realImages`
in `buildPost()`, renamed from `feedImages`).

Not yet live-tested — worth checking after a real run whether Brave's
search actually returns relevant, on-topic results for football
transfer/injury news specifically (as opposed to e.g. stock photos or
unrelated matches of the same player name), and whether the 100/month free
quota is enough at real usage volume.

## Widening the picker to a week, with ranking (2026-08-14, fourth session)

User reported only seeing stories from the last ~3 hours. Root cause:
`filterItems()`'s 24h freshness window wasn't the problem (it was already
24h, not 3) — the real culprit was `/api/feeds` sorting freshest-first and
slicing to `MAX_CANDIDATES` (50) *before* any notion of importance. On a
busy news day, the freshest 50 items across 10 feeds can all land within
a couple of hours of each other, silently pushing anything older off the
list even though it was well within the 24h window.

Fix, both in `app/api/feeds/route.js`:
- `MAX_AGE_HOURS` raised from 24 to `24 * 7` (a full week) — passed
  explicitly to `filterItems()`, which still defaults to 24h for any other
  caller.
- `MAX_CANDIDATES` raised from 50 to 100.
- New `rankStories()` in `lib/claude.js` reintroduces newsworthiness
  ranking (using the same `topics.ranking_rules` text the old deleted
  auto-generate flow used), but strictly to order/trim the pool the picker
  shows — it returns every story it's given, just reordered, and the route
  slices to the top 100 *after* ranking instead of before. The user still
  manually picks from that list; nothing here auto-selects or builds a
  post. If ranking itself fails (Claude API error, bad JSON), the route
  falls back to a plain freshest-first sort rather than failing the whole
  request — same never-throw posture as the rest of the pipeline.
- Added `export const maxDuration = 60` to the route, matching
  `/api/image` — ranking a few hundred stories in one Claude call is
  slower than the plain fetch this route used to be, and the previous
  version had no explicit duration (relying on Vercel's short default).

Not yet load-tested against a real high-volume week (transfer deadline
day, a full round of European fixtures) — worth watching whether ranking
a genuinely large pool (300+) stays fast and within `maxDuration`.

## Cutting down AI image generation (2026-08-14, third session)

User asked to move away from AI-generated slide images since most feed
stories already ship a real photo. Two changes, both in `app/page.jsx`'s
`buildPost()`:

- **Results slides no longer call `/api/image` at all.**
  football-data.org gives team names and a score, not a photo, so there
  was never a real image to fall back to — previously this meant *every*
  Results slide was AI-generated. Now `buildResultSlide()`'s slide is
  used as-is with no `image_url`, and `Slide.jsx` renders a branded
  gradient (`accentLight → accent → accentDeep` from `topics.style`)
  instead of a photo when `image_url` is empty. This applies to a
  Results post's cover too.
- **The cover no longer gets its own generated image.** It now shows a
  collage of the real feed photos collected while writing the story
  slides (`feedImages` in `buildPost()`, capped at 4 via `image_urls` —
  `Slide.jsx` already had 2/3/4-photo grid layouts wired up but unused
  until now). When fewer than 2 real photos were collected — a News run
  where every story needed the AI fallback, or any Results run — it
  falls back to a single image (`image_url`): the lead slide's AI
  fallback for News, or `null` for Results, which renders as the
  branded gradient. Net effect: a full Results post now does zero
  OpenAI image calls; a News post only calls it for feed items missing
  a photo, and never for the cover directly.

Originally the cover just reused `slides[0].image_url`, which meant the
cover and the first story slide showed the *exact same* image
back-to-back whenever that lead story needed the AI fallback. The
collage (2026-08-14, same session, follow-up request) mostly sidesteps
this — it only recurs now in the fewer-than-2-real-photos fallback case.

Also updated `lib/images.js` this session (separate fix, same theme):
when OpenAI's moderation blocks a prompt naming real players/clubs
(`moderation_block`), `generateSlideImage()` now retries once with the
generic `FALLBACK_PROMPT` instead of failing the whole build — previously
one flagged story killed the entire run since nothing saves until the
last step.

## RSS feed verification — DONE (2026-08-13, second session)

**Why this matters**: several feeds had URLs that were dead, wrong, or (worse)
silently returning content that isn't what the app expects — see AS.com's
video-as-image bug below. A feed that 404s is obvious (shows in the failed-feeds
banner); a feed that returns *plausible-looking but wrong* content is not, and
can silently degrade post quality for weeks before anyone notices.

**Methodology that worked** (repeat this if a feed breaks again later): ask the
user to open the feed URL directly in their browser and paste back either (a)
the raw XML if it loads, or (b) a screenshot/description of what happens. Then:
1. Confirm it's real, current football content — not empty, not a dead
   redirect, not a different sport/section.
2. Check the actual image hosts used (`media:content`, `media:thumbnail`,
   `enclosure` URLs) against `ALLOWED_HOSTS` in `app/api/image-proxy/route.js`
   — add any missing host. Watch for a feed's photo CDN living on a
   *completely different domain* than the feed/article host (AS.com's photos
   are on `img.asmedia.epimg.net`, nothing to do with `as.com`).
3. Check whether `media:content` might carry non-image content (video, in
   AS.com's case) — `extractImage()` in `lib/feeds.js` now rejects
   `medium="video"`, but a different feed could have a different footgun here.
   Read a few real `<item>` entries, don't assume.
4. Check whether images need `upgradeImageUrl()` handling — a small
   RSS-declared thumbnail with no larger version offered via the XML, but a
   larger one reachable by editing the URL (BBC: path segment; Guardian:
   `?width=` query param; WordPress feeds: strip the `-WIDTHxHEIGHT` filename
   suffix). If a feed's images come through at good resolution already
   (like AS.com's and Marca's do — 1980×1320 or better), no fix is needed.
5. Confirm `lang` in `topics.feeds` matches reality — wrong `lang` either
   skips translation it needs or wastes a translation call it doesn't.
6. Update `topics.feeds` in Supabase (source of truth, live immediately) AND
   `schema.sql` (keeps a fresh setup from re-seeding a since-fixed dead URL).

**Final status, all 10 feeds checked** (as of 2026-08-13):

| Feed | lang | Status |
|---|---|---|
| Marca | es | ✅ Fixed prior session — `objetos.estaticos-marca.com/rss/futbol/primera-division.xml`. |
| AS.com | es | ✅ Fixed prior session — `feeds.as.com/mrss-s/pages/as/site/as.com/section/futbol/portada/`. |
| Guardian Football | en | ✅ Fixed this session — old `/football/rss` no longer resolves, real URL is `theguardian.com/us/soccer/rss`. Confirmed by the user pasting raw feed content; updated in Supabase and `schema.sql`. |
| BBC Sport | en | ✅ Confirmed working as-is, no change. |
| Get French Football News | en | ✅ Confirmed working as-is, no change. |
| Get Italian Football News | en | ✅ Confirmed working as-is, no change. |
| Football Italia | en | ✅ Confirmed working as-is, no change. |
| Football Espana | en | ✅ Confirmed working as-is, no change. |
| kicker | de | ✅ Confirmed working as-is, no change. German content confirmed real (Bundesliga transfer news) — still worth watching whether `translateCandidates()` renders it well in the picker, but the feed itself is fine. |
| LEquipe | fr | ✅ Confirmed working as-is, no change. The `dwh.lequipe.fr` hostname looked suspicious (internal-sounding) but is genuinely their public edito RSS API. |

This session's sandbox had **no** outbound network access at all — not just to
these feed hosts, `WebFetch` failed even on `en.wikipedia.org`. Every check
above was done by the user opening the URL in their own browser and pasting
back the raw XML; there was no way to automate or spot-check this from inside
the sandbox. If verifying feeds again, expect to repeat that manual loop
unless a future session's network policy is less restrictive.

## Other things fixed this session (2026-08-13), condensed

- **Wrong photo on downloaded slides**: `lib/capture.js` had `cacheBust:
  false` in the `toPng()` call, letting html-to-image reuse a cached image
  across captures — downloading a full carousel could embed an earlier
  story's photo on several later slides' PNGs even though each slide's own
  preview and stored `image_url` were always correct. Fixed: `cacheBust: true`.
- **JSON parsing hardened** in `lib/claude.js`'s `parseJson()` against several
  real LLM output quirks found via production errors: trailing commas,
  unquoted property names, missing commas between properties, Python-style
  `True`/`False`/`None`. Deliberately NOT auto-fixed (too risky to guess):
  single-quoted strings, an unescaped quote/newline inside a string value —
  these still fail, but with a diagnostic error naming the actual problem.
- **`lib/filter.js`**: removed a bare `'efl'` from `SOFT_EXCLUDE` — it matched
  "EFL Cup" (Carabao Cup, a competition Premier League clubs play in), not
  just genuine lower-division mentions, and was wrongly excluding real
  top-flight stories about clubs not in the `BIG_FIVE` rescue list.
- **Body text overflow off the bottom of slides**: mitigated (not
  guaranteed-fixed — the exact rendering mechanism wasn't fully confirmed) by
  tightening the body copy word limit (45 → 32 words) and trimming
  `Slide.jsx`'s font sizes slightly for headroom. Worth re-checking against a
  batch of real posts.
- Image generation prompts (`lib/images.js`) deliberately name real players,
  clubs, kits, crests, and sponsors for realism — see README for the
  publicity-rights/trademark/OpenAI-policy tradeoffs this accepts. Prompt
  explicitly asks for correct team *colours* over exact kit pattern, since
  pattern/sponsor-logo detail is what the model is most likely to get wrong.

## Security audit + first fixes (2026-08-17)

A separate session did a full read-only production-readiness audit against
an old commit (before this file even existed) and committed it as
`AUDIT.md` — its own scope note explains the staleness, don't treat its
findings about the deleted auto-rank flow as current. This session started
working through its two Critical items against the *actual* current code:

- **C-1 (no auth on any route) — fixed.** Added `middleware.js`: gates
  every page and API route behind the browser's native Basic Auth prompt,
  checked against a single shared `APP_PASSWORD`. Chosen over Vercel
  Deployment Protection because that's a dashboard toggle this sandbox has
  no way to set (no network access, no Vercel API/MCP tool available) —
  someone needs to either flip that in Vercel's UI directly, or (what this
  session did instead) rely on this in-app gate. Fails open if
  `APP_PASSWORD` is unset, so it can't lock anyone out of a deploy that
  forgot to configure it — but that also means **it does nothing until the
  env var is actually added in Vercel**. This has not been confirmed done
  yet — check the env var list above before assuming this is live.
- **C-2 (schema.sql missing RLS) — fixed.** Turned out RLS was already
  enabled live on Supabase (deny-all, no policies) but `schema.sql` never
  reflected it — a fresh setup from this file alone would *not* have had
  that protection. Added the `alter table ... enable row level security`
  statements to `schema.sql` so it now matches production. No live
  behavior change; the service-role key already bypassed RLS either way.

The remaining High/Medium items in `AUDIT.md` (unchecked Supabase
`.single()` calls, the queue-trim race, no retry on Claude calls, etc.)
were written against the old auto-rank flow and need re-checking against
the current News/Results picker code before acting on them — several may
already be moot (the picker flow removed a lot of what H-2's race
condition depended on) and the current code has its own issues `AUDIT.md`
never looked at (`/api/image`, `/api/image-search`, `/api/results` didn't
exist yet when it was written).

## Re-audit against current code, then fixes (2026-08-17, same day)

Took the previous entry's own advice: re-audited against the *actual*
current code (not `AUDIT.md`'s stale commit) and worked through the
resulting "do next" list. Full re-audit isn't saved to the repo (it was
presented as an artifact in that session) — condensed version below;
ask for a fresh pass if the detail is needed again.

**Found one new, real bug in the process**: `translateCandidates()` in
`lib/claude.js` (the picker's "show non-English candidates in English"
feature, added 2026-08-14) matched translations back to their source
story by checking whether the *translated* text equaled the *original*
text — which is never true for a real translation. Claude's response
already carried the correct `index` field for this exact purpose; it was
computed and never read. Net effect: every kicker/L'Equipe candidate in
the picker rendered in German/French instead of English, silently, while
still paying for the (wasted) translation call. Confirmed this reproduces
by running the matching logic in isolation before touching anything, and
confirmed via the live DB that it does *not* corrupt saved posts —
`writeSlide()` does its own separate correct translation at write time,
so this was scoped to the picker's own display. **Fixed**: rewrote the
matching to key off the batch-local `index` directly, keyed by object
reference instead of content equality. Also moved the `callClaude` call
for each batch inside its own try/catch (it wasn't before) — a batch that
failed at the network/API level, not just a bad-JSON level, used to throw
out of the whole function and kill `/api/feeds`'s entire response;
now it degrades to "this batch stays untranslated" like a parse failure
already did.

Also fixed, all four of the re-audit's "do next" items:

- **Unguarded Supabase `.single()` calls** — added the same
  `if (error || !topic) return 404` guard `api/feeds` already had to
  `api/write`'s topic lookup and all three lookups in `api/posts`
  (topic in POST, topic in GET, post in PATCH). The PATCH one matters
  most in practice: it's what used to throw a bare `Cannot read
  properties of undefined (reading 'slides')` if you clicked Approve on
  a post that had already been deleted (e.g. by the queue-trim race) —
  now it returns a clear "this post no longer exists" message instead.
- **Slides insert now checked and rolled back on failure** — `api/posts`
  POST used to insert the post row, then insert its slides with no error
  check at all; a failed slides insert left a "queued" post with zero
  slides that crashed the review screen when opened. Now checks the
  error and deletes the just-created post if the slides insert fails.
- **`downloadAll()` now has try/catch/finally** — it was the only one of
  six async handlers in `app/page.jsx` with no error handling at all; a
  capture failure on any slide (most plausibly an image-proxy host not
  yet on the allowlist) left "Rendering slide X of Y…" stuck on screen
  forever with nothing telling you it failed. Now matches the same
  try/catch/finally shape as `approve()` and the others in that file.

Ran `npm run build` after each change and read the full diff before
committing, per the working agreement above. All four fixes are small,
additive, and don't touch the success path's existing shape.

**Not yet done** — the re-audit's "then" and "whenever there's room"
tiers: retry-with-backoff on the per-story build loop (`/api/write`,
`/api/image`, `/api/image-search` — still no retry, so a mid-loop
failure still burns whatever was already spent on earlier stories in
that run), applying `imageSearch.js`'s own env-var-presence-check
pattern to `lib/images.js`/`lib/results.js`, trimming the debug
`console.log`s in `lib/imageSearch.js`, surfacing source text next to
generated body copy in the review UI, consolidating the two capture-loop
implementations (`lib/capture.js`'s unused `captureAll()` vs.
`downloadAll()`'s own inline copy), a daily run cap as a cost backstop,
and the cross-language duplicate-candidate question (downgraded from the
original audit's High since the picker's human review is a real
backstop, but worth revisiting once the translation fix above has had a
few real runs to prove out).

## Working down the re-audit's remaining list (2026-08-17, same day, third pass)

Continued past the four "do next" items from earlier the same day into
the "then" and "whenever there's room" tiers. Each change below was
its own commit with `npm run build` run first.

- **`approve()`'s silent failure — fixed, and it undercut last pass's
  own work.** `app/page.jsx`'s `approve()` used a raw `fetch()` with no
  `res.ok` check, so the new PATCH 404 added earlier the same day (for
  an already-deleted post) was never actually seen by the UI — it just
  proceeded as if approval had succeeded regardless of what the server
  returned. This is the kind of thing that's easy to miss when fixing
  the backend in isolation without re-checking who's reading the
  response. Fixed: checks status, surfaces the error, and refreshes the
  queue on failure so a stale post doesn't linger looking valid.
- **Retry-with-backoff — added to all three paid API call sites**, not
  just Claude. `lib/claude.js`'s `callClaude()` (used by rank, write,
  caption, chat, translate) gets 2 short capped retries on 429/5xx.
  `lib/images.js`'s `requestImage()` and `lib/imageSearch.js`'s Brave
  call get one retry each, deliberately narrower: both have a per-request
  timeout (55s and 10s respectively) that already eats most of their
  route's budget if a request hangs, so only a *fast-failing* 429/5xx
  response is retried — never the timeout itself, which would have no
  budget left for a second attempt. Added `maxDuration = 30` to
  `api/write`, `api/posts` (POST), and `api/chat`, none of which had an
  explicit value before — they were relying on Vercel's ambiguous
  default, which retries need headroom beyond.
- **Env var checks** added to `lib/images.js` (`OPENAI_API_KEY`) and
  `lib/results.js` (`FOOTBALL_DATA_API_KEY`), matching the pattern
  `lib/imageSearch.js` already had for `BRAVE_SEARCH_API_KEY`.
- **`lib/imageSearch.js` debug logging trimmed** to two summary lines
  (result counts, and a "found nothing" line) — dropped the raw
  response-shape dumps and per-candidate URL logging left over from
  getting the integration working.
- **Capture-loop implementations consolidated** — `downloadAll()` now
  calls `lib/capture.js`'s `captureAll()` instead of reimplementing the
  same loop inline, so there's exactly one place capture behavior lives.
- **Source text now shown during review.** `api/write` returns the
  original story summary as `source_summary` (not persisted — no schema
  change, session-only); `buildPost()` merges it onto the saved slides
  by position and now opens the just-built post straight into review
  instead of dropping back to the queue list, since that's the one
  moment `source_summary` is still around before a later re-fetch from
  the DB loses it. A small "Source" block shows it above the edit-chat
  panel when present. Reopening the same post later from the queue or
  history won't show one — by design, not oversight.
- **Daily cost cap (M-8) — deliberately NOT implemented.** The only
  correct way to do this is a counter incremented when a run *starts*
  (`/api/feeds`), not when one *completes* (`posts` row count) — a
  broken or malicious loop that never reaches `/api/posts` would spend
  money without ever tripping a completion-based cap, making it
  security theatre rather than an actual backstop. Doing this properly
  needs a new table, which is a schema change on the live production
  DB — exactly the category of change the working agreement at the top
  of this file says to flag before pushing, not decide alone mid-run.
  Left undone rather than shipped in a form that looks like protection
  but isn't. `APP_PASSWORD` (confirmed set 2026-08-17 — see above)
  remains the real primary defense here regardless.
- **Not yet done**: unit tests for `lib/filter.js` and `lib/claude.js`'s
  `parseJson()` — the last item on the re-audit's list, and the
  `translateCandidates()` bug from earlier the same day is a concrete
  example of exactly what a test suite would have caught immediately.

## Delete-drafts feature (2026-08-17, fourth pass)

Added a way to manually discard a stale queued (unapproved) draft
instead of waiting for 3 new ones to auto-evict it: a small `×` on
each queue card, and a "Delete draft" button in the review screen next
to Approve. Both go through a new `DELETE /api/posts` handler that
refuses (400) unless the post's status is `queued` — it can't be used
to erase approved history. Gated behind `window.confirm()` since it's
irreversible.

**Not live-tested against real data** — this sandbox has no Supabase
credentials. Verified instead with the dev server + a headless browser
with `/api/posts` responses mocked: both entry points send the correct
`DELETE` request, the card's delete button's `stopPropagation()` does
stop the card's own open-handler from also firing, and the review
screen correctly backs out to the queue list after a successful
delete. Worth deleting one real stale draft next time the app is open,
just to close the loop on an actual live confirmation.

## Real-post bug hunt: Guardian images, black-slide fallback, and a font-embedding hang (2026-08-17, fifth pass)

The user pasted screenshots of an actual queued post's slides for a
sanity check before approving. That surfaced three real, previously
unknown bugs no amount of code reading had caught, plus one already-known
one (the corrupted `Andkey` slide from the DB spot-check earlier this
session) — the exact kind of thing manual QA against real output finds
that a code audit doesn't.

- **Every Guardian-sourced image failed to load (fixed).** 3 for 3 in
  that one post — two story slides and one cover-collage tile, all
  black; zero failures from BBC or football-espana.net. Root cause:
  `lib/feeds.js`'s `upgradeImageUrl()` rewrote the `?width=` query param
  on Guardian URLs to request a larger image, but left the URL's
  trailing `&s=<hash>` (almost certainly a signature over the original
  request) untouched — the Guardian's CDN appears to reject the
  resulting mismatched URL outright. Stopped mutating Guardian URLs;
  the original (smaller) URL's signature stays valid and the photo
  actually loads. A real photo at lower resolution beats a guaranteed-
  blank slide.
- **Slide.jsx had no fallback for a present-but-broken image (fixed).**
  This is *why* the Guardian bug was even visible as solid black rather
  than the branded gradient — only a fully-*absent* `image_url` got the
  gradient; a non-null URL that failed to fetch just left the base black
  background showing through. Added a `PhotoLayer` component that
  actually probes whether each image loads (same technique
  `lib/capture.js`'s `waitForImages()` already used for a different
  purpose) and falls back to the gradient on ANY failure — wrong host,
  expired signature, dead link, a cause nobody's hit yet. Applies to
  both the single-image case and each cover-collage tile independently.
  Verified with a mocked dev server: broken → gradient, working → real
  photo, mixed collage → correct per-tile.
- **Headline/body text overlap on a 3-line headline (fixed) — and a
  worse bug found while diagnosing it.** Reproducing the exact Romero
  slide content at true capture resolution via a native browser render
  showed clean, non-overlapping layout — ruling out a CSS bug. Triggering
  the *actual* download pipeline (`captureSlide` → html-to-image's
  `toPng`) reproduced it for real: the exported PNG silently fell back
  to a generic wide font instead of the intended condensed "Anton" face
  (html-to-image serializes to a separate SVG for rasterizing, which
  doesn't automatically inherit the page's own loaded `@font-face`
  rules), and the layout is sized for Anton's narrow letterforms
  specifically (the headline CSS applies `scaleX(.92)` for exactly this
  reason). Fixed by calling html-to-image's own `getFontEmbedCSS()` once
  per download run to pre-fetch and inline the real font files, instead
  of relying on its internal auto-discovery. That surfaced a second,
  more serious bug: when the font CDN is unreachable, `getFontEmbedCSS()`
  doesn't fail fast, it hangs — and so does `toPng()`'s own fallback
  discovery when no `fontEmbedCSS` is supplied. Unguarded, either one
  turned "Download all slides" into a silent, permanent stuck progress
  bar with no error and no recovery short of a page reload. Fixed by
  racing the pre-fetch against a 4s timeout and explicitly passing an
  empty `fontEmbedCSS` string on failure (not `undefined` — only a
  non-null value skips `toPng()`'s own internal discovery attempt).
  **Not verified against the real Anton font specifically** — this
  sandbox cannot reach Google Fonts at all (network policy, not a bug),
  so every test here exercised the timeout/fallback path, not the
  happy path. In production the pre-fetch should just succeed quickly.
- **The corrupted "Barcelona" slide — deleted, not fixed.** No way to
  recover a correct headline for it (the original source text was never
  persisted — see the source-text feature earlier this session — and
  the story itself is long gone from any feed by now). The post had
  already been approved by the time this got sorted out, so it was
  deleted directly via Supabase (bypassing the normal queued-only
  restriction) with explicit user confirmation, rather than through the
  app's delete-draft feature, which correctly refuses to touch anything
  already approved.

## Results picker ranking (2026-08-17, sixth pass)

Added the importance signal the README's "Not built yet" section flagged
as missing: `matchImportance()` / `rankMatches()` in `lib/results.js`
score and reorder `fetchResults()`'s output biggest-game-first (Champions
League, marquee clubs on either side, close/high-scoring scorelines — see
README's "How the Results picker ranks matches" for the exact formula).
Deliberately **not** a Claude call, unlike News's `rankStories()` — kept
in line with Results' existing "templated, not written" design, and one
more paid-API dependency wasn't worth it for a formula this simple.
`app/page.jsx`'s picker shows a "★ Big game" badge (score ≥ 2) so the
ranking is visible, not just an invisible reorder. `matchImportance()`
first summed one point per *matching list entry* rather than per team,
which double-counted any club with more than one synonym in the list
(e.g. "Bayern Munich" matched both `'bayern'` and `'bayern munich'`,
scoring 2 for one club) — caught by the new unit tests
(`lib/results.test.js`) before it shipped, fixed to cap each team at one
point regardless of how many synonyms it matches. `npm run build` and
`npm test` (52/52) both clean.

**Not live-tested** — same sandbox constraint as everything else this
project hits: no network access to football-data.org from here, and the
2026 season's big-five-plus-Champions-League fixtures haven't produced
finished matches yet regardless. Worth a look once real Results data is
available: does the "★ Big game" threshold (score ≥ 2) feel right, or
does every Champions League game (which alone scores 3) drown out
marquee-vs-marquee league games that only reach 2?

## First real production run: a new parseJson() quirk found and fixed (2026-08-17, seventh pass)

User ran a real News build (with `APP_PASSWORD`/`BRAVE_SEARCH_API_KEY` now
live) and hit a hard failure while writing story slides: `writeSlide()`'s
Claude response for a Leão-to-Roma transfer story came back as
`{"text":"Leao",true}` instead of `{"text":"Leao","key":true}` — the model
dropped the `"key":` property name entirely, not just its quotes or a
comma, which is a shape `parseJson()`'s existing hardening (trailing
commas, unquoted names, missing commas, Python literals) didn't cover.
Confirmed reproducing the exact reported string before touching anything.

**Fixed**: added one more repair to `parseJson()` in `lib/claude.js` —
a quoted string immediately followed by a bare `true`/`false`/`null`
(no property name between them) always means "key" was dropped, since
that's the only boolean field in any of this app's Claude-facing JSON
schemas (rank/translate/write/chat). Scoped the regex to only fire right
after a string value, not after any comma, so it can't misfire inside a
legitimate array of booleans elsewhere — covered by a new test for
exactly that. Added two tests to `lib/claude.test.js`: one reproducing
the real failing string verbatim, one confirming a plain boolean array
is left untouched. `npm test` (54/54) and `npm run build` both clean.

This is the first bug caught by an actual live run since `APP_PASSWORD`
and `BRAVE_SEARCH_API_KEY` were confirmed set — worth treating any future
report from a real run the same way: reproduce the exact failure first,
fix narrowly, add a regression test, don't guess at the broader pattern.

## Three bugs from a second real run: duplicate picker cards, a low-res slide, and Brave search barely finding anything (2026-08-17, eighth pass)

User ran another real News build and reported three problems together.
Investigated and fixed all three; two were confirmed root causes, the
third is a strong, but not sandbox-verifiable, fix.

- **Duplicate picker cards that select together and build duplicate
  slides — fixed, root cause confirmed.** `rankStories()` in
  `lib/claude.js` built its `order` array straight from Claude's
  `{"ranked":[...]}` response with no dedup — if the model repeated an
  index (plausible on a few-hundred-story list), the same story object
  landed in the returned array twice. The picker keys candidates by
  fingerprint (`app/page.jsx`'s `candidateKey`), so two array entries
  for the same story share one key: clicking either card toggled both,
  and `buildPost()`'s filter-by-key picked up both, writing the story
  twice. Fixed by dropping repeated indices as they're encountered,
  keeping the first (best-ranked) occurrence. Also added a last-mile
  fingerprint-uniqueness filter in `app/api/feeds/route.js` as a
  backstop against any other duplication source. Both covered by new
  tests in `lib/claude.test.js`.
- **A low-resolution image on a slide — fixed, root cause confirmed.**
  `lib/feeds.js`'s `extractImage()` picked the *first* candidate that
  merely wasn't confirmed too small — and treated "no width reported at
  all" as passing that bar. A candidate with no size metadata (common
  for an `enclosure` or the last-resort HTML `<img>`) could win purely
  by coming first in priority order, ahead of a later candidate the feed
  explicitly confirmed was large. Fixed: now prefers a confirmed-large
  candidate over an unconfirmed one, only falling through to "unknown,
  hope for the best" (then finally to a confirmed-small candidate) when
  nothing better exists. Covered by new tests in `lib/feeds.test.js`.
- **Web image search barely ever finding a usable photo — fixed, but
  not verifiable from this sandbox.** `lib/imageSearch.js` was calling
  Brave's plain **Web Search** endpoint (`/res/v1/web/search`) and
  reading an `images.results` mixin from the response. That mixin is
  opt-in/plan-gated and came back empty essentially every call, so
  search silently fell through to parsing image metadata off plain web
  results (which mostly don't have any) and from there straight to the
  AI fallback almost every time — the opposite of what this feature is
  for. Switched to Brave's **dedicated Image Search endpoint**
  (`/res/v1/images/search`), confirmed via Brave's own docs and
  independent references (this sandbox has no network egress to fetch
  those pages directly — see the working agreement at the top of this
  file — so this was corroborated through multiple independent
  `WebSearch` queries rather than one fetch). Response parsing stayed
  defensive (tries the old shapes as a fallback) in case that turns out
  wrong on a real call. Also added `lib/imageDimensions.js` -- a small,
  hand-rolled JPEG/PNG header parser (deliberately not the `image-size`
  npm package, which has known unpatched infinite-loop DoS advisories in
  parsers for formats this app doesn't even need) -- so a downloaded
  search result's *actual* pixel width is checked, not just its file
  size, closing the same low-res gap as the feeds.js fix above for
  search-sourced images too. Bumped `count` from 10 to 20 (same one
  billed call, more candidates to try). **This is the one fix in this
  pass that genuinely needs a live run to confirm** — request/response
  shape for this specific endpoint was not fetched from a live source.

## A third real run: two RSS feeds blocked by bot-protection, and a slide with no body text (2026-08-17, ninth pass)

User ran another real News build and reported three more problems.
Investigated using the live Supabase data for the actual post (found via
MCP, not guessed) rather than reasoning about it in the abstract.

- **Get French Football News ("not recognized as RSS 1 or 2") and Get
  Italian Football News ("Invalid character in entity name") both
  failed — likely fixed, but not verifiable from this sandbox.**
  Root-caused to rss-parser's own default User-Agent header, which is
  the literal string `"rss-parser"` — about as obvious a scraper
  signature as exists, and exactly what WordPress bot-protection
  (Wordfence, Cloudflare, etc.) tends to challenge or block. Both are
  WordPress sites, both were confirmed *working* in the original
  2026-08-13 feed-verification pass, and "not recognized as RSS 1 or 2"
  is consistent with getting back a challenge/interstitial HTML page
  instead of the real feed rather than a genuinely broken one. Set a
  real browser User-Agent on the shared `Parser` instance in
  `lib/feeds.js` — can only help, since it can't break a feed that was
  already working with the old default. Separately, also hardened
  `fetchFeed()` with one retry on any parse failure: re-fetch the raw
  XML directly and repair a bare, unescaped `&` (invalid XML, but a
  common real-world feed bug, and exactly what "Invalid character in
  entity name" means) before parsing again — a narrow, same-shape fix to
  parseJson()'s existing quirk-repairs, just for XML instead of JSON.
  Covered by new tests in `lib/feeds.test.js`. **Not verified against
  the real feeds** — no network access to either host from this sandbox.
- **Two slides with a headline but no body text — fixed, root cause
  confirmed via the live post's actual DB row.** `writeSlide()` in
  `lib/claude.js` returned `parseJson(text)` straight through with no
  validation that the result was actually complete. Checked the real
  post in Supabase: both broken slides had a normal, non-empty
  `headline_parts` but `body: null` — valid, cleanly-parsed JSON that
  simply didn't follow the prompt's own "always write a body" rule.
  Nowhere in the pipeline throws on that, so it silently saved as a
  slide with no body text. Fixed: `writeSlide()` now validates the
  response has a non-empty body and usable headline parts, retries once
  if not (a bad response from a non-deterministic model rarely repeats),
  and if the body is still missing after that, falls back to the
  story's own summary text verbatim (never invents anything) rather than
  shipping empty. An unusable headline still throws rather than being
  papered over -- there's no safe way to fabricate one the same way.
  Covered by new tests in `lib/claude.test.js`.
- **Slide 7's low-res image — root cause confirmed, but a different one
  than the Brave search path from last session's fixes.** The live DB
  row showed this slide's image was a **feed** photo (Guardian), not a
  search or AI-generated one: a `?width=140&...&s=<hash>` URL. Guardian
  URLs are deliberately never upgraded to a larger size (see
  `upgradeImageUrl()` — rewriting that hash-signed URL breaks it
  outright, a prior session's fix), so 140px is genuinely the *only*
  size that feed ever offers for this item, and `extractImage()` was
  still using it anyway since something beat nothing. Fixed: a candidate
  every source confirms is too small is no longer used at all —
  `extractImage()` now returns null in that case (same as "no photo"),
  which lets `buildPost()`'s existing fallback chain try a real web
  image search (now on the fixed Brave endpoint) instead of a feed
  thumbnail already known to be too small. This is a real, general
  improvement to image quality across any feed with only a small photo
  on offer, not just Guardian specifically.

Still outstanding from last session: the Brave Image Search endpoint
switch itself has not been confirmed working by a real run yet — this
session's report didn't mention whether search found real photos, only
this Guardian feed-image issue and the two bugs above. Still the
single highest-priority open item.

## Confirmed live: the Brave Image Search endpoint was right, one request param wasn't (2026-08-18, tenth pass)

User pasted the actual server log line, which resolved the top open
item without further guessing: `[imageSearch] Brave API 422: {...
"detail":"Unable to validate request parameter(s)"... "loc":["query",
"safesearch"...`. Two things confirmed at once --

- **The endpoint switch itself was correct.** A 422 is Brave validating
  and rejecting a specific parameter, not a 404 -- `/res/v1/images/search`
  is a real, reachable endpoint on this account's plan. If the endpoint
  guess had been wrong, this would have been a 404, not a 422.
- **`safesearch: 'moderate'` doesn't exist on this endpoint.** Carried
  over unchanged from the old Web Search code, but confirmed via
  `WebSearch` (Brave's own docs) that Image Search's `safesearch` is a
  2-value enum, `off`/`strict` -- not the 3-value `off`/`moderate`/
  `strict` the Web Search endpoint takes. Every real call was failing
  outright before search ever got a chance to find anything, which is
  also almost certainly why "does search find real photos" went
  unanswered in every report since the endpoint switch -- it never got
  the chance to run.

**Fixed**: dropped the `safesearch` param entirely rather than guess at
`strict` unverified -- Brave's documented default for this endpoint is
already `strict`, so omitting it gets the same behavior without a
second unverified guess. `npm test` (90/90) and `npm run build` both
clean. **Still needs one real run to confirm** search actually returns
usable results now that the request itself is valid -- this was a
request-validation fix, not a live content-quality check.

## Another parseJson() quirk: a stray "=" and a leaked TypeScript cast (2026-08-18, eleventh pass)

User hit another `writeSlide()` parse failure on a live run: Claude's
response came back as `{"headline_parts":[{"text":"Rodri","key":=true}
as any]}` instead of `{"headline_parts":[{"text":"Rodri","key":true}]}`
-- two quirks in one response, neither covered by the existing repairs:
a stray `=` wedged between the `"key":` colon and its value, and a
trailing TypeScript type assertion (`as any`) leaked onto the end of
the object, right before the array's closing `]`. Both read like
JS/TS-flavored code briefly leaking into what should be plain JSON.

**Fixed**: two more narrow repairs in `parseJson()`. The `:=` fix only
strips the `=` when what follows is actually the start of a JSON value
(`true`/`false`/`null`/a quote/a digit/`[`/`{`), so a colon genuinely
followed by `=` inside real string content would be left alone. The
`as any` fix only fires when sat directly between a value-ending token
(`}`, `]`, or a closing quote) and the next JSON structural character --
deliberately tight, since the word "as" appears constantly in normal
football copy ("seen as a coup") and a looser match would have
corrupted real body text. Covered by new tests in `lib/claude.test.js`,
including one confirming the word "as" inside real text is left
untouched. Reproduced the exact reported string before touching
anything, per the standing practice from prior sessions. `npm test`
(94/94) and `npm run build` both clean.

## First confirmed-good run (2026-08-18, twelfth pass)

User reported a successful run; checked the actual saved post in
Supabase (id `5fc12fb6...`) rather than taking that at face value, since
several "fixed" items were still unconfirmed. Real, concrete evidence
this time, not just an absence of errors:

- **The Brave Image Search fix is confirmed working** -- the single
  highest-priority open item since the endpoint switch, finally
  resolved. 4 of 5 story slides (Bezos/Liverpool, Mourinho/Real Madrid,
  Rodri/Barcelona, Man City/Fernandez) carry a `search-<id>.jpeg`
  `image_url` in the `generated-images` bucket -- real photos found via
  Brave and re-hosted, not AI-generated. The 5th (Romero/Atlético) used
  its own feed photo directly, so search wasn't even needed there.
  **Zero AI-generated images anywhere in the post** -- the cover collage
  is 3 search photos + 1 feed photo. This is also the first real
  evidence toward the user's "get away from AI generation" ask.
- **No duplicate stories, no null bodies.** All 5 story slides have
  distinct headlines and non-empty, well-formed body text -- both the
  `rankStories()` dedup fix and `writeSlide()`'s body-validation/retry/
  fallback held up on a real run.
- **Not confirmed either way by this post**: the two RSS fixes (Get
  French Football News / Get Italian Football News's User-Agent and
  bare-`&` repair) -- neither outlet's stories appear in this post, but
  that alone doesn't prove they're still broken, only that nothing from
  them got picked (or the picker screen wasn't inspected for failed-feed
  banners this run). Still worth a direct check next time.

## Open items

`APP_PASSWORD` and `BRAVE_SEARCH_API_KEY` are both **confirmed set in
Vercel as of 2026-08-17** (user confirmed directly) — no longer open items.

**Confirmed working as of the twelfth pass (2026-08-18)**, all via a
real saved post inspected in Supabase, not just an error-free report:
the Brave Image Search fix (real photos, zero AI-generated images in
that post), `rankStories()`'s duplicate-index fix (5 distinct stories,
no repeats), and `writeSlide()`'s body-validation/fallback (no null
bodies). No longer open items.

1. **Highest priority**: confirm the two RSS fixes from the ninth pass
   actually work — the new browser User-Agent on `lib/feeds.js`'s
   `Parser` (should fix Get French Football News and Get Italian
   Football News, both WordPress sites likely blocking the old
   `"rss-parser"` UA) and the bare-`&` XML repair retry. Neither
   outlet's stories have appeared in a post since the fix, which isn't
   proof either way — check the picker screen's failed-feeds banner
   directly on the next run.
2. Confirm the font-embedding fix actually reaches the real Anton font
   in production (this sandbox can't reach Google Fonts to check) —
   download a slide with a long headline and confirm both the correct
   font and no text overlap.
3. Try the new delete-draft buttons against a real queued post — see
   "Delete-drafts feature" above. Only mock-tested so far.
4. Results workflow needs a real end-to-end test once the season starts and
   `football-data.org` actually has finished matches to return — including
   whether the new "★ Big game" ranking's threshold feels right against
   real fixtures (see "Results picker ranking" above).
5. Not built: analytics view, feed-health UI (failed feeds now show in a
   persistent banner for that session, but nothing is recorded across runs).
6. `rankStories()`'s ranking of a large (300+) candidate pool hasn't been
   tested against a real high-volume week — watch whether it stays fast
   enough and within `/api/feeds`'s `maxDuration = 120`.
7. Cross-language duplicate candidates in the picker (see the first
   "Re-audit..." entry above) — worth revisiting once the translation
   fix has had a few real runs, since the picker showing readable
   English for every candidate was supposed to help a reviewer spot
   these by eye.
8. A real daily/per-run cost cap (M-8 above) needs a new table to track
   run attempts, not completions — a schema change deliberately left
   for an explicit decision rather than done autonomously. `APP_PASSWORD`
   is the real defense in the meantime.
9. `npm test` (`lib/filter.test.js`, `lib/claude.test.js`,
   `lib/results.test.js`, `lib/feeds.test.js`, `lib/imageDimensions.test.js`,
   `lib/imageSearch.test.js`) covers the RSS filter/dedupe logic,
   `parseJson()`, Results ranking, feed image selection, and the header
   parser, but nothing else in the app has test coverage — the API
   routes and `app/page.jsx`'s state machine are still untested, by
   manual QA only.
10. Watch a real batch of downloaded posts for the text-overflow /
    font-embedding fix above actually holding up outside this sandbox's
    network constraints.
