import { createClient } from '@supabase/supabase-js';

// Server-side client. Uses the service role key, which bypasses row
// level security -- fine here because only you use this app, and the
// key never leaves the server.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
