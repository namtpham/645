#!/usr/bin/env python3
"""
Lucky Pool — Group Lottery Investment Tracker
Local network web server for tracking shared lottery investments.
"""
from flask import Flask, session, request, jsonify, render_template, redirect, Response
import json, os, uuid, threading, queue
from datetime import datetime
from functools import wraps

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'lucky-pool-xk9q-2024-change-me')

DATA_FILE   = 'pool_data.json'
CONFIG_FILE = 'pool_config.json'

# ─── SSE ─────────────────────────────────────────────────────────────────────
_sse_queues: list[queue.Queue] = []
_sse_lock = threading.Lock()

def _notify_sse():
    with _sse_lock:
        dead = []
        for q in _sse_queues:
            try:
                q.put_nowait('update')
            except Exception:
                dead.append(q)
        for q in dead:
            _sse_queues.remove(q)

# ─── Config ───────────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    'password': 'lucky2024',
    'currency': 'THB',
    'big_win_threshold': 100000,
    'title': 'Lucky Pool',
}

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding='utf-8') as f:
            return {**DEFAULT_CONFIG, **json.load(f)}
    return DEFAULT_CONFIG.copy()

def save_config(cfg: dict):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

# ─── Data ─────────────────────────────────────────────────────────────────────
_data_lock = threading.Lock()

def _empty_data() -> dict:
    return {
        'investors': [],
        'weeks': [],
        'prize_pool': {'total': 0.0, 'entries': []},
        'last_modified': '',
    }

def load_data() -> dict:
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding='utf-8') as f:
            return json.load(f)
    return _empty_data()

def save_data(data: dict):
    data['last_modified'] = datetime.now().isoformat()
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    _notify_sse()

# ─── Prize Pool Logic ─────────────────────────────────────────────────────────
def rebuild_prize_pool(weeks: list, threshold: float) -> dict:
    """Replay all weeks chronologically to reconstruct the current prize pool."""
    pool: dict = {'total': 0.0, 'entries': []}

    for w in sorted(weeks, key=lambda x: x.get('result_date', '')):
        # Consume pool if some was used this week
        used = float(w.get('pool_used', 0))
        if used > 0 and pool['total'] > 0:
            consume = min(used, pool['total'])
            ratio   = 1.0 - consume / pool['total']
            pool['entries'] = [
                {**e, 'amount': round(e['amount'] * ratio, 4)}
                for e in pool['entries']
                if e['amount'] * ratio >= 0.01
            ]
            pool['total'] = max(0.0, pool['total'] - consume)

        # Add prize if it's a small win (below threshold)
        prize = float(w.get('prize_won', 0))
        if prize > 0 and not w.get('big_win', False):
            pool['entries'].append({
                'week_id':     w['id'],
                'result_date': w.get('result_date', ''),
                'amount':      prize,
                'percentages': w.get('percentages', {}),
            })
            pool['total'] += prize

    pool['total'] = round(sum(e['amount'] for e in pool['entries']), 2)
    return pool

def blended_pool_pcts(pool: dict) -> dict:
    """Weighted average of investor percentages across all pool entries."""
    if not pool['entries'] or pool['total'] <= 0:
        return {}
    blended: dict = {}
    for entry in pool['entries']:
        w = entry['amount'] / pool['total']
        for iid, pct in (entry.get('percentages') or {}).items():
            blended[iid] = blended.get(iid, 0.0) + pct * w
    return blended

def calc_percentages(investments: dict, pool_used: float, pool: dict):
    """
    Compute effective amounts and percentages for a single week.
    Returns (percentages, effective_amounts, total).
    """
    eff: dict = {iid: float(amt) for iid, amt in investments.items() if float(amt) > 0}

    if pool_used > 0 and pool['total'] > 0:
        actual_used = min(pool_used, pool['total'])
        for iid, pct in blended_pool_pcts(pool).items():
            eff[iid] = eff.get(iid, 0.0) + actual_used * pct / 100.0

    total = sum(eff.values())
    if total <= 0:
        return {}, {}, 0.0

    pcts = {iid: round(amt / total * 100, 4) for iid, amt in eff.items()}
    return pcts, {iid: round(amt, 2) for iid, amt in eff.items()}, round(total, 2)

# ─── Auth ─────────────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def inner(*args, **kwargs):
        if not session.get('auth'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'unauthorized'}), 401
            return redirect('/login')
        return f(*args, **kwargs)
    return inner

# ─── Routes ───────────────────────────────────────────────────────────────────
@app.route('/login', methods=['GET', 'POST'])
def login():
    cfg = load_config()
    err = None
    if request.method == 'POST':
        if request.form.get('password') == cfg['password']:
            session.permanent = True
            session['auth'] = True
            return redirect('/')
        err = 'Incorrect password — try again.'
    return render_template('login.html', title=cfg.get('title', 'Lucky Pool'), error=err)

@app.route('/logout')
def logout():
    session.clear()
    return redirect('/login')

@app.route('/')
@login_required
def index():
    return render_template('index.html')

# ─── Data API ─────────────────────────────────────────────────────────────────
@app.route('/api/data')
@login_required
def api_get_data():
    with _data_lock:
        return jsonify(load_data())

@app.route('/api/config')
@login_required
def api_get_config():
    cfg = load_config()
    return jsonify({k: v for k, v in cfg.items() if k != 'password'})

