'use strict';
/*
 * 645 — Group Lotto Tracker
 * Static single-page app (GitHub Pages) backed by Supabase (auth, database, storage, realtime).
 * All permissions are enforced by Row Level Security in supabase/schema.sql — this file only
 * hides buttons a user is not allowed to use.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const CFG = window.APP_CONFIG || {};
const TZ = 'Asia/Seoul';
const FIRST_DRAW = '2002-12-07';      // Lotto 6/45 draw #1 (Saturday)
const SALES_CLOSE = '20:00';          // KST, ticket sales stop
const DRAW_TIME = '20:35';            // KST, live draw
const RESULTS_TIME = '20:50';         // KST, results published
const BUCKET = 'tickets';
const MAX_SIDE = 2560;                // px, uploaded photos are resized to this
const THUMB_SIDE = 480;
const START_DEFAULT = '2025-05-17';  // first Saturday the group played
const NO_END = '9999-12-31';
const POPULAR_CURRENCIES = ['KRW', 'USD', 'VND', 'JPY', 'CNY', 'THB', 'EUR', 'PHP', 'SGD'];
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const S = {
  sb: null, user: null, me: null,
  settings: { title: '645', currency: 'KRW', currency_display: 'symbol', big_win_threshold: 100000 },
  profiles: [], investors: [], weeks: [], tickets: [],
  ledger: { pool: { total: 0, entries: [] }, perWeek: {}, history: [] },
  charts: {}, tab: 'dashboard', openWeeks: new Set(),
  audit: null, invites: null, uploads: [], lbTicket: null,
  draws: {}, lastChange: null, loadedAt: null,
};
let _wmPool = { total: 0, entries: [] };
let _wmShare = false, _wmShareTouched = false;   // week modal: share prize now vs. add to pool
let _wmVals = {};                                 // week modal: investor id → typed amount

// ─── Small helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr) => arr.reduce((a, b) => a + (+b || 0), 0);
const ini = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();
const show = (id, on = true) => { $(id).hidden = !on; };
const isAdmin = () => S.me?.role === 'admin';
const username2email = (u) => `${u.trim().toLowerCase()}@${CFG.authEmailDomain || 'namtpham.github.io'}`;
const fmtInvite = (c) => c ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : '';
// Whole amounts typed with thousands separators: "1,234,000" ⇄ 1234000
const amt = (v) => +String(v ?? '').replace(/[^\d]/g, '') || 0;
const fmtAmt = (n) => (+n > 0 ? Math.round(+n).toLocaleString('en-US') : '');
function formatAmountInput(el) {
  const caretDigits = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/\D/g, '').length;
  el.value = fmtAmt(amt(el.value));
  let pos = 0;
  for (let seen = 0; pos < el.value.length && seen < caretDigits; pos++) if (/\d/.test(el.value[pos])) seen++;
  if (document.activeElement === el) el.setSelectionRange(pos, pos);
}
const normInvite = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const uuid = () => crypto.randomUUID?.() ||
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function fail(err, fallback = 'Something went wrong.') {
  console.error(err);
  toast(err?.message || fallback, 'err');
}

// ─── Dates (all draw logic in Korea time) ─────────────────────────────────────
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const kstAt = (d, hm) => new Date(`${d}T${hm}:00+09:00`);

/** The Saturday whose results are not out yet (today if it is Saturday before 20:50 KST). */
function currentDraw() {
  let d = kstToday();
  d = addDays(d, (6 - weekday(d) + 7) % 7);
  if (Date.now() >= kstAt(d, RESULTS_TIME).getTime()) d = addDays(d, 7);
  return d;
}

function drawNo(d) {
  if (!d || weekday(d) !== 6) return null;
  const days = Math.round((new Date(d + 'T00:00:00Z') - new Date(FIRST_DRAW + 'T00:00:00Z')) / 864e5);
  return days >= 0 ? days / 7 + 1 : null;
}

const drawDate = (n) => addDays(FIRST_DRAW, (n - 1) * 7);
const fmtShort = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
const fmtD = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const fmtKST = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' KST' : '—';
const drawLabel = (d) => { const n = drawNo(d); return n ? `#${n}` : ''; };

function countdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), dd = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
  return dd > 0 ? `${dd}d ${hh}h` : hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

// ─── Money ────────────────────────────────────────────────────────────────────
const _nf = {};
function moneyFormatter(currency = S.settings.currency, display = S.settings.currency_display) {
  const key = currency + '|' + display;
  if (!_nf[key]) {
    // Amounts are whole numbers: no decimals, thousands separated by commas
    const opts = { style: 'currency', currency, currencyDisplay: display, minimumFractionDigits: 0, maximumFractionDigits: 0 };
    try { _nf[key] = new Intl.NumberFormat('en-US', opts); }
    catch { _nf[key] = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'KRW' }); }
  }
  return _nf[key];
}
const money = (n, cur, disp) => (n == null || isNaN(n)) ? '—' : moneyFormatter(cur, disp).format(+n);
const fmtP = (n) => `${(+n || 0).toFixed(1)}%`;

function currencyName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code); } catch { return code; }
}
function currencySymbol(code) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((p) => p.type === 'currency')?.value || code;
  } catch { return code; }
}
function allCurrencies() {
  try { return Intl.supportedValuesOf('currency'); } catch { return POPULAR_CURRENCIES; }
}

// ─── Pool ledger (replays every week in date order) ───────────────────────────
function sortWeeks(ws) {
  return [...ws].sort((a, b) =>
    a.result_date < b.result_date ? -1 : a.result_date > b.result_date ? 1
      : (a.created_at || '') < (b.created_at || '') ? -1 : 1);
}

function blendedPoolPcts(pool) {
  if (!pool.entries.length || pool.total <= 0) return {};
  const out = {};
  for (const e of pool.entries) {
    const w = e.amount / pool.total;
    for (const [iid, pct] of Object.entries(e.percentages || {})) out[iid] = (out[iid] || 0) + pct * w;
  }
  return out;
}

/** Effective amounts & percentages for one week, given the pool as it was before that week. */
function calcWeek(investments, poolUsed, pool) {
  const eff = {};
  for (const [iid, amt] of Object.entries(investments || {})) if (+amt > 0) eff[iid] = +amt;
  const used = Math.min(+poolUsed || 0, pool.total);
  if (used > 0) {
    for (const [iid, pct] of Object.entries(blendedPoolPcts(pool))) eff[iid] = (eff[iid] || 0) + used * pct / 100;
  }
  const total = sum(Object.values(eff));
  const pcts = {};
  if (total > 0) for (const [iid, amt] of Object.entries(eff)) pcts[iid] = amt / total * 100;
  return { pcts, eff, total, used };
}

/**
 * Prizes not shared out (big_win = false) go into the prize pool, remembering who owned which
 * share. Using pool money in a later week shrinks every entry proportionally and credits it to
 * the original owners.
 */
function replay(weeks) {
  const pool = { total: 0, entries: [] };
  const perWeek = {}, history = [];
  for (const w of sortWeeks(weeks)) {
    const c = calcWeek(w.investments, w.pool_used, pool);
    perWeek[w.id] = c;
    if (c.used > 0) {
      const ratio = 1 - c.used / pool.total;
      pool.entries = pool.entries.map((e) => ({ ...e, amount: e.amount * ratio })).filter((e) => e.amount >= 0.01);
    }
    const prize = +w.prize_won || 0;
    if (prize > 0 && !w.big_win) {
      pool.entries.push({ week_id: w.id, result_date: w.result_date, amount: prize, percentages: c.pcts });
    }
    pool.total = sum(pool.entries.map((e) => e.amount));
    history.push(pool.total);
  }
  return { pool, perWeek, history };
}

const poolBefore = (date, excludeId) =>
  replay(S.weeks.filter((w) => w.id !== excludeId && w.result_date < date)).pool;

function investorStats() {
  const stats = {};
  for (const inv of S.investors) stats[inv.id] = { invested: 0, won: 0, weeks: 0 };
  for (const w of S.weeks) {
    for (const [id, amt] of Object.entries(w.investments || {})) {
      if (stats[id] && +amt > 0) { stats[id].invested += +amt; stats[id].weeks += 1; }
    }
    if (w.big_win && +w.prize_won > 0) {
      for (const [id, pct] of Object.entries(S.ledger.perWeek[w.id]?.pcts || {})) {
        if (stats[id]) stats[id].won += w.prize_won * pct / 100;
      }
    }
  }
  return stats;
}

// ─── Lookups ──────────────────────────────────────────────────────────────────
const invName = (id) => S.investors.find((i) => i.id === id)?.nickname || id;
const userName = (id) => { const p = S.profiles.find((x) => x.id === id); return p ? p.display_name : (id ? 'former member' : 'system'); };
const ticketsFor = (date) => S.tickets.filter((t) => t.draw_date === date);

// ─── Investor periods (start / end date) ──────────────────────────────────────
const invStart = (inv) => inv.since || START_DEFAULT;
const invEnd = (inv) => inv.end_date || NO_END;
const inPeriod = (inv, d) => d >= invStart(inv) && d <= invEnd(inv);
const fmtPeriod = (inv) => `${fmtD(invStart(inv))} → ${invEnd(inv) === NO_END ? 'no end' : fmtD(invEnd(inv))}`;
function invState(inv) {
  const today = kstToday();
  return today < invStart(inv) ? 'upcoming' : today > invEnd(inv) ? 'ended' : 'active';
}
function periodProblem(inv, d) {
  if (d < invStart(inv)) return `before start date ${fmtD(invStart(inv))}`;
  if (d > invEnd(inv)) return `after end date ${fmtD(invEnd(inv))}`;
  return '';
}
/** Investors with money in week w although w is outside their start/end dates. */
function outOfPeriod(w) {
  return Object.entries(w.investments || {})
    .map(([id, amt]) => ({ inv: S.investors.find((i) => i.id === id), amt: +amt }))
    .filter(({ inv, amt }) => inv && amt > 0 && !inPeriod(inv, w.result_date))
    .map(({ inv }) => inv);
}

// ─── Signed image URLs (bucket is private) ────────────────────────────────────
const _urls = new Map();
async function signedUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => p && !(_urls.get(p)?.exp > now + 60e3));
  if (need.length) {
    const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    if (error) throw error;
    for (const r of data || []) if (r.signedUrl) _urls.set(r.path, { url: r.signedUrl, exp: now + 3600e3 });
  }
  const out = {};
  for (const p of paths) out[p] = _urls.get(p)?.url;
  return out;
}

async function hydrateImages(root = document) {
  const imgs = [...root.querySelectorAll('img[data-path]:not([src])')];
  if (!imgs.length) return;
  try {
    const map = await signedUrls(imgs.map((i) => i.dataset.path));
    for (const img of imgs) if (map[img.dataset.path]) img.src = map[img.dataset.path];
  } catch (e) { console.error(e); }
}

const thumbImg = (t, cls = 'thumb thumb-sm') =>
  `<img class="${cls}" data-path="${esc(t.thumb_path || t.storage_path)}" data-act="ticket-open" data-id="${esc(t.id)}" alt="Ticket photo" loading="lazy">`;

function uploadBadge(t) {
  const before = new Date(t.created_at) < kstAt(t.draw_date, DRAW_TIME);
  return before
    ? `<span class="badge bg-green" title="Uploaded before the ${DRAW_TIME} KST draw">✓ before draw</span>`
    : `<span class="badge bg-red" title="Uploaded after the ${DRAW_TIME} KST draw">after draw</span>`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Boot & auth
// ═════════════════════════════════════════════════════════════════════════════
function showView(name) {
  for (const v of ['boot', 'setup', 'auth', 'revoked', 'app']) show('view-' + v, v === name);
}

async function boot() {
  if (!CFG.supabaseUrl || !CFG.supabaseKey || CFG.supabaseUrl.includes('YOUR-PROJECT') || !window.supabase) {
    showView('setup');
    return;
  }
  S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const inviteFromLink = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (inviteFromLink) {
    $('jn-code').value = fmtInvite(normInvite(inviteFromLink));
    history.replaceState(null, '', location.pathname + location.search);
  }

  S.sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;
    if (event === 'SIGNED_OUT') { S.user = null; stopRealtime(); showAuth(); }
    else if (session?.user && session.user.id !== S.user?.id) { S.user = session.user; setTimeout(enterApp, 0); }
  });

  const { data: { session } } = await S.sb.auth.getSession();
  if (session?.user) { S.user = session.user; await enterApp(); }
  else showAuth(inviteFromLink ? 'join' : 'login');
}

function showAuth(tab) {
  showView('auth');
  if (tab) setAuthTab(tab);
}

function setAuthTab(tab) {
  document.querySelectorAll('#view-auth .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  show('form-login', tab === 'login');
  show('form-join', tab === 'join');
  (tab === 'login' ? $('li-user') : $('jn-code').value ? $('jn-user') : $('jn-code')).focus();
}

function formError(id, msg) { const el = $(id); el.textContent = msg || ''; el.hidden = !msg; }

async function doLogin(e) {
  e.preventDefault();
  formError('li-err');
  const u = $('li-user').value.trim().toLowerCase(), pw = $('li-pw').value;
  if (!u || !pw) return;
  $('li-btn').disabled = true;
  try {
    const { error } = await S.sb.auth.signInWithPassword({ email: username2email(u), password: pw });
    if (error) formError('li-err', /invalid login/i.test(error.message) ? 'Wrong username or password.' : error.message);
    else $('li-pw').value = '';
  } finally { $('li-btn').disabled = false; }
}

async function doJoin(e) {
  e.preventDefault();
  formError('jn-err');
  const code = normInvite($('jn-code').value);
  const u = $('jn-user').value.trim().toLowerCase();
  const name = $('jn-name').value.trim();
  const pw = $('jn-pw').value, pw2 = $('jn-pw2').value;
  if (code.length !== 12) return formError('jn-err', 'The invitation key has 12 characters, like ABCD-EFGH-JKMN.');
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return formError('jn-err', 'Username: 3–20 characters, only a–z, 0–9 and _.');
  if (pw.length < 8) return formError('jn-err', 'Password must be at least 8 characters.');
  if (pw !== pw2) return formError('jn-err', 'The two passwords do not match.');

  $('jn-btn').disabled = true;
  try {
    const { data: status, error: e1 } = await S.sb.rpc('check_invite', { p_code: code });
    if (e1) throw e1;
    const msg = { invalid: 'This invitation key does not exist. Check for typos.', used: 'This invitation key has already been used.',
      revoked: 'This invitation key was cancelled by the admin.', expired: 'This invitation key has expired. Ask the admin for a new one.' }[status];
    if (msg) return formError('jn-err', msg);

    const { data: free, error: e2 } = await S.sb.rpc('username_available', { p_code: code, p_username: u });
    if (e2) throw e2;
    if (!free) return formError('jn-err', 'That username is taken — please choose another.');

    const { data, error } = await S.sb.auth.signUp({
      email: username2email(u), password: pw,
      options: { data: { invite_code: code, display_name: name || u } },
    });
    if (error) return formError('jn-err', /database error/i.test(error.message)
      ? 'Could not create the account with this key. Ask the admin for a new invitation.' : error.message);
    if (!data.session) {
      return formError('jn-err', 'Account created, but sign-in is blocked by "Confirm email" in Supabase. ' +
        'The admin must turn it off (Authentication → Sign In / Providers → Email).');
    }
    $('jn-pw').value = $('jn-pw2').value = '';
    toast('Welcome to 645! 🎉', 'ok');
  } catch (err) {
    formError('jn-err', err.message || 'Network error.');
  } finally { $('jn-btn').disabled = false; }
}

async function enterApp() {
  showView('boot');
  try {
    await loadAll();
  } catch (e) {
    fail(e, 'Could not load data.');
    showView('auth');
    return;
  }
  if (!S.me || S.me.status !== 'active') { stopRealtime(); showView('revoked'); return; }
  showView('app');
  navigator.storage?.persist?.().catch(() => {});   // keep the login even when storage is tight
  startRealtime();
  goTab(S.tab);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Data loading & realtime
// ═════════════════════════════════════════════════════════════════════════════
async function loadAll() {
  const sb = S.sb;
  const { data: me, error: meErr } = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle();
  if (meErr) throw meErr;
  S.me = me;
  if (!me || me.status !== 'active') return;

  const res = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).maybeSingle(),
    sb.from('profiles').select('*').order('created_at'),
    sb.from('investors').select('*').order('created_at'),
    sb.from('weeks').select('*').order('result_date').order('created_at'),
    sb.from('tickets').select('*').order('draw_date', { ascending: false }).order('created_at'),
  ]);
  const err = res.find((r) => r.error)?.error;
  if (err) throw err;
  const [st, pr, iv, wk, tk] = res.map((r) => r.data);
  const [drawRows, lc] = await Promise.all([
    loadDraws(),
    sb.from('audit_log').select('*').order('at', { ascending: false }).limit(1),
  ]);
  S.draws = Object.fromEntries(drawRows.map((d) => [d.round, d]));   // missing table → {}
  S.lastChange = lc.data?.[0] || null;
  S.loadedAt = new Date();
  if (st) S.settings = { ...S.settings, ...st, big_win_threshold: +st.big_win_threshold };
  S.profiles = pr || [];
  S.investors = iv || [];
  S.weeks = (wk || []).map((w) => ({ ...w, pool_used: +w.pool_used, prize_won: +w.prize_won }));
  S.tickets = sortTickets(tk || []);
  S.ledger = replay(S.weeks);
  await loadBoard().catch(console.error);
  if (S.lbTicket) {
    S.lbTicket = S.tickets.find((t) => t.id === S.lbTicket.id) || S.lbTicket;
    if ($('lb-overlay').classList.contains('open')) renderLbQr();
  }
  renderAll();
  maybeAutoCheck();
}

