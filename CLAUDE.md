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

## Current deployment

- **Repo**: `Reluyo/Touchline-Soccer-Post-Generator`, production branch is `main`.
- **Hosting**: Vercel, auto-deploys on push to `main`.
  Production URL: https://touchline-soccer-post-generator.vercel.app/
- **Database**: Supabase project **Touchline** (`bnasaybdlczxfbifezxz`, us-east-2,
  org "Boriapps"). RLS enabled with no policies (deny-all) on all tables — safe
  because the app only ever talks to Supabase server-side via the `service_role`
  key, which bypasses RLS; the browser never calls Supabase directly.
- **Env vars** (all set in Vercel already — don't ask the user to re-paste
  secrets into chat; if a new one is ever needed, have them add it directly in
  Vercel's/Supabase's own UI):
  - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `ANTHROPIC_API_KEY` — writing/chat/translation (`lib/claude.js`)
  - `OPENAI_API_KEY` — `gpt-image-1` image generation (`lib/images.js`)
  - `FOOTBALL_DATA_API_KEY` — Results posts (`lib/results.js`), free tier,
    10 req/min. Added 2026-08-13, not yet live-tested with real match data
    since the big-five leagues + Champions League haven't kicked off this
    season yet — `fetchResults()` correctly returned an empty list, which at
    least confirms auth + parsing work.
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
   - News: `/api/feeds` returns up to 50 recent candidates (filtered, deduped,
     freshness-checked, non-English ones auto-translated for display).
   - Results: `/api/results` returns finished matches from the last 7 days
     across `PL,PD,SA,BL1,FL1,CL` (football-data.org competition codes).
2. Manually check which candidates to use — no automatic ranking anymore.
3. Click **Build post**: News stories go through `/api/write` (Claude writes
   headline+body) same as before; Results slides are templated directly from
   the scoreline in `lib/results.js`'s `buildResultSlide()` — no Claude call,
   the "content" is just team names and a score.
4. Cover gets an AI-generated image illustrating the first-picked item. **CTA
   is one fixed, hand-picked image** (`CTA_IMAGE_URL` constant in
   `app/page.jsx`) — not regenerated per run, the user asked for visual
   consistency on the closing slide.
5. Caption + save, same as before.

`/api/rank` and `lib/claude.js`'s `rankStories` were deleted — nothing calls
them anymore.

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

## Open items

1. Results workflow needs a real end-to-end test once the season starts and
   `football-data.org` actually has finished matches to return.
2. Text-overflow mitigation (see above) is a mitigation, not a proven fix —
   watch the next few batches of generated posts for a body that still runs
   off the bottom.
3. Not built: analytics view, feed-health UI (failed feeds only show in the
   picker screen's warning banner, nowhere persistent/actionable).
