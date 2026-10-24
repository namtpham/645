# 🎰 Lucky Pool — Group Lottery Investment Tracker

A local-network web app for tracking shared lottery ticket investments.
Everyone on your Wi-Fi can open it in their browser and see live updates.

---

## Quick Start

**1. Install Python 3.9+ if you don't have it.**

**2. Install Flask:**
```bash
pip install flask
```

**3. Run the server:**
```bash
python lottery_server.py
```

You'll see output like:
```
  🎰  Lucky Pool — Group Lottery Tracker
  ──────────────────────────────────────
  Local   →  http://localhost:5555
  Network →  http://192.168.1.42:5555
  Password:  lucky2024
  ──────────────────────────────────────
  Share the Network URL with others on your LAN.
```

**4. Open the Network URL** on any device connected to the same Wi-Fi.

---

## Default Password

The default password is `lucky2024`.

You can change it inside the app under **Settings → Change Password**,
or edit `pool_config.json` directly.

---

## How It Works

### Investments & Percentages
Each week, members contribute fresh money. Each person's **effective percentage**
is calculated from their contribution relative to the total pool for that week.

### Prize Pool (Carry-Over)
If the prize won is **below the Big Win Threshold** (default: 100,000 THB):
- The prize money is added to the **Prize Pool** for future weeks.
- The winning percentages from that week are remembered.

### Using the Prize Pool Next Week
When a new week is entered, the prize pool can be used as part of that week's
lottery money. Members who earned a share of the pool keep their original
percentage attribution. Fresh investments are added on top, and the final
percentages are recalculated proportionally.

### Big Win
If the prize **meets or exceeds the threshold**, it's marked as a **Big Win**
and the money is distributed directly to investors based on that week's
percentages. It does **not** go into the prize pool.

---

## File Structure

```
lucky_pool/
├── lottery_server.py   ← Flask server (run this)
├── requirements.txt    ← Python dependencies
├── pool_data.json      ← Auto-created: all investor/week data
├── pool_config.json    ← Auto-created: app settings & password
└── templates/
    ├── login.html      ← Login page
    └── index.html      ← Main dashboard SPA
```

---

## Changing the Port

Set the `PORT` environment variable:
```bash
PORT=8080 python lottery_server.py
```

---

## Features

- **Dashboard** — Pool balance, total won, recent activity at a glance
- **Weeks** — Add/edit/delete weekly entries with live percentage preview
- **Investors** — Manage members, see per-person stats and P/L
- **Charts** — Prize history, net P/L, pool balance over time, share breakdown
- **Settings** — Currency, big-win threshold, password
- **Real-time sync** — All open browser tabs update automatically via SSE
- **LAN access** — Share with anyone on your Wi-Fi, no internet needed