/** All saved winning numbers (the API returns at most 1000 rows per request). */
async function loadDraws() {
  const out = [];
  let cols = 'round, draw_date, numbers, bonus, prizes';
  for (let from = 0; from < 5000; from += 1000) {
    let { data, error } = await S.sb.from('draws').select(cols).order('round', { ascending: false }).range(from, from + 999);
    if (error && cols.includes('prizes')) {   // database without the prizes column yet
      cols = 'round, draw_date, numbers, bonus';
      ({ data, error } = await S.sb.from('draws').select(cols).order('round', { ascending: false }).range(from, from + 999));
    }
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

let _reloadT = null, _boardT = null, _channel = null;
function scheduleBoardReload() {
  clearTimeout(_boardT);
  _boardT = setTimeout(() => loadBoard().then(() => S.tab === 'picks' && renderBoard()).catch(console.error), 250);
}
function scheduleReload() {
  clearTimeout(_reloadT);
  _reloadT = setTimeout(async () => {
    if (!S.user) return;
    try {
      await loadAll();
      if (!S.me || S.me.status !== 'active') { stopRealtime(); showView('revoked'); return; }
      if (S.tab === 'activity') loadActivity();
    } catch (e) { console.error(e); }
  }, 400);
}

function startRealtime() {
  if (_channel) return;
  _channel = S.sb.channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public' },
      (p) => (BOARD_TABLES.includes(p?.table) ? scheduleBoardReload() : scheduleReload()))
    .subscribe((status) => $('syncDot').classList.toggle('off', status !== 'SUBSCRIBED'));
}
function stopRealtime() {
  clearTimeout(_reloadT);
  if (_channel) { S.sb.removeChannel(_channel); _channel = null; }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Rendering
// ═════════════════════════════════════════════════════════════════════════════
// ─── Time bar: local time + last change ───────────────────────────────────────
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
function ago(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderTimebar() {
  if (!$('tb-clock')) return;
  const now = new Date();
  const local = now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const kst = LOCAL_TZ === TZ ? '' : ` · Korea ${now.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })}`;
  $('tb-clock').textContent = `🕒 ${local} (${LOCAL_TZ.replace('_', ' ')})${kst}`;
  const c = S.lastChange;
  if (c) {
    const d = describeChange(c);
    const at = new Date(c.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    $('tb-update').innerHTML = `🔄 Last update <strong>${esc(at)}</strong> (${ago(c.at)}) · ${esc(d.self ? userName(d.self) : d.auto || userName(c.actor))} ${esc(d.head)} ${esc(d.subject || '')}`;
  } else $('tb-update').textContent = '';
  $('tb-update').title = S.loadedAt ? `Data loaded ${S.loadedAt.toLocaleTimeString('en-GB', { hour12: false })}` : '';
}
setInterval(renderTimebar, 1000);

function renderAll() {
  document.body.classList.toggle('is-admin', isAdmin());
  document.title = S.settings.title || '645';
  $('nav-title').textContent = S.settings.title || '645';
  $('nav-user').textContent = S.me.display_name;
  renderTimebar();
  renderDashboard();
  renderWeeks();
  renderTickets();
  renderInvestors();
  renderSettings();
  if (S.tab === 'charts') renderCharts();
  if (S.tab === 'picks') renderBoard();
}

function goTab(name) {
  S.tab = name;
  document.querySelectorAll('.tab-pane').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + name));
  document.querySelectorAll('.nav-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
  if (name === 'charts') setTimeout(renderCharts, 60);
  if (name === 'dashboard') setTimeout(renderDashChart, 60);
  if (name === 'picks') setTimeout(renderPicks, 30);
  if (name === 'tickets') hydrateImages($('tickets-list'));
  if (name === 'activity') loadActivity();
  if (name === 'settings' && isAdmin()) loadInvites();
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function resultBadge(w, long = false) {
  const prize = +w.prize_won || 0;
  if (prize === 0) return `<span class="badge bg-gray">No win</span>`;
  if (w.big_win) {
    const label = prize >= S.settings.big_win_threshold ? '🏆 Big Win — shared' : '💸 Shared';
    return `<span class="badge bg-gold">${label}${long ? ' ' + esc(money(prize)) : ''}</span>`;
  }
  return `<span class="badge bg-green">${long ? '＋Pool ' + esc(money(prize)) : '→ Added to pool'}</span>`;
}

function renderDrawCard() {
  const d = currentDraw(), n = drawNo(d), tix = ticketsFor(d), now = Date.now(), qs = qrSummary(tix);
  const close = kstAt(d, SALES_CLOSE).getTime(), results = kstAt(d, RESULTS_TIME).getTime();
  const status = now < close
    ? `Sales close in <strong>${countdown(close - now)}</strong> (Sat ${SALES_CLOSE} KST)`
    : `Sales closed · results at <strong>${RESULTS_TIME} KST</strong> (${countdown(results - now)})`;
  const games = sum(qs.items.map((i) => i.games?.length || 0));
  const week = S.weeks.find((w) => w.result_date === d);
  $('draw-card').innerHTML = `
    <div class="dc-head">
      <div><div class="fhelp">THIS WEEK · DRAW</div><div class="draw-no">#${n}</div></div>
      <div class="draw-meta">
        <div class="t">Saturday ${esc(fmtD(d))}</div>
        <div class="s">${status}</div>
      </div>
    </div>
    <div class="dc-facts">
      <span>🎟️ <strong>${tix.length}</strong> photo${tix.length === 1 ? '' : 's'}</span>
      <span>🔍 <strong>${qs.n}</strong> QR · <strong>${games}</strong> game${games === 1 ? '' : 's'}</span>
      <span>💰 ${week ? `<strong>${esc(money(sum(Object.values(week.investments || {}))))}</strong> entered` : 'week not entered yet'}</span>
    </div>
    ${tix.length ? `<div class="draw-thumbs">${tix.slice(0, 8).map((t) => thumbImg(t)).join('')}</div>` : ''}
    <div class="btn-row">
      <button class="btn btn-primary" data-act="tab" data-tab="tickets">📤 Upload tickets</button>
      ${week ? `<button class="btn btn-secondary" data-act="week-edit" data-id="${esc(week.id)}">Edit week</button>`
        : `<button class="btn btn-secondary" data-act="week-add-date" data-date="${d}">+ Add week</button>`}
    </div>`;
  hydrateImages($('draw-card'));
}

/** Result of the most recent finished draw: winning numbers, our games, what we won. */
function renderLastCard() {
  const d = addDays(currentDraw(), -7), n = drawNo(d), draw = S.draws[n];
  const tix = ticketsFor(d), qs = qrSummary(tix), week = S.weeks.find((w) => w.result_date === d);
  const ranks = {};
  for (const it of qs.items) for (const g of it.games || []) {
    const r = gameResult(g, S.draws[it.round || n]);
    if (r?.rank != null) ranks[r.rank] = (ranks[r.rank] || 0) + 1;
  }
  const games = sum(Object.values(ranks));
  const rankLine = games ? [1, 2, 3, 4, 5].filter((r) => ranks[r]).map((r) => `<span class="rs-rank r${r}">${ranks[r]}× ${r}등</span>`).join(' ')
    + (ranks[0] ? ` <span class="rs-rank r0">${ranks[0]}× 낙첨</span>` : '') : '';
  const prize = week ? +week.prize_won || 0 : qs.done ? qs.total : null;
  const verdict = !week && !tix.length ? `<div class="rs-verdict lose">Not played</div>`
    : prize > 0 ? `<div class="rs-verdict win">축하합니다! <span>총 ${esc(money(prize))} 당첨${week ? (week.big_win ? ' · 💸 shared' : ' · 🏦 to pool') : ''}</span></div>`
      : prize === 0 ? `<div class="rs-verdict lose">아쉽게도, <span>낙첨되었습니다.</span></div>`
        : `<div class="rs-verdict wait">⏳ Results are being checked</div>`;
  $('last-card').innerHTML = `
    <div class="card-hd"><div class="card-title">🎱 Last draw #${n}</div><span class="fhelp">${esc(fmtD(d))}</span></div>
    <div class="lc-balls">${draw ? drawBalls(draw) : '<span class="fhelp">Winning numbers appear after the result check.</span>'}</div>
    ${verdict}
    ${rankLine ? `<div class="lc-ranks">${games} game${games === 1 ? '' : 's'}: ${rankLine}</div>` : ''}
    <div class="lc-facts fhelp">${week ? `Invested ${esc(money(sum(Object.values(week.investments || {}))))}${week.pool_used > 0 ? ` + ${esc(money(week.pool_used))} from pool` : ''}` : 'No week entry'}
      · ${tix.length} ticket photo${tix.length === 1 ? '' : 's'}
      ${!week && (tix.length || qs.n) ? ` · <a href="#" data-act="week-add-date" data-date="${d}">add the week</a>` : ''}
      ${qs.done && week && Math.round(qs.total) !== Math.round(+week.prize_won || 0) ? `<div class="red">⚠️ QR results say ${esc(money(qs.total))}, the week records ${esc(money(+week.prize_won || 0))}</div>` : ''}</div>`;
}

const lastDraw = () => S.draws[Math.max(0, ...Object.keys(S.draws).map(Number))] || null;

function renderDashboard() {
  const weeks = S.weeks, pool = S.ledger.pool;
  let totalInv = 0, paidOut = 0, allPrizes = 0;
  for (const w of weeks) {
    totalInv += sum(Object.values(w.investments || {}));
    allPrizes += +w.prize_won || 0;
    if (w.big_win) paidOut += +w.prize_won || 0;
  }
  renderDrawCard();
  renderLastCard();

  const timeline = weekTimeline().filter((r) => r.date < currentDraw());
  const played = timeline.filter((r) => r.weeks.length).length;
  const wins = weeks.filter((w) => +w.prize_won > 0).length;
  const net = allPrizes - totalInv;
  const tile = (cls, label, id, value, sub, subId = '') => `<div class="stat-card ${cls}"><div class="stat-label">${label}</div>
    <div class="stat-value" id="${id}">${value}</div><div class="stat-sub" ${subId ? `id="${subId}"` : ''}>${sub}</div></div>`;
  $('dash-kpis').innerHTML = [
    tile('', 'Prize pool', 's-pool', esc(money(pool.total)), 'kept for re-investing'),
    tile('bl', 'Total invested', 's-inv', esc(money(totalInv)), `${esc(money(totalInv / Math.max(1, groupDays())))} per day since ${esc(fmtD(groupStart()))}`, 's-inv-sub'),
    tile('em', 'Paid out', 's-won', esc(money(paidOut)), 'prizes shared to investors'),
    tile(net >= 0 ? 'em' : 'rd', 'Group result', 's-net', `${net >= 0 ? '+' : ''}${esc(money(net))}`, `${esc(money(allPrizes))} won in total`),
    tile('pu', 'Win rate', 's-rate', weeks.length ? `${Math.round(wins / weeks.length * 100)}%` : '—', `${wins} of ${weeks.length} draws won something`),
    tile('', 'Draws played', 's-wks', `${played}`, `of ${timeline.length} since ${esc(fmtD(groupStart()))} · ${S.tickets.length} photos`, 's-tix'),
  ].join('');

  // Recent draws, including the ones we did not play
  $('recent-draws').innerHTML = timeline.slice(0, 8).map((r) => {
    const n = drawNo(r.date), tix = ticketsFor(r.date);
    if (!r.weeks.length) return `<div class="rd-row muted"><span class="rd-no">#${n}</span><span class="rd-date">${esc(fmtD(r.date))}</span>
      <span class="rd-main">Not played</span><span class="rd-res"></span></div>`;
    return r.weeks.map((w) => {
      const fresh = sum(Object.values(w.investments || {})), prize = +w.prize_won || 0;
      const res = prize ? `<span class="rd-prize ${w.big_win ? 'shared' : 'pooled'}">${esc(money(prize))} ${w.big_win ? '💸' : '🏦'}</span>` : '<span class="muted">낙첨</span>';
      return `<div class="rd-row" data-act="week-edit" data-id="${esc(w.id)}" title="Edit this week"><span class="rd-no">#${n}</span><span class="rd-date">${esc(fmtD(r.date))}</span>
        <span class="rd-main"><span class="green mono">${esc(money(fresh))}</span>${w.pool_used > 0 ? ` <span class="gold mono">+${esc(money(w.pool_used))}</span>` : ''}${tix.length ? ` · 🎟️ ${tix.length}` : ''}</span>
        <span class="rd-res">${res}</span></div>`;
    }).join('');
  }).join('') || '<div class="empty"><p>No draws yet.</p></div>';

  // Investors at a glance
  const stats = investorStats();
  const invRows = S.investors.filter((i) => invState(i) === 'active' || stats[i.id]?.invested > 0).map((inv) => {
    const s = stats[inv.id] || {};
    return { inv, invested: s.invested || 0, net: (s.won || 0) - (s.invested || 0), daily: perDay(inv, s.invested || 0) };
  }).sort((a, b) => b.invested - a.invested);
  $('dash-investors').innerHTML = invRows.length ? `<div class="di-head"><span>Investor</span><span>Invested</span><span>Net</span><span>Per day</span></div>` +
    invRows.map((r) => `<div class="di-row" data-act="inv-detail" data-id="${esc(r.inv.id)}">
      <span class="di-name"><i style="background:${invColor(r.inv)}"></i>${esc(r.inv.nickname)}</span>
      <span class="mono">${esc(money(r.invested))}</span>
      <span class="mono ${r.net >= 0 ? 'green' : 'red'}">${r.net >= 0 ? '+' : ''}${esc(money(r.net))}</span>
      <span class="mono">${esc(money(r.daily))}</span></div>`).join('')
    : '<div class="empty"><p>No investors yet.</p></div>';

  // Pool breakdown (only when there is money in the pool)
  $('pool-card').hidden = !pool.entries.length;
  $('pool-ttl-badge').textContent = money(pool.total);
  if (pool.entries.length) {
    const ids = [...new Set(pool.entries.flatMap((e) => Object.keys(e.percentages || {})))];
    let h = `<div class="tbl-wrap"><table><thead><tr><th>Won On</th><th>Amount in Pool</th>`;
    for (const id of ids) h += `<th>${esc(invName(id))}</th>`;
    h += `</tr></thead><tbody>`;
    for (const e of pool.entries) {
      h += `<tr><td>${esc(fmtD(e.result_date))} <span class="fhelp">${drawLabel(e.result_date)}</span></td><td class="mono gold">${esc(money(e.amount))}</td>`;
      for (const id of ids) {
        const pct = e.percentages?.[id] || 0;
        h += `<td><span class="mono">${esc(money(e.amount * pct / 100))}</span> <span class="fhelp">(${pct.toFixed(1)}%)</span></td>`;
      }
      h += `</tr>`;
    }
    $('pool-breakdown').innerHTML = h + `</tbody></table></div>`;
  }
  if (S.tab === 'dashboard') renderDashChart();
}

function renderDashChart() {
  if (!window.Chart) return;
  const weeks = sortWeeks(S.weeks);
  let run = 0;
  const data = weeks.map((w) => (run += (+w.prize_won || 0) - sum(Object.values(w.investments || {}))));
  const opts = chartOpts({ legend: false, timeline: true });
  opts.aspectRatio = window.innerWidth < 640 ? 1.4 : 4;
  opts.plugins.tooltip.callbacks.title = (items) => `${drawLabel(weeks[items[0].dataIndex].result_date)} · ${fmtD(weeks[items[0].dataIndex].result_date)}`;
  opts.scales.y.grid.color = (c) => (c.tick.value === 0 ? INK.zero : INK.grid);
  killChart('dash');
  S.charts.dash = new Chart($('ch-dash'), { type: 'line', data: { labels: weeks.map((w) => fmtShort(w.result_date)),
    datasets: [{ label: 'Group result', data, ...lineStyle(run >= 0 ? SERIES.won : SERIES.down, true) }] }, options: opts });
}

// ─── Weeks ────────────────────────────────────────────────────────────────────
function pctRows(pcts, eff) {
  return Object.entries(pcts).sort((a, b) => b[1] - a[1]).map(([id, pct]) => `
    <div class="pct-row">
      <span class="pct-name">${esc(invName(id))}</span>
      <div class="pct-bar"><div class="pct-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <span class="pct-val">${pct.toFixed(1)}%</span>
      <span class="pct-amt">${esc(money(eff[id] || 0))}</span>
    </div>`).join('');
}

/** Every Saturday from the first week played to the current draw, plus any off-date entries. */
function weekTimeline() {
  const byDate = {};
  for (const w of S.weeks) (byDate[w.result_date] ||= []).push(w);
  const first = [START_DEFAULT, ...S.weeks.map((w) => w.result_date)].sort()[0];
  let d = addDays(first, (6 - weekday(first) + 7) % 7);
  const dates = new Set(Object.keys(byDate));
  for (const end = currentDraw(); d <= end; d = addDays(d, 7)) dates.add(d);
  return [...dates].sort().reverse().map((date) => ({ date, weeks: sortWeeks(byDate[date] || []) }));
}

const wkCell = (cls, label, value) =>
  `<div class="wk-c ${cls}"><span class="wk-l">${label}</span><span class="wk-v">${value}</span></div>`;

function prizeCell(w) {
  const prize = +w.prize_won || 0;
  if (!prize) return `<span class="muted">—</span>`;
  if (w.big_win) return `${esc(money(prize))}<small>${prize >= S.settings.big_win_threshold ? '🏆' : '💸'} shared</small>`;
  return `${esc(money(prize))}<small>→ pool</small>`;
}

function ticketsCell(tix) {
  if (!tix.length) return `<span class="muted">—</span>`;
  return `🎟️ ${tix.length}${qrSummary(tix).n ? ' ' + qrBadge(qrSummary(tix), { short: true }) : ''}`;
}

function weekRow(w) {
  const c = S.ledger.perWeek[w.id] || { pcts: {}, eff: {}, total: 0 };
  const fresh = sum(Object.values(w.investments || {})), tix = ticketsFor(w.result_date), qs = qrSummary(tix);
  const used = c.used ?? w.pool_used;
  const warns = [];
  if (w.pool_used - (c.used || 0) > 0.005) warns.push(`entered ${money(w.pool_used)} from pool, only ${money(c.used || 0)} available (earlier weeks changed)`);
  const out = outOfPeriod(w);
  if (out.length) warns.push(`outside their dates: ${out.map((i) => i.nickname).join(', ')}`);
  if (qs.done && Math.round(qs.total) !== Math.round(+w.prize_won || 0)) warns.push(`ticket QR results say ${money(qs.total)}, but this week records ${money(+w.prize_won || 0)}`);
  if (qs.problem) warns.push(`${qs.problem} ticket QR result${qs.problem > 1 ? 's need' : ' needs'} checking by hand (Tickets tab)`);
  const n = drawNo(w.result_date);
  return `<div class="week-item">
    <div class="wk-row" data-act="week-toggle" data-id="${esc(w.id)}">
      <div class="wk-no">${n ? '#' + n : '—'}</div>
      <div class="wk-date">${esc(fmtD(w.result_date))}</div>
      ${wkCell('wk-total', 'Total', esc(money(c.total)))}
      ${wkCell('wk-fresh', 'Fresh', fresh > 0 ? esc(money(fresh)) : '<span class="muted">—</span>')}
      ${wkCell('wk-pool', 'From pool', used > 0 ? esc(money(used)) : '<span class="muted">—</span>')}
      ${wkCell('wk-prize ' + (w.big_win ? 'shared' : 'pooled'), 'Prize', prizeCell(w))}
      ${wkCell('wk-tix', 'Tickets', ticketsCell(tix))}
      <div class="wk-act">
        <button class="btn btn-secondary btn-sm" data-act="week-edit" data-id="${esc(w.id)}">Edit</button>
        <button class="btn btn-danger btn-sm admin-only" data-act="week-del" data-id="${esc(w.id)}">Delete</button>
      </div>
    </div>
    ${warns.length ? `<div class="wk-warn">${warns.map((x) => `<span>⚠️ ${esc(x)}</span>`).join('')}</div>` : ''}
    <div class="week-body ${S.openWeeks.has(w.id) ? 'open' : ''}" id="wb-${esc(w.id)}">
      <div class="flbl mb8">Effective percentages &amp; amounts</div>
      ${pctRows(c.pcts, c.eff) || '<p class="fhelp">No investments recorded.</p>'}
      ${S.draws[drawNo(w.result_date)] ? `<div class="fhelp" style="margin-top:10px">당첨번호 <span class="rs-win">${drawBalls(S.draws[drawNo(w.result_date)])}</span></div>` : ''}
      ${qs.n ? `<div class="fhelp" style="margin-top:10px">Ticket QR results: ${qs.n} code${qs.n > 1 ? 's' : ''} · ${qs.win} won · ${qs.lose} no win${qs.pending ? ` · ${qs.pending} waiting` : ''} ${qrBadge(qs)}</div>` : ''}
      ${tix.length ? `<div class="thumb-row">${tix.map((t) => thumbImg(t)).join('')}</div>` : ''}
      ${w.notes ? `<div class="week-notes">${esc(w.notes)}</div>` : ''}
      <div class="fhelp" style="margin-top:10px">Last edited by ${esc(userName(w.updated_by))} · ${esc(fmtKST(w.updated_at))}</div>
    </div>
  </div>`;
}

function emptyRow(date) {
  const tix = ticketsFor(date), n = drawNo(date), upcoming = date >= currentDraw();
  return `<div class="week-item wk-empty">
    <div class="wk-row">
      <div class="wk-no">${n ? '#' + n : '—'}</div>
      <div class="wk-date">${esc(fmtD(date))}</div>
      <div class="wk-c wk-none">${upcoming ? '⏳ This week — not entered yet' : 'Not played'}</div>
      ${wkCell('wk-tix', 'Tickets', ticketsCell(tix))}
      <div class="wk-act"><button class="btn btn-ghost btn-sm" data-act="week-add-date" data-date="${date}">+ Add</button></div>
    </div>
    ${tix.length ? `<div class="wk-warn"><span>⚠️ ${tix.length} ticket photo${tix.length > 1 ? 's' : ''} uploaded, but no week entry yet</span></div>` : ''}
  </div>`;
}

function renderWeeks() {
  const el = $('weeks-list');
  const rows = weekTimeline();
  const played = rows.filter((r) => r.weeks.length).length;
  el.innerHTML = `<div class="wk-summary fhelp">${played} of ${rows.length} draws played since ${esc(fmtD(rows.at(-1)?.date))}</div>
    <div class="wk-head"><span>Draw</span><span>Date</span><span class="r">Total</span><span class="r">Fresh</span>
      <span class="r">From pool</span><span class="r">Prize</span><span>Tickets</span><span></span></div>`
    + rows.map((r) => (r.weeks.length ? r.weeks.map(weekRow).join('') : emptyRow(r.date))).join('');
  el.querySelectorAll('.week-body.open').forEach((b) => hydrateImages(b));
}

function toggleWeek(id) {
  const body = $('wb-' + id);
  if (!body) return;
  body.classList.toggle('open');
  if (body.classList.contains('open')) { S.openWeeks.add(id); hydrateImages(body); }
  else S.openWeeks.delete(id);
}

function dateInfo(d) {
  if (!d) return '';
  const n = drawNo(d);
  const dup = S.weeks.some((w) => w.result_date === d && w.id !== $('wm-id').value);
  return (n ? `Draw #${n}` : '⚠️ Not a Saturday') + (dup ? ' · ⚠️ another entry already uses this date' : '');
}

function openWeekModal(wid, dateArg) {
  const existing = wid ? S.weeks.find((w) => w.id === wid) : null;
  const date = existing?.result_date || dateArg || currentDraw();
  $('wm-title').textContent = existing ? 'Edit Week' : 'Add Week';
  $('wm-id').value = wid || '';
  $('wm-date').value = date;
  $('wm-prize').value = fmtAmt(existing?.prize_won);
  $('wm-notes').value = existing?.notes || '';
  _wmPool = poolBefore(date, wid);
  _wmShareTouched = +existing?.prize_won > 0;   // keep the saved choice when editing
  _wmShare = _wmShareTouched && !!existing.big_win;
  $('wm-pool-used').value = fmtAmt(existing ? existing.pool_used : _wmPool.total);
  _wmVals = Object.fromEntries(Object.entries(existing?.investments || {}).map(([k, v]) => [k, fmtAmt(v)]));
  $('wm-inv-inputs').innerHTML = '';
  // New week whose ticket results are all in: start from the QR total
  const qs = qrSummary(ticketsFor(date));
  if (!existing && qs.done && qs.total > 0) $('wm-prize').value = fmtAmt(qs.total);
  refreshWeekPool();
  $('week-overlay').classList.add('open');
}

/**
 * One input per investor whose start/end dates cover the week's date. Anyone outside their dates
 * who already has money in this week is still listed (flagged) so the mistake can be fixed.
 */
function renderWeekInputs() {
  document.querySelectorAll('#wm-inv-inputs input[data-inv]').forEach((el) => {
    if (el.value === '') delete _wmVals[el.dataset.inv]; else _wmVals[el.dataset.inv] = el.value;
  });
  const date = $('wm-date').value || currentDraw();
  const shown = S.investors.filter((i) => inPeriod(i, date) || amt(_wmVals[i.id]) > 0);
  const hidden = S.investors.length - shown.length;
  $('wm-inv-inputs').innerHTML = (shown.length ? shown.map((inv) => {
    const problem = periodProblem(inv, date);
    return `<div class="inv-input-row">
      <div class="nm">${esc(inv.nickname)}${problem ? `<div class="red fhelp">⚠️ ${esc(problem)} — clear this amount if it is a mistake</div>` : ''}</div>
      <div class="quick-row">
        <button type="button" class="qb" data-act="q-inv" data-id="${esc(inv.id)}" data-set="5000" title="Set to 5,000">5K</button>
        <button type="button" class="qb" data-act="q-inv" data-id="${esc(inv.id)}" data-set="10000" title="Set to 10,000">10K</button>
        <button type="button" class="qb qb-minus" data-act="q-inv" data-id="${esc(inv.id)}" data-add="-1000" title="Minus 1,000">−1K</button>
        <button type="button" class="qb qb-plus" data-act="q-inv" data-id="${esc(inv.id)}" data-add="1000" title="Plus 1,000">+1K</button>
      </div>
      <input type="text" class="finp amt" id="wi-${esc(inv.id)}" data-inv="${esc(inv.id)}" data-amount inputmode="numeric"
             autocomplete="off" placeholder="0" value="${esc(_wmVals[inv.id] || '')}" data-on-input="wm-preview">
      <span class="pp" id="wp-${esc(inv.id)}">—</span>
    </div>`;
  }).join('') : `<p class="fhelp">${S.investors.length ? 'No investor takes part on this date.' : 'Add investors first (Investors tab).'}</p>`)
    + (hidden > 0 ? `<p class="fhelp">${hidden} investor${hidden > 1 ? 's are' : ' is'} not shown: this date is outside their start/end dates.</p>` : '');
}

function refreshWeekPool() {
  const date = $('wm-date').value;
  renderWeekInputs();
  _wmPool = poolBefore(date || '9999-12-31', $('wm-id').value);
  $('wm-date-info').textContent = dateInfo(date);
  $('wm-pool-val').textContent = money(_wmPool.total);
  const n = _wmPool.entries.length;
  $('wm-pool-entries-info').textContent = n ? `from ${n} winning week${n > 1 ? 's' : ''} before this date` : '';
  const tix = ticketsFor(date), qs = qrSummary(tix);
  $('wm-qr').innerHTML = !tix.length ? '' : !qs.n ? `🎟️ ${tix.length} ticket photo${tix.length > 1 ? 's' : ''}, no QR results yet.`
    : `🎟️ Ticket QR results: ${qs.n} code${qs.n > 1 ? 's' : ''}, ${qs.win} won ${qrBadge(qs)}${qs.pending ? ` · ${qs.pending} still waiting` : ''}
       ${qs.total > 0 ? `<button type="button" class="btn btn-secondary btn-sm" data-act="wm-use-qr" data-v="${qs.total}">Use ${esc(money(qs.total))}</button>` : ''}`;
  previewWeek();
}

function weekInputs() {
  const investments = {};
  document.querySelectorAll('#wm-inv-inputs input[data-inv]').forEach((el) => {
    const v = amt(el.value);
    if (v > 0) investments[el.dataset.inv] = v;
  });
  return { investments, pool_used: amt($('wm-pool-used').value), prize_won: amt($('wm-prize').value) };
}

function previewWeek() {
  const { investments, pool_used, prize_won } = weekInputs();
  const c = calcWeek(investments, pool_used, _wmPool);
  document.querySelectorAll('#wm-inv-inputs input[data-inv]').forEach((el) => {
    $('wp-' + el.dataset.inv).textContent = c.pcts[el.dataset.inv] ? fmtP(c.pcts[el.dataset.inv]) : '—';
  });
  $('wm-total').textContent = money(c.total);
  $('wm-prize-hint').textContent = prize_won > 0 ? money(prize_won) : '';
  const wl = $('wm-win-label'), threshold = S.settings.big_win_threshold;
  if (prize_won > 0 && !_wmShareTouched) _wmShare = prize_won >= threshold;
  show('wm-mode', prize_won > 0);
  document.querySelectorAll('#wm-mode .seg-btn').forEach((b) => b.classList.toggle('active', (b.dataset.on === 'share') === _wmShare));
  $('wm-mode-hint').textContent = `Default for this amount: ${prize_won >= threshold ? 'share' : 'add to pool'} ` +
    `(${prize_won >= threshold ? 'at or above' : 'below'} the ${money(threshold)} threshold).${_wmShareTouched ? '' : ' Tap to change.'}`;
  if (prize_won > 0) {
    wl.textContent = _wmShare
      ? '💸 Paid out: ' + Object.entries(c.pcts).sort((a, b) => b[1] - a[1]).map(([id, p]) => `${invName(id)} ${money(prize_won * p / 100)}`).join(' · ')
      : '🏦 Added to prize pool';
    wl.className = _wmShare ? 'gold' : 'green';
  } else wl.textContent = '';
  if (pool_used > _wmPool.total + 0.005) {
    wl.textContent = `⚠️ Only ${money(_wmPool.total)} is in the pool — that amount will be used.`;
    wl.className = 'red';
  }
  $('wm-preview').innerHTML = pctRows(c.pcts, c.eff);
}

async function saveWeek() {
  const id = $('wm-id').value || null;
  const result_date = $('wm-date').value;
  if (!result_date) return toast('Please select a result date.', 'err');
  const { investments, pool_used, prize_won } = weekInputs();
  const row = {
    result_date, investments, pool_used, prize_won,
    big_win: prize_won > 0 && _wmShare,
    notes: $('wm-notes').value.trim(),
  };
  $('wm-save-btn').disabled = true;
  try {
    const q = id ? S.sb.from('weeks').update(row).eq('id', id) : S.sb.from('weeks').insert(row);
    const { error } = await q;
    if (error) throw error;
    toast('Week saved!', 'ok');
    closeModal('week-overlay');
    await loadAll();
  } catch (e) { fail(e, 'Error saving week.'); }
  finally { $('wm-save-btn').disabled = false; }
}

async function deleteWeek(id) {
  const w = S.weeks.find((x) => x.id === id);
  if (!w || !confirm(`Delete the week of ${fmtD(w.result_date)}? The prize pool will be recalculated.`)) return;
  const { error } = await S.sb.from('weeks').delete().eq('id', id);
  if (error) return fail(error);
  toast('Week deleted.', 'ok');
  await loadAll();
}

// ─── Ticket QR codes & automatic results ─────────────────────────────────────
// A ticket carries a Data Matrix, a PDF417 and a QR code; only the QR code (a dhlottery.co.kr
// link to that ticket's result page) is read. tickets.qr_data holds one item per QR code:
//   { url, round, games: [{ mode, nums }], status, prize, manual, checked_at, message }
// status: pending (results not checked / not out yet) · win · lose · error · invalid.
// The check-tickets Edge Function fills in status/prize; members can correct any item by hand
// (manual: true), and the automatic check then leaves that item alone.
const QR_LABEL = { pending: '⏳ Waiting for results', win: '🎉 Won', lose: '낙첨 · no win', error: '❓ Could not check', invalid: '❓ Not a lotto QR' };
const QR_SEEN_MS = 10 * 60e3;

let _zx = null;
function loadZXing() {
  _zx ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing-reader.js';
    s.onload = () => {
      window.ZXingWASM.prepareZXingModule({ overrides: { locateFile: (f) => new URL('vendor/' + f, location.href).href } });
      resolve(window.ZXingWASM);
    };
    s.onerror = () => { _zx = null; reject(new Error('Could not load the QR reader.')); };
    document.head.appendChild(s);
  });
  return _zx;
}

function parseLottoQR(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (!/(^|\.)dhlottery\.co\.kr$/i.test(u.hostname)) return null;
  const v = u.searchParams.get('v') || '';
  const m = v.match(/^(\d{3,4})/);
  const games = [...v.slice(m ? m[1].length : 0).matchAll(/([a-z])(\d{12})/gi)]
    .map(([, mode, d]) => ({ mode: mode.toLowerCase(), nums: d.match(/\d\d/g).map(Number) }));
  return { url: u.href, round: m ? +m[1] : null, games, status: 'pending', prize: null, manual: false, checked_at: null, message: null };
}

/** All lotto QR codes in a photo (several tickets per photo are fine). */
async function readTicketQRs(source) {
  const ZX = await loadZXing();
  const bmp = await createImageBitmap(source);
  const scale = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const found = await ZX.readBarcodes(g.getImageData(0, 0, c.width, c.height), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 40 });
  const items = [];
  for (const r of found) {
    const it = r.isValid && parseLottoQR(r.text);
    if (it && !items.some((x) => x.url === it.url)) items.push(it);
  }
  return items;
}

function sortTickets(list) {
  return [...list].sort((a, b) => (a.draw_date < b.draw_date ? 1 : a.draw_date > b.draw_date ? -1
    : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
}
/** The one draw all QR codes on a photo belong to (null if none or mixed). */
function qrRound(items) {
  const rounds = [...new Set((items || []).map((i) => i.round).filter(Boolean))];
  return rounds.length === 1 ? rounds[0] : null;
}
const qrItems = (t) => (Array.isArray(t.qr_data) ? t.qr_data : []);
const qrNeedsCheck = (i) => !i.manual && (i.status === 'pending' || i.status === 'error');
const qrProblem = (i) => i.status === 'error' || i.status === 'invalid' || (i.status === 'win' && !(+i.prize > 0));

/** QR results for some photos; a QR that appears in two photos is counted once. */
function qrSummary(tickets) {
  const byUrl = new Map();
  for (const t of tickets) for (const it of qrItems(t)) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  const items = [...byUrl.values()];
  const won = items.filter((i) => i.status === 'win');
  const pending = items.filter((i) => i.status === 'pending').length;
  return {
    items, n: items.length, win: won.length, lose: items.filter((i) => i.status === 'lose').length,
    pending, problem: items.filter(qrProblem).length, total: sum(won.map((i) => +i.prize || 0)),
    done: items.length > 0 && pending === 0 && !items.some(qrProblem),
  };
}

function qrBadge(s, { short = false } = {}) {
  if (!s.n) return '';
  if (s.win) return `<span class="badge qr-win">🎉 ${esc(money(s.total))}${s.pending ? ` · ${s.pending} ⏳` : ''}</span>`;
  if (s.pending) return `<span class="badge bg-gray">⏳ ${short ? s.pending : `${s.pending} waiting`}</span>`;
  if (s.problem) return `<span class="badge bg-red">❓ check</span>`;
  return `<span class="badge bg-gray">낙첨</span>`;
}

const resultsOut = (d) => Date.now() >= kstAt(d, RESULTS_TIME).getTime();

const CHECK_FN_URL = () => `${CFG.supabaseUrl}/functions/v1/check-tickets`;

async function checkResults(ticketId) {
  const { data, error } = await S.sb.functions.invoke('check-tickets', {
    body: ticketId ? { ticket_id: ticketId } : {}, region: 'ap-northeast-2',
  });
  if (!error) return data;
  // The function answered with an error: show its own message
  let detail = '';
  try { detail = (await error.context?.json?.())?.error || ''; } catch { /* not JSON */ }
  const err = new Error(detail ? `Result check failed: ${detail}` : 'Could not reach the result checker.');
  err.unreachable = !detail && error.name === 'FunctionsFetchError';
  throw err;
}

function checkFailHelp(e) {
  if (!e.unreachable) return esc(e.message);
  return `Could not reach the <strong>check-tickets</strong> Edge Function. Usually one of:
    <ul><li>it is not deployed yet: in GitHub run <em>Actions → Deploy result checker → Run workflow</em>
      (needs the <code>SUPABASE_ACCESS_TOKEN</code> secret, see README);</li>
    <li>"Verify JWT" is still on in the function's settings (only if deployed from the Supabase dashboard).</li></ul>
    Test it: <a href="${esc(CHECK_FN_URL())}" target="_blank" rel="noopener">open the function</a> — it should show
    <code>"ok": true</code>. Anything else (e.g. "Missing authorization header", "NOT_FOUND") tells you which step to redo.`;
}

/** After 20:50 KST on draw day, the first member who opens the app triggers the check. */
let _lastAutoCheck = 0;
function maybeAutoCheck() {
  if (Date.now() - _lastAutoCheck < QR_SEEN_MS) return;
  const due = S.tickets.some((t) => resultsOut(t.draw_date) && (qrItems(t).some((i) =>
    qrNeedsCheck(i) && !(i.checked_at && Date.now() - new Date(i.checked_at).getTime() < QR_SEEN_MS))
    // or a finished draw whose winning numbers are not saved yet
    || qrItems(t).some((i) => i.round && !S.draws[i.round])));
  if (!due) return;
  _lastAutoCheck = Date.now();
  checkResults().catch((e) => console.warn(e.message));
}

// ─── Result summary (like the official result page) ──────────────────────────
const FIXED_PRIZE = { 4: 50000, 5: 5000 };
const GAME_LABELS = 'ABCDE';
const ball = (n, cls = '') => `<span class="ball ${cls} b${Math.ceil(n / 10)}">${String(n).padStart(2, '0')}</span>`;

/** Rank of one game: 6 = 1등, 5+bonus = 2등, 5 = 3등, 4 = 4등, 3 = 5등, else 0. */
function gameResult(g, draw) {
  if (g.rank != null && g.match) return g;
  if (!draw) return null;
  const match = g.nums.filter((n) => draw.numbers.includes(n)), bonus = g.nums.includes(draw.bonus), k = match.length;
  return { ...g, match, bonus, rank: k === 6 ? 1 : k === 5 && bonus ? 2 : k === 5 ? 3 : k === 4 ? 4 : k === 3 ? 5 : 0 };
}

function drawBalls(draw) {
  return `${draw.numbers.map((n) => ball(n)).join('')}<span class="plus">+</span>${ball(draw.bonus, 'bonus')}`;
}

function resultSummary(it, drawDate) {
  const draw = S.draws[it.round];
  const games = (it.games || []).map((g) => gameResult(g, draw) || g);
  const verdict = it.status === 'win'
    ? `<div class="rs-verdict win">축하합니다! <span>총 ${+it.prize > 0 ? esc(money(it.prize)) : '?'} 당첨</span></div>`
    : it.status === 'lose' ? `<div class="rs-verdict lose">아쉽게도, <span>낙첨되었습니다.</span></div>`
      : `<div class="rs-verdict wait">${resultsOut(drawDate) ? '⏳ Result not checked yet' : `⏳ Results after ${RESULTS_TIME} KST on ${esc(fmtD(drawDate))}`}</div>`;
  return `<div class="rs">
    <div class="rs-head">제${it.round ?? '?'}회${draw?.draw_date ? ` · ${esc(fmtD(draw.draw_date))}` : ''}
      ${draw ? `<span class="rs-win">당첨번호 ${drawBalls(draw)}</span>` : resultsOut(drawDate) ? '<span class="fhelp">winning numbers not loaded yet</span>' : ''}</div>
    ${games.map((g, i) => {
      const hit = (n) => (g.match?.includes(n) ? 'hit' : g.bonus && draw && n === draw.bonus ? 'hit-bonus' : '');
      const rank = g.rank == null ? '' : g.rank ? `<span class="rs-rank r${g.rank}">${g.rank}등${FIXED_PRIZE[g.rank] ? ' ' + esc(money(FIXED_PRIZE[g.rank])) : ''}</span>` : '<span class="rs-rank r0">낙첨</span>';
      return `<div class="rs-game"><span class="rs-label">${GAME_LABELS[i] || i + 1}</span><span class="rs-nums">${g.nums.map((n) => ball(n, hit(n))).join('')}</span>${rank}</div>`;
    }).join('')}
    ${verdict}
  </div>`;
}

// Lightbox panel: the QR codes of one photo, with manual correction.
function renderLbQr() {
  const t = S.lbTicket, el = $('lb-qr');
  if (!t) return;
  const items = qrItems(t), drawN = drawNo(t.draw_date);
  const elsewhere = (url) => S.tickets.some((x) => x.id !== t.id && qrItems(x).some((i) => i.url === url));
  const head = `<div class="qr-head">
      <strong>🔍 QR codes on this photo${t.qr_data ? ` (${items.length})` : ''}</strong>
      ${qrRound(items) && qrRound(items) !== drawN ? `<button class="btn btn-primary btn-sm" data-act="qr-move">Move photo to draw #${qrRound(items)} (${esc(fmtD(drawDate(qrRound(items))))})</button>` : ''}
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" data-act="qr-scan">${t.qr_data ? 'Scan again' : 'Scan photo'}</button>
        ${items.some((i) => !i.manual) ? `<button class="btn btn-secondary btn-sm" data-act="qr-check">Check results now</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="qr-add">＋ Add QR link</button>
      </div>
    </div>`;
  const body = !t.qr_data
    ? `<p class="fhelp">This photo has not been scanned yet.</p>`
    : !items.length
      ? `<p class="fhelp">No lotto QR code was found. Try "Scan again", upload a sharper photo, or add the link by hand
         (scan the ticket with your phone camera and copy the link).</p>`
      : items.map((it, i) => `<div class="qr-item ${it.status}">
        <div class="qr-main">
          <div><strong>${it.round ? `#${it.round}` : 'QR'}</strong>
            ${it.round && drawN && it.round !== drawN ? `<span class="red fhelp"> ⚠️ this photo is filed under draw #${drawN}</span>` : ''}
            ${elsewhere(it.url) ? `<span class="fhelp"> · also in another photo (counted once)</span>` : ''}
            ${it.manual ? `<span class="badge bg-gray">corrected by hand</span>` : ''}</div>
          ${resultSummary(it, t.draw_date)}
          <div class="fhelp">${it.checked_at ? `Checked ${esc(fmtKST(it.checked_at))}` : resultsOut(t.draw_date) ? 'Not checked yet' : `Results after ${RESULTS_TIME} KST on draw day`}${it.message ? ` · ${esc(it.message)}` : ''}</div>
        </div>
        <div class="qr-edit">
          <select class="fsel" data-on-input="qr-status" data-i="${i}">
            ${Object.entries(QR_LABEL).filter(([k]) => ['pending', 'win', 'lose'].includes(k) || k === it.status)
              .map(([k, label]) => `<option value="${k}" ${k === it.status ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <input class="finp" data-amount inputmode="numeric" placeholder="Prize" value="${esc(fmtAmt(it.prize))}"
                 data-on-input="qr-prize" data-i="${i}" ${it.status === 'win' ? '' : 'hidden'}>
          <button class="btn btn-ghost btn-sm" data-act="qr-remove" data-i="${i}" title="Not a real ticket / wrong detection">✕</button>
        </div>
        <a class="fhelp" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open result page ↗</a>
      </div>`).join('');
  const s = qrSummary([t]);
  el.innerHTML = head + body + (s.n ? `<div class="qr-total">This photo: ${qrBadge(s)}</div>` : '');
}

async function saveQr(items, msg = 'Saved.') {
  const t = S.lbTicket;
  const { error } = await S.sb.from('tickets').update({ qr_data: items }).eq('id', t.id);
  if (error) return fail(error);
  t.qr_data = items;
  renderLbQr();
  toast(msg, 'ok');
  scheduleReload();
}

async function scanLbPhoto() {
  const t = S.lbTicket;
  $('lb-qr').querySelector('[data-act=qr-scan]').textContent = 'Scanning…';
  try {
    const url = (await signedUrls([t.storage_path]))[t.storage_path];
    const found = await readTicketQRs(await (await fetch(url)).blob());
    const items = [...qrItems(t)];
    for (const f of found) if (!items.some((i) => i.url === f.url)) items.push(f);
    await saveQr(items, `${found.length} QR code${found.length === 1 ? '' : 's'} found.`);
    if (resultsOut(t.draw_date) && items.some(qrNeedsCheck)) await checkLb();
  } catch (e) { fail(e, 'Could not scan the photo.'); renderLbQr(); }
}

async function checkLb() {
  const t = S.lbTicket;
  if (!resultsOut(t.draw_date)) return toast(`Results come out at ${RESULTS_TIME} KST on ${fmtD(t.draw_date)}.`, 'err');
  toast('Checking results…', 'ok');
  try {
    await checkResults(t.id);
    const { data, error } = await S.sb.from('tickets').select('*').eq('id', t.id).maybeSingle();
    if (error) throw error;
    Object.assign(t, data);
    renderLbQr();
    toast('Results checked.', 'ok');
    scheduleReload();
  } catch (e) {
    console.warn(e);
    renderLbQr();
    $('lb-qr').insertAdjacentHTML('afterbegin', `<div class="form-error qr-error">${checkFailHelp(e)}</div>`);
    toast(e.unreachable ? 'Could not reach the result checker — see the note under the photo.' : e.message, 'err');
  }
}

function editLbItem(i, patch) {
  const items = qrItems(S.lbTicket).map((x) => ({ ...x }));
  Object.assign(items[i], patch, { manual: true, checked_at: new Date().toISOString(), message: `Corrected by ${S.me.display_name}` });
  if (items[i].status !== 'win') items[i].prize = items[i].status === 'lose' ? 0 : null;
  saveQr(items, 'Correction saved.');
}

async function moveLbToQrDraw() {
  const t = S.lbTicket, r = qrRound(qrItems(t));
  if (!r || !confirm(`Move this photo from draw #${drawNo(t.draw_date)} to draw #${r}, as its QR code says?`)) return;
  const { error } = await S.sb.rpc('move_ticket_to_qr_draw', { p_ticket: t.id });
  if (error) return fail(/function|schema/i.test(error.message) ? new Error('Run the latest supabase/schema.sql once in Supabase to enable this.') : error);
  t.draw_date = drawDate(r);
  toast(`Moved to draw #${r}.`, 'ok');
  await loadAll();
  openTicket(t.id);
}

function addLbLink() {
  const text = prompt('Paste the link from the ticket\'s QR code (scan it with your phone camera):');
  if (!text) return;
  const it = parseLottoQR(text);
  if (!it) return toast('That is not a dhlottery.co.kr QR link.', 'err');
  const items = [...qrItems(S.lbTicket)];
  if (items.some((x) => x.url === it.url)) return toast('This QR code is already on the list.', 'err');
  saveQr([...items, it], 'QR link added.');
}

// ─── Tickets ──────────────────────────────────────────────────────────────────
function renderTickets() {
  if (!$('up-date').value) { $('up-date').value = currentDraw(); $('up-round').value = drawNo(currentDraw()); }
  upDateInfo();

  const groups = {};
  for (const t of S.tickets) (groups[t.draw_date] ||= []).push(t);
  const dates = Object.keys(groups).sort().reverse();
  const el = $('tickets-list');
  if (!dates.length) {
    el.innerHTML = `<div class="empty"><div class="ico">🎟️</div><p>No ticket photos yet. Upload the first one above.</p></div>`;
    return;
  }
  el.innerHTML = dates.map((d) => {
    const ts = groups[d], games = sum(ts.map((t) => t.game_count || 0));
    return `<div class="draw-group" id="tg-${d}">
      <div class="draw-group-hd">
        <span class="t">Draw ${drawLabel(d)} · ${esc(fmtD(d))}</span>
        <span class="fhelp">${ts.length} photo${ts.length > 1 ? 's' : ''}${games ? ` · ${games} games` : ''}${qrSummary(ts).n ? ` · ${qrSummary(ts).n} QR codes` : ''}</span>
        ${qrBadge(qrSummary(ts))}
      </div>
      <div class="ticket-grid">${ts.map((t) => `
        <div class="ticket" data-act="ticket-open" data-id="${esc(t.id)}">
          <img class="thumb" data-path="${esc(t.thumb_path || t.storage_path)}" alt="Ticket photo" loading="lazy">
          <div class="meta">
            <strong>${esc(userName(t.uploaded_by))}</strong>
            <span>${esc(fmtKST(t.created_at))}</span>
            <span>${uploadBadge(t)}${t.game_count ? ` <span class="badge bg-gray">${t.game_count} games</span>` : ''}</span>
            <span>${t.qr_data ? (qrItems(t).length ? qrBadge(qrSummary([t])) : '<span class="badge bg-red">no QR found</span>') : '<span class="badge bg-gray">QR not scanned</span>'}
              ${qrRound(t.qr_data) && qrRound(t.qr_data) !== drawNo(t.draw_date) ? `<span class="badge bg-red">QR says #${qrRound(t.qr_data)}</span>` : ''}</span>
            ${t.note ? `<span>${esc(t.note)}</span>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
  if (S.tab === 'tickets') hydrateImages(el);
}

function upDateInfo() {
  const d = $('up-date').value, n = drawNo(d);
  $('up-date-info').textContent = !d ? '' : n ? `제${n}회 · ${fmtD(d)}${d === currentDraw() ? ' (this week)' : ''}` : '⚠️ Not a Saturday';
}

function addUploadFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/') && !/\.(heic|heif)$/i.test(f.name)) continue;
    S.uploads.push({ file: f, url: URL.createObjectURL(f) });
  }
  renderUploadPreview();
}

function renderUploadPreview() {
  $('up-preview').innerHTML = S.uploads.map((u, i) =>
    `<div class="pv"><img src="${u.url}" alt=""><button data-act="up-remove" data-id="${i}" title="Remove">✕</button></div>`).join('');
  $('up-btn').disabled = !S.uploads.length;
  $('up-btn').textContent = S.uploads.length ? `Upload ${S.uploads.length} photo${S.uploads.length > 1 ? 's' : ''}` : 'Upload';
}

function canvasJpeg(bmp, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res({ blob: b, w: c.width, h: c.height }), 'image/jpeg', quality));
}

/** Resize big phone photos (keeps QR codes readable) and make a small thumbnail. */
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch {
    // e.g. HEIC on browsers that can't decode it: upload the original untouched
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return { main: file, ext: /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'img', thumb: null,
      type: file.type || (/^hei[cf]$/.test(ext) ? 'image/' + ext : 'image/jpeg') };
  }
  const big = Math.max(bmp.width, bmp.height) > MAX_SIDE;
  const main = (!big && file.type === 'image/jpeg') ? { blob: file, w: bmp.width, h: bmp.height } : await canvasJpeg(bmp, MAX_SIDE, 0.9);
  const thumb = await canvasJpeg(bmp, THUMB_SIDE, 0.75);
  bmp.close?.();
  return { main: main.blob, w: main.w, h: main.h, ext: 'jpg', type: 'image/jpeg', thumb: thumb.blob };
}

async function uploadTickets() {
  const chosen = $('up-date').value;
  if (!chosen) return toast('Choose the draw (회차) or its date.', 'err');
  if (!drawNo(chosen) && !confirm(`${fmtD(chosen)} is not a Saturday. Upload anyway?`)) return;
  const games = parseInt($('up-games').value, 10);
  const note = $('up-note').value.trim();
  const btn = $('up-btn'), status = $('up-status');
  btn.disabled = true;
  let done = 0, qrFound = 0;
  const movedTo = [];
  const total = S.uploads.length;
  try {
    while (S.uploads.length) {
      const u = S.uploads[0];
      status.textContent = `Reading QR codes ${done + 1} of ${total}…`;
      let qr_data = null;   // null = not scanned (reader failed), [] = scanned, nothing found
      try { qr_data = await readTicketQRs(u.file); qrFound += qr_data.length; }
      catch (e) { console.warn('QR scan failed', e); }
      // The QR code knows the ticket's draw: file the photo there even if another week was chosen
      const r = qrRound(qr_data), draw_date = r ? drawDate(r) : chosen;
      if (draw_date !== chosen) movedTo.push(r);
      status.textContent = `Uploading ${done + 1} of ${total}…`;
      const img = await prepareImage(u.file);
      const id = uuid();
      const path = `${draw_date}/${id}.${img.ext}`;
      const store = S.sb.storage.from(BUCKET);
      const { error: e1 } = await store.upload(path, img.main, { contentType: img.type, upsert: false, cacheControl: '31536000' });
      if (e1) throw e1;
      let thumb_path = null;
      if (img.thumb) {
        thumb_path = `${draw_date}/${id}.thumb.jpg`;
        const { error: e2 } = await store.upload(thumb_path, img.thumb, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
        if (e2) thumb_path = null;
      }
      const { error: e3 } = await S.sb.from('tickets').insert({
        id, draw_date, storage_path: path, thumb_path, note,
        game_count: Number.isFinite(games) && done === 0 ? games : null,
        width: img.w || null, height: img.h || null, bytes: img.main.size, qr_data,
      });
      if (e3) throw e3;
      URL.revokeObjectURL(u.url);
      S.uploads.shift();
      done++;
    }
    status.textContent = '';
    $('up-games').value = $('up-note').value = '';
    toast(`Uploaded ${done} photo${done > 1 ? 's' : ''} · ${qrFound} QR code${qrFound === 1 ? '' : 's'} read.` +
      (movedTo.length ? ` ${movedTo.length} filed under draw ${[...new Set(movedTo)].map((x) => '#' + x).join(', ')} as their QR codes say.` : ' Good luck! 🍀'), 'ok');
    _lastAutoCheck = 0;
    await loadAll();
  } catch (e) {
    status.textContent = done ? `${done} uploaded, then an error occurred.` : '';
    fail(e, 'Upload failed.');
  } finally {
    renderUploadPreview();
  }
}

function navTicket(delta) {
  const i = S.tickets.findIndex((x) => x.id === S.lbTicket?.id) + delta;
  if (i >= 0 && i < S.tickets.length) openTicket(S.tickets[i].id);
}

async function openTicket(id) {
  const t = S.tickets.find((x) => x.id === id);
  if (!t) return;
  S.lbTicket = t;
  const idx = S.tickets.indexOf(t);
  $('lb-pos').textContent = `${idx + 1} / ${S.tickets.length}`;
  $('lb-prev').disabled = idx <= 0;
  $('lb-next').disabled = idx >= S.tickets.length - 1;
  $('lb-img').removeAttribute('src');
  $('lb-info').innerHTML = `<strong>Draw ${drawLabel(t.draw_date)} · ${esc(fmtD(t.draw_date))}</strong><br>
    Uploaded by ${esc(userName(t.uploaded_by))} · ${esc(fmtKST(t.created_at))} ${uploadBadge(t)}
    ${t.game_count ? ` · ${t.game_count} games` : ''}${t.note ? ` · ${esc(t.note)}` : ''}`;
  renderLbQr();
  $('lb-overlay').classList.add('open');
  try {
    const map = await signedUrls([t.storage_path]);
    $('lb-img').src = map[t.storage_path];
    $('lb-open').href = map[t.storage_path];
  } catch (e) { fail(e, 'Could not load the image.'); }
}

async function deleteTicket() {
  const t = S.lbTicket;
  if (!t || !confirm('Delete this ticket photo permanently? (Admin only — the deletion is kept in the activity log.)')) return;
  const { error: e1 } = await S.sb.storage.from(BUCKET).remove([t.storage_path, t.thumb_path].filter(Boolean));
  if (e1) return fail(e1);
  const { error: e2 } = await S.sb.from('tickets').delete().eq('id', t.id);
  if (e2) return fail(e2);
  closeModal('lb-overlay');
  toast('Photo deleted.', 'ok');
  await loadAll();
}

// ─── Number suggestions ───────────────────────────────────────────────────────
// The engine lives in picks.js (also used by tools/analyze-picks.mjs).
const { RECENT_DRAWS, suggestSets, suggestPartial, backtest } = window.PicksEngine;

// ── page
let _picks = null, _picksKey = '', _picksCount = 10, _historyAsked = false;
// How many numbers to suggest (1–6) and the member's own numbers; remembered on this device only.
const PICK_PREF = (() => { try { return JSON.parse(localStorage.getItem('645-picks')) || {}; } catch { return {}; } })();
let _pickK = [1, 2, 3, 4, 5, 6].includes(PICK_PREF.k) ? PICK_PREF.k : 6;
let _pickOwn = Array.isArray(PICK_PREF.own) ? PICK_PREF.own.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45).slice(0, 5) : [];
function savePickPref() { try { localStorage.setItem('645-picks', JSON.stringify({ k: _pickK, own: _pickOwn })); } catch { /* private mode */ } }

/** "7, 15 22" → [7, 15, 22]; ignores repeats and anything outside 1–45, keeps at most 5. */
function parseOwnNumbers(text) {
  const all = (String(text).match(/\d+/g) || []).map(Number), out = [], bad = [];
  for (const n of all) {
    if (n < 1 || n > 45) bad.push(n);
    else if (!out.includes(n)) out.push(n);
  }
  return { nums: out.slice(0, 5), bad, extra: Math.max(0, out.length - 5) };
}
function setPickOwn(text) {
  const { nums, bad, extra } = parseOwnNumbers(text);
  _pickOwn = nums;
  const help = [];
  if (bad.length) help.push(`Ignored ${bad.join(', ')}: numbers go from 1 to 45.`);
  if (extra) help.push(`Only the first 5 are used.`);
  $('pick-own-help').textContent = help.join(' ') || (nums.length
    ? `Using ${nums.join(', ')}. ${6 - nums.length} more to fill.`
    : 'Up to 5. Suggestions are built around them.');
  $('pick-own-help').classList.toggle('warn', !!help.length);
  savePickPref();
  renderPicks();
}
// _pickK is the member's choice; 6 means "fill every open slot". With own numbers it is capped at 6 − own.
const pickK = () => Math.min(_pickK, 6 - _pickOwn.length);
function setPickK(k) {
  _pickK = k;
  savePickPref();
  renderPicks();
}
function renderPickControls() {
  const max = 6 - _pickOwn.length, k = pickK();
  document.querySelectorAll('#pick-k .seg-btn').forEach((b) => {
    const bk = +b.dataset.k, fill = bk === 6;
    if (fill) b.textContent = _pickOwn.length ? `All ${max} left` : 'All 6';
    // with own numbers, the first button already means "fill the rest", so k ≥ max is not offered twice
    b.hidden = !fill && bk >= max && _pickOwn.length > 0;
    b.classList.toggle('active', fill ? k === max : bk === k && k < max);
  });
  const inp = $('pick-own');
  if (document.activeElement !== inp && parseOwnNumbers(inp.value).nums.join() !== _pickOwn.join()) inp.value = _pickOwn.join(' ');
}
const pickHistory = () => Object.values(S.draws).filter((d) => d.numbers?.length === 6).sort((a, b) => a.round - b.round);

function renderPicks() {
  renderBoard();
  const target = drawNo(currentDraw()), latestOut = drawNo(addDays(currentDraw(), -7));
  const hist = pickHistory().filter((d) => d.round < target);
  $('picks-for').textContent = `for draw #${target} · ${fmtD(currentDraw())}`;
  if (hist.length < latestOut - 5) {
    $('picks-list').innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div>
      <p>Loading past winning numbers (${hist.length} of ${latestOut} draws)…</p>
      <p class="fhelp">The result checker downloads the full history once. This needs the check-tickets function.</p></div>`;
    $('picks-grid').innerHTML = $('picks-backtest').innerHTML = '';
    if (!_historyAsked) {
      _historyAsked = true;
      checkResults().then(() => loadAll()).then(() => S.tab === 'picks' && renderPicks())
        .catch((e) => { $('picks-list').innerHTML = `<div class="form-error">${checkFailHelp(e)}</div>`; });
    }
    return;
  }
  renderPickControls();
  const own = _pickOwn, k = pickK(), partial = k < 6;
  const key = `${target}-${hist.length}-${_picksCount}-${k}-${own.join(',')}`;
  if (key !== _picksKey) {
    if (partial && _picksKey !== `working:${key}`) {
      // building partial suggestions takes up to a second; show that something is happening
      _picksKey = `working:${key}`;
      $('picks-list').innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><p>Working out suggestions…</p></div>';
      setTimeout(() => S.tab === 'picks' && _picksKey === `working:${key}` && renderPicks(), 20);
      return;
    }
    _picks = partial
      ? suggestPartial(hist, { fixed: own, k, seed: target * 7919 + k, count: _picksCount })
      : suggestSets(hist, { seed: target * 7919, count: _picksCount });
    _picksKey = key;
  }
  const { st, picks } = _picks, open = partial ? _picks.open : 0;
  const stars = (f) => '★★★★★'.slice(0, Math.max(1, Math.round(f / 20))).padEnd(5, '☆');
  const balls = (p) => {
    const mine = partial ? own : [];
    return p.nums.map((n) => ball(n, mine.includes(n) ? 'own' : 'hit')).join('') + '<span class="ball open">?</span>'.repeat(open);
  };
  const what = !partial ? 'sets' : open ? `groups of ${k}` : 'sets';
  const key6 = !partial ? '' : `<div class="pick-key">
      <span>${ball(7, 'hit')}suggested</span>
      ${own.length ? `<span>${ball(own[0], 'own')}yours</span>` : ''}
      ${open ? `<span><span class="ball open">?</span>you choose${open > 1 ? ` (${open})` : ''}</span>` : ''}
    </div>`;
  $('picks-list').innerHTML = key6 + (picks.length ? picks.map((p, i) => `<div class="pick">
      <div class="pick-rank">${i + 1}</div>
      <div class="pick-main">
        <div class="pick-balls">${balls(p)}</div>
        <div class="pick-why">${p.reasons.map((r) => `<span>${esc(r)}</span>`).join('')}</div>
      </div>
      <div class="pick-score" title="Fits past winning patterns better than ${p.percentile.toFixed(1)}% of random ${what}">
        <div class="stars">${stars(p.fit)}</div>
        <div class="fhelp">score ${p.fit.toFixed(0)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-act="copy" data-text="${p.nums.map((n) => String(n).padStart(2, '0')).join(' ')}" title="Copy numbers">Copy</button>
    </div>`).join('') : '<div class="empty"><p>No suggestions for this choice.</p></div>');

  const maxR = Math.max(...st.recent.slice(1));
  $('picks-grid').innerHTML = `<div class="num-grid">${[...Array(45)].map((_, i) => {
      const n = i + 1, a = 0.08 + 0.6 * st.recent[n] / (maxR || 1);
      return `<div class="num-cell" style="background:rgba(57,135,229,${a.toFixed(2)})" title="#${n}: ${st.recent[n]}× in the last ${RECENT_DRAWS} draws · ${st.freq[n]}× in all ${st.N} draws · last seen ${st.gap[n]} draw${st.gap[n] === 1 ? '' : 's'} ago">
        ${ball(n, 'hit')}<small>${st.recent[n]}×</small></div>`;
    }).join('')}</div>
    <p class="fhelp" style="margin:8px 0 12px">Shading and count: times drawn in the last ${RECENT_DRAWS} draws (≈ 1 year). Hover for all-time numbers.</p>
    <div class="num-lists">
      <div><span class="flbl">🔥 Hot</span>${st.hot.slice(0, 8).map((n) => ball(n, 'hit')).join('')}</div>
      <div><span class="flbl">🧊 Cold</span>${st.cold.map((n) => ball(n, 'hit')).join('')}</div>
      <div><span class="flbl">⏳ Overdue</span>${st.overdue.map((n) => `<span title="${st.gap[n]} draws">${ball(n, 'hit')}</span>`).join('')}</div>
    </div>`;
  if (!$('picks-backtest').innerHTML) {
    $('picks-backtest').innerHTML = `<p class="fhelp">Replays the last 100 draws: 5 suggestions per draw made only from the draws before it,
      against 5 random sets. This shows honestly what the analysis is worth.</p>
      <button class="btn btn-secondary btn-sm" data-act="picks-backtest">Run backtest</button>`;
  }
  renderSim();
}

function runBacktest() {
  $('picks-backtest').innerHTML = '<p class="fhelp">Running… (a few seconds)</p>';
  setTimeout(() => {
    const r = backtest(pickHistory().filter((d) => d.round < drawNo(currentDraw())), 100, 5);
    const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0') + '%';
    $('picks-backtest').innerHTML = `<table class="bt">
      <thead><tr><th></th><th>Suggested</th><th>Random</th><th>Theory</th></tr></thead>
      <tbody>
        <tr><td>Numbers matched per game</td><td class="mono">${(r.matches / r.games).toFixed(2)}</td><td class="mono">${(r.rMatches / r.rGames).toFixed(2)}</td><td class="mono">0.80</td></tr>
        <tr><td>Games with 3+ matches (5등 or better)</td><td class="mono">${pct(r.hit3, r.games)}</td><td class="mono">${pct(r.rHit3, r.rGames)}</td><td class="mono">2.4%</td></tr>
      </tbody></table>
      <p class="fhelp" style="margin-top:8px">${r.draws} draws · ${r.games} suggested games. Differences this small are luck:
      every set has the same chance. The real benefit is a smaller chance of sharing a big prize.</p>`;
  }, 30);
}

// ── Our numbers: every member picks numbers for each group of the coming draw, live
const BOARD_TABLES = ['pick_plans', 'group_picks'];
const MEMBER_COLORS = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#f472b6', '#2dd4bf', '#fb923c', '#a3e635', '#22d3ee', '#fda4af', '#93c5fd', '#fcd34d'];
const ENGINE_COLOR = '#a78bfa';
const memberColor = (id) => { const i = S.profiles.findIndex((p) => p.id === id); return i < 0 ? '#94a3b8' : MEMBER_COLORS[i % MEMBER_COLORS.length]; };
const memberName = (id) => S.profiles.find((p) => p.id === id)?.display_name || 'someone';
const pickColor = (p) => (p.by_engine ? ENGINE_COLOR : memberColor(p.picked_by));
const pickWho = (p) => (p.by_engine ? `🤖 engine, asked by ${memberName(p.picked_by)}` : memberName(p.picked_by));
S.board = { round: null, groups: 0, picks: [], missing: false, busy: {} };

async function loadBoard() {
  const round = drawNo(currentDraw());
  const [pl, gp] = await Promise.all([
    S.sb.from('pick_plans').select('*').eq('round', round).maybeSingle(),
    S.sb.from('group_picks').select('*').eq('round', round).order('created_at'),
  ]);
  const err = pl.error || gp.error;   // tables not created yet → ask the admin to run the schema
  S.board = { ...S.board, round, groups: pl.data?.groups || 0, picks: err ? [] : gp.data || [], missing: !!err };
}

const boardDefault = () => 5 * Math.max(1, simActiveMembers(currentDraw()));
const groupPicks = (g) => S.board.picks.filter((p) => p.grp === g).sort((a, b) => a.num - b.num);

// The same 0–100 scale as the ranked suggestions, so our own sets can be compared with them
let _scale = null, _scaleKey = '';
function boardScale() {
  const target = drawNo(currentDraw()), hist = pickHistory().filter((d) => d.round < target);
  if (hist.length < 100) return null;
  const key = `${target}-${hist.length}`;
  if (key !== _scaleKey) { _scale = suggestSets(hist, { seed: target * 7919, count: 1 }); _scaleKey = key; }
  return _scale;
}

function renderBoard() {
  const B = S.board, target = drawNo(currentDraw());
  if (!$('board-body')) return;
  $('board-for').textContent = `for draw #${target} · ${fmtD(currentDraw())}`;
  if (B.round !== target) { loadBoard().then(renderBoard).catch(console.error); return; }
  if (B.missing) {
    $('board-legend').innerHTML = '';
    $('board-body').innerHTML = `<div class="form-error">Picking numbers together needs two new database tables.
      ${isAdmin() ? 'Run <code>supabase/schema.sql</code> again in the Supabase SQL editor, then reload.' : 'Ask the admin to update the database.'}</div>`;
    return;
  }
  const inp = $('board-x');
  if (document.activeElement !== inp) inp.value = B.groups || '';
  inp.placeholder = String(boardDefault());
  const members = S.profiles.filter((p) => p.status === 'active');
  $('board-legend').innerHTML = members.map((p) => `<span class="${p.id === S.me.id ? 'me' : ''}"><span class="sw" style="--c:${memberColor(p.id)}"></span>${esc(p.display_name)}${p.id === S.me.id ? ' (you)' : ''}</span>`).join('')
    + `<span><span class="sw" style="--c:${ENGINE_COLOR}"></span>🤖 engine</span>`;
  if (!B.groups) {
    $('board-body').innerHTML = `<div class="empty"><p>How many groups do we play for draw #${target}?</p>
      <button class="btn btn-primary btn-sm" data-act="board-x" data-set="${boardDefault()}">Start with ${boardDefault()} groups</button>
      <p class="fhelp" style="margin-top:8px">5 per active investor. Or use the buttons above.</p></div>`;
    return;
  }
  const scale = boardScale(), stars = (f) => '★★★★★'.slice(0, Math.max(1, Math.round(f / 20))).padEnd(5, '☆');
  const groups = Array.from({ length: B.groups }, (_, i) => {
    const g = i + 1, picks = groupPicks(g), nums = picks.map((p) => p.num), full = nums.length >= 6;
    const r = scale && full ? scale.rate(nums) : null;
    return { g, picks, nums, full, r };
  });
  const scoreHtml = (x) => (!x.r ? (x.full ? '' : `${6 - x.nums.length} to go`)
    : `<div class="stars">${stars(x.r.fit)}</div><div>score ${x.r.fit.toFixed(0)} · better than ${Math.min(99, Math.floor(x.r.percentile))}% of random sets</div>`);
  const busy = (g) => (B.busy[g] ? 'disabled' : '');
  const hidden = B.picks.filter((p) => p.grp > B.groups).length;
  const done = groups.filter((x) => x.full);
  $('board-body').innerHTML = `<div class="board-groups">${groups.map((x) => `<div class="bgroup ${x.full ? 'full' : ''}" data-g="${x.g}">
      <div class="bg-hd">
        <span class="bg-title">Group ${x.g}</span>
        <span class="bg-count">${x.nums.length}/6</span>
        <div class="bg-score">${scoreHtml(x)}</div>
      </div>
      <div class="bg-nums">${[...Array(45)].map((_, i) => {
        const n = i + 1, p = x.picks.find((q) => q.num === n);
        return `<button type="button" class="bn ${p ? 'on' : ''}" data-act="board-num" data-g="${x.g}" data-n="${n}"
          ${p ? `style="--c:${pickColor(p)}" title="${n} · ${esc(pickWho(p))}"` : `title="${n}"`} ${busy(x.g)}>${n}</button>`;
      }).join('')}</div>
      ${x.full && x.r ? `<div class="bg-why">${x.r.reasons.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="bg-foot">
        ${x.full ? '' : `<button class="btn btn-ghost btn-sm" data-act="board-engine" data-g="${x.g}" data-mode="one" ${busy(x.g)} title="The engine adds one number that fits the ones already picked">🤖 +1</button>
        <button class="btn btn-ghost btn-sm" data-act="board-engine" data-g="${x.g}" data-mode="fill" ${busy(x.g)}>🤖 Fill the rest</button>`}
        ${x.picks.some((p) => p.picked_by === S.me.id) ? `<button class="btn btn-ghost btn-sm" data-act="board-clear" data-g="${x.g}" ${busy(x.g)}>Clear mine</button>` : ''}
      </div>
    </div>`).join('')}</div>
    ${hidden ? `<p class="fhelp" style="margin-top:10px">Groups above ${B.groups} still hold ${hidden} number${hidden > 1 ? 's' : ''}; raise the count to see them again.</p>` : ''}
    <div class="board-sum">
      <div class="bsum-hd">
        <div class="card-title">🧾 Our tickets</div>
        <span class="fhelp">${done.length} of ${B.groups} groups complete · ${esc(money(B.groups * TICKET_PRICE))}</span>
        ${done.length ? `<button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(done.map((x) => `${x.g}: ${x.nums.map((n) => String(n).padStart(2, '0')).join(' ')}`).join('\n'))}">Copy complete groups</button>` : ''}
      </div>
      ${groups.map((x) => `<div class="bsum-row">
        <span class="bsum-n">${x.g}</span>
        <span>${x.picks.map((p) => `<span class="ball mc" style="--c:${pickColor(p)}" title="${esc(pickWho(p))}">${String(p.num).padStart(2, '0')}</span>`).join('')}${'<span class="ball open">?</span>'.repeat(6 - x.nums.length)}</span>
        <span class="fhelp">${x.full && x.r ? `<span class="stars">${stars(x.r.fit)}</span> ${x.r.fit.toFixed(0)}` : `${6 - x.nums.length} to go`}</span>
      </div>`).join('')}
    </div>`;
}

async function setBoardGroups(n) {
  const B = S.board;
  n = Math.max(1, Math.min(100, n | 0));
  if (B.missing || n === B.groups) return;
  const lost = B.picks.filter((p) => p.grp > n && p.grp <= (B.groups || 0)).length;
  if (lost && !confirm(`Groups ${n + 1}–${B.groups} have ${lost} number${lost > 1 ? 's' : ''} picked. Hide them? (They come back if you raise the count again.)`)) { renderBoard(); return; }
  B.groups = n;
  renderBoard();
  const { error } = await S.sb.from('pick_plans').upsert({ round: B.round, groups: n }, { onConflict: 'round' });
  if (error) { fail(error); await loadBoard(); renderBoard(); }
}

async function toggleBoardNum(g, n) {
  const B = S.board, p = B.picks.find((q) => q.grp === g && q.num === n);
  if (p) {
    if (p.picked_by !== S.me.id && !p.by_engine && !isAdmin()) { toast(`${memberName(p.picked_by)} picked ${n}. Only they or an admin can take it back.`, 'err'); return; }
    B.picks = B.picks.filter((q) => q !== p);
    renderBoard();
    const { error } = await S.sb.from('group_picks').delete().eq('round', B.round).eq('grp', g).eq('num', n);
    if (error) { fail(error); await loadBoard(); renderBoard(); }
    return;
  }
  if (groupPicks(g).length >= 6) { toast(`Group ${g} already has 6 numbers. Take one back first.`, 'err'); return; }
  B.picks.push({ round: B.round, grp: g, num: n, picked_by: S.me.id, by_engine: false, created_at: new Date().toISOString() });
  renderBoard();
  const { error } = await S.sb.from('group_picks').insert({ round: B.round, grp: g, num: n });
  if (error) { fail(error); await loadBoard(); renderBoard(); }
}

/** The engine picks one number (or fills the group) around the numbers already in it. */
async function engineFill(g, mode) {
  const B = S.board, target = B.round, have = groupPicks(g).map((p) => p.num);
  const hist = pickHistory().filter((d) => d.round < target);
  if (have.length >= 6) return;
  if (hist.length < 100) { toast('Past winning numbers are still loading. Try again in a moment.', 'err'); return; }
  const k = mode === 'one' ? 1 : 6 - have.length;
  B.busy[g] = true;
  renderBoard();
  await new Promise((r) => setTimeout(r, 20));   // let the page show the busy state
  const res = suggestPartial(hist, { fixed: have, k, seed: target * 7919 + g * 131, count: 8 });
  // when completing a group, don't repeat a set another group already has
  const others = new Set(Array.from({ length: B.groups }, (_, i) => i + 1).filter((x) => x !== g).map((x) => groupPicks(x).map((p) => p.num).join()));
  const pick = res.picks.find((p) => have.length + k < 6 || !others.has(p.nums.join())) || res.picks[0];
  const rows = (pick?.part || []).map((num) => ({ round: target, grp: g, num, by_engine: true }));
  const { error } = rows.length ? await S.sb.from('group_picks').insert(rows) : {};
  delete B.busy[g];
  if (error) fail(error);
  await loadBoard();
  renderBoard();
}

async function clearMine(g) {
  const B = S.board;
  B.picks = B.picks.filter((p) => !(p.grp === g && p.picked_by === S.me.id));
  renderBoard();
  const { error } = await S.sb.from('group_picks').delete().eq('round', B.round).eq('grp', g).eq('picked_by', S.me.id);
  if (error) { fail(error); await loadBoard(); renderBoard(); }
}

// ── Past-week simulation: suggestions made only from draws before that week, then the real result
const TICKET_PRICE = 1000;
const FIXED_RANK_PRIZE = { 4: 50000, 5: 5000 };
const TYPICAL_RANK_PRIZE = { 1: 2000000000, 2: 55000000, 3: 1450000 };   // used only when the draw's own amounts are unknown
const SIM = { round: null, x: null, qty: [], sets: null, key: '', revealed: false, prizesAsked: false };

/** Any date → the draw it belongs to: Sunday → the coming Saturday, Monday–Saturday → that week's Saturday. */
const saturdayOf = (d) => addDays(d, (6 - weekday(d) + 7) % 7);

function simActiveMembers(date) {
  return S.investors.filter((i) => inPeriod(i, date)).length || S.investors.filter((i) => invState(i) === 'active').length;
}

function simSetRound(n) {
  const latestOut = drawNo(addDays(currentDraw(), -7));
  n = Math.max(200, Math.min(latestOut, n | 0));
  if (n !== SIM.round) { SIM.round = n; SIM.x = null; SIM.revealed = false; }
  renderSim();
}

function simSetX(x) {
  SIM.x = Math.max(1, Math.min(200, x));
  SIM.qty = [];
  renderSim();
}

function simPrize(rank, draw) {
  if (!rank) return { amount: 0, estimated: false };
  const own = +draw?.prizes?.[rank];
  if (own > 0) return { amount: own, estimated: false };
  if (FIXED_RANK_PRIZE[rank]) return { amount: FIXED_RANK_PRIZE[rank], estimated: false };
  return { amount: TYPICAL_RANK_PRIZE[rank], estimated: true };
}

function renderSim() {
  const el = $('sim-body');
  if (!el) return;
  const all = pickHistory(), latestOut = drawNo(addDays(currentDraw(), -7));
  if (all.length < latestOut - 5) { el.innerHTML = '<p class="fhelp">Waiting for the history of winning numbers (see above).</p>'; return; }
  if (!SIM.round) SIM.round = latestOut;
  const date = drawDate(SIM.round), draw = S.draws[SIM.round];
  const members = simActiveMembers(date);
  if (SIM.x == null) { SIM.x = Math.max(5, 5 * members); SIM.qty = []; }
  const count = Math.max(30, SIM.x);
  const key = `${SIM.round}-${count}-${all.length}`;
  if (key !== SIM.key) {
    // only draws BEFORE the chosen week — its own result is never used for the suggestions
    SIM.sets = suggestSets(all.filter((d) => d.round < SIM.round), { seed: SIM.round * 7919, count }).picks;
    SIM.key = key;
  }
  if (!SIM.qty.length) SIM.qty = SIM.sets.map((_, i) => (i < SIM.x ? 1 : 0));
  const groups = sum(SIM.qty), cost = groups * TICKET_PRICE;
  $('sim-round').value = SIM.round;
  $('sim-date').value = date;
  $('sim-x').value = SIM.x;
  $('sim-info').textContent = `제${SIM.round}회 · Saturday ${fmtD(date)} · ${members} active member${members === 1 ? '' : 's'} → default ${Math.max(5, 5 * members)} groups`;

  let won = 0, estimated = false;
  const rankCount = {};
  const rows = SIM.sets.map((p, i) => {
    const r = draw ? gameResult({ nums: p.nums }, draw) : null;
    const prize = simPrize(r?.rank, draw), q = SIM.qty[i] || 0;
    if (SIM.revealed && q) { won += q * prize.amount; estimated ||= prize.estimated && r.rank > 0; if (r.rank) rankCount[r.rank] = (rankCount[r.rank] || 0) + q; }
    const hit = (n) => (!SIM.revealed ? 'hit' : r.match.includes(n) ? 'hit' : r.bonus && n === draw.bonus ? 'hit-bonus' : '');
    return `<div class="sim-row ${q ? '' : 'off'}">
      <span class="sim-rank">${i + 1}</span>
      <span class="sim-balls">${p.nums.map((n) => ball(n, hit(n))).join('')}</span>
      <span class="fhelp" title="score">${p.fit.toFixed(0)}</span>
      <span class="sim-qty">
        <button class="qb qb-minus" data-act="sim-qty" data-i="${i}" data-d="-1" ${q ? '' : 'disabled'}>−</button>
        <strong>${q}</strong>
        <button class="qb qb-plus" data-act="sim-qty" data-i="${i}" data-d="1">+</button>
      </span>
      <span class="sim-res">${!SIM.revealed ? '' : r.rank ? `<span class="rs-rank r${r.rank}">${r.rank}등</span> ${esc(money(prize.amount))}${prize.estimated ? '≈' : ''}${q > 1 ? ` ×${q}` : ''}` : '<span class="rs-rank r0">낙첨</span>'}</span>
    </div>`;
  }).join('');

  const profit = won - cost;
  el.innerHTML = `
    <div class="sim-summary">
      <span><strong>${groups}</strong> group${groups === 1 ? '' : 's'} · cost <strong>${esc(money(cost))}</strong></span>
      ${SIM.revealed
        ? `<span>Won <strong class="${won ? 'green' : ''}">${esc(money(won))}${estimated ? ' ≈' : ''}</strong></span>
           <span class="sim-profit ${profit >= 0 ? 'green' : 'red'}">Profit ${profit >= 0 ? '+' : ''}${esc(money(profit))}</span>
           <span class="fhelp">${Object.keys(rankCount).length ? Object.entries(rankCount).map(([k, v]) => `${v}× ${k}등`).join(' · ') : 'no winning games'}</span>`
        : `<button class="btn btn-primary btn-sm" data-act="sim-reveal" ${groups && draw ? '' : 'disabled'}>Reveal results</button>`}
    </div>
    ${SIM.revealed && draw ? `<div class="sim-draw">Winning numbers 제${SIM.round}회: <span class="rs-win">${drawBalls(draw)}</span></div>` : ''}
    ${!draw ? '<p class="form-error">The winning numbers of this draw are not loaded.</p>' : ''}
    <div class="sim-list">${rows}</div>
    <p class="fhelp" style="margin-top:8px">Suggestions use only the ${SIM.round - 1} draws before 제${SIM.round}회, the same way this
      week's picks are made. Prizes: 4등 ₩50,000 and 5등 ₩5,000 are fixed. 1등–3등 use that draw's real amount when known,
      otherwise a typical amount marked ≈. On average a ₩1,000 game pays back about ₩500.</p>`;

  // the draw's own 1–3등 amounts: ask the result checker once if they are missing
  if (SIM.revealed && estimated && !SIM.prizesAsked) {
    SIM.prizesAsked = true;
    S.sb.functions.invoke('check-tickets', { body: { prizes: true }, region: 'ap-northeast-2' })
      .then(() => loadAll()).then(() => S.tab === 'picks' && renderSim()).catch(() => {});
  }
}

// ─── Investors ────────────────────────────────────────────────────────────────
function renderInvestors() {
  const stats = investorStats();
  const order = { active: 0, upcoming: 1, ended: 2 };
  const all = [...S.investors].sort((a, b) => order[invState(a)] - order[invState(b)]);
  const grid = $('inv-grid');
  grid.innerHTML = !all.length
    ? `<div class="empty" style="grid-column:1/-1"><div class="ico">👥</div><p>No investors yet. Add your first one!</p></div>`
    : all.map((inv) => {
      const s = stats[inv.id] || {}, net = (s.won || 0) - (s.invested || 0);
      const clr = invColor(inv);
      const state = invState(inv);
      const bad = S.weeks.filter((w) => outOfPeriod(w).includes(inv)).length;
      return `<div class="inv-card clickable" data-act="inv-detail" data-id="${esc(inv.id)}" style="${state === 'active' ? '' : 'opacity:.55'}">
        <div class="inv-actions">
          <button class="btn btn-ghost btn-sm" data-act="inv-edit" data-id="${esc(inv.id)}" title="Edit name and dates">✏️</button>
        </div>
        <div class="inv-avatar" style="background:${clr}22;color:${clr};border:2px solid ${clr}44">${esc(ini(inv.nickname))}</div>
        <div class="inv-name">${esc(inv.nickname)} ${state === 'active' ? '' : `<span class="badge bg-gray">${state === 'ended' ? 'ended' : 'not started'}</span>`}</div>
        <div class="inv-id">${esc(fmtPeriod(inv))}</div>
        ${bad ? `<div class="red fhelp" style="margin-top:6px">⚠️ ${bad} week${bad > 1 ? 's' : ''} outside these dates</div>` : ''}
        <div class="inv-stats">
          <div class="inv-stat"><span class="k">Invested</span><span class="v">${esc(money(s.invested || 0))}</span></div>
          <div class="inv-stat"><span class="k">Won (paid out)</span><span class="v">${esc(money(s.won || 0))}</span></div>
          <div class="inv-stat"><span class="k">Net P/L</span><span class="v ${net >= 0 ? 'green' : 'red'}">${net >= 0 ? '+' : ''}${esc(money(net))}</span></div>
          <div class="inv-stat"><span class="k">Weeks</span><span class="v">${s.weeks || 0}</span></div>
          <div class="inv-stat"><span class="k">Per day</span><span class="v" title="Fresh money ÷ ${activeDays(inv)} days of their active period">${esc(money(perDay(inv, s.invested || 0)))}</span></div>
        </div>
        <div class="fhelp" style="margin-top:8px">View all weeks →</div>
      </div>`;
    }).join('');

  renderLeaderboard(stats);
}

const LB_COLS = [
  { key: 'nickname', label: 'Investor', text: true },
  { key: 'invested', label: 'Invested' },
  { key: 'won', label: 'Won' },
  { key: 'net', label: 'Net P/L' },
  { key: 'weeks', label: 'Weeks' },
  { key: 'daily', label: 'Per day', title: 'Fresh money ÷ days of their active period' },
];

function renderLeaderboard(stats = investorStats()) {
  const { key, dir } = S.lbSort ||= { key: 'net', dir: -1 };
  const rows = S.investors.map((inv) => {
    const s = stats[inv.id] || {};
    return { ...inv, invested: s.invested || 0, won: s.won || 0, weeks: s.weeks || 0,
      net: (s.won || 0) - (s.invested || 0), days: activeDays(inv), daily: perDay(inv, s.invested || 0) };
  }).sort((a, b) => {
    const x = a[key], y = b[key];
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir || a.nickname.localeCompare(b.nickname);
  });
  $('leaderboard-head').innerHTML = `<tr><th>#</th>${LB_COLS.map((c) => `<th class="sortable ${c.key === key ? 'sorted' : ''}" data-act="lb-sort"
    data-id="${c.key}" ${c.title ? `title="${c.title}"` : ''}>${c.label}<span class="sort-ind">${c.key === key ? (dir > 0 ? '▲' : '▼') : '↕'}</span></th>`).join('')}</tr>`;
  $('leaderboard-body').innerHTML = rows.map((r, i) => `<tr>
    <td class="fhelp">${i + 1}</td>
    <td><strong>${esc(r.nickname)}</strong></td>
    <td class="mono">${esc(money(r.invested))}</td>
    <td class="mono">${esc(money(r.won))}</td>
    <td class="mono ${r.net >= 0 ? 'green' : 'red'}">${r.net >= 0 ? '+' : ''}${esc(money(r.net))}</td>
    <td>${r.weeks}</td>
    <td class="mono" title="${r.days} days">${esc(money(r.daily))} <span class="fhelp">/ ${r.days} d</span></td>
  </tr>`).join('');
  const inv = sum(rows.map((r) => r.invested)), won = sum(rows.map((r) => r.won)), days = groupDays();
  $('leaderboard-foot').innerHTML = rows.length ? `<tr>
    <td></td><td><strong>Group</strong></td>
    <td class="mono">${esc(money(inv))}</td><td class="mono">${esc(money(won))}</td>
    <td class="mono ${won - inv >= 0 ? 'green' : 'red'}">${won - inv >= 0 ? '+' : ''}${esc(money(won - inv))}</td>
    <td>${S.weeks.length}</td>
    <td class="mono" title="since ${fmtD(groupStart())}">${esc(money(inv / Math.max(1, days)))} <span class="fhelp">/ ${days} d</span></td>
  </tr>` : '';
}

function openInvModal(id) {
  const inv = id ? S.investors.find((i) => i.id === id) : null;
  $('im-title').textContent = inv ? 'Edit Investor' : 'Add Investor';
  $('im-id').value = id || '';
  $('im-nick').value = inv?.nickname || '';
  $('im-start').value = inv ? invStart(inv) : START_DEFAULT;
  $('im-end').value = inv && invEnd(inv) !== NO_END ? invEnd(inv) : '';
  $('inv-overlay').classList.add('open');
  setTimeout(() => $('im-nick').focus(), 80);
}

async function saveInvestor() {
  const nickname = $('im-nick').value.trim();
  if (!nickname) return toast('Please enter a name.', 'err');
  const since = $('im-start').value || START_DEFAULT;
  const end_date = $('im-end').value || NO_END;
  if (end_date < since) return toast('End date must be on or after the start date.', 'err');
  const row = { nickname, since, end_date };
  const id = $('im-id').value;
  const { error } = id
    ? await S.sb.from('investors').update(row).eq('id', id)
    : await S.sb.from('investors').insert(row);
  if (error) return fail(error);
  toast('Investor saved!', 'ok');
  closeModal('inv-overlay');
  await loadAll();
  if ($('invd-overlay').classList.contains('open') && id) openInvDetail(id);
}

/** Days in the investor's active period so far: start date … today (or end date), both counted. */
function activeDays(inv) {
  const today = kstToday(), start = invStart(inv), end = invEnd(inv) < today ? invEnd(inv) : today;
  if (end < start) return 0;
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 864e5) + 1;
}
/** The group's own period: first draw played (or 17 May 2025) to today, both counted. */
function groupStart() { return [START_DEFAULT, ...S.weeks.map((w) => w.result_date)].sort()[0]; }
function groupDays() {
  return Math.round((Date.parse(kstToday() + 'T00:00:00Z') - Date.parse(groupStart() + 'T00:00:00Z')) / 864e5) + 1;
}
const perDay = (inv, invested) => { const d = activeDays(inv); return d > 0 ? invested / d : 0; };

/** One row per draw in the investor's period (like the Weeks list), plus any week they paid into outside it. */
function investorTimeline(inv) {
  const id = inv.id, byDate = {};
  for (const w of S.weeks) (byDate[w.result_date] ||= []).push(w);
  const dates = new Set();
  const last = invEnd(inv) < currentDraw() ? invEnd(inv) : currentDraw();
  for (let d = addDays(invStart(inv), (6 - weekday(invStart(inv)) + 7) % 7); d <= last; d = addDays(d, 7)) dates.add(d);
  for (const w of S.weeks) if (+w.investments?.[id] > 0 || (S.ledger.perWeek[w.id]?.eff[id] || 0) > 0.005) dates.add(w.result_date);
  return [...dates].sort().reverse().flatMap((date) => {
    const ws = sortWeeks(byDate[date] || []);
    if (!ws.length) return [{ date, kind: 'none' }];
    return ws.map((w) => {
      const c = S.ledger.perWeek[w.id] || { pcts: {}, eff: {} };
      const fresh = +w.investments?.[id] || 0, eff = c.eff[id] || 0, pct = c.pcts[id] || 0;
      const r = { date, w, fresh, fromPool: Math.max(0, eff - fresh), eff, pct, share: (+w.prize_won || 0) * pct / 100 };
      r.kind = eff > 0.005 ? 'played' : 'skipped';
      r.problem = fresh > 0 ? periodProblem(inv, date) : '';
      return r;
    });
  });
}

function invRow(r) {
  const n = drawNo(r.date), head = `<div class="wk-no">${n ? '#' + n : '—'}</div><div class="wk-date">${esc(fmtD(r.date))}</div>`;
  if (r.kind === 'none') {
    return `<div class="week-item wk-empty"><div class="wk-row">${head}
      <div class="wk-c wk-none">${r.date >= currentDraw() ? '⏳ This week — not entered yet' : 'Group did not play'}</div>
      <div class="wk-c wk-tix"></div>
      <div class="wk-act"><button class="btn btn-ghost btn-sm" data-act="invd-add" data-date="${r.date}">+ Add</button></div></div></div>`;
  }
  if (r.kind === 'skipped') {
    return `<div class="week-item wk-empty"><div class="wk-row">${head}
      <div class="wk-c wk-none">Did not take part this week</div>
      <div class="wk-c wk-tix"></div>
      <div class="wk-act"><button class="btn btn-ghost btn-sm" data-act="invd-week" data-id="${esc(r.w.id)}">Edit</button></div></div></div>`;
  }
  const prize = r.share > 0
    ? `${esc(money(r.share))}<small>${r.w.big_win ? '💸 paid' : '🏦 pool'}</small>`
    : '<span class="muted">—</span>';
  return `<div class="week-item">
    <div class="wk-row">${head}
      ${wkCell('wk-total', 'Total', esc(money(r.eff)))}
      ${wkCell('wk-fresh', 'Fresh', r.fresh > 0 ? esc(money(r.fresh)) : '<span class="muted">—</span>')}
      ${wkCell('wk-pool', 'From pool', r.fromPool > 0.005 ? esc(money(r.fromPool)) : '<span class="muted">—</span>')}
      ${wkCell('wk-prize ' + (r.w.big_win ? 'shared' : 'pooled'), 'Prize share', prize)}
      ${wkCell('wk-tix', 'Share', fmtP(r.pct))}
      <div class="wk-act"><button class="btn btn-secondary btn-sm" data-act="invd-week" data-id="${esc(r.w.id)}">Edit</button></div>
    </div>
    ${r.problem ? `<div class="wk-warn"><span>⚠️ ${esc(r.problem)} — clear this amount if it is a mistake</span></div>` : ''}
  </div>`;
}

/** Every draw in this investor's period: what they put in, their share and prize — or why not. */
function openInvDetail(id) {
  const inv = S.investors.find((i) => i.id === id);
  if (!inv) return;
  const rows = investorTimeline(inv), played = rows.filter((r) => r.kind === 'played');
  const skipped = rows.filter((r) => r.kind === 'skipped').length, none = rows.filter((r) => r.kind === 'none' && r.date < currentDraw()).length;
  const tot = {
    fresh: sum(played.map((r) => r.fresh)),
    fromPool: sum(played.map((r) => r.fromPool)),
    paid: sum(played.filter((r) => r.w.big_win).map((r) => r.share)),
    pooled: sum(played.filter((r) => !r.w.big_win).map((r) => r.share)),
  };
  const days = activeDays(inv), bad = rows.filter((r) => r.problem);
  $('invd-title').textContent = inv.nickname;
  $('invd-edit').dataset.id = id;
  $('invd-body').innerHTML = `
    <div class="fhelp mb8">Takes part: <strong>${esc(fmtPeriod(inv))}</strong> · ${days} day${days === 1 ? '' : 's'} so far</div>
    <div class="mini-stats">
      <div><span>Fresh invested</span><strong>${esc(money(tot.fresh))}</strong></div>
      <div><span>Per day (active period)</span><strong>${esc(money(perDay(inv, tot.fresh)))}</strong></div>
      <div><span>Used from pool</span><strong>${esc(money(tot.fromPool))}</strong></div>
      <div><span>Prizes shared to them</span><strong class="green">${esc(money(tot.paid))}</strong></div>
      <div><span>Prizes added to pool</span><strong>${esc(money(tot.pooled))}</strong></div>
      <div><span>Net P/L</span><strong class="${tot.paid - tot.fresh >= 0 ? 'green' : 'red'}">${esc(money(tot.paid - tot.fresh))}</strong></div>
    </div>
    <div class="fhelp" style="margin:12px 0 6px">Played <strong>${played.length}</strong> draw${played.length === 1 ? '' : 's'}
      · did not take part in ${skipped} · group did not play ${none}</div>
    ${bad.length ? `<div class="form-error">⚠️ ${bad.length} week${bad.length > 1 ? 's have' : ' has'} money from ${esc(inv.nickname)} outside their dates
      (${esc(fmtPeriod(inv))}). They are highlighted below — click Edit to fix.</div>` : ''}
    <div class="invd-list">
      <div class="wk-head"><span>Draw</span><span>Date</span><span class="r">Total</span><span class="r">Fresh</span>
        <span class="r">From pool</span><span class="r">Prize share</span><span>Share</span><span></span></div>
      ${rows.map(invRow).join('') || '<p class="fhelp">No draws in this period yet.</p>'}
    </div>
    <p class="fhelp" style="margin-top:10px">Total = their fresh money + their part of pool money used that week.
      💸 = share paid out to them · 🏦 = their share of a prize that went into the pool.</p>`;
  $('invd-overlay').classList.add('open');
}

// ─── Charts ───────────────────────────────────────────────────────────────────
// Investor colours follow the investor (by order added), validated for colour-blind separation
// on the dark card surface. A 9th+ investor gets neutral gray rather than a re-used hue.
const SERIES = { invested: '#3987e5', won: '#199e70', pool: '#c98500', up: '#3987e5', down: '#e66767' };
const INK = { text: '#94a3b8', muted: '#64748b', grid: 'rgba(30,45,74,.55)', zero: '#475569', surface: '#131b2e' };
const invColor = (inv) => { const i = S.investors.indexOf(inv); return i >= 0 && i < COLORS.length ? COLORS[i] : '#6b7280'; };

function killChart(id) { if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; } }

/** Shared Chart.js options: hairline grid, money ticks & tooltips, hover by column. */
function chartOpts({ stacked = false, horizontal = false, legend = true, endLabels = false, pct = false, hideZero = false, timeline = false } = {}) {
  const phone = window.innerWidth < 640;
  if (phone) endLabels = false;   // the legend names the lines; keep the narrow plot for data
  const fmt = pct ? (v) => `${(+v).toFixed(0)}%` : (v) => money(v);
  const valueAxis = {
    stacked, beginAtZero: true, grid: { color: INK.grid }, border: { display: false },
    ticks: { color: INK.muted, font: { size: 11 }, callback: fmt, maxTicksLimit: 6 },
  };
  // Timelines: dates at an angle so many more fit; other category axes stay horizontal
  const catAxis = { stacked, grid: { display: false }, border: { color: INK.grid },
    ticks: timeline
      ? { color: INK.muted, font: { size: 10 }, minRotation: 60, maxRotation: 60, autoSkip: true, autoSkipPadding: 2 }
      : { color: INK.muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12, maxTicksLimit: phone && !horizontal ? 4 : undefined } };
  return {
    responsive: true,
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    layout: { padding: { right: endLabels ? 84 : 8 } },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    plugins: {
      legend: { display: legend, position: 'top', align: 'start',
        labels: { color: INK.text, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2, font: { family: "'DM Sans',sans-serif", size: 12 } } },
      tooltip: {
        backgroundColor: '#0d1117', borderColor: '#253656', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#cbd5e1', padding: 10,
        callbacks: { label: (c) => (c.dataset.marker ? ` ${c.dataset.label}` : ` ${c.dataset.label}: ${fmt(horizontal ? c.parsed.x : c.parsed.y)}`) },
        // e.g. investors who did not take part in that draw
        filter: hideZero ? (c) => (c.dataset.marker ? c.raw != null : (horizontal ? c.parsed.x : c.parsed.y) !== 0) : undefined,
      },
      endLabels: { enabled: endLabels },
    },
  };
}

const barStyle = (color, stacked = false) => ({
  backgroundColor: color, borderColor: INK.surface, borderWidth: stacked ? { top: 2 } : 0,
  borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28,
});
const lineStyle = (color, fill = false) => ({
  borderColor: color, backgroundColor: fill ? color + '22' : color, fill, borderWidth: 2, tension: .25,
  pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: INK.surface,
});

// Direct labels at the end of each line (name in text ink, colour in the dot beside it).
const endLabelsPlugin = {
  id: 'endLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.enabled) return;
    const { ctx, chartArea } = chart;
    const items = chart.data.datasets.map((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      const pt = meta.data[meta.data.length - 1];
      return meta.hidden || !pt ? null : { y: pt.y, x: pt.x, label: ds.label, color: ds.borderColor };
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + 14);
    ctx.save();
    ctx.font = "500 11px 'DM Sans',sans-serif";
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const y = Math.min(it.y, chartArea.bottom);
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.arc(chartArea.right + 10, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK.text;
      ctx.fillText(it.label.length > 10 ? it.label.slice(0, 9) + '…' : it.label, chartArea.right + 18, y);
    }
    ctx.restore();
  },
};

/** Everything the statistics tab needs, computed once from the weeks + ledger. */
function chartData() {
  const weeks = sortWeeks(S.weeks), stats = investorStats();
  const labels = weeks.map((w) => fmtShort(w.result_date));
  const titles = weeks.map((w) => `${drawLabel(w.result_date)} · ${fmtD(w.result_date)}`);
  let ci = 0, cw = 0;
  const cumInvested = [], cumWon = [];
  for (const w of weeks) { ci += sum(Object.values(w.investments || {})); cw += +w.prize_won || 0; cumInvested.push(ci); cumWon.push(cw); }

  const running = Object.fromEntries(S.investors.map((i) => [i.id, 0]));
  const cumPL = Object.fromEntries(S.investors.map((i) => [i.id, []]));
  for (const w of weeks) {
    const pcts = S.ledger.perWeek[w.id]?.pcts || {};
    for (const inv of S.investors) {
      running[inv.id] += (w.big_win ? (+w.prize_won || 0) * (pcts[inv.id] || 0) / 100 : 0) - (+w.investments?.[inv.id] || 0);
      cumPL[inv.id].push(running[inv.id]);
    }
  }

  const months = {};
  for (const w of weeks) {
    const m = (months[w.result_date.slice(0, 7)] ||= { invested: 0, won: 0 });
    m.invested += sum(Object.values(w.investments || {}));
    m.won += +w.prize_won || 0;
  }

  const m = (n) => money(n);
  const buckets = [   // multi-line labels so every bar keeps its label
    ['No win', (p) => p === 0], [m(5000), (p) => p > 0 && p <= 5000], [[m(5001), `– ${m(49999)}`], (p) => p > 5000 && p < 50000],
    [[m(50000), `– ${m(99999)}`], (p) => p >= 50000 && p < 100000], [[m(100000), `– ${m(4999999)}`], (p) => p >= 100000 && p < 5e6], [`${m(5e6)}+`, (p) => p >= 5e6],
  ];
  const outcomes = buckets.map(([label, test]) => ({ label, n: weeks.filter((w) => test(+w.prize_won || 0)).length }))
    .filter((b, i) => b.n > 0 || i < 2);

  return { weeks, labels, titles, stats, cumInvested, cumWon, cumPL, months, outcomes };
}

function renderKpis(d) {
  const { weeks } = d;
  const invested = d.cumInvested.at(-1) || 0, won = d.cumWon.at(-1) || 0;
  const wins = weeks.filter((w) => +w.prize_won > 0);
  const biggest = wins.reduce((b, w) => (!b || +w.prize_won > +b.prize_won ? w : b), null);
  let streak = 0, longest = 0, cur = 0;
  for (const w of weeks) { cur = +w.prize_won > 0 ? 0 : cur + 1; longest = Math.max(longest, cur); }
  streak = cur;
  const tile = (label, value, sub, cls = '') => `<div class="stat-card ${cls}"><div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  $('kpi-grid').innerHTML = weeks.length ? [
    tile('Return rate', invested ? `${Math.round(won / invested * 100)}%` : '—', `${esc(money(won))} won from ${esc(money(invested))}`, 'em'),
    tile('Win rate', `${Math.round(wins.length / weeks.length * 100)}%`, `${wins.length} of ${weeks.length} draws won something`, 'bl'),
    tile('Biggest prize', biggest ? esc(money(biggest.prize_won)) : '—', biggest ? `${esc(fmtD(biggest.result_date))} ${drawLabel(biggest.result_date)}` : 'no wins yet'),
    tile('Avg. per draw', esc(money(invested / weeks.length)), 'fresh money invested', 'pu'),
    tile('Group per day', esc(money(invested / Math.max(1, groupDays()))), `${groupDays()} days since ${esc(fmtD(groupStart()))}`, 'bl'),
    tile('Since last win', `${streak}`, streak === 1 ? 'draw without a prize' : 'draws without a prize', 'rd'),
    tile('Longest dry spell', `${longest}`, 'draws in a row without a prize'),
  ].join('') : '';
}

/**
 * Odd vs even draw numbers (회차): what we spent and won in each, and how often a gap that big
 * appears when the same draws are split into two groups at random (a permutation test).
 */
function parityStats() {
  const byDraw = {};
  for (const w of S.weeks) {
    const n = drawNo(w.result_date);
    if (!n) continue;
    const d = (byDraw[n] ||= { n, spent: 0, won: 0 });
    d.spent += sum(Object.values(w.investments || {})) + (+w.pool_used || 0);
    d.won += +w.prize_won || 0;
  }
  const draws = Object.values(byDraw).filter((d) => d.spent > 0 || d.won > 0);
  const side = (list) => {
    const spent = sum(list.map((d) => d.spent)), won = sum(list.map((d) => d.won)), wins = list.filter((d) => d.won > 0).length;
    const best = list.reduce((b, d) => (!b || d.won > b.won ? d : b), null);
    return { draws: list.length, spent, won, wins, best, ret: spent ? won / spent : 0, winRate: list.length ? wins / list.length : 0,
      retNoBest: spent ? (won - (best?.won || 0)) / spent : 0 };
  };
  const odd = side(draws.filter((d) => d.n % 2)), even = side(draws.filter((d) => d.n % 2 === 0));
  let pRet = null, pWin = null;
  if (odd.draws && even.draws) {
    const rng = window.PicksEngine.mulberry32(645), idx = draws.map((_, i) => i), N = 4000;
    const gap = (a, b) => [Math.abs(a.ret - b.ret), Math.abs(a.winRate - b.winRate)];
    const [obsR, obsW] = gap(odd, even);
    let geR = 0, geW = 0;
    for (let t = 0; t < N; t++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const a = side(idx.slice(0, odd.draws).map((i) => draws[i])), b = side(idx.slice(odd.draws).map((i) => draws[i]));
      const [r, w] = gap(a, b);
      if (r >= obsR - 1e-12) geR++;
      if (w >= obsW - 1e-12) geW++;
    }
    pRet = (geR + 1) / (N + 1); pWin = (geW + 1) / (N + 1);
  }
  return { odd, even, pRet, pWin };
}

function renderParity(mk) {
  const { odd, even, pRet, pWin } = parityStats();
  const per1000 = (x) => money(Math.round(x * TICKET_PRICE));
  const better = (a, b) => (a > b ? 'best' : '');
  const row = (label, a, b, fa, fb = fa) => `<tr><td>${label}</td><td class="mono ${fb ? better(a, b) : ''}">${fa(a)}</td><td class="mono ${fb ? better(b, a) : ''}">${fa(b)}</td></tr>`;
  const plain = (f) => (x) => esc(f(x));
  $('parity-table').innerHTML = `<table>
    <thead><tr><th></th><th>Odd draws</th><th>Even draws</th></tr></thead>
    <tbody>
      ${row('Draws played', odd.draws, even.draws, String, null)}
      ${row('Spent', odd.spent, even.spent, plain(money), null)}
      ${row('Prizes won', odd.won, even.won, plain(money))}
      ${row('Back per ₩1,000', odd.ret, even.ret, plain(per1000))}
      ${row('Draws with a prize', odd.winRate, even.winRate, (x) => `${Math.round(x * 100)}%`)}
      ${row('Back per ₩1,000 without the biggest prize', odd.retNoBest, even.retNoBest, plain(per1000))}
      ${row('Biggest prize', odd.best?.won || 0, even.best?.won || 0, plain(money))}
    </tbody></table>`;
  const opts = chartOpts();
  opts.aspectRatio = window.innerWidth < 640 ? 1.3 : 1.8;
  mk('parity', { type: 'bar', data: { labels: ['Odd draws', 'Even draws'], datasets: [
    { label: 'Spent', data: [odd.spent, even.spent], ...barStyle(SERIES.invested), maxBarThickness: 56 },
    { label: 'Prizes won', data: [odd.won, even.won], ...barStyle(SERIES.won), maxBarThickness: 56 },
  ] }, options: opts });
  let verdict;
  if (pRet == null) verdict = 'Play both odd and even draws to compare them.';
  else {
    const lead = odd.ret === even.ret ? null : odd.ret > even.ret ? 'Odd' : 'Even';
    const chance = (p) => (p < 0.01 ? 'under 1%' : `${Math.round(p * 100)}%`);
    verdict = (lead ? `<strong>${lead} draws have paid back more so far</strong> (${esc(per1000(Math.max(odd.ret, even.ret)))} vs ${esc(per1000(Math.min(odd.ret, even.ret)))} per ₩1,000). ` : 'Odd and even draws have paid back the same. ')
      + `If we split the same ${odd.draws + even.draws} draws into two groups at random, a gap this big shows up <strong>${chance(pRet)}</strong> of the time (${chance(pWin)} for the gap in how often we win). `
      + (pRet < 0.05
        ? 'That is unusual, but the machine doesn\'t know the draw number, so it is very likely to even out.'
        : 'So it is luck, not a pattern: every draw has the same odds, whatever its number.');
  }
  $('parity-verdict').innerHTML = verdict;
}

function renderCharts() {
  if (!window.Chart) return;
  if (!Chart.registry.plugins.get('endLabels')) Chart.register(endLabelsPlugin);
  const d = chartData(), { weeks, labels, stats } = d, investors = S.investors;
  const tl = (opts, titles = d.titles) => { opts.plugins.tooltip.callbacks.title = (items) => titles[items[0].dataIndex]; return opts; };
  renderKpis(d);
  show('charts-empty', !weeks.length);
  document.querySelector('#tab-charts .charts-grid').hidden = !weeks.length;
  if (!weeks.length) return;
  const phone = window.innerWidth < 640;
  const mk = (id, cfg) => {
    killChart(id);
    const canvas = $('ch-' + id), wide = !!canvas.closest('.wide');
    cfg.options.aspectRatio ??= phone ? 1.15 : wide ? 3 : 1.6;
    S.charts[id] = new Chart(canvas, cfg);
  };

  mk('cum', { type: 'line', data: { labels, datasets: [
    { label: 'Invested', data: d.cumInvested, ...lineStyle(SERIES.invested) },
    { label: 'Prizes won', data: d.cumWon, ...lineStyle(SERIES.won, true) },
  ] }, options: tl(chartOpts({ endLabels: true, timeline: true })) });

  // Every finished draw: prize bars; a flat gray bar for "played, no prize"; nothing for "not played"
  const draws = weekTimeline().filter((r) => r.weeks.length || r.date < currentDraw()).reverse();
  const tot = (r, shared) => sum(r.weeks.filter((w) => !!w.big_win === shared).map((w) => +w.prize_won || 0));
  const prizeOpts = tl(chartOpts({ stacked: true, hideZero: true, timeline: true }), draws.map((r) =>
    `${drawLabel(r.date)} · ${fmtD(r.date)}${r.weeks.length ? '' : ' · not played'}`));
  mk('prize', { type: 'bar', data: { labels: draws.map((r) => fmtShort(r.date)), datasets: [
    { label: 'Shared to investors', data: draws.map((r) => tot(r, true)), ...barStyle(SERIES.won, true) },
    { label: 'Added to pool', data: draws.map((r) => tot(r, false)), ...barStyle(SERIES.pool, true) },
    { label: 'Played, no prize', marker: true, data: draws.map((r) => (r.weeks.length && !sum(r.weeks.map((w) => +w.prize_won || 0)) ? 0 : null)),
      ...barStyle('#64748b', true), minBarLength: 6 },
  ] }, options: prizeOpts });

  const outOpts = chartOpts({ legend: false });
  outOpts.scales.y.ticks.callback = (v) => (Number.isInteger(v) ? v : '');
  outOpts.scales.x.ticks.autoSkip = false;
  outOpts.plugins.tooltip.callbacks.label = (c) => ` ${c.parsed.y} draw${c.parsed.y === 1 ? '' : 's'} (${Math.round(c.parsed.y / weeks.length * 100)}%)`;
  mk('outcome', { type: 'bar', data: { labels: d.outcomes.map((o) => o.label),
    datasets: [{ label: 'Draws', data: d.outcomes.map((o) => o.n), ...barStyle(SERIES.invested), maxBarThickness: 44 }] }, options: outOpts });

  renderParity(mk);

  mk('pool', { type: 'line', data: { labels, datasets: [{ label: 'Pool balance', data: S.ledger.history, ...lineStyle(SERIES.pool, true), stepped: true }] },
    options: tl(chartOpts({ legend: false, timeline: true })) });

  const monthKeys = Object.keys(d.months).sort();
  const monthLabel = (k) => new Date(k + '-15T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  mk('monthly', { type: 'bar', data: { labels: monthKeys.map(monthLabel), datasets: [
    { label: 'Invested', data: monthKeys.map((k) => d.months[k].invested), ...barStyle(SERIES.invested) },
    { label: 'Prizes won', data: monthKeys.map((k) => d.months[k].won), ...barStyle(SERIES.won) },
  ] }, options: chartOpts({ timeline: monthKeys.length > 6 }) });

  const byNet = [...investors].sort((a, b) => ((stats[b.id].won - stats[b.id].invested) - (stats[a.id].won - stats[a.id].invested)));
  mk('netpl', { type: 'bar', data: { labels: byNet.map((i) => i.nickname), datasets: [{
    label: 'Net P/L', data: byNet.map((i) => stats[i.id].won - stats[i.id].invested),
    ...barStyle(byNet.map((i) => stats[i.id].won - stats[i.id].invested >= 0 ? SERIES.up : SERIES.down)), borderSkipped: false,
  }] }, options: chartOpts({ horizontal: true, legend: false }) });

  mk('invwon', { type: 'bar', data: { labels: investors.map((i) => i.nickname), datasets: [
    { label: 'Invested', data: investors.map((i) => stats[i.id].invested), ...barStyle(SERIES.invested) },
    { label: 'Prizes shared to them', data: investors.map((i) => stats[i.id].won), ...barStyle(SERIES.won) },
  ] }, options: chartOpts({ horizontal: true }) });

  const byDaily = [...investors].filter((i) => activeDays(i) > 0).sort((a, b) => perDay(b, stats[b.id].invested) - perDay(a, stats[a.id].invested));
  const dailyOpts = chartOpts({ horizontal: true, legend: false });
  dailyOpts.plugins.tooltip.callbacks.label = (c) => ` ${money(c.parsed.x)} per day (${money(stats[byDaily[c.dataIndex].id].invested)} over ${activeDays(byDaily[c.dataIndex])} days)`;
  mk('perday', { type: 'bar', data: { labels: byDaily.map((i) => i.nickname), datasets: [{
    label: 'Per day', data: byDaily.map((i) => perDay(i, stats[i.id].invested)), ...barStyle(byDaily.map(invColor)),
  }] }, options: dailyOpts });

  mk('cumpl', { type: 'line', data: { labels, datasets: investors.map((inv) => ({ label: inv.nickname, data: d.cumPL[inv.id], ...lineStyle(invColor(inv)) })) },
    options: tl(chartOpts({ endLabels: investors.length <= 8, timeline: true })) });

  const shareOpts = chartOpts({ horizontal: true, legend: false, pct: true });
  shareOpts.scales.x.max = 100;
  const totalInv = sum(investors.map((i) => stats[i.id].invested)) || 1;
  mk('share', { type: 'bar', data: { labels: investors.map((i) => i.nickname), datasets: [{
    label: 'Share of all money invested', data: investors.map((i) => stats[i.id].invested / totalInv * 100),
    ...barStyle(investors.map(invColor)),
  }] }, options: shareOpts });

  // Only investors who put money in at some point; empty columns per draw are skipped in the tooltip
  const payers = investors.filter((inv) => weeks.some((w) => +w.investments?.[inv.id] > 0));
  mk('wkly', { type: 'bar', data: { labels, datasets: payers.map((inv) => ({
    label: inv.nickname, data: weeks.map((w) => +w.investments?.[inv.id] || null), ...barStyle(invColor(inv), true), maxBarThickness: 22,
  })) }, options: tl(chartOpts({ stacked: true, hideZero: true, timeline: true })) });
}

// ─── Activity log ─────────────────────────────────────────────────────────────
const TABLE_LABEL = { weeks: 'week', investors: 'investor', tickets: 'ticket photo', settings: 'settings', profiles: 'member' };
const SKIP_FIELDS = new Set(['updated_at', 'updated_by', 'created_at', 'created_by', 'id']);

function qrStatusText(it) {
  if (it.status === 'win') return `🎉 won ${+it.prize > 0 ? money(it.prize) : '(amount ?)'}`;
  return { lose: '낙첨', pending: '⏳ waiting', error: '❓ could not check', invalid: '❓ not a lotto QR' }[it.status] || it.status;
}

function describeQrChange(oldItems, newItems) {
  const o = Array.isArray(oldItems) ? oldItems : [], n = Array.isArray(newItems) ? newItems : [];
  const out = [];
  n.forEach((it, i) => {
    const prev = o.find((x) => x.url === it.url), name = `QR ${i + 1}${it.round ? ` (#${it.round})` : ''}`;
    if (!prev) out.push(`${name} added`);
    else if (prev.status !== it.status || (+prev.prize || 0) !== (+it.prize || 0)) {
      out.push(`${name}: ${qrStatusText(prev)} → ${qrStatusText(it)}${it.manual && !prev.manual ? ' (corrected by hand)' : ''}`);
    }
  });
  const removed = o.filter((x) => !n.some((it) => it.url === x.url)).length;
  if (removed) out.push(`${removed} QR code${removed > 1 ? 's' : ''} removed`);
  return out.length ? out : ['winning numbers compared, no change in result'];
}

function describeChange(r) {
  const o = r.old_data || {}, n = r.new_data || {}, row = r.new_data || r.old_data || {};
  let subject = '';
  if (r.table_name === 'weeks') subject = `${fmtD(row.result_date)} ${drawLabel(row.result_date)}`;
  else if (r.table_name === 'investors') subject = row.nickname;
  else if (r.table_name === 'tickets') subject = `draw ${drawLabel(row.draw_date)} ${fmtD(row.draw_date)}`;
  else if (r.table_name === 'profiles') subject = `${row.display_name} (@${row.username})`;

  const verb = { INSERT: 'added', UPDATE: 'changed', DELETE: 'deleted' }[r.action] || r.action;
  if (r.table_name === 'profiles' && r.action === 'INSERT') return { head: `joined the group`, subject: '', detail: '', self: row.id };

  const details = [];
  if (r.action === 'UPDATE') {
    for (const k of Object.keys(n)) {
      if (SKIP_FIELDS.has(k) || JSON.stringify(o[k]) === JSON.stringify(n[k])) continue;
      if (k === 'qr_data') {
        details.push(...describeQrChange(o[k], n[k]));
      } else if (k === 'draw_date') {
        details.push(`moved from draw ${drawLabel(o[k])} to ${drawLabel(n[k])}`);
      } else if (k === 'investments') {
        const ids = new Set([...Object.keys(o[k] || {}), ...Object.keys(n[k] || {})]);
        for (const id of ids) {
          const a = o[k]?.[id] || 0, b = n[k]?.[id] || 0;
          if (a !== b) details.push(`${invName(id)}: ${money(a)} → ${money(b)}`);
        }
      } else if (k === 'big_win') {
        details.push(`prize ${n[k] ? 'shared to investors' : 'added to pool'}`);
      } else if (['pool_used', 'prize_won', 'big_win_threshold'].includes(k)) {
        details.push(`${k.replace(/_/g, ' ')}: ${money(o[k])} → ${money(n[k])}`);
      } else if (typeof n[k] === 'object' && n[k] !== null) {
        details.push(`${k.replace(/_/g, ' ')} updated`);
      } else {
        details.push(`${k.replace(/_/g, ' ')}: ${o[k] ?? '—'} → ${n[k] ?? '—'}`);
      }
    }
  } else if (r.table_name === 'weeks') {
    details.push(`fresh ${money(sum(Object.values(row.investments || {})))}, from pool ${money(row.pool_used)}, prize ${money(row.prize_won)}`);
  }
  // Changes without a logged-in user come from the result checker (tickets) or database upgrades
  const auto = r.actor ? null : r.table_name === 'tickets' ? '🤖 Result checker' : '⚙️ System';
  return { head: `${verb} ${TABLE_LABEL[r.table_name] || r.table_name}`, subject, detail: details.join(' · '), auto };
}

async function loadActivity() {
  const { data, error } = await S.sb.from('audit_log').select('*').order('at', { ascending: false }).limit(300);
  if (error) return fail(error);
  S.audit = data || [];
  const el = $('activity-list');
  el.innerHTML = S.audit.length ? S.audit.map((r) => {
    const d = describeChange(r);
    const who = d.self ? userName(d.self) : d.auto || userName(r.actor);
    return `<div class="act-row">
      <div class="act-time">${esc(fmtKST(r.at))}</div>
      <div class="act-body">
        <strong>${esc(who)}</strong> ${esc(d.head)} ${d.subject ? `<strong>${esc(d.subject)}</strong>` : ''}
        ${d.detail ? `<div class="act-detail">${esc(d.detail)}</div>` : ''}
      </div>
    </div>`;
  }).join('') : `<div class="empty"><p>No activity yet.</p></div>`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
let _curDraft = null;

function renderSettings() {
  $('me-username').value = '@' + S.me.username;
  if (document.activeElement !== $('me-name')) $('me-name').value = S.me.display_name;

  const st = S.settings, admin = isAdmin();
  if (document.activeElement !== $('cfg-title')) $('cfg-title').value = st.title;
  if (document.activeElement !== $('cfg-threshold')) $('cfg-threshold').value = fmtAmt(st.big_win_threshold) || '0';
  document.querySelectorAll('.admin-only-input').forEach((el) => { el.disabled = !admin; });
  if (!_curDraft || !admin) _curDraft = { currency: st.currency, display: st.currency_display };
  renderCurrencyPicker();
  moneyHint('cfg-threshold', 'cfg-threshold-hint');
  if (admin) renderMembers();
}

function renderCurrencyPicker() {
  const admin = isAdmin(), { currency, display } = _curDraft;
  const codes = allCurrencies();
  if (!codes.includes(currency)) codes.unshift(currency);
  const dis = admin ? '' : 'disabled';
  $('cur-picker').innerHTML = `
    <div class="cur-chips">${POPULAR_CURRENCIES.map((c) =>
      `<button class="cur-chip ${c === currency ? 'active' : ''}" data-act="cur-pick" data-id="${c}" ${dis}>${esc(currencySymbol(c))} ${c}</button>`).join('')}
    </div>
    <div class="cur-row">
      <select class="fsel" id="cur-select" data-on-input="cur-select" ${dis}>
        ${codes.map((c) => `<option value="${c}" ${c === currency ? 'selected' : ''}>${c} — ${esc(currencyName(c))}</option>`).join('')}
      </select>
      <select class="fsel" id="cur-display" data-on-input="cur-display" ${dis}>
        <option value="symbol" ${display === 'symbol' ? 'selected' : ''}>Symbol · ${esc(money(12000, currency, 'symbol'))}</option>
        <option value="narrowSymbol" ${display === 'narrowSymbol' ? 'selected' : ''}>Short symbol · ${esc(money(12000, currency, 'narrowSymbol'))}</option>
        <option value="code" ${display === 'code' ? 'selected' : ''}>Code · ${esc(money(12000, currency, 'code'))}</option>
        <option value="name" ${display === 'name' ? 'selected' : ''}>Name · ${esc(money(12000, currency, 'name'))}</option>
      </select>
    </div>
    <div class="cur-preview">Preview: <strong>${esc(money(1234567, currency, display))}</strong> · ${esc(currencyName(currency))}</div>`;
}

function moneyHint(inputId, hintId) {
  const v = amt($(inputId).value);
  $(hintId).textContent = v > 0 ? `= ${money(v, _curDraft?.currency, _curDraft?.display)}.` : '';
}

async function saveSettings() {
  const row = {
    title: $('cfg-title').value.trim() || '645',
    currency: _curDraft.currency,
    currency_display: _curDraft.display,
    big_win_threshold: amt($('cfg-threshold').value),
  };
  const { error } = await S.sb.from('settings').update(row).eq('id', 1);
  if (error) return fail(error);
  toast('Settings saved!', 'ok');
  await loadAll();
}

async function saveName() {
  const display_name = $('me-name').value.trim();
  if (!display_name) return toast('Name cannot be empty.', 'err');
  const { error } = await S.sb.from('profiles').update({ display_name }).eq('id', S.me.id);
  if (error) return fail(error);
  toast('Name saved!', 'ok');
  await loadAll();
}

async function savePassword() {
  const cur = $('pw-cur').value, p1 = $('pw-new').value, p2 = $('pw-new2').value;
  if (p1.length < 8) return toast('New password must be at least 8 characters.', 'err');
  if (p1 !== p2) return toast('Passwords do not match.', 'err');
  const { error: e1 } = await S.sb.auth.signInWithPassword({ email: S.user.email, password: cur });
  if (e1) return toast('Current password is wrong.', 'err');
  const { error } = await S.sb.auth.updateUser({ password: p1 });
  if (error) return fail(error);
  $('pw-cur').value = $('pw-new').value = $('pw-new2').value = '';
  toast('Password updated!', 'ok');
}

// ─── Admin: invitations & members ─────────────────────────────────────────────
const inviteLink = (code) => `${location.origin}${location.pathname}#invite=${fmtInvite(code)}`;

function inviteStatus(i) {
  if (i.used_at) return `<span class="badge bg-green">used by ${esc(userName(i.used_by))}</span>`;
  if (i.revoked) return `<span class="badge bg-gray">cancelled</span>`;
  if (new Date(i.expires_at) < new Date()) return `<span class="badge bg-gray">expired</span>`;
  return `<span class="badge bg-gold">waiting</span>`;
}
const inviteOpen = (i) => !i.used_at && !i.revoked && new Date(i.expires_at) >= new Date();

async function loadInvites() {
  const { data, error } = await S.sb.from('invites').select('*').order('created_at', { ascending: false });
  if (error) return fail(error);
  S.invites = data || [];
  $('invites-body').innerHTML = S.invites.length ? S.invites.map((i) => `<tr>
    <td class="mono">${esc(fmtInvite(i.code))}${i.role === 'admin' ? ' <span class="badge bg-gold">admin</span>' : ''}</td>
    <td>${esc(i.note || '—')}</td>
    <td>${inviteStatus(i)}</td>
    <td class="fhelp">${esc(fmtKST(i.expires_at))}</td>
    <td><div class="btn-row">${inviteOpen(i)
      ? `<button class="btn btn-secondary btn-sm" data-act="invite-copy" data-id="${esc(i.code)}">Copy link</button>
         <button class="btn btn-danger btn-sm" data-act="invite-revoke" data-id="${esc(i.code)}">Cancel</button>`
      : `<button class="btn btn-ghost btn-sm" data-act="invite-delete" data-id="${esc(i.code)}">Remove</button>`}</div></td>
  </tr>`).join('') : `<tr><td colspan="5" class="fhelp">No invitations yet.</td></tr>`;
}

async function createInvite() {
  const { data, error } = await S.sb.rpc('create_invite', { p_note: $('inv-note').value.trim(), p_days: +$('inv-days').value });
  if (error) return fail(error);
  const link = inviteLink(data.code);
  $('invite-new').innerHTML = `<div class="invite-box">
    <div class="fhelp">New invitation${data.note ? ' for <strong>' + esc(data.note) + '</strong>' : ''} — valid until ${esc(fmtKST(data.expires_at))}, works once.</div>
    <div class="invite-code">${esc(fmtInvite(data.code))}</div>
    <div class="invite-link">${esc(link)}</div>
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" data-act="invite-copy" data-id="${esc(data.code)}">Copy link</button>
      ${navigator.share ? `<button class="btn btn-secondary btn-sm" data-act="invite-share" data-id="${esc(data.code)}">Share…</button>` : ''}
    </div>
    <div class="fhelp">Send it privately (e.g. KakaoTalk direct message). Your friend opens the link, picks a username and password, and is in.</div>
  </div>`;
  show('invite-new');
  $('inv-note').value = '';
  loadInvites();
}

async function copyText(text, label = 'Copied!') {
  try { await navigator.clipboard.writeText(text); toast(label, 'ok'); }
  catch { prompt('Copy this:', text); }
}

async function revokeInvite(code) {
  if (!confirm(`Cancel invitation ${fmtInvite(code)}? It can no longer be used.`)) return;
  const { error } = await S.sb.from('invites').update({ revoked: true }).eq('code', code);
  if (error) return fail(error);
  loadInvites();
}

async function deleteInvite(code) {
  const { error } = await S.sb.from('invites').delete().eq('code', code);
  if (error) return fail(error);
  loadInvites();
}

function renderMembers() {
  $('members-body').innerHTML = S.profiles.map((p) => {
    const self = p.id === S.me.id, active = p.status === 'active';
    return `<tr style="${active ? '' : 'opacity:.6'}">
      <td><strong>${esc(p.display_name)}</strong> <span class="fhelp">@${esc(p.username)}</span>${self ? ' <span class="badge bg-gray">you</span>' : ''}</td>
      <td>${p.role === 'admin' ? '<span class="badge bg-gold">admin</span>' : '<span class="badge bg-gray">member</span>'}</td>
      <td>${active ? '<span class="badge bg-green">active</span>' : `<span class="badge bg-red">revoked ${esc(fmtD(p.revoked_at?.slice(0, 10)))}</span>`}</td>
      <td class="fhelp">${esc(fmtD(p.created_at?.slice(0, 10)))}</td>
      <td>${self ? '' : `<div class="btn-row">
        ${active
          ? `<button class="btn btn-danger btn-sm" data-act="member-status" data-id="${p.id}" data-on="revoked">Revoke access</button>`
          : `<button class="btn btn-secondary btn-sm" data-act="member-status" data-id="${p.id}" data-on="active">Restore</button>`}
        <button class="btn btn-ghost btn-sm" data-act="member-pw" data-id="${p.id}">Reset password</button>
        <button class="btn btn-ghost btn-sm" data-act="member-role" data-id="${p.id}" data-on="${p.role === 'admin' ? 'member' : 'admin'}">${p.role === 'admin' ? 'Make member' : 'Make admin'}</button>
      </div>`}</td>
    </tr>`;
  }).join('');
}

async function setMember(id, patch, question) {
  if (question && !confirm(question)) return;
  const { error } = await S.sb.rpc('admin_update_member', { p_user: id, p_status: patch.status ?? null, p_role: patch.role ?? null });
  if (error) return fail(error);
  toast('Member updated.', 'ok');
  await loadAll();
}

function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => abc[x % abc.length]).join('');
}

async function resetMemberPassword(id) {
  const p = S.profiles.find((x) => x.id === id);
  if (!p || !confirm(`Set a new temporary password for ${p.display_name}?`)) return;
  const pw = randomPassword();
  const { error } = await S.sb.rpc('admin_set_password', { p_user: id, p_password: pw });
  if (error) return fail(error);
  $('dlg-title').textContent = 'Temporary password';
  $('dlg-body').innerHTML = `<p class="fhelp">Send this to <strong>${esc(p.display_name)}</strong> (username <strong>@${esc(p.username)}</strong>).
    They should change it in Settings → Change Password after signing in.</p>
    <div class="dlg-pw">${esc(pw)}</div>
    <button class="btn btn-secondary btn-sm" data-act="copy" data-text="${esc(pw)}">Copy</button>`;
  $('dlg-overlay').classList.add('open');
}

// ─── Admin: backup & legacy import ────────────────────────────────────────────
function exportBackup() {
  const payload = {
    app: '645', exported_at: new Date().toISOString(), settings: S.settings,
    investors: S.investors, weeks: S.weeks, tickets: S.tickets,
    members: S.profiles.map(({ id, username, display_name, role, status, created_at }) => ({ id, username, display_name, role, status, created_at })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.download = `645-backup-${kstToday()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importLegacy(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That is not a valid JSON file.', 'err'); }
  const investors = (data.investors || []).map((i) => ({
    id: String(i.id), nickname: String(i.nickname || 'Unknown').slice(0, 40), active: i.active !== false,
    since: /^\d{4}-\d{2}-\d{2}$/.test(i.since || '') ? i.since : START_DEFAULT,
  }));
  const weeks = (data.weeks || []).map((w) => ({
    id: String(w.id), result_date: w.result_date,
    investments: Object.fromEntries(Object.entries(w.investments || {}).map(([k, v]) => [k, +v || 0]).filter(([, v]) => v > 0)),
    pool_used: +w.pool_used || 0, prize_won: +w.prize_won || 0, big_win: !!w.big_win, notes: String(w.notes || '').slice(0, 2000),
  })).filter((w) => w.result_date);
  if (!confirm(`Import ${investors.length} investors and ${weeks.length} weeks?`)) return;
  const { error: e1 } = await S.sb.from('investors').upsert(investors, { onConflict: 'id' });
  if (e1) return fail(e1);
  const { error: e2 } = await S.sb.from('weeks').upsert(weeks, { onConflict: 'id' });
  if (e2) return fail(e2);
  toast('Import complete.', 'ok');
  await loadAll();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function quickSet(input, value) {
  input.value = fmtAmt(Math.max(0, value));
  previewWeek();
}

function closeModal(id) { $(id).classList.remove('open'); }

// ═════════════════════════════════════════════════════════════════════════════
//  Event wiring (no inline handlers, so the page can use a strict CSP)
// ═════════════════════════════════════════════════════════════════════════════
const ACTIONS = {
  'auth-tab': (el) => setAuthTab(el.dataset.tab),
  logout: () => S.sb?.auth.signOut(),
  tab: (el) => goTab(el.dataset.tab),
  'close-modal': (el) => closeModal(el.dataset.id),
  'week-new': () => openWeekModal(null),
  'week-edit': (el, e) => { e.stopPropagation(); openWeekModal(el.dataset.id); },
  'week-del': (el, e) => { e.stopPropagation(); deleteWeek(el.dataset.id); },
  'week-toggle': (el) => toggleWeek(el.dataset.id),
  'week-save': () => saveWeek(),
  'q-prize': (el) => quickSet($('wm-prize'), el.dataset.add ? amt($('wm-prize').value) + +el.dataset.add : 0),
  'q-inv': (el) => {
    const input = $('wi-' + el.dataset.id);
    quickSet(input, el.dataset.set ? +el.dataset.set : amt(input.value) + +el.dataset.add);
  },
  'wm-mode': (el) => { _wmShare = el.dataset.on === 'share'; _wmShareTouched = true; previewWeek(); },
  'inv-new': () => openInvModal(null),
  'inv-edit': (el, e) => { e.stopPropagation(); openInvModal(el.dataset.id); },
  'inv-detail': (el) => openInvDetail(el.dataset.id),
  'invd-week': (el) => { closeModal('invd-overlay'); openWeekModal(el.dataset.id); },
  'picks-backtest': () => runBacktest(),
  'picks-more': () => { _picksCount += 10; renderPicks(); },
  'pick-k': (el) => setPickK(+el.dataset.k),
  'board-x': (el) => setBoardGroups(el.dataset.add ? (S.board.groups || boardDefault()) + +el.dataset.add : +el.dataset.set),
  'board-num': (el) => toggleBoardNum(+el.dataset.g, +el.dataset.n),
  'board-engine': (el) => engineFill(+el.dataset.g, el.dataset.mode),
  'board-clear': (el) => clearMine(+el.dataset.g),
  'sim-x': (el) => simSetX(el.dataset.add ? (SIM.x || 0) + +el.dataset.add : +el.dataset.set),
  'sim-qty': (el) => { const i = +el.dataset.i; SIM.qty[i] = Math.max(0, (SIM.qty[i] || 0) + +el.dataset.d); renderSim(); },
  'sim-reveal': () => { SIM.revealed = true; renderSim(); },
  'sim-hide': () => { SIM.revealed = false; renderSim(); },
  'lb-sort': (el) => {
    const k = el.dataset.id, col = LB_COLS.find((c) => c.key === k);
    S.lbSort = S.lbSort?.key === k ? { key: k, dir: -S.lbSort.dir } : { key: k, dir: col.text ? 1 : -1 };
    renderLeaderboard();
  },
  'invd-add': (el) => { closeModal('invd-overlay'); openWeekModal(null, el.dataset.date); },
  'lb-prev': (el, e) => { e.stopPropagation(); navTicket(-1); },
  'lb-next': (el, e) => { e.stopPropagation(); navTicket(1); },
  'inv-save': () => saveInvestor(),
  upload: () => uploadTickets(),
  'up-remove': (el, e) => { e.preventDefault(); const [u] = S.uploads.splice(+el.dataset.id, 1); if (u) URL.revokeObjectURL(u.url); renderUploadPreview(); },
  'ticket-open': (el, e) => { e.stopPropagation(); openTicket(el.dataset.id); },
  'ticket-del': () => deleteTicket(),
  'qr-scan': () => scanLbPhoto(),
  'qr-check': () => checkLb(),
  'qr-add': () => addLbLink(),
  'qr-move': () => moveLbToQrDraw(),
  'qr-remove': (el) => {
    if (!confirm('Remove this QR code from the photo? (e.g. a wrong detection)')) return;
    const items = qrItems(S.lbTicket).filter((_, i) => i !== +el.dataset.i);
    saveQr(items, 'Removed.');
  },
  'week-add-date': (el, e) => { e.preventDefault(); e.stopPropagation(); openWeekModal(null, el.dataset.date); },
  'wm-use-qr': (el) => quickSet($('wm-prize'), +el.dataset.v),
  'save-name': () => saveName(),
  'save-pw': () => savePassword(),
  'save-cfg': () => saveSettings(),
  'cur-pick': (el) => { _curDraft.currency = el.dataset.id; renderCurrencyPicker(); moneyHint('cfg-threshold', 'cfg-threshold-hint'); },
  'invite-create': () => createInvite(),
  'invite-copy': (el) => copyText(inviteLink(el.dataset.id), 'Invitation link copied!'),
  'invite-share': (el) => navigator.share({ title: '645 invitation', text: 'Join our 645 lotto group:', url: inviteLink(el.dataset.id) }).catch(() => {}),
  'invite-revoke': (el) => revokeInvite(el.dataset.id),
  'invite-delete': (el) => deleteInvite(el.dataset.id),
  'member-status': (el) => setMember(el.dataset.id, { status: el.dataset.on },
    el.dataset.on === 'revoked' ? 'Revoke this member\'s access? They are locked out immediately. Their past data stays.' : null),
  'member-role': (el) => setMember(el.dataset.id, { role: el.dataset.on }, `Change role to ${el.dataset.on}?`),
  'member-pw': (el) => resetMemberPassword(el.dataset.id),
  copy: (el) => copyText(el.dataset.text),
  export: () => exportBackup(),
};

const INPUTS = {
  'wm-preview': () => previewWeek(),
  'wm-date': () => refreshWeekPool(),
  'up-date': () => { $('up-round').value = drawNo($('up-date').value) || ''; upDateInfo(); },
  'sim-round': (el, e) => { if (e.type === 'change') simSetRound(parseInt(el.value, 10) || 0); },
  'sim-date': (el, e) => { if (e.type === 'change' && el.value) simSetRound(drawNo(saturdayOf(el.value))); },
  'sim-x': (el, e) => { if (e.type === 'change') simSetX(parseInt(el.value, 10) || 1); },
  'pick-own': (el, e) => { if (e.type === 'change') setPickOwn(el.value); },
  'board-x': (el, e) => { if (e.type === 'change' && el.value) setBoardGroups(parseInt(el.value, 10) || 1); },
  'up-round': () => { const n = parseInt($('up-round').value, 10); if (n >= 1) $('up-date').value = drawDate(n); upDateInfo(); },
  'money-hint': (el) => moneyHint(el.id, el.dataset.hint),
  'cur-select': (el) => { _curDraft.currency = el.value; renderCurrencyPicker(); moneyHint('cfg-threshold', 'cfg-threshold-hint'); },
  'qr-status': (el, e) => { if (e.type === 'change') editLbItem(+el.dataset.i, { status: el.value }); },
  'qr-prize': (el, e) => { if (e.type === 'change') editLbItem(+el.dataset.i, { status: 'win', prize: amt(el.value) }); },
  'cur-display': (el) => { _curDraft.display = el.value; renderCurrencyPicker(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el, e);
  else if (e.target.classList.contains('overlay')) closeModal(e.target.id);
});
for (const type of ['input', 'change']) {
  document.addEventListener(type, (e) => {
    if (type === 'input' && e.target.matches?.('[data-amount]')) formatAmountInput(e.target);
    const h = e.target.dataset?.onInput;
    if (h && INPUTS[h]) INPUTS[h](e.target, e);
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && $('lb-overlay').classList.contains('open')
      && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) {
    navTicket(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach((o) => o.classList.remove('open'));
});

$('form-login').addEventListener('submit', doLogin);
$('form-join').addEventListener('submit', doJoin);
$('up-files').addEventListener('change', (e) => { addUploadFiles(e.target.files); e.target.value = ''; });
$('import-file').addEventListener('change', (e) => { if (e.target.files[0]) importLegacy(e.target.files[0]); e.target.value = ''; });
// Swipe left/right on the photo to move between tickets
let _swipeX = null;
$('lb-stage').addEventListener('touchstart', (e) => { _swipeX = e.touches[0].clientX; }, { passive: true });
$('lb-stage').addEventListener('touchend', (e) => {
  if (_swipeX == null) return;
  const dx = e.changedTouches[0].clientX - _swipeX;
  _swipeX = null;
  if (Math.abs(dx) > 50) navTicket(dx < 0 ? 1 : -1);
});
const dz = $('dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); addUploadFiles(e.dataTransfer.files); });

// Keep the dashboard countdown fresh and pick up the new draw after Saturday 20:50.
setInterval(() => { if (S.me?.status === 'active' && S.tab === 'dashboard') renderDrawCard(); }, 60e3);

boot().catch((e) => { fail(e); showView('auth'); });
