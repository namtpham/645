# 645 — Group Lotto 6/45 Tracker

A private web app for a small group (≤ 10 people) that invests together in the Korean
**Lotto 6/45** (drawn every Saturday). It tracks who put in how much, how prizes are
shared, keeps small wins in a prize pool for re-investing, and stores **photos of the
tickets** before each draw for transparency and fairness.

**Live site:** <https://namtpham.github.io/645/>

---

## How it works

GitHub Pages can only host static files. It can't run a server or save data. So the
app is split in two:

```
 Browser ──► https://namtpham.github.io/645/   (GitHub Pages: HTML/CSS/JS in web/)
    │
    └──────► Supabase (free tier)              login, database, photo storage, live sync
              └─ all permissions enforced here by Row Level Security (supabase/schema.sql)
```

The code (and the Supabase "anon/publishable" key in `web/config.js`) is public by design.
Nobody can read or change any data without an account, and accounts can only be created
with an invitation key from the admin.

### Features

- **Dashboard**: this week's draw number, countdown to the 20:00 KST sales close,
  ticket photos uploaded so far, prize pool, totals, recent weeks.
- **Weeks**: per-draw investments, use of the prize pool, prize won, and live percentage preview.
- **Tickets**: upload one or many photos per draw (each photo may show several tickets).
  Photos are resized to keep QR codes sharp and stamped with the upload time by the
  server. Each one shows **"✓ before draw"** if it was uploaded before 20:35 KST on draw day.
- **Investors**: per-person invested / won / net P/L, plus a leaderboard.
- **Charts**: prize history, P/L, pool balance, investment share, weekly stacked contributions.
- **Activity log**: every add/edit/delete by every member, with old → new values. It can't be edited.
- **Currency**: KRW by default. Pick from popular currencies (₩ $ ₫ ¥ ฿ € …) or any ISO
  currency, and choose how it is displayed (₩12,000 / KRW 12,000 / 12,000 South Korean won).
- **Live sync**: every open browser updates instantly when someone changes something.

### Who can do what

| Action | Member | Admin |
|---|:-:|:-:|
| View everything (dashboard, weeks, tickets, charts, activity) | ✅ | ✅ |
| Add / edit investors and weekly numbers | ✅ | ✅ |
| Upload ticket photos | ✅ | ✅ |
| Delete ticket photos | ❌ | ✅ |
| Delete weeks | ❌ | ✅ |
| Change title / currency / big-win threshold | ❌ | ✅ |
| Create invitations, revoke or restore members, reset passwords | ❌ | ✅ |
| Change own display name and password | ✅ | ✅ |

---

## One-time setup (about 10 minutes)

### 1. Create the Supabase project

1. Sign up at <https://supabase.com> (free) and click **New project**.
   Choose the region **Northeast Asia (Seoul)**, and save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql),
   and click **Run**.
3. The result panel shows an **`admin_invite_key`** like `Q5EU-FFMW-MMQD`. Copy it. It is
   valid for 1 day. If it expires, just run the script again to get a new one.

### 2. Configure Supabase Auth

In **Authentication → Sign In / Providers → Email**:

- Turn **OFF "Confirm email"**. *(Required.)* Members sign in with a username, not a real
  e-mail address, so a confirmation mail could never arrive.
- Keep **"Allow new users to sign up"** ON. This is safe: the database rejects every
  sign-up that doesn't carry a valid, unused invitation key.
- Optional: set the minimum password length to 8.

In **Authentication → URL Configuration**, set **Site URL** to `https://namtpham.github.io/645/`.

### 3. Connect the site to Supabase

Open **Project Settings → API Keys** (or the **Connect** button) and copy:

- the **Project URL**, e.g. `https://abcdefgh.supabase.co`
- the **anon** key, or the newer **publishable** key (`sb_publishable_…`)

Put both into [`web/config.js`](web/config.js) and commit.
**Never** put the `service_role` / secret key there.

### 4. Publish on GitHub Pages

1. GitHub Pages on a free GitHub plan only works for **public** repositories. Either make
   this repo public (**Settings → General → Danger Zone → Change visibility**), or use a
   paid plan. Making it public is fine: there are no secrets in the code. All data lives
   in Supabase behind logins.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow `.github/workflows/pages.yml` publishes `web/` to
   <https://namtpham.github.io/645/>. Watch the progress in the **Actions** tab.

### 5. Create your admin account

Open the site, choose **Join with invite**, paste the admin key, then pick your username and
password. You are now the admin.

### 6. (Optional) Bring over old data

If you used the earlier Lucky Pool server, go to **Settings → Data → Import old
pool_data.json**. Investors and weeks keep their IDs, so the import can be repeated safely.

---

