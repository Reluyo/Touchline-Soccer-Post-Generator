# Touchline — working notes for Claude Code

Read `README.md` first for setup and architecture. This file is session-to-session
state: decisions made, what's deployed, and what's still open. Update it as things
change — don't let it go stale.

## Working agreement with the user

- **Commit and push directly to `main`.** The user has no ability to review code
  themselves, so hold a higher bar before pushing: run `npm run build` after every
  change and actually read the diff, don't just assume it works. Flag anything
  risky (schema changes, deleted data, config touching the live deploy) before
  pushing, not after.
- This session's network policy blocks outbound access to the production Vercel
  URL and general web browsing — can't self-test end-to-end in a browser. Debugging
  relies on the user's screenshots/reports, plus reasoning from code +
  Supabase data directly (Supabase MCP tools are available and connected).

## Current deployment

- **Repo**: `Reluyo/Touchline-Soccer-Post-Generator`, production branch is `main`.
- **Hosting**: Vercel, auto-deploys on push to `main`.
  Production URL: https://touchline-soccer-post-generator.vercel.app/
- **Database**: Supabase project **Touchline** (`bnasaybdlczxfbifezxz`, us-east-2,
  org "Boriapps"). Schema applied from `schema.sql`, RLS enabled with no policies
  (deny-all) on all 4 tables — safe because the app only ever talks to Supabase
  server-side via the `service_role` key, which bypasses RLS; the browser never
  calls Supabase directly.
- **Env vars**: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ANTHROPIC_API_KEY` — all set in Vercel already. Don't ask the user to re-paste
  secrets into chat; if a new one is ever needed, have them add it directly in
  Vercel's/Supabase's own UI.
- **Model**: `claude-sonnet-5` (see `lib/claude.js`). Deliberately not Opus —
  cost-sensitive app, README targets "a run costs a few cents." Uses
  `thinking: {type: 'adaptive'}` + `output_config: {effort: 'low'}` — disabling
  thinking outright was tried and reverted, it made the model leak stray content
  after the JSON it was told to output cleanly (see git log Aug 2026 for the
  full story if this resurfaces).
- Queue and history were cleared in Supabase (2026-08-12) after a round of
  bug fixes, to retest clean. `seen_stories` was already empty at that point.

## Bug list from the first real test run (2026-08-12)

Original 7 items reported after the first live "Generate posts" run. Status:

1. ✅ Bad image quality — fixed (see below)
2. ✅ Cover should be a collage — fixed, `Slide.jsx` now renders a 1–4 photo grid
3. ✅ Some slides had no picture — largely fixed as a side effect of #1's fix
4. ✅ Some slides had headline only, no body — fixed, prompt had a loophole
   ("if the source is thin, write less") the model was satisfying with an
   empty string; now requires at least one sentence always
5. ✅ Repeat coverage — fixed, but **read this carefully if touching it again**:
   seen-story tracking must only happen on **approval** (`PATCH` in
   `app/api/posts/route.js`), never on queue/generation. An earlier version of
   this fix marked stories seen at queue time, which the user explicitly said
   was wrong — a story generated during testing and never approved should stay
   eligible for future selection. Only an approved (actually posted) story
   should be excluded, and even then only until a genuine update produces a
   different fingerprint.
6. ✅ Stale stories — fixed: `filterItems` had a bug where a missing
   `publishedAt` skipped the age check entirely; window tightened 36h→24h;
   ranking prompt now shows each candidate's age and has explicit
   freshness/photo-preference rules (it previously had zero freshness signal).
7. 🔶 **Open** — image generation for slides without a good source photo.
   See "Image generation decision" below — this is the one unresolved item.

**Root cause behind #1/#3 (and why the on-screen preview looked fine but the
downloaded PNGs didn't):** `extractImage()` in `lib/feeds.js` had a fallback to
"first `<img>` in the article body," which was grabbing a shared promotional
banner embedded across multiple unrelated articles on the same outlet instead
of each story's real photo — two completely different stories ended up with
the *identical* image. Preview and download read the same underlying data, so
both were wrong; the small on-screen thumbnail just didn't make it obvious.
Fixed with three changes in `lib/feeds.js`: candidate images now carry size
hints and tiny ones are skipped, WordPress's `-WIDTHxHEIGHT` filename suffix is
stripped to get the full-res original, and any image URL that repeats across
2+ different candidates in one fetch is treated as a shared asset and dropped.

## Image generation decision (open item #7)

Claude's API doesn't generate images — this needs a separate vendor + API key.
Recommended, in order: **OpenAI `gpt-image-1`** (mature REST API, good default,
~5–20s/image — will likely need the image step broken into its own
start-job/poll-result pair to fit Vercel's ~10s function timeout, same pattern
the rest of the app already uses for feeds/rank/write) or **FLUX via fal.ai/
Replicate** (faster — FLUX Schnell renders in 1–4s, fits the timeout with no
restructuring — usually cheaper, strong editorial/photorealistic quality).
Ruled out: Midjourney (no official API). Flagged but not recommended without
more research: Higgsfield (positioned more toward social/video content tools
than a bare image API; didn't have confident enough info on current API terms).

**Status**: user is manually comparing OpenAI (via chatgpt.com) vs FLUX (via a
fal.ai/Replicate playground) using three test prompts (dark editorial sports
photography, no text/logos, portrait orientation — see chat history for exact
wording, or just ask the user, they were designed to match the slide's existing
teal-gradient-overlay aesthetic). **Waiting on the user to report back** with
which look/vendor they prefer before any integration code gets written.

Once a vendor is chosen: get the API key (same pattern as the others — env var
in Vercel, never in chat), decide the polling architecture if needed, and wire
it in as a fallback when `extractImage()` returns null (or possibly always, for
consistent branding — worth asking the user which).

## Next steps

1. Waiting on user's image-gen comparison results (item #7).
2. Once Vercel redeploys the latest fixes, a fresh "Generate posts" run should
   be checked for: no duplicate images across stories, cover renders as an
   actual collage, no headline-only slides, no story older than ~24h, and that
   re-running without approving still resurfaces the same stories (expected —
   only approval should suppress repeats).
3. Not built yet (from the original README): Monday round-up ranking logic
   (currently just swaps cover text, no real match-importance ranking), an
   analytics view, and a feed-health UI for surfacing failed feeds.