@app.route('/api/config', methods=['POST'])
@login_required
def api_save_config():
    body = request.json or {}
    cfg  = load_config()
    for key in ('currency', 'big_win_threshold', 'title'):
        if key in body:
            cfg[key] = body[key]
    if body.get('new_password'):
        cfg['password'] = body['new_password']
    save_config(cfg)
    return jsonify({'ok': True})

# ─── Investors API ────────────────────────────────────────────────────────────
@app.route('/api/investor', methods=['POST'])
@login_required
def api_investor():
    body = request.json or {}
    with _data_lock:
        data = load_data()
        if body.get('id'):
            for inv in data['investors']:
                if inv['id'] == body['id']:
                    if 'nickname' in body:
                        inv['nickname'] = body['nickname']
                    if 'active' in body:
                        inv['active'] = body['active']
                    break
        else:
            data['investors'].append({
                'id':       str(uuid.uuid4())[:8],
                'nickname': body.get('nickname', 'Unknown'),
                'active':   True,
                'since':    datetime.now().isoformat()[:10],
            })
        save_data(data)
    return jsonify({'ok': True})

# ─── Weeks API ────────────────────────────────────────────────────────────────
@app.route('/api/week', methods=['POST'])
@login_required
def api_save_week():
    body = request.json or {}
    cfg  = load_config()
    threshold = float(cfg.get('big_win_threshold', 100000))

    with _data_lock:
        data = load_data()

        week_id     = body.get('id') or str(uuid.uuid4())[:8]
        result_date = body.get('result_date', '')
        investments = {k: float(v) for k, v in (body.get('investments') or {}).items() if float(v) > 0}
        pool_used   = float(body.get('pool_used', 0))
        prize_won   = float(body.get('prize_won', 0))
        notes       = body.get('notes', '')

        # Rebuild pool as it existed just before this week (exclude this week + all after)
        other_weeks  = [w for w in data['weeks'] if w['id'] != week_id]
        prior_weeks  = [w for w in other_weeks if w.get('result_date', '') < result_date]
        pool_at_week = rebuild_prize_pool(prior_weeks, threshold)

        pcts, eff_amts, total = calc_percentages(investments, pool_used, pool_at_week)
        big_win = prize_won >= threshold

        week_entry = {
            'id':               week_id,
            'result_date':      result_date,
            'investments':      investments,
            'pool_used':        pool_used,
            'total_pool':       total,
            'effective_amounts': eff_amts,
            'percentages':      pcts,
            'prize_won':        prize_won,
            'big_win':          big_win,
            'notes':            notes,
            'updated':          datetime.now().isoformat(),
        }

        # Replace or append
        data['weeks'] = [w for w in data['weeks'] if w['id'] != week_id]
        data['weeks'].append(week_entry)
        data['weeks'].sort(key=lambda w: w.get('result_date', ''))

        # Rebuild full pool
        data['prize_pool'] = rebuild_prize_pool(data['weeks'], threshold)
        save_data(data)

    return jsonify({'ok': True, 'week': week_entry})

@app.route('/api/week/<wid>', methods=['DELETE'])
@login_required
def api_delete_week(wid):
    cfg = load_config()
    threshold = float(cfg.get('big_win_threshold', 100000))
    with _data_lock:
        data = load_data()
        data['weeks'] = [w for w in data['weeks'] if w['id'] != wid]
        data['prize_pool'] = rebuild_prize_pool(data['weeks'], threshold)
        save_data(data)
    return jsonify({'ok': True})

# ─── Pool Preview API ─────────────────────────────────────────────────────────
@app.route('/api/pool_at')
@login_required
def api_pool_at():
    """Return the prize pool as it existed just before a given date (for edit modal)."""
    before  = request.args.get('before', '')
    exclude = request.args.get('exclude', '')
    cfg = load_config()
    threshold = float(cfg.get('big_win_threshold', 100000))
    with _data_lock:
        data = load_data()
    prior = [w for w in data['weeks']
             if w['id'] != exclude and w.get('result_date', '') < before]
    pool = rebuild_prize_pool(prior, threshold)
    return jsonify(pool)

# ─── SSE ─────────────────────────────────────────────────────────────────────
@app.route('/api/events')
@login_required
def api_events():
    def stream():
        q: queue.Queue = queue.Queue(maxsize=32)
        with _sse_lock:
            _sse_queues.append(q)
        try:
            yield 'data: connected\n\n'
            while True:
                try:
                    msg = q.get(timeout=28)
                    yield f'data: {msg}\n\n'
                except queue.Empty:
                    yield 'data: ping\n\n'
        finally:
            with _sse_lock:
                try:
                    _sse_queues.remove(q)
                except ValueError:
                    pass

    return Response(
        stream(),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )

# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import socket

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = '127.0.0.1'

    port = int(os.environ.get('PORT', 5555))
    cfg  = load_config()

    print(f'\n  🎰  Lucky Pool — Group Lottery Tracker')
    print(f'  {"─" * 38}')
    print(f'  Local   →  http://localhost:{port}')
    print(f'  Network →  http://{local_ip}:{port}')
    print(f'  Password:  {cfg["password"]}')
    print(f'  {"─" * 38}')
    print(f'  Share the Network URL with others on your LAN.')
    print(f'  Edit pool_config.json to change the password.\n')

    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