## Day-to-day admin

### Inviting a friend

**Settings → Invitations → "Who is it for?" → Create invitation.** You get a key such as
`7KQM-W3ZD-P9TX` and a link like
`https://namtpham.github.io/645/#invite=7KQM-W3ZD-P9TX`. Send the link privately
(for example a KakaoTalk direct message). Your friend opens it, picks a username and
password, and is in.

- Each key works **once** and expires after the period you chose (default 7 days).
- You can **Cancel** a key that hasn't been used yet.
- The key is only in the part of the link after `#`, which browsers never send to any server.

### Someone quits

**Settings → Members & access → Revoke access.** It takes effect immediately, even on a
phone where they are still signed in, because every database request checks their status.
Their past data (investments, uploads, activity) stays. **Restore** lets them back in.

### Someone forgot their password

There is no e-mail, so the admin resets it. Go to **Settings → Members & access → Reset
password**. A random temporary password is shown. Send it to them, and they change it under
**Settings → Change Password**.

---

## Security notes

The goal is "solid for a small private group", not bank-grade.

- **Invitation-only accounts**, enforced inside the database (trigger on `auth.users`), not by the web page.
- **Row Level Security** on every table and on the photo bucket. Revoked users get nothing.
- **Members can't delete or overwrite** ticket photos. There is no update policy on the
  storage bucket, and the upload time and uploader are set by the server.
- **Activity log** written by database triggers, so members can't edit or erase it.
- **Private photo bucket**: images are served through signed links that expire after 1 hour.
- **Passwords** are hashed by Supabase Auth (bcrypt). Supabase also rate-limits sign-in attempts.
- **Strict Content-Security-Policy**: no inline scripts, and connections only to Supabase.
  All user text is escaped.
- The page is marked `noindex`, so search engines won't list it. Keeping the link private
  helps, but the real protection is the login.

What to keep in mind:

- Anyone who has the link can see the sign-in page. They can't get in without an account.
- If you suspect a password leaked, revoke that member and invite them again, or reset
  their password.
- Supabase's dashboard (your Supabase login) has full access. Protect it with a strong
  password and 2FA.

---

## Prize pool rules

Each week, members contribute fresh money. Each person's **effective percentage** is their
share of that week's total.

For every prize, the week form has a switch: **🏦 Add to prize pool** or **💸 Share to
investors now**. The default comes from the *big win threshold* (₩100,000 unless changed in
Settings). Smaller prizes default to the pool and larger ones to sharing, but you can choose
either for any week.

- **Added to pool** (e.g. 5th prize ₩5,000): the prize goes into the **prize pool**,
  remembering each investor's percentage from that week.
- **Using the pool**: when a later week uses money from the pool, that money is credited
  back to the original owners in proportion to their shares. Fresh money is added on top,
  and the week's percentages are recalculated.
- **Shared** (e.g. 3rd prize, or a ₩50,000 win you decided to split): paid out directly to
  that week's investors by percentage. It does not go into the pool.

The pool is recalculated by replaying every week in date order, so editing an old week
always gives consistent numbers.

---

## Free-tier limits

| Supabase free tier | What it means here |
|---|---|
| 500 MB database | Effectively unlimited for this app |
| 1 GB file storage | About 2,000+ ticket photos (≈ 300–600 KB each after resizing) |
| Pauses after 7 days idle | Prevented by `.github/workflows/keepalive.yml`, which pings twice a week |

---

## Next phase: automatic result check (planned)

Each Lotto 6/45 ticket has a QR code linking to the official result checker. The plan:

1. On upload, read every QR code in the photo in the browser and store the payloads in
   `tickets.qr_data`. That column is already in the schema.
2. A scheduled Supabase Edge Function runs every Saturday after **20:50 KST**, fetches the
   winning numbers, checks each ticket, and writes `tickets.result`.
3. The dashboard shows each ticket's result and suggests the week's prize amount.

---

## Project structure

```
645/
├── web/                     ← the website (published to GitHub Pages)
│   ├── index.html           ← page layout
│   ├── style.css
│   ├── app.js               ← all app logic (Supabase client, pool maths, UI)
│   └── config.js            ← Supabase URL + public key  ← edit this
├── supabase/
│   └── schema.sql           ← tables, security rules, storage, realtime (run once)
└── .github/workflows/
    ├── pages.yml            ← deploy web/ to GitHub Pages on push to main
    └── keepalive.yml        ← keeps the free Supabase project awake
```

### Running locally

```bash
python3 -m http.server -d web 8000
# open http://localhost:8000  (uses the same Supabase project as config.js)
```

### Upgrading the database later

`supabase/schema.sql` is safe to run again. It keeps existing data and re-applies
functions, policies and grants.
