import { NextResponse } from 'next/server';
import { fetchResults } from '@/lib/results';

// Fetches finished matches from the last 7 days for the picker screen.
// The browser shows all of them and the user picks which become slides
// -- no automatic importance ranking, same manual-curation approach as
// the news picker.
export async function POST() {
  try {
    const matches = await fetchResults({ days: 7 });
    return NextResponse.json({ matches });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
