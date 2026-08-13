'use client';

// One carousel slide at full Instagram size (1080 x 1350).
// Rendered off-screen at true size, then captured to PNG.
// The `scale` prop only shrinks it for on-screen preview -- capture
// always uses the unscaled element so the output is full resolution.

const SIZE = { width: 1080, height: 1350 };

function proxied(url) {
  // Route every external image through our own domain so the capture
  // canvas doesn't get tainted. See app/api/image-proxy/route.js.
  if (!url) return null;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

export default function Slide({
  slide,
  style,
  wordmark,
  scale = 1,
  captureRef,
}) {
  const accent = style?.accent || '#16A39B';
  const accentLight = style?.accentLight || '#3FD3C8';
  const accentDeep = style?.accentDeep || '#0B6B66';

  const isCover = slide.role === 'cover' || slide.role === 'cta';
  const image = proxied(slide.image_url);
  const collageUrls = slide.role === 'cover'
    ? (slide.image_urls || []).filter(Boolean).slice(0, 4)
    : [];

  // Grid layout per photo count: 1 = full bleed, 2 = side by side,
  // 3 = one large + two stacked, 4 = even 2x2.
  const collageGrid = {
    2: { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' },
    3: { gridTemplateColumns: '1.4fr 1fr', gridTemplateRows: '1fr 1fr', gridTemplateAreas: '"a b" "a c"' },
    4: { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' },
  }[collageUrls.length];
  const collageAreas = collageUrls.length === 3 ? ['a', 'b', 'c'] : [];

  const keyGradient = {
    backgroundImage: `linear-gradient(168deg, ${accentLight} 0%, ${accent} 38%, ${accentDeep} 72%, ${accent} 100%)`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    filter: 'drop-shadow(0 3px 0 rgba(0,0,0,.85))',
  };

  return (
    <div
      style={{
        width: SIZE.width * scale,
        height: SIZE.height * scale,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        ref={captureRef}
        style={{
          position: 'relative',
          width: SIZE.width,
          height: SIZE.height,
          background: '#000',
          overflow: 'hidden',
          fontFamily: "'Anton', Impact, sans-serif",
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {/* Photo fills the top 78%, fading to black behind the text */}
        <div style={{ position: 'absolute', inset: '0 0 auto 0', height: '78%' }}>
          {collageUrls.length > 1 ? (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', gap: 2, ...collageGrid }}>
              {collageUrls.map((url, i) => (
                <div
                  key={url}
                  style={{
                    gridArea: collageAreas[i],
                    backgroundImage: `url(${proxied(url)})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                />
              ))}
            </div>
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundImage: image ? `url(${image})` : 'none',
                backgroundColor: image ? undefined : '#111',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0) 46%, rgba(0,0,0,.55) 68%, rgba(0,0,0,.94) 88%, #000 100%)',
            }}
          />
        </div>

        {/* Story slides carry the wordmark top-right; covers centre it above the headline */}
        {!isCover && (
          <div
            style={{
              position: 'absolute',
              top: 26,
              right: 34,
              zIndex: 3,
              fontSize: 26,
              letterSpacing: '.24em',
              color: 'rgba(255,255,255,.88)',
              textTransform: 'uppercase',
              textShadow: '0 2px 10px rgba(0,0,0,.75)',
            }}
          >
            {wordmark}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2,
            padding: '0 42px 54px',
            textAlign: 'center',
          }}
        >
          {isCover && (
            <div
              style={{
                fontSize: 27,
                letterSpacing: '.26em',
                color: '#fff',
                textTransform: 'uppercase',
                margin: '0 0 24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 20,
                whiteSpace: 'nowrap',
                textShadow: '0 2px 10px rgba(0,0,0,.75)',
              }}
            >
              <span style={{ height: 2, width: 150, background: '#fff' }} />
              {wordmark}
              <span style={{ height: 2, width: 150, background: '#fff' }} />
            </div>
          )}

          <h2
            style={{
              fontSize: 104,
              lineHeight: 0.88,
              letterSpacing: '-.005em',
              textTransform: 'uppercase',
              margin: '0 0 26px',
              textAlign: 'center',
              transform: 'scaleX(.92)',
              transformOrigin: 'center',
              fontWeight: 400,
            }}
          >
            {slide.headline_parts?.map((part, i) => (
              <span key={i}>
                <span
                  style={
                    part.key
                      ? keyGradient
                      : { color: '#fff', filter: 'drop-shadow(0 3px 0 rgba(0,0,0,.85))' }
                  }
                >
                  {part.text}
                </span>{' '}
              </span>
            ))}
          </h2>

          {slide.body && (
            <p
              style={{
                fontFamily: "'Barlow Condensed', Arial, sans-serif",
                fontWeight: 700,
                fontSize: 37,
                lineHeight: 1.13,
                textTransform: 'uppercase',
                color: '#fff',
                margin: '0 auto',
                textShadow: '0 2px 5px rgba(0,0,0,.9)',
                maxWidth: '96%',
                textAlign: 'center',
              }}
            >
              {slide.body}
            </p>
          )}

          {slide.role === 'cover' && (
            <p
              style={{
                fontFamily: "'Barlow Condensed', Arial, sans-serif",
                fontWeight: 700,
                fontSize: 29,
                letterSpacing: '.16em',
                textTransform: 'uppercase',
                margin: '16px 0 0',
                textAlign: 'center',
                color: accentLight,
              }}
            >
              Swipe for more ›
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
