# Touchline — post generator

Generates daily European football carousels for Instagram. You click a button,
it fetches news, writes the slides, and puts a draft in a review queue. You edit
via chat, approve, download the PNGs, and post them yourself.

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

Get a key from platform.openai.com. Used to generate the cover, the CTA,
and any story slide whose feed item had no usable photo. Your
organization must be verified (**Settings → Organization → Verify**)
before `gpt-image-1` will generate images — this is an OpenAI account
setting, not something this app can work around.

### 4. Local

```bash
npm install
cp .env.example .env.local     # then fill in the four values
npm run dev
```

Open http://localhost:3000

### 5. Deploy

Push to GitHub, import the repo at vercel.com, and add the same four
environment variables under **Settings → Environment Variables**. Deploy.

---

## How a run works

Clicking **Generate posts** kicks off a sequence of short requests, driven by
your browser:

| Step | Route | What it does |
|---|---|---|
| 1 | `/api/feeds` | Fetches all feeds in parallel, filters, dedupes |
| 2 | `/api/rank` | One Claude call picks the best stories |
| 3 | `/api/write` | One call per story — writes headline and body |
| 3b | `/api/image` | One call per image needed — the cover, the CTA, and any story slide whose feed item had no photo |
| 4 | `/api/posts` | Writes the caption, saves the draft to the queue |

Each request finishes well inside Vercel's timeout, except `/api/image` —
image generation genuinely takes 10-30s, so that route sets
`maxDuration = 60`. **Keep the tab open** — nothing is saved until step 4,
so closing it mid-run means starting over.

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

**Why generated images are generic.** `lib/images.js` prompts deliberately
avoid named athletes, club crests, and sponsor logos — a cover or CTA
slide trading on a real person's likeness or someone else's trademark is
a legal problem this account doesn't need. The images are photoreal
football mood shots (silhouettes, boot strikes, empty stadiums), not
depictions of anyone specific.

**Why generated images live in Supabase Storage, not the DB.** OpenAI's
image response is either a data URL or a base64 blob — neither is
something you want sitting in a text column or a temporary link that
expires. `lib/images.js` uploads the PNG to the `generated-images`
bucket and stores the public URL, same shape as any other `image_url`.

---

## Adding a topic

No code change needed — insert a row in `topics`:

```sql
insert into topics (slug, name, wordmark, style, feeds, ranking_rules)
values ('f1', 'Formula 1', 'Apex',
        '{"accent":"#D84A3A","accentLight":"#F58170","accentDeep":"#8C2519"}',
        '[{"name":"...","url":"...","lang":"en","league":"all"}]',
        'Rank by ...');
```

Then add the option to the dropdown in `app/page.jsx`, and add the new feeds'
image hosts to the allowlist in `app/api/image-proxy/route.js`.

Two things are still soccer-specific and would need generalising for a topic
where they don't apply: the keyword lists in `lib/filter.js`, and the Monday
round-up branch in `app/page.jsx`.

---

## Not built yet

- **Monday round-up content.** The cover slide switches to round-up wording on
  Mondays, but the match-importance ranking (club weight, goal count, rivalries)
  isn't implemented — Monday currently produces a normal news carousel with a
  different cover. It needs a results/fixtures source, not just RSS.
- **Analytics.** The dashboard shows the queue and history only.
- **Feed health UI.** Failed feeds are counted in the progress line but not
  listed anywhere you can act on.
