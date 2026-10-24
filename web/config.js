// ─── 645 configuration ──────────────────────────────────────────────────────
// Fill in from Supabase → Project Settings → API (or "Connect" → App Frameworks).
// Both values are public by design: what users can see and do is enforced by the
// Row Level Security rules in supabase/schema.sql, not by keeping these secret.
// NEVER put the "service_role" / "secret" key here.
window.APP_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY',

  // Members sign in with a username. Behind the scenes it becomes the login e-mail
  // "<username>@<authEmailDomain>". No e-mail is ever sent. Don't change this after
  // people have joined, or their usernames will stop working.
  authEmailDomain: 'namtpham.github.io',
};
