'use client';

import { useEffect, useRef, useState } from 'react';
import Slide from '@/components/Slide';
import { captureAll, downloadDataUrl } from '@/lib/capture';
import { buildResultSlide } from '@/lib/results';

// The CTA slide is the same "follow us" prompt on every post, so it
// uses one fixed image rather than generating a new one each run --
// keeps the closing slide visually consistent and saves an image
// generation call. Swap this URL to change it account-wide.
const CTA_IMAGE_URL = 'https://bnasaybdlczxfbifezxz.supabase.co/storage/v1/object/public/generated-images/cta-1786647377181-o0dhbp.png';

// Turns a written slide's copy into the plain-text description the
// image generator uses to depict the real people and clubs in that story.
function slideText(slide) {
  const headline = (slide.headline_parts || []).map((p) => p.text).join(' ');
  return [headline, slide.body].filter(Boolean).join('. ');
}

// A full sentence makes a poor image-search query -- this pulls just the
// "key" headline parts (the club/player names writeSlide already flagged
// as the actual news), which is what someone would type into a search
// box themselves.
function searchQuery(slide) {
  return (slide.headline_parts || [])
    .filter((p) => p.key)
    .map((p) => p.text)
    .join(' ');
}

// News candidates are keyed by their story fingerprint, results by the
// match id from football-data.org -- both already unique per candidate.
function candidateKey(postType, c) {
  return postType === 'news' ? c.fingerprint : c.id;
}

