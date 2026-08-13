'use client';

import { useEffect, useRef, useState } from 'react';
import Slide from '@/components/Slide';
import { captureSlide, downloadDataUrl } from '@/lib/capture';

// Turns a written slide's copy into the plain-text description the
// image generator uses to depict the real people and clubs in that story.
function slideText(slide) {
  const headline = (slide.headline_parts || []).map((p) => p.text).join(' ');
  return [headline, slide.body].filter(Boolean).join('. ');
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

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

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
  // THE RUN
  // Each step is its own short request. The browser drives the
  // sequence, which is what keeps every call inside Vercel's timeout.
  // Closing this tab mid-run abandons it -- nothing is saved until
  // the final step.
  // ---------------------------------------------------------------
  async function generate() {
    setRunning(true);
    setError('');
    try {
      setProgress('Fetching feeds…');
      const feedData = await post('/api/feeds', { topicSlug });

      if (!feedData.candidates.length) {
        throw new Error('No fresh stories found. Try again later.');
      }

      const failedNote = feedData.failedFeeds.length
        ? ` (${feedData.failedFeeds.length} feed(s) unavailable)`
        : '';
      setProgress(`Ranking ${feedData.candidates.length} stories${failedNote}…`);

      const isMonday = new Date().getDay() === 1;
      const { selected } = await post('/api/rank', {
        topicSlug,
        candidates: feedData.candidates,
        wanted: 7,
      });

      if (!selected.length) throw new Error('Ranking returned no stories.');

      const slides = [];
      for (let i = 0; i < selected.length; i += 1) {
        setProgress(`Writing story ${i + 1} of ${selected.length}…`);
        const { slide } = await post('/api/write', { topicSlug, story: selected[i] });

        // Not every feed item ships a usable photo. Rather than post a
        // black slide, generate one.
        if (!slide.image_url) {
          setProgress(`Generating an image for story ${i + 1} of ${selected.length}…`);
          const { image_url } = await post('/api/image', {
            role: 'story',
            context: slideText(slide),
          });
          slide.image_url = image_url;
        }

        slides.push({ ...slide, role: 'story' });
      }

      // Cover and CTA never had a photo of their own to reuse -- both
      // always get an AI-generated background now. The cover illustrates
      // the lead story so it's not just a generic stadium shot.
      setProgress('Generating cover image…');
      const { image_url: coverImage } = await post('/api/image', {
        role: 'cover',
        context: slideText(slides[0]),
      });

      const cover = {
        role: 'cover',
        headline_parts: isMonday
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
        image_url: coverImage,
      };

      setProgress('Generating closing image…');
      const { image_url: ctaImage } = await post('/api/image', { role: 'cta' });

      const cta = {
        role: 'cta',
        headline_parts: [
          { text: 'you may', key: false },
          { text: 'never', key: true },
          { text: 'find our page again if', key: false },
          { text: "you don't follow us", key: true },
        ],
        body: null,
        image_url: ctaImage,
      };

      setProgress('Writing caption and saving…');
      await post('/api/posts', {
        topicSlug,
        kind: isMonday ? 'weekend' : 'daily',
        slides: [cover, ...slides, cta],
      });

      setProgress('');
      await refresh();
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
      await fetch('/api/posts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId: activePost.id }),
      });
      setActivePost(null);
      setChatLog([]);
      await refresh();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function downloadAll() {
    if (!activePost) return;
    for (let i = 0; i < activePost.slides.length; i += 1) {
      const node = slideRefs.current[i];
      if (!node) continue;
      setProgress(`Rendering slide ${i + 1} of ${activePost.slides.length}…`);
      const dataUrl = await captureSlide(node);
      downloadDataUrl(dataUrl, `slide-${String(i + 1).padStart(2, '0')}.png`);
    }
    setProgress('');
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
            disabled={running}
          >
            <option value="soccer">European Soccer</option>
          </select>
          <button onClick={generate} disabled={running} style={S.primaryButton}>
            {running ? 'Generating…' : 'Generate posts'}
          </button>
        </div>
      </header>

      {progress && <div style={S.progress}>{progress}</div>}
      {error && <div style={S.error}>{error}</div>}
      {running && (
        <div style={S.warning}>
          Keep this tab open. Closing it cancels the run and nothing is saved.
        </div>
      )}

      {!activePost && (
        <>
          <section>
            <h2 style={S.sectionTitle}>Review queue</h2>
            {queue.length === 0 && <p style={S.empty}>Nothing waiting. Generate a post to start.</p>}
            <div style={S.grid}>
              {queue.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setActivePost(p); setActiveSlideIndex(0); setChatLog([]); }}
                  style={S.card}
                >
                  <div style={S.cardMeta}>
                    {p.kind === 'weekend' ? 'Weekend round-up' : 'Daily'} ·{' '}
                    {new Date(p.created_at).toLocaleDateString()}
                  </div>
                  <div style={S.cardHeadline}>
                    {p.slides?.[1]?.headline_parts?.map((x) => x.text).join(' ') || '—'}
                  </div>
                  <div style={S.cardMeta}>{p.slides?.length || 0} slides</div>
                </button>
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
                  <button onClick={approve} style={S.primaryButton}>Approve</button>
                )}
              </div>

              <pre style={S.caption}>{activePost.caption}</pre>
            </div>

            <div style={S.chatPanel}>
              <h3 style={S.sectionTitle}>Edit slide {activeSlideIndex + 1}</h3>
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
  primaryButton: { background: '#16A39B', color: '#04211F', border: 'none',
                   borderRadius: 8, padding: '10px 18px', fontSize: 14,
                   fontWeight: 600, cursor: 'pointer' },
  secondaryButton: { background: '#171B1C', color: '#E8ECEC', border: '1px solid #2a2f30',
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
  cardMeta: { fontSize: 12, color: '#6E7A7A', marginBottom: 6 },
  cardHeadline: { fontSize: 15, lineHeight: 1.35, marginBottom: 8 },
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
