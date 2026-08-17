import { NextResponse } from 'next/server';

// WHY THIS EXISTS
// -----------------------------------------------------------------
// Every route in this app -- including the ones that make billed
// Anthropic/OpenAI/Brave calls -- was reachable by anyone who found the
// Vercel URL, with zero credential check anywhere (see AUDIT.md, C-1).
// This is a single-operator tool, so full multi-user auth would be
// overkill; a shared password behind the browser's native Basic Auth
// prompt is the smallest fix that actually closes the hole. Once the
// browser has the credential it attaches it automatically to every
// same-origin request -- page loads, fetch() calls from app/page.jsx,
// and the <img>/background-image requests to /api/image-proxy -- so
// nothing else in the app needs to change.
//
// Fails OPEN (no gate) if APP_PASSWORD isn't set, so a deploy that
// forgot to configure it doesn't lock the owner out -- but that also
// means the fix does nothing until the env var is actually set in
// Vercel. See README.md's Setup section.

function unauthorized() {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="SixYardBox", charset="UTF-8"' },
  });
}

export function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return unauthorized();

  let suppliedPassword;
  try {
    // Edge runtime -- atob is the standard global, no Buffer needed.
    suppliedPassword = atob(encoded).split(':').slice(1).join(':');
  } catch {
    return unauthorized();
  }

  if (suppliedPassword !== password) return unauthorized();

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
