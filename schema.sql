-- Run this once in the Supabase SQL editor.
-- Dashboard > SQL Editor > New query > paste > Run.

-- ---------------------------------------------------------------
-- TOPICS
-- One row per subject you post about. Soccer is the first; adding
-- another topic later is an INSERT, not a code change.
-- The style column holds the visual theme so each topic can have
-- its own colours without a new template.
-- ---------------------------------------------------------------
create table topics (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,        -- 'soccer'
  name        text not null,               -- 'European Soccer'
  wordmark    text not null,               -- 'Touchline'
  style       jsonb not null default '{}', -- { accent, accentLight, accentDeep }
  feeds       jsonb not null default '[]', -- [{ name, url, lang, league }]
  ranking_rules text,                      -- plain-English newsworthiness rules
  created_at  timestamptz default now()
);

-- ---------------------------------------------------------------
-- POSTS
-- One row per carousel. status drives the whole workflow:
--   draft    -> being generated right now
--   queued   -> waiting for your review (max 3 kept)
--   approved -> reviewed, ready to publish manually
-- ---------------------------------------------------------------
create table posts (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references topics(id) on delete cascade,
  status      text not null default 'draft'
              check (status in ('draft','queued','approved')),
  kind        text not null default 'daily'
              check (kind in ('daily','weekend')),  -- weekend = Monday round-up
  caption     text,
  approved_at timestamptz,
  created_at  timestamptz default now()
);

create index posts_topic_status_idx on posts (topic_id, status, created_at desc);

-- ---------------------------------------------------------------
-- SLIDES
-- One row per image in the carousel. position 0 is the cover.
-- headline_parts stores the teal/white split as an ordered array:
--   [{ "text": "Liverpool", "key": true }, { "text": "agree", "key": false }]
-- 'key' true means it renders in the topic accent colour.
-- ---------------------------------------------------------------
create table slides (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  position       int not null,
  role           text not null default 'story'
                 check (role in ('cover','story','cta')),
  headline_parts jsonb not null default '[]',
  body           text,
  image_url      text,        -- original URL at the source (single fallback)
  image_urls     jsonb not null default '[]', -- cover-slide collage, up to 4 photo URLs
  source_name    text,        -- single credited outlet
  source_url     text,
  fingerprint    text,        -- story fingerprint, used by seen_stories
  created_at     timestamptz default now()
);

create unique index slides_post_position_idx on slides (post_id, position);

-- ---------------------------------------------------------------
-- SEEN_STORIES
-- Remembers what you've already posted so the same transfer saga
-- doesn't reappear three days running. Keyed by a hash of the
-- normalised headline.
-- ---------------------------------------------------------------
create table seen_stories (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid not null references topics(id) on delete cascade,
  fingerprint text not null,
  headline   text,
  seen_at    timestamptz default now()
);

create unique index seen_topic_fingerprint_idx on seen_stories (topic_id, fingerprint);

-- ---------------------------------------------------------------
-- STORAGE
-- Bucket for AI-generated slide backgrounds: the cover, the CTA, and
-- any story slide whose feed item had no usable photo. Public so the
-- browser can load them directly (through /api/image-proxy, same as
-- any other slide image) without needing a signed URL.
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('generated-images', 'generated-images', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- Seed the soccer topic
-- ---------------------------------------------------------------
insert into topics (slug, name, wordmark, style, feeds, ranking_rules) values (
  'soccer',
  'European Soccer',
  'Touchline',
  '{"accent":"#16A39B","accentLight":"#3FD3C8","accentDeep":"#0B6B66"}',
  '[
    {"name":"BBC Sport","url":"https://feeds.bbci.co.uk/sport/football/rss.xml","lang":"en","league":"all"},
    {"name":"Guardian Football","url":"https://www.theguardian.com/football/rss","lang":"en","league":"all"},
    {"name":"Get French Football News","url":"https://www.getfootballnewsfrance.com/feed","lang":"en","league":"ligue1"},
    {"name":"Get Italian Football News","url":"https://www.getfootballnewsitaly.com/feed","lang":"en","league":"seriea"},
    {"name":"Football Italia","url":"https://football-italia.net/feed","lang":"en","league":"seriea"},
    {"name":"Football Espana","url":"https://football-espana.net/feed","lang":"en","league":"laliga"},
    {"name":"Marca","url":"https://e00-marca.uecdn.es/rss/en/football/spanish-league.xml","lang":"en","league":"laliga"},
    {"name":"kicker","url":"https://newsfeed.kicker.de/news/bundesliga","lang":"de","league":"bundesliga"},
    {"name":"LEquipe","url":"https://dwh.lequipe.fr/api/edito/rss?path=/Football/","lang":"fr","league":"ligue1"}
  ]',
  'Rank by newsworthiness for a general European football audience.
- A completed deal outranks a rumour. "Signs for" beats "linked with".
- Bigger clubs outrank smaller ones. Champions League regulars outrank mid-table.
- First-team injuries outrank squad-player injuries. Long-term outranks a knock.
- Manager sackings and appointments rank very high.
- Derbies and historic rivalries outrank ordinary fixtures.
- Prefer stories a fan would not already have seen three days ago.
- Ignore: women''s football, lower divisions, non-big-five leagues, quizzes,
  podcasts, kit launches, and opinion columns without news in them.'
);