function ageLabel(publishedAt) {
  const ms = publishedAt ? Date.now() - new Date(publishedAt).getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export default function Dashboard() {
  const [topicSlug, setTopicSlug] = useState('soccer');
  const [topic, setTopic] = useState(null);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);

  const [postType, setPostType] = useState('news');
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [failedFeeds, setFailedFeeds] = useState([]);

  const [activePost, setActivePost] = useState(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [chatLog, setChatLog] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  const slideRefs = useRef({});

  async function refresh() {
    try {
      const res = await fetch(`/api/posts?topic=${topicSlug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTopic(data.topic);
      setQueue(data.queue);
      setHistory(data.history);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  useEffect(() => { refresh(); }, [topicSlug]);

  // ---------------------------------------------------------------
  // STAGE 1: find candidates
  // News fetches feeds; results fetches finished matches from the
  // last 7 days. Either way this just populates the picker -- nothing
  // is written or generated until buildPost().
  // ---------------------------------------------------------------
  async function findCandidates() {
    setRunning(true);
    setError('');
    setFailedFeeds([]);
    setCandidates([]);
    setSelected(new Set());
    try {
      if (postType === 'news') {
        setProgress('Fetching feeds…');
        const feedData = await post('/api/feeds', { topicSlug });
        setFailedFeeds(feedData.failedFeeds);
        if (!feedData.candidates.length) {
          throw new Error('No fresh stories found. Try again later.');
        }
        setCandidates(feedData.candidates);
      } else {
        setProgress('Fetching results…');
        const { matches } = await post('/api/results', {});
        if (!matches.length) {
          throw new Error('No finished matches found in the last 7 days.');
        }
        setCandidates(matches);
      }
      setPicking(true);
      setProgress('');
    } catch (err) {
      setError(String(err.message || err));
      setProgress('');
    } finally {
      setRunning(false);
    }
  }

  function toggleSelect(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function cancelPicking() {
    setPicking(false);
    setCandidates([]);
    setSelected(new Set());
    setError('');
  }

  // ---------------------------------------------------------------
  // STAGE 2: build the post from whatever was picked
  // Each step is its own short request. The browser drives the
  // sequence, which is what keeps every call inside Vercel's timeout.
  // Closing this tab mid-run abandons it -- nothing is saved until
  // the final step.
  // ---------------------------------------------------------------
  async function buildPost() {
    const chosen = candidates.filter((c) => selected.has(candidateKey(postType, c)));
    if (!chosen.length) return;

    setRunning(true);
    setError('');
    try {
      const slides = [];
      const realImages = []; // real photos only (feed or search, never AI), for the cover collage
      for (let i = 0; i < chosen.length; i += 1) {
        let slide;
        if (postType === 'news') {
          setProgress(`Writing story ${i + 1} of ${chosen.length}…`);
          const { slide: written } = await post('/api/write', { topicSlug, story: chosen[i] });
          slide = written;

          if (slide.image_url) {
            realImages.push(slide.image_url);
          } else {
            // Not every feed item ships a usable photo. Try a real photo
            // via web image search first; only generate one with AI if
            // search comes up empty (or fails outright) too.
            setProgress(`Searching for a photo for story ${i + 1} of ${chosen.length}…`);
            let found = null;
            try {
              const { image_url } = await post('/api/image-search', { query: searchQuery(slide) });
              found = image_url;
            } catch {
              found = null;
            }

            if (found) {
              slide.image_url = found;
              realImages.push(found);
            } else {
              setProgress(`Generating an image for story ${i + 1} of ${chosen.length}…`);
              const { image_url } = await post('/api/image', {
                role: 'story',
                context: slideText(slide),
              });
              slide.image_url = image_url;
            }
          }
        } else {
          // football-data.org gives team names and a score, not a photo --
          // there's no real image to fall back to, so results slides skip
          // image generation entirely and render as a branded gradient
          // (see Slide.jsx) instead of an AI-generated stand-in.
          slide = buildResultSlide(chosen[i]);
        }
        slides.push({ ...slide, role: 'story' });
      }

      // The cover shows a collage of the real photos gathered above (up
      // to 4, however many were actually collected -- feed photos and
      // search results both count, AI-generated ones don't) rather than
      // any single story's image or a generated one. Results have no
      // real photo source at all, and a News run can end up with none
      // too if every story needed the AI fallback -- either way, fall
      // back to the lead slide's own image (the AI fallback for News, or
      // nothing for Results, which renders as the branded gradient --
      // see Slide.jsx).
      const collage = realImages.slice(0, 4);
      const cover = {
        role: 'cover',
        headline_parts: postType === 'results'
          ? [
              { text: 'the', key: false },
              { text: 'biggest matches', key: true },
              { text: 'of the', key: false },
              { text: 'weekend', key: true },
            ]
          : [
              { text: 'what just happened', key: true },
              { text: 'in', key: false },
              { text: 'european football', key: true },
              { text: 'today?', key: false },
            ],
        body: null,
        image_url: collage.length > 1 ? null : (collage[0] || slides[0]?.image_url || null),
        image_urls: collage.length > 1 ? collage : [],
      };

      const cta = {
        role: 'cta',
        headline_parts: [
          { text: 'you may', key: false },
          { text: 'never', key: true },
          { text: 'find our page again if', key: false },
          { text: "you don't follow us", key: true },
        ],
        body: null,
        image_url: CTA_IMAGE_URL,
      };

      const built = [cover, ...slides, cta];

      setProgress('Writing caption and saving…');
      const { post: savedPost } = await post('/api/posts', {
        topicSlug,
        kind: postType,
        slides: built,
      });

      // source_summary only ever exists in this in-memory `built` array --
      // it's deliberately not a slides column (see the api/write route),
      // so it has to be merged in now, by position, before it's gone for
      // good. Reopening this same post later (from the queue or history)
      // won't have it; this is the one moment it's available.
      const mergedSlides = savedPost.slides.map((s, i) => ({
        ...s,
        source_summary: built[i]?.source_summary || null,
      }));

      cancelPicking();
      setProgress('');
      // Drop straight into review instead of back to the queue list --
      // this also means the human can immediately compare the generated
      // body against the source (see the review panel below) while the
      // source text above is still available to show.
      setActivePost({ ...savedPost, slides: mergedSlides });
      setActiveSlideIndex(0);
      setChatLog([]);
      refresh(); // background -- keeps the queue list accurate for later, nothing here depends on it
    } catch (err) {
      setError(String(err.message || err));
      setProgress('');
    } finally {
      setRunning(false);
    }
  }

  async function sendChat() {
    if (!chatInput.trim() || !activePost) return;
    const slide = activePost.slides[activeSlideIndex];
    const message = chatInput.trim();

    setChatInput('');
    setChatBusy(true);
    const nextLog = [...chatLog, { role: 'user', content: message }];
    setChatLog(nextLog);

    try {
      const { result } = await post('/api/chat', {
        slideId: slide.id,
        history: chatLog,
        message,
      });

      if (result.action === 'ask') {
        setChatLog([...nextLog, { role: 'assistant', content: result.question }]);
      } else {
        setChatLog([...nextLog, { role: 'assistant', content: result.note || 'Updated.' }]);
        const updated = { ...activePost };
        updated.slides = [...updated.slides];
        updated.slides[activeSlideIndex] = {
          ...slide,
          headline_parts: result.headline_parts ?? slide.headline_parts,
          body: result.body ?? slide.body,
        };
        setActivePost(updated);
      }
    } catch (err) {
      setChatLog([...nextLog, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setChatBusy(false);
    }
  }

  async function approve() {
    if (!activePost) return;
    try {
      // Not using the post() helper -- this is a PATCH -- but the check it
      // does (res.ok) matters just as much here: without it, a failed
      // approval (e.g. this post was already deleted by the queue-trim
      // race) went completely unnoticed and the UI proceeded as if it
      // had succeeded.
      const res = await fetch('/api/posts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId: activePost.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
      setActivePost(null);
      setChatLog([]);
      await refresh();
    } catch (err) {
      setError(String(err.message || err));
      // The post may no longer exist server-side even though this tab
      // still shows it -- refresh the queue so it reflects reality
      // instead of leaving a stale, now-inaccurate list behind.
      await refresh();
    }
  }

  // Manually discard a queued draft -- e.g. one that's gone stale
  // waiting for review. Callable from a queue card or from the open
  // review screen; `postId` defaults to whatever's currently open.
  async function deletePost(postId = activePost?.id) {
    if (!postId) return;
    if (!window.confirm("Delete this draft? This can't be undone.")) return;
    try {
      const res = await fetch('/api/posts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
      if (activePost?.id === postId) {
        setActivePost(null);
        setChatLog([]);
      }
      await refresh();
    } catch (err) {
      setError(String(err.message || err));
      await refresh();
    }
  }

  async function downloadAll() {
    if (!activePost) return;
    try {
      // Keep each entry's original slide index alongside its node --
      // captureAll() only sees the filtered list, but filenames still
      // need to reflect true slide position even if a ref is missing.
      const entries = activePost.slides
        .map((_, i) => ({ index: i, node: slideRefs.current[i] }))
        .filter((e) => e.node);

      const dataUrls = await captureAll(
        entries.map((e) => e.node),
        (i, total) => setProgress(`Rendering slide ${i + 1} of ${total}…`)
      );

      dataUrls.forEach((dataUrl, i) => {
        downloadDataUrl(dataUrl, `slide-${String(entries[i].index + 1).padStart(2, '0')}.png`);
      });
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setProgress('');
    }
  }

  const S = styles;

  return (
    <main style={S.page}>
      <header style={S.header}>
        <div>
          <h1 style={S.title}>{topic?.name || 'Loading…'}</h1>
          <p style={S.subtitle}>{queue.length} in queue · {history.length} recent</p>
        </div>
        <div style={S.controls}>
          <select
            value={topicSlug}
            onChange={(e) => setTopicSlug(e.target.value)}
            style={S.select}
            disabled={running || picking}
          >
            <option value="soccer">European Soccer</option>
          </select>
          <div style={S.segment}>
            <button
              onClick={() => setPostType('news')}
              disabled={running || picking}
              style={{ ...S.segmentButton, ...(postType === 'news' ? S.segmentButtonActive : {}) }}
            >
              News
            </button>
            <button
              onClick={() => setPostType('results')}
              disabled={running || picking}
              style={{ ...S.segmentButton, ...(postType === 'results' ? S.segmentButtonActive : {}) }}
            >
              Results
            </button>
          </div>
          <button onClick={findCandidates} disabled={running || picking} style={S.primaryButton}>
            {running && !picking ? 'Finding…' : postType === 'news' ? 'Find stories' : 'Find results'}
          </button>
        </div>
      </header>

      {progress && <div style={S.progress}>{progress}</div>}
      {error && <div style={S.error}>{error}</div>}
      {failedFeeds.length > 0 && (
        <div style={S.warning}>
          {failedFeeds.map((f) => `${f.source}: ${f.error}`).join(' · ')}
        </div>
      )}
      {running && (
        <div style={S.warning}>
          Keep this tab open. Closing it cancels the run and nothing is saved.
        </div>
      )}

      {picking && !activePost && (
        <section>
          <div style={S.pickerHeader}>
            <h2 style={S.sectionTitle}>
              {postType === 'news' ? `Pick stories (${candidates.length} found)` : `Pick results (${candidates.length} found)`}
            </h2>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={cancelPicking} disabled={running} style={S.secondaryButton}>Cancel</button>
              <button onClick={buildPost} disabled={running || selected.size === 0} style={S.primaryButton}>
                {running ? 'Building…' : `Build post (${selected.size} selected)`}
              </button>
            </div>
          </div>

          <div style={S.pickerList}>
            {postType === 'news' ? candidates.map((c) => {
              const key = candidateKey(postType, c);
              const isSelected = selected.has(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleSelect(key)}
                  disabled={running}
                  style={{ ...S.pickerCard, ...(isSelected ? S.pickerCardSelected : {}) }}
                >
                  <div style={S.pickerCheck}>{isSelected ? '✓' : ''}</div>
                  <div>
                    <div style={S.cardHeadline}>{c.title}</div>
                    <div style={S.cardMeta}>{c.sourceName} · {ageLabel(c.publishedAt)}{!c.imageUrl ? ' · no photo' : ''}</div>
                    {c.summary && <div style={S.pickerSummary}>{c.summary}</div>}
                  </div>
                </button>
              );
            }) : candidates.map((c) => {
              const key = candidateKey(postType, c);
              const isSelected = selected.has(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleSelect(key)}
                  disabled={running}
                  style={{ ...S.pickerCard, ...(isSelected ? S.pickerCardSelected : {}) }}
                >
                  <div style={S.pickerCheck}>{isSelected ? '✓' : ''}</div>
                  <div>
                    <div style={S.cardHeadline}>
                      {c.homeTeam} {c.homeScore}-{c.awayScore} {c.awayTeam}
                    </div>
                    <div style={S.cardMeta}>
                      {c.competition}{c.matchday ? ` · Matchday ${c.matchday}` : ''} ·{' '}
                      {new Date(c.utcDate).toLocaleDateString()}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!activePost && !picking && (
        <>
          <section>
            <h2 style={S.sectionTitle}>Review queue</h2>
            {queue.length === 0 && <p style={S.empty}>Nothing waiting. Find stories or results to start.</p>}
            <div style={S.grid}>
              {queue.map((p) => (
                <div key={p.id} style={{ ...S.card, position: 'relative' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); deletePost(p.id); }}
                    title="Delete this draft"
                    style={S.cardDelete}
                  >
                    ×
                  </button>
                  <button
                    onClick={() => { setActivePost(p); setActiveSlideIndex(0); setChatLog([]); }}
                    style={S.cardOpen}
                  >
                    <div style={S.cardMeta}>
                      {p.kind === 'results' ? 'Results' : 'News'} ·{' '}
                      {new Date(p.created_at).toLocaleDateString()}
                    </div>
                    <div style={S.cardHeadline}>
                      {p.slides?.[1]?.headline_parts?.map((x) => x.text).join(' ') || '—'}
                    </div>
                    <div style={S.cardMeta}>{p.slides?.length || 0} slides</div>
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section style={{ marginTop: 40 }}>
            <h2 style={S.sectionTitle}>Recently approved</h2>
            {history.length === 0 && <p style={S.empty}>No approved posts yet.</p>}
            <div style={S.grid}>
              {history.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setActivePost(p); setActiveSlideIndex(0); setChatLog([]); }}
                  style={{ ...S.card, opacity: 0.7 }}
                >
                  <div style={S.cardMeta}>
                    Approved {p.approved_at ? new Date(p.approved_at).toLocaleDateString() : ''}
                  </div>
                  <div style={S.cardHeadline}>
                    {p.slides?.[1]?.headline_parts?.map((x) => x.text).join(' ') || '—'}
                  </div>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {activePost && (
        <section>
          <button onClick={() => setActivePost(null)} style={S.backButton}>← Back to queue</button>

          <div style={S.reviewLayout}>
            <div>
              <div style={S.thumbRow}>
                {activePost.slides.map((s, i) => (
                  <button
                    key={s.id || i}
                    onClick={() => setActiveSlideIndex(i)}
                    style={{
                      ...S.thumb,
                      borderColor: i === activeSlideIndex ? (topic?.style?.accent || '#16A39B') : '#2a2f30',
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>

              <Slide
                slide={activePost.slides[activeSlideIndex]}
                style={topic?.style}
                wordmark={topic?.wordmark}
                scale={0.42}
              />

              <div style={S.actionRow}>
                <button onClick={downloadAll} style={S.secondaryButton}>Download all slides</button>
                <button
                  onClick={() => navigator.clipboard.writeText(activePost.caption || '')}
                  style={S.secondaryButton}
                >
                  Copy caption
                </button>
                {activePost.status === 'queued' && (
                  <>
                    <button onClick={() => deletePost()} style={S.dangerButton}>Delete draft</button>
                    <button onClick={approve} style={S.primaryButton}>Approve</button>
                  </>
                )}
              </div>

              <pre style={S.caption}>{activePost.caption}</pre>
            </div>

            <div style={S.chatPanel}>
              <h3 style={S.sectionTitle}>Edit slide {activeSlideIndex + 1}</h3>
              {activePost.slides[activeSlideIndex]?.source_summary && (
                <div style={S.sourceBlock}>
                  <div style={S.sourceLabel}>Source</div>
                  {activePost.slides[activeSlideIndex].source_summary}
                </div>
              )}
              <div style={S.chatLog}>
                {chatLog.length === 0 && (
                  <p style={S.empty}>
                    Ask for changes — “make the headline punchier”, “shorten the body”,
                    “lead with the fee”.
                  </p>
                )}
                {chatLog.map((m, i) => (
                  <div key={i} style={m.role === 'user' ? S.chatUser : S.chatBot}>
                    {m.content}
                  </div>
                ))}
                {chatBusy && <div style={S.chatBot}>Thinking…</div>}
              </div>
              <div style={S.chatInputRow}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                  placeholder="Request a change…"
                  style={S.input}
                  disabled={chatBusy}
                />
                <button onClick={sendChat} disabled={chatBusy} style={S.primaryButton}>Send</button>
              </div>
            </div>
          </div>

          {/* Off-screen full-size copies used only for PNG capture.
              They must be rendered (not display:none) or the browser
              has nothing to photograph. */}
          <div style={S.captureStage} aria-hidden="true">
            {activePost.slides.map((s, i) => (
              <Slide
                key={`cap-${s.id || i}`}
                slide={s}
                style={topic?.style}
                wordmark={topic?.wordmark}
                scale={1}
                captureRef={(el) => { slideRefs.current[i] = el; }}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

const styles = {
  page: { maxWidth: 1180, margin: '0 auto', padding: '32px 24px 80px',
          fontFamily: 'system-ui, sans-serif', color: '#E8ECEC' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
            gap: 24, marginBottom: 28, flexWrap: 'wrap' },
  title: { fontSize: 26, margin: '0 0 4px', fontWeight: 600 },
  subtitle: { margin: 0, fontSize: 14, color: '#8B9797' },
  controls: { display: 'flex', gap: 12, alignItems: 'center' },
  select: { background: '#171B1C', color: '#E8ECEC', border: '1px solid #2a2f30',
            borderRadius: 8, padding: '10px 12px', fontSize: 14 },
  segment: { display: 'flex', background: '#171B1C', border: '1px solid #2a2f30',
             borderRadius: 8, padding: 3, gap: 2 },
  segmentButton: { background: 'none', border: 'none', color: '#8B9797',
                   borderRadius: 6, padding: '7px 14px', fontSize: 13.5,
                   fontWeight: 600, cursor: 'pointer' },
  segmentButtonActive: { background: '#16A39B', color: '#04211F' },
  primaryButton: { background: '#16A39B', color: '#04211F', border: 'none',
                   borderRadius: 8, padding: '10px 18px', fontSize: 14,
                   fontWeight: 600, cursor: 'pointer' },
  secondaryButton: { background: '#171B1C', color: '#E8ECEC', border: '1px solid #2a2f30',
                     borderRadius: 8, padding: '10px 16px', fontSize: 14, cursor: 'pointer' },
  dangerButton: { background: '#241416', color: '#e88', border: '1px solid #7a2a2a',
                  borderRadius: 8, padding: '10px 16px', fontSize: 14, cursor: 'pointer' },
  backButton: { background: 'none', border: 'none', color: '#8B9797',
                fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 20 },
  progress: { background: '#12211F', border: '1px solid #16A39B', color: '#3FD3C8',
              borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 14 },
  warning: { background: '#221D12', border: '1px solid #7a5c1e', color: '#e0b355',
             borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 14 },
  error: { background: '#241416', border: '1px solid #7a2a2a', color: '#e88',
           borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 14 },
  sectionTitle: { fontSize: 15, textTransform: 'uppercase', letterSpacing: '.08em',
                  color: '#8B9797', margin: '0 0 14px', fontWeight: 600 },
  empty: { color: '#6E7A7A', fontSize: 14 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 },
  card: { background: '#171B1C', border: '1px solid #2a2f30', borderRadius: 10,
          padding: 16, textAlign: 'left', cursor: 'pointer', color: '#E8ECEC' },
  cardOpen: { display: 'block', width: '100%', paddingRight: 26,
              background: 'none', border: 'none', margin: 0,
              textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' },
  cardDelete: { position: 'absolute', top: 10, right: 10, width: 22, height: 22,
                borderRadius: 6, border: '1px solid #2a2f30', background: '#1c2122',
                color: '#8B9797', fontSize: 15, lineHeight: 1, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  cardMeta: { fontSize: 12, color: '#6E7A7A', marginBottom: 6 },
  cardHeadline: { fontSize: 15, lineHeight: 1.35, marginBottom: 8 },
  pickerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  flexWrap: 'wrap', gap: 12, marginBottom: 14 },
  pickerList: { display: 'flex', flexDirection: 'column', gap: 8 },
  pickerCard: { display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%',
                background: '#171B1C', border: '1px solid #2a2f30', borderRadius: 10,
                padding: '14px 16px', textAlign: 'left', cursor: 'pointer', color: '#E8ECEC' },
  pickerCardSelected: { borderColor: '#16A39B', background: '#12211F' },
  pickerCheck: { width: 22, height: 22, borderRadius: 5, border: '1px solid #2a2f30',
                 flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                 fontSize: 14, color: '#3FD3C8', marginTop: 2 },
  pickerSummary: { fontSize: 13, color: '#8B9797', lineHeight: 1.45 },
  reviewLayout: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(280px,380px)', gap: 28 },
  thumbRow: { display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' },
  thumb: { width: 34, height: 34, borderRadius: 6, background: '#171B1C',
           border: '2px solid #2a2f30', color: '#E8ECEC', cursor: 'pointer', fontSize: 13 },
  actionRow: { display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' },
  caption: { background: '#171B1C', border: '1px solid #2a2f30', borderRadius: 10,
             padding: 16, marginTop: 16, fontSize: 13.5, lineHeight: 1.6,
             whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: '#C9D2D2' },
  chatPanel: { background: '#141819', border: '1px solid #2a2f30', borderRadius: 10,
               padding: 18, display: 'flex', flexDirection: 'column', height: 'fit-content' },
  sourceBlock: { background: '#0F1213', border: '1px solid #2a2f30', borderRadius: 8,
                 padding: '10px 12px', marginBottom: 14, fontSize: 13, lineHeight: 1.5,
                 color: '#9CACA5' },
  sourceLabel: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em',
                 color: '#6E7A7A', fontWeight: 700, marginBottom: 4 },
  chatLog: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
             maxHeight: 420, overflowY: 'auto' },
  chatUser: { background: '#12211F', borderRadius: 8, padding: '10px 12px', fontSize: 13.5 },
  chatBot: { background: '#1c2122', borderRadius: 8, padding: '10px 12px',
             fontSize: 13.5, color: '#C9D2D2' },
  chatInputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, background: '#0F1213', border: '1px solid #2a2f30', borderRadius: 8,
           padding: '10px 12px', color: '#E8ECEC', fontSize: 14 },
  captureStage: { position: 'absolute', left: -99999, top: 0, width: 1080 },
};
