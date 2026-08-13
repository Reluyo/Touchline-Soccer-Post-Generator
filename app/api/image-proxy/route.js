import { NextResponse } from 'next/server';

// WHY THIS EXISTS
// -----------------------------------------------------------------
// Browsers refuse to let JavaScript read the pixels of an image that
// was loaded from another domain. The canvas becomes "tainted" and
// any attempt to export it throws a SecurityError.
//
// Our slide backgrounds come from bbc.co.uk, marca.com and friends,
// so capturing a slide directly would fail every time.
//
// The fix: our own server downloads the image and re-serves it from
// our domain. The browser now sees a same-origin image and lets the
// capture proceed.
//
// Usage in markup:  /api/image-proxy?url=<encoded original url>

const ALLOWED_HOSTS = [
  'ichef.bbci.co.uk', 'bbci.co.uk',
  'i.guim.co.uk', 'media.guim.co.uk',
  'phantom-marca.uecdn.es', 'e00-marca.uecdn.es',
  'getfootballnewsfrance.com', 'www.getfootballnewsfrance.com',
  'getfootballnewsitaly.com', 'www.getfootballnewsitaly.com',
  'football-italia.net', 'football-espana.net',
  'derivates.kicker.de', 'kicker.de',
  'medias.lequipe.fr',
];

// Generated slide backgrounds live in our own Supabase Storage bucket
// (see lib/images.js), so that project's host is always trusted --
// no need to hardcode it alongside the news outlets below.
function supabaseHost() {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
  } catch {
    return null;
  }
}

function hostAllowed(hostname) {
  if (hostname === supabaseHost()) return true;
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

export async function GET(request) {
  const raw = request.nextUrl.searchParams.get('url');
  if (!raw) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'Malformed url' }, { status: 400 });
  }

  if (target.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only https is allowed' }, { status: 400 });
  }

  // Without this allowlist the route would happily fetch anything on
  // the internet on request -- an open proxy anyone could point at
  // internal addresses. Keep it restrictive.
  if (!hostAllowed(target.hostname)) {
    return NextResponse.json({ error: `Host not allowed: ${target.hostname}` }, { status: 403 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; TouchlineBot/1.0)' },
      signal: AbortSignal.timeout(7000),
    });

    if (!upstream.ok) {
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return NextResponse.json({ error: 'Not an image' }, { status: 415 });
    }

    const body = await upstream.arrayBuffer();

    return new NextResponse(body, {
      headers: {
        'content-type': contentType,
        // Cache hard: the same slide gets re-rendered on every edit,
        // and there's no reason to re-download the photo each time.
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 502 });
  }
}
