# SixYardBox — post generator

Generates European football carousels for Instagram. You choose **News** or
**Results**, the app fetches candidates and shows them to you, you pick which
ones make the cut, and it writes the slides and puts a draft in a review
queue. You edit via chat, approve, download the PNGs, and post them yourself.

You curate every post by hand from a pool of candidates — ranking only
decides what the picker shows you, it never auto-builds a post. A **News**
post pulls stories from the last 7 days across the RSS feeds, ranks the
whole pool by newsworthiness, and shows you the top 100; a **Results** post
pulls finished matches from the last 7 days across the big-five leagues and
the Champions League. Either way, nothing gets written or generated until
you've picked which candidates to use.

---

## Setup

### 1. Supabase

1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste all of `schema.sql`, click **Run**.
   This creates the tables, seeds the soccer topic with its feeds, and
   creates the `generated-images` storage bucket used for AI-generated
   slide backgrounds.
3. Go to **Project Settings → Data API** and copy the Project URL.
4. Go to **Project Settings → API Keys** and copy the `service_role` key.

### 2. Anthropic

Get a key from console.anthropic.com. It needs credit on the account —
a run costs a few cents.

### 3. OpenAI

Get a key from platform.openai.com. Used to generate the cover and any
story/result slide that needs an image (the CTA uses one fixed image,
not this). Your organization must be verified (**Settings → Organization
→ Verify**) before `gpt-image-1` will generate images — this is an
OpenAI account setting, not something this app can work around.

### 4. football-data.org

Free API key from football-data.org/client/register. Used only for
**Results** posts — finished matches from the last 7 days across the
big-five leagues and the Champions League.

### 5. Local

```bash
npm install
cp .env.example .env.local     # then fill in the five values
npm run dev
```

Open http://localhost:3000

### 6. Deploy

Push to GitHub, import the repo at vercel.com, and add the same five
environment variables under **Settings → Environment Variables**. Deploy.

---

## How a run works

Two stages, both driven by short requests from your browser so nothing hits
Vercel's timeout.

**Stage 1 — find candidates.** Click **Find stories** (News) or **Find
results** (Results):

| Route | What it does |
|---|---|
| `/api/feeds` | News only. Fetches all feeds in parallel, filters, dedupes, drops anything already posted. Sorted newest-first, capped at 50. |
| `/api/results` | Results only. Fetches finished matches from the last 7 days across the big-five leagues and the Champions League from football-data.org. |

This populates a picker screen — check the ones you want, then click
**Build post**.

**Stage 2 — build the post** from whatever you picked:

| Route | What it does |
|---|---|
| `/api/write` | News only, one call per picked story — writes headline and body. Results slides are templated directly from the scoreline, no Claude call needed. |
| `/api/image` | One call per image needed — the cover, and any picked item that has no usable photo (every result, and any news story whose feed item had none). |
| `/api/posts` | Writes the caption, saves the draft to the queue. |

`/api/image` sets `maxDuration = 60` since image generation genuinely takes
10-30s. **Keep the tab open** during either stage — nothing is saved until
the final `/api/posts` call, so closing it mid-run means starting over.

---

## Things worth knowing

**Why the browser drives the run.** Vercel kills any single serverless request
after ~10 seconds on the free tier. A whole run takes a minute or two, so it's
split into many short calls instead of one long one.

**Why there's an image proxy.** Browsers won't let JavaScript read pixels from
an image loaded off another domain, which would break PNG capture. `/api/image-proxy`
re-serves the photo from your own domain so the capture works. Its allowlist
must include any host you add a feed for, or images from that source will 403.

**Why html-to-image and not html2canvas.** html2canvas doesn't support
`background-clip: text` and renders the accent words as solid blocks. This was
measured: html-to-image came within 0.12% of the browser's own rendering,
html2canvas was 4.90% off and visibly broken. Don't swap the library.

**Fonts must load before capture.** `lib/capture.js` waits on
`document.fonts.ready` and explicitly loads Anton and Barlow Condensed.
Skipping this produces slides in Arial.

**AI image generation is a fallback, not the default.** Most News feed
items ship a real photo (`extractImage()` in `lib/feeds.js`), which is
used as-is — `lib/images.js` / `/api/image` only gets called for a News
story slide when its feed item genuinely had no usable photo. The cover
slide never generates its own image either: it shows a collage (up to 4,
via the `image_urls` column and `Slide.jsx`'s grid layouts) of whichever
real feed photos were collected from the picked stories, falling back to
a single image (the AI fallback for News, if that's all there is) or a
branded gradient background when fewer than 2 real photos were
available. Results slides (templated from a football-data.org scoreline,
not an RSS item) never have a photo to begin with, so they — and a
Results post's cover — skip image generation entirely and always render
the gradient (`accent`/`accentLight`/`accentDeep` from `topics.style`).

**When it does generate an image, it names real players, clubs, crests,
and sponsors on purpose.** `lib/images.js` builds the prompt straight
from the slide's own headline and body, and explicitly asks for the real
people, kits, crests, and sponsor branding involved — a deliberate
choice to maximize realism, made knowingly accepting the tradeoffs:
real-person likeness without consent raises publicity-rights exposure,
real crests/logos raise trademark exposure, and OpenAI's own usage
policy restricts photorealistic real people and brand logos, so
`gpt-image-1` may refuse or alter these prompts unpredictably — when
that happens, `generateSlideImage()` retries once with a generic,
no-real-names prompt rather than failing the whole run. Exact kit
pattern and sponsor logo placement change every season and are the
detail most likely to come out wrong, so the prompt explicitly asks for
correct team *colours* first, exact kit detail second. The CTA doesn't
go through any of this — it's one fixed, hand-picked image
(`CTA_IMAGE_URL` in `app/page.jsx`), not generated per run.

**Why generated images live in Supabase Storage, not the DB.** OpenAI's
image response is either a data URL or a base64 blob — neither is
something you want sitting in a text column or a temporary link that
expires. `lib/images.js` uploads the PNG to the `generated-images`
bucket and stores the public URL, same shape as any other `image_url`.

---

## Adding a topic

Mostly no code change — insert a row in `topics`:

```sql
insert into topics (slug, name, wordmark, style, feeds)
values ('f1', 'Formula 1', 'Apex',
        '{"accent":"#D84A3A","accentLight":"#F58170","accentDeep":"#8C2519"}',
        '[{"name":"...","url":"...","lang":"en","league":"all"}]');
```

(`ranking_rules` feeds `lib/claude.js`'s `rankStories()`, which orders the
picker's candidate list by newsworthiness — plain English works fine, see
the `soccer` topic's row for an example. Leaving it null is fine too;
`rankStories()` falls back to a generic "bigger clubs and completed news
outrank smaller clubs and rumours" rule for that topic.)

Then add the option to the dropdown in `app/page.jsx`, and add the new feeds'
image hosts to the allowlist in `app/api/image-proxy/route.js`.

Three things are still soccer-specific and would need generalising for a
topic where they don't apply: the keyword lists in `lib/filter.js`, the
Results flow (`lib/results.js` is hardcoded to football-data.org's
big-five-plus-Champions-League competition codes), and the cover/CTA copy
in `app/page.jsx`.

---

## Not built yet

- **Analytics.** The dashboard shows the queue and history only.
- **Feed health UI.** Failed feeds are counted in the picker screen but not
  listed anywhere you can act on.
- **Results picker has no importance signal.** Every finished match in the
  window is shown with no ranking or highlighting of the bigger games — you
  do that filtering by eye. Could add derby/rivalry or table-position
  weighting later if picking through a full week's matches gets tedious.
