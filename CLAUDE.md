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
    added 2026-08-17. **Not yet confirmed set in Vercel** — until it is, the
    production app is still wide open; this is the one env var that actually
    matters for security, not just for a feature to work. Fails open (no
    prompt at all) if unset, so check this first if the password prompt
    isn't appearing after deploy.
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
    new customers — see "Web image search" below. Not yet confirmed set
    in Vercel; if search silently never finds anything, check this is
    actually there before assuming the feature is broken (the code treats
    missing/invalid credentials as "search failed" and falls straight
    through to AI generation, so it fails silent, not loud).
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

## Open items

1. **Confirm `APP_PASSWORD` is set in Vercel** — until it is, the auth
   fix from the security-audit session above is inert and the app is
   still fully open. Highest priority open item.
2. The per-story build loop (`/api/write`, `/api/image`,
   `/api/image-search`) still has no retry — a failure partway through
   burns whatever was already spent on earlier stories in that run with
   nothing saved. See "Re-audit..." above for the fuller list of what's
   still open from that pass.
3. Results workflow needs a real end-to-end test once the season starts and
   `football-data.org` actually has finished matches to return.
4. Text-overflow mitigation (see above) is a mitigation, not a proven fix —
   watch the next few batches of generated posts for a body that still runs
   off the bottom.
5. Not built: analytics view, feed-health UI (failed feeds now show in a
   persistent banner for that session, but nothing is recorded across runs).
6. `rankStories()`'s ranking of a large (300+) candidate pool hasn't been
   tested against a real high-volume week — watch whether it stays fast
   enough and within `/api/feeds`'s `maxDuration = 120`.
7. Confirm `BRAVE_SEARCH_API_KEY` is actually set in Vercel, then
   live-test `/api/image-search` — result relevance and the 100/month
   free quota are both unverified so far. Also worth trimming the debug
   `console.log`s in `lib/imageSearch.js` once this is confirmed working.
8. Cross-language duplicate candidates in the picker (see "Re-audit..."
   above) — worth revisiting once the translation fix has had a few real
   runs, since the picker showing readable English for every candidate
   was supposed to help a reviewer spot these by eye.
