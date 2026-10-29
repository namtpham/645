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
  draws since the last win, longest dry spell) plus 11 charts:
  - invested vs. prizes won (running total), prize per draw, how often we win by prize size
  - prize pool balance, month by month
  - net P/L per investor, invested vs. received per investor, each investor's P/L over time
  - share of money invested, fresh investment per draw
  - **odd vs even draws (회차)**: spent, won, money back per ₩1,000 and how often we win, for
    odd- and even-numbered draws. It also reports how often a gap that big appears when the same
    draws are split into two groups at random, which tells luck from a real pattern.
- **Picks tab** has five sections: **✍️ Picks** (our own numbers), **🛒 Buy** (who buys, and QR
  codes for the shop), **🎯 Suggestion** (the engine's ranked sets, number statistics, backtest),
  **🕰️ Simulation** (a past week) and **📺 Live** (follow the draw). The section you last opened is remembered on that device.
- **Our numbers** (✍️ Picks): we pick the coming draw's numbers together.
  - Choose how many groups of 6 we play (quick buttons 5–30, ±1).
  - Each group shows 45 round buttons: gray = free, coloured = taken. Every member has their
    own colour. The buttons are shuffled by default (so nobody picks a row or diagonal of a
    1–45 grid, which many players do); **🔀 Random / 🔢 Sorted** switches each group, keeps the
    chosen numbers, and is remembered on that device. Complete groups have a green frame and
    **✓ Complete**; unfinished ones a dashed amber frame with how many are still to pick. Tap a number to add it; tap it again to take it back. Only the person who
    picked a number (or an admin) can take it back.
  - **🤖 +1** and **🤖 Fill the rest** ask the suggestion engine to pick around the numbers
    already chosen (purple, marked "asked by" whoever pressed it).
  - **➕ Add to picks** on any suggestion puts it into the first empty group (or a new group).
    With your own numbers typed in Suggestion, those stay yours and the rest are the engine's.
  - **Our tickets** sits at the top, above the group pickers, so the week's numbers are the first
    thing you see: one row per group that has numbers (empty groups are left out), with
    **Copy complete groups**. A complete group can also get a score on the same scale as the
    ranked suggestions; stars and scores are hidden until you press **⭐ Show scores**
    (remembered on that device).
  - **Bought by …:** when a ticket photo for that draw is uploaded, its QR games are compared
    with our groups. The same 6 numbers, or the closest group with at least 5 in common, is
    marked **🛒 Bought by** whoever uploaded it (a 5-of-6 match also says which number differs).
    Games that match no group are added to Our tickets as extra rows, so the list is the union of
    what we chose on the site and what was really bought. Only bought tickets get a blue frame,
    a blue background and a **🛒 Bought · name** label, in the list and on the group card; the
    rest stay plain.
  - **Focus while copying:** tap a row of Our tickets that isn't bought yet and everything else on the page is dimmed,
    so you copy the right numbers onto the slip. Tap another row to move the focus, the same row
    again (or anywhere else, or Esc) to go back to normal.
  - Changes show up live on every member's screen. Needs the database update below
    (run `supabase/schema.sql` again).
- **Picks**: ranked suggestions of 6 numbers for the coming draw. They're not random. The main
  lever is avoiding numbers that many people pick, so a 1등–3등 win is shared with fewer people
  (see [How good are the picks?](#how-good-are-the-picks)). Sets also keep the shape of real
  winning draws (sum, odd/even, low/high, spread, repeats from last week), with a small weight
  for all-time and last-year frequency. The page says plainly that every set has the same
  1 in 8,145,060 chance. **Number statistics** cover the last 6 months, 1 year, 2 years or all
  time (one button each), sorted by number or by how often each came up, with tables of hot,
  cold and overdue numbers and hot pairs (their counts, and what chance alone would give). A
  backtest replays the last 100 draws against random sets. The full history of winning numbers is
  downloaded once by the `check-tickets` function.
  - **Only some numbers:** choose **Numbers to suggest** = 1–5 to get just that many, ranked;
    dashed **?** circles are the ones you pick yourself. Under **Your own numbers** you can enter
    up to 5 numbers you already like; suggestions are then built around them (gold rings), and
    **All N left** fills the rest. The choice is remembered on that device.
- **🛒 Buy** (Picks tab): QR codes to show at the shop.
  - **Who buys:** **🙋 I buy** gives you a slider over all groups 1–m. Slide it to the last group
    you buy (say 13) and a new buyer gets 14–m with their own slider; slide that one and the rest
    goes to another new buyer, and so on. Each buyer's part starts right after the one above, so
    ranges never overlap or leave a gap; a coloured bar on top shows the split. Pick who each buyer
    is from the menu (a new one is someone not buying yet, or "Choose who…"); ✕ hands a buyer's
    groups to the one above. Saved with the week's picks, so everyone sees it.
  - **Reminder:** until sales close, the Dashboard tells each buyer what they still have to buy
    (games, amount, time left) with a button to their QR codes, and tells everyone when nobody
    is set to buy yet.
  - **QR codes:** each buyer gets codes for their complete groups that aren't bought yet, at most
    20 games per code (your own first). Tap one to show it full screen (the screen stays on while it is shown); **Numbers and QR text**
    lists the games and the exact text. Incomplete and already-bought groups are listed, not coded.
  - **Format:** the mobile-slip text that slip apps such as LottoMate produce:
    `MSG_ESLIP{10645}{(5,M:081114233145,…)(1,M:…)}{}6B|`. Each game is its 6 numbers sorted, two
    digits each, after `M:`; games go in slips of up to 5 as `(count,…)`; the last two characters
    before `|` are a CRC-8 (polynomial 0x07, start 0, no reflection, no final XOR) of everything
    from `MSG_ESLIP` up to and including `{}`. This reproduces the known samples exactly
    (`node tools/eslip-check.mjs` checks them); we can't test a real shop terminal, so keep the
    numbers handy as a backup.
  - A tool that compared our codes with another QR maker's (LottoMate) confirmed they match; it is
    switched off but kept, commented out, in `index.html`, `app.js` and `style.css`.
- **📺 Live** (Picks tab): while watching the draw, tap each number as it comes out (the 7th
  is the bonus). The taps are shared: every member sees the same numbers in real time and anyone
  can tap (needs the database update: run `supabase/schema.sql` again, which adds `live_picks`;
  until then the taps stay on your device). Our tickets (as bought) are ranked on the left by how many numbers they match,
  the system's top suggestions (as many as our tickets) on the right, with 등수 and prizes once 6
  numbers are in. It works any time for fun: outside Saturday 20:00–24:00 KST it is a test and
  clears itself after 10 minutes without a tap. When the official result is downloaded, it
  replaces the tapped numbers (**Get official result** asks for it after 20:50 KST).
- **Simulate a past week** (Picks tab): choose a draw by number or by any date. A Sunday counts
  toward the coming Saturday; Monday–Saturday count toward that week's Saturday. The
  suggestions are made only from the draws before it, exactly as they would have been that week.
  - **Groups:** the number of ₩1,000 sets defaults to 5 × the members active that week. Quick
    buttons set 5–30 or ±1, and **− / +** on each row takes a set any number of times.
  - **Reveal results:** shows the winning numbers, each set's 등수 and prize, the total won and
    the profit. 4등/5등 are fixed amounts. 1등–3등 use that draw's real prize when dhlottery's
    data has it; otherwise a typical amount marked ≈ is used.
- **Languages**: English, 한국어 and Tiếng Việt (Settings → Language, or the 🌐 menu on the sign-in
  page; first visit follows the phone's language). Dates follow the language too. The app is
  written in English and `web/i18n.js` translates the page as it is drawn, using the table in
  `web/i18n-dict.js` (add a row there to translate something new; anything missing stays English).
- **Notifications** (Settings → 🔔 Notifications, per device): the Saturday result as soon as it
  is out: **every result**, **when we win** (any prize) or **big wins only** (4등 or better), in
  the member's language. Sent by the `check-tickets` function, which runs from 20:57 KST on
  Saturdays (scheduled workflow) and whenever a member opens the site after the draw; each device
  is told about each draw once. **Send a test** checks it works. Android and computers: Chrome,
  Edge, Firefox. iPhone/iPad (iOS 16.4+): add 645 to the Home Screen first and turn it on from
  there. Signing out turns notifications off on that device. No keys to set up: the function makes
  its own key pair on first use and keeps the private half in the `push_keys` table.
- **Screen stays on** while a QR code is shown full screen and while 📺 Live is open.
- **Light on data**: a live update reloads only the table that changed, the draw history is
  downloaded once per visit, and photo links are kept for a day so the browser shows photos
  from its cache.
- **Activity log**: every add/edit/delete by every member, with old → new values. It can't be edited.
  Deleting a ticket photo (admins only) asks why: duplicate, QR code not detected, wrong image,
  wrong draw, blurry, or a reason you write; the reason is shown with the deletion.
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
   Each photo is read straight and turned 90° both ways (a blurry ticket photographed sideways
   is often found in one turn and missed in another); if that finds nothing, it is also read
   smaller with noise removal, upside down and with another contrast method. **Scan photo
   again** in the viewer always tries every way.
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

### How good are the picks?

`tools/analyze-picks.mjs` tests the engine against the real history (1,247 draws when last run).
Run it any time from **Actions → Analyze picks → Run workflow**; the report appears on the run's
summary page. What it found:

- **The draw is fair.** Every number came up about equally often (chi-square p = 0.96).
- **Hot, cold and overdue numbers predict nothing.** Replaying every draw with only the draws
  before it, none of those rules matched more numbers than chance.
- **Winning sets look like random sets.** Sum, odd/even, low/high and spread follow the same
  spread as random sets, so shape only avoids odd-looking sets; it can't raise the odds.
- **What does work: avoiding popular numbers.** The number of 5등 winners each week shows which
  numbers people over-pick (11, 9, 12, 24, 34 …; least picked: 43, 36, 29, 37, 44 …). The habit
  is stable over time, and in the newer half of history the most popular fifth of winning sets
  had about **16 % more 1등 winners** than expected, so each got a smaller share. The suggested
  sets sit around the 15th–30th popularity percentile of random sets.
- **Money:** any ₩1,000 game pays back about ₩500 on average. Avoiding popular numbers raises
  that a little for the big prizes, but no system makes the lottery profitable.

---

## Project structure

```
645/
├── web/                     ← the website (published to GitHub Pages)
│   ├── index.html           ← page layout
│   ├── style.css
│   ├── app.js               ← all app logic (Supabase client, pool maths, UI)
│   ├── picks.js             ← number suggestion engine (Picks tab, simulation, backtest)
│   ├── eslip.js             ← mobile-slip QR text for the shop (MSG_ESLIP)
│   ├── i18n.js, i18n-dict.js ← Korean and Vietnamese
│   ├── sw.js                ← service worker: shows result notifications
│   └── config.js            ← Supabase URL + public key  ← edit this
├── web/vendor/            ← QR code reader (zxing-wasm, MIT) and maker (qrcode-generator 2.0.4, MIT)
├── supabase/
│   ├── schema.sql           ← tables, security rules, storage, realtime (run once)
│   └── functions/check-tickets/ ← reads ticket result pages, sends notifications (Edge Function)
├── tools/analyze-picks.mjs  ← tests the pick engine on the real draw history
├── tools/eslip-check.mjs    ← checks the shop QR text against known samples
└── .github/workflows/
    ├── pages.yml            ← deploy web/ to GitHub Pages on push to main
    ├── keepalive.yml        ← keeps the free Supabase project awake
    ├── check-results.yml    ← checks ticket results on Saturday night
    ├── deploy-function.yml  ← deploys the check-tickets function
    └── analyze-picks.yml    ← runs tools/analyze-picks.mjs (manual)
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
functions, policies and grants. Run it again after updates that add tables, for example
**Our numbers** (tables `pick_plans` and `group_picks`), shared **Live** picks (`live_picks`) and
**Who buys** (column `pick_plans.buyers`), photo deletion with a reason (`delete_ticket`), and
notifications (tables `push_subs` and `push_keys`).
