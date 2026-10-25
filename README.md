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
- **Weeks**: one row for **every draw** since 17 May 2025, newest first, led by the draw number
  (회차). Draws you didn't play are shown as *Not played* with a **+ Add** button. Total, fresh
  money, money from the pool, prize and tickets each have their own aligned, colour-coded column.
  On phones each draw becomes a compact card.
- **Tickets**: upload one or many photos per draw (each photo may show several tickets).
  Photos are resized to keep QR codes sharp and stamped with the upload time by the
  server. Each one shows **"✓ before draw"** if it was uploaded before 20:35 KST on draw day.
- **Investors**: per-person invested / won / net P/L, plus a leaderboard. Each investor has a
  **start date** (default 17 May 2025) and an **end date** (empty = still in). Add/Edit Week only
  lists investors whose dates cover that week. Click an investor to see **every draw** in their
  period, laid out like the Weeks list. Draws they skipped or the group didn't play are marked,
  and weeks where they have money outside their dates are highlighted, so mistakes are easy to
  find. **Per day** is fresh money ÷ days from their start date to today (or their end date),
  start day included, so it changes every day. It appears on the card, in the leaderboard and
  as a chart.
- **Weeks form shortcuts**: amounts show thousands separators as you type (`1,234,000`).
  Prize buttons **+5K / +10K / +50K** add to the prize (two 5th-prize tickets = +5K twice).
  Each investor has **5K / 10K**, which set the amount, and **−1K / +1K**, which adjust it.
- **Statistics**: headline numbers (return rate, win rate, biggest prize, average per draw,
  draws since the last win, longest dry spell) plus 10 charts:
  - invested vs. prizes won (running total), prize per draw, how often we win by prize size
  - prize pool balance, month by month
  - net P/L per investor, invested vs. received per investor, each investor's P/L over time
  - share of money invested, fresh investment per draw
- **Picks**: ranked suggestions of 6 numbers for the coming draw. They're not random:
  numbers are weighted by all-time and last-year frequency and by how overdue they are, and sets
  are kept only when they look like real winning draws (sum, odd/even, low/high, spread, repeats
  from last week). Sets many people would pick are avoided, so a win is shared less. The page
  says plainly that every set has the same 1 in 8,145,060 chance. It also shows a 1–45 frequency
  grid, hot / cold / overdue numbers, and a backtest over the last 100 draws against random sets.
  The full history of winning numbers is downloaded once by the `check-tickets` function.
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

## Automatic result check (ticket QR codes)

Every Lotto 6/45 ticket carries a Data Matrix, a PDF417 and a **QR code**. The QR code is a
link to that ticket's result page on dhlottery.co.kr.

1. **On upload**, the browser finds every lotto QR code in the photo (one photo can hold
   several tickets) and stores the links with the ticket. The other two codes are ignored.
   Pick the week by **draw number (회차) or date**; the two fill each other in. If the QR codes
   name a different draw, the photo is filed under the QR's draw. An older photo filed under
   the wrong week shows **"QR says #N"** and gets a **Move photo to draw #N** button in the
   viewer. The move is only allowed to the draw the QR names, and it is logged.
2. **After 20:50 KST on draw day**, the `check-tickets` Edge Function opens each link and
   reads the page:
   - "축하합니다! 총 5,000원 당첨" means **won ₩5,000**
   - "아쉽게도, 낙첨되었습니다." means **no win**
   - anything else means results aren't out yet, and it tries again later

   The first member who opens the site after the draw triggers the check. The scheduled
   workflow `.github/workflows/check-results.yml` also runs it on Saturday night and Sunday
   morning.
3. **Results show up everywhere.** Each photo gets a badge, and the Weeks list shows QR totals
   and warns if the recorded prize doesn't match. Add/Edit Week offers **"Use ₩X"**, and a new
   week starts with that amount.

**Human correction.** Open a photo in the **Tickets** tab. The panel under it lists every QR
code with its numbers and result. Any member can:
- change a result (won / no win / waiting) and its amount
- remove a wrong detection
- scan the photo again
- add a QR link by hand

Corrected codes are marked *corrected by hand* and the automatic check never overwrites them.
Every change is in the Activity log. A QR that appears in two photos is counted only once.

### One-time setup for the result check

1. **Update the database.** Run the latest [`supabase/schema.sql`](supabase/schema.sql) in the
   SQL Editor again. It adds the `draws` table for winning numbers and lets members correct
   QR results.
2. **Deploy the function.** Option A, the GitHub Action, is easiest and repeatable:
   1. Create a Supabase access token at <https://supabase.com/dashboard/account/tokens>.
      Give it **write access to Edge Functions** for this project, or full access.
      A read-only token fails with `Missing required permission(s): edge_functions_write`.
      A token's access can't be edited later, so make a new token instead.
   2. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
      Name it `SUPABASE_ACCESS_TOKEN` and paste the token.
   3. Open **Actions → Deploy result checker → Run workflow**. It deploys `check-tickets`
      with "Verify JWT" off, and its last step checks that the function answers. After that,
      it redeploys automatically whenever the function code changes.

   Option B is the Supabase dashboard: **Edge Functions → Deploy a new function → Via
   Editor**. Name it exactly `check-tickets`, paste
   [`supabase/functions/check-tickets/index.ts`](supabase/functions/check-tickets/index.ts),
   click **Deploy**, then turn **off "Verify JWT"** in its settings.
3. **Self-test.** Open `https://<your-project>.supabase.co/functions/v1/check-tickets` in a
   browser. It should show `"ok": true`.
   - `NOT_FOUND`: the function isn't deployed under that name.
   - `Missing authorization header`: "Verify JWT" is still on.
4. **Try it.** Open a photo whose draw is over and click **Check results now**.

**How a result is decided.** The function loads the draw's winning numbers from dhlottery's
public draw data and compares every game on the ticket (matched numbers, 1등–5등). It also
reads the ticket's own result page. The page's "축하합니다! 총 N원 당첨" or "낙첨되었습니다"
wins, and a disagreement with the numbers is flagged. If the page can't be read, the numbers
decide: no match means no win, and 4등/5등 means ₩50,000/₩5,000. For 1등–3등 the amount
varies, so it asks you to enter it from the result page.

---

## Project structure

```
645/
├── web/                     ← the website (published to GitHub Pages)
│   ├── index.html           ← page layout
│   ├── style.css
│   ├── app.js               ← all app logic (Supabase client, pool maths, UI)
│   └── config.js            ← Supabase URL + public key  ← edit this
├── web/vendor/            ← QR code reader (zxing-wasm, MIT)
├── supabase/
│   ├── schema.sql           ← tables, security rules, storage, realtime (run once)
│   └── functions/check-tickets/index.ts ← reads ticket result pages (Edge Function)
└── .github/workflows/
    ├── pages.yml            ← deploy web/ to GitHub Pages on push to main
    ├── keepalive.yml        ← keeps the free Supabase project awake
    └── check-results.yml    ← checks ticket results on Saturday night
```

### Staying signed in

A login stays on the device until **Sign out**, and Supabase sessions don't expire by
default. On iPhone, Safari may clear data for sites not opened in 7 days. Avoid this with
Share → **Add to Home Screen** (the site ships an app icon and manifest), then sign in once
inside the home-screen app.

### Running locally

```bash
python3 -m http.server -d web 8000
# open http://localhost:8000  (uses the same Supabase project as config.js)
```

### Upgrading the database later

`supabase/schema.sql` is safe to run again. It keeps existing data and re-applies
functions, policies and grants.
