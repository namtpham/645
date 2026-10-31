// 645 — check-tickets
//
// Works out the result of every ticket QR code after the draw, the same way you check by hand:
//   1. Winning numbers + bonus of the draw, from dhlottery's public draw data
//      (selectPstLt645Info.do), saved in the `draws` table.
//   2. Each game on the ticket is compared with them: matched numbers and rank (1등…5등).
//   3. The ticket's own result page (the QR link) is read for the official verdict:
//        "축하합니다! … 총 5,000원 당첨" → win, prize 5000
//        "아쉽게도, 낙첨되었습니다."      → no win
//   If the page can't be read, the numbers decide: no match → no win, 4등/5등 → fixed prize
//   (50,000 / 5,000); 1등–3등 → that draw's own amount per game (it changes every draw), or to be
//   entered by hand when dhlottery doesn't give it. Nothing known yet → pending.
//   Prizes are recorded before tax, as the result page shows them; the app shows them after tax too.
//
// Deploy with the GitHub Action "Deploy result checker" (recommended), or in Supabase →
// Edge Functions → Deploy a new function → Via Editor → name "check-tickets" → paste → Deploy,
// then turn OFF "Verify JWT" in its settings (this code checks who is calling itself).
//
// GET  → self-test.  POST body (optional): { "ticket_id": "<uuid>" }
//   • An active member may re-check one ticket now (manual results are never overwritten).
//   • Without a member login, only pending QR codes whose results are already out are checked,
//     so the scheduled GitHub Action can call it with the public key.
//   • { "push": "key" } → the public key browsers subscribe to notifications with;
//     { "push": "test" } (member) → a test notification to that member's devices;
//     { "push": "remind" } → before Saturday's draw (20:10–20:35 KST): "the draw starts in x minutes", once per device;
//     { "push": "tickets", "ticket_ids": [...] } (the member who just uploaded them) → "new ticket photos" to the others;
//     { "push": "chat", "message_id": n } (its author, right after sending) → the message to members who want chat;
//     { "push": "money", "member": id, "to": name, "amount": n, "round": n } (a member) → "please send …" to that member.
// The result bot also posts each draw's result in 💬 Chat (once).
// After every check, members who turned notifications on get the latest draw's result once
// (every result, any win, or 4등 and better: their choice, in their language).

import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { newVapidKeys, sendPush, type Vapid } from './push.ts';
import { chatMessage, mentionedIds, mentionMessage, mentionText, message, moneyMessage, reminderMessage, resultPost, shouldNotify, summarize, testMessage, ticketsMessage, type Lang, type Mode } from './notify.ts';

// The service key is provided to every Edge Function automatically (legacy or new key format).
function serviceKey(): string | undefined {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { return Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'))[0] as string; } catch { return undefined; }
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = serviceKey();
// deno-lint-ignore no-explicit-any
let db: any = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const RESULTS_TIME = '20:50';          // KST, results published on draw day
const RETRY_AFTER_MS = 10 * 60e3;      // don't hit the same QR more than every 10 minutes
const MAX_CHECKS = 60;                 // per call
const FIXED_PRIZE: Record<number, number> = { 4: 50000, 5: 5000 };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

type Game = { mode: string; nums: number[]; match?: number[]; bonus?: boolean; rank?: number };
type QrItem = {
  url: string; round?: number | null; games?: Game[]; status?: string; prize?: number | null;
  manual?: boolean; checked_at?: string | null; message?: string | null; source?: string;
};
type Draw = {
  round: number; draw_date: string | null; numbers: number[]; bonus: number;
  prizes?: Record<string, number> | null;   // prize per winning game by rank, e.g. { "1": 2_000_000_000, … }
  raw?: unknown;                              // the draw record as dhlottery sent it
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const resultsOut = (drawDate: string) => Date.now() >= new Date(`${drawDate}T${RESULTS_TIME}:00+09:00`).getTime();
const okHost = (h: string) => /(^|\.)dhlottery\.co\.kr$/i.test(h);

/** The signed-in active member calling, if any. */
async function callerMember(req: Request): Promise<string | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (token.split('.').length !== 3) return null;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: p } = await db.from('profiles').select('status').eq('id', data.user.id).maybeSingle();
  return p?.status === 'active' ? data.user.id : null;
}

function decode(buf: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
  const charset = (contentType.match(/charset=([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder().decode(buf); }
}

function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// ─── Draw numbers ─────────────────────────────────────────────────────────────
function parseDrawList(body: unknown, round: number): Draw | null {
  // deno-lint-ignore no-explicit-any
  const list: any[] = (body as any)?.data?.list ?? (body as any)?.list ?? [];
  const d = list.find((x) => Number(x.ltEpsd) === round);
  if (!d) return null;
  const numbers = [1, 2, 3, 4, 5, 6].map((i) => Number(d[`tm${i}WnNo`]));
  if (numbers.some((n) => !(n >= 1 && n <= 45)) || !(Number(d.bnsWnNo) >= 1)) return null;
  const ymd = String(d.ltRflYmd ?? '');
  return { round, numbers, bonus: Number(d.bnsWnNo), prizes: extractPrizes(d), raw: d,
    draw_date: /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null };
}

/** Prize per winning game for ranks 1–5 (fields like rnk1WnAmt), if the record has them. */
// deno-lint-ignore no-explicit-any
function extractPrizes(d: any): Record<string, number> | null {
  const out: Record<string, number> = {};
  const keys = Object.keys(d ?? {});
  for (let r = 1; r <= 5; r++) {
    const exact = keys.find((k) => new RegExp(`^rnk${r}WnAmt$`, 'i').test(k));
    const loose = keys.find((k) => new RegExp(`rnk${r}`, 'i').test(k) && /amt/i.test(k) && !/sum|tot|whol/i.test(k));
    const v = Number(String(d[exact ?? loose ?? ''] ?? '').replace(/[^\d]/g, ''));
    if (v > 0) out[r] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Save draws; works with an older database that has no prizes/raw columns yet. */
async function saveDraws(rows: Draw[]): Promise<void> {
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((d) => ({ ...d, fetched_at: stamp }));
    let { error } = await db.from('draws').upsert(chunk);
    if (error && /prizes|raw/i.test(error.message)) {
      ({ error } = await db.from('draws').upsert(chunk.map(({ prizes: _p, raw: _r, ...rest }) => rest)));
    }
    if (error) throw new Error(`Saving draws: ${error.message}`);
  }
}

/**
 * Load the whole history of winning numbers once (used by the number suggestions on the site),
 * and again when asked for prize amounts that are still missing (past-week simulation).
 */
async function backfillHistory(wantPrizes = false): Promise<number> {
  // latest draw whose results are out: Korea time minus 20:50, counted in whole weeks since draw #1
  const latest = Math.floor((Date.now() + 9 * 3600e3 - (20 * 60 + 50) * 60e3 - FIRST_DRAW) / (7 * 864e5)) + 1;
  const { count } = await db.from('draws').select('round', { count: 'exact', head: true });
  let missingPrizes = 0;
  if (wantPrizes) {
    const r = await db.from('draws').select('round', { count: 'exact', head: true }).is('prizes', null);
    missingPrizes = r.error ? 0 : r.count ?? 0;
  }
  if ((count ?? 0) >= latest - 1 && missingPrizes <= 5) return 0;
  const res = await fetch('https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=all', {
    signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Draw history: HTTP ${res.status}`);
  const body = await res.json();
  // deno-lint-ignore no-explicit-any
  const list: any[] = body?.data?.list ?? body?.list ?? [];
  const rows = list.map((d) => parseDrawList({ list: [d] }, Number(d.ltEpsd))).filter(Boolean) as Draw[];
  await saveDraws(rows);
  return rows.length;
}

async function getDraw(round: number, cache: Map<number, Draw | null>): Promise<Draw | null> {
  if (cache.has(round)) return cache.get(round)!;
  const { data: saved } = await db.from('draws').select('round, draw_date, numbers, bonus').eq('round', round).maybeSingle();
  if (saved) { cache.set(round, saved); return saved; }
  let draw: Draw | null = null;
  for (const q of [String(round), 'all']) {
    try {
      const res = await fetch(`https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=${q}`, {
        signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      draw = parseDrawList(await res.json(), round);
      if (draw) break;
    } catch { /* try the next form, else stay unknown */ }
  }
  if (draw) await saveDraws([draw]).catch(() => {});
  cache.set(round, draw);
  return draw;
}

/** Lotto 6/45 ranks: 6 = 1등, 5+bonus = 2등, 5 = 3등, 4 = 4등, 3 = 5등. */
function rankGame(nums: number[], draw: Draw): { match: number[]; bonus: boolean; rank: number } {
  const match = nums.filter((n) => draw.numbers.includes(n));
  const bonus = nums.includes(draw.bonus);
  const k = match.length;
  const rank = k === 6 ? 1 : k === 5 && bonus ? 2 : k === 5 ? 3 : k === 4 ? 4 : k === 3 ? 5 : 0;
  return { match, bonus, rank };
}

// ─── Ticket result page ───────────────────────────────────────────────────────
async function readResultPage(url: string): Promise<{ status: string; prize: number | null; message: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { status: 'invalid', prize: null, message: 'Not a URL' }; }
  if (!okHost(u.hostname)) return { status: 'invalid', prize: null, message: `Not a dhlottery link (${u.hostname})` };

  const res = await fetch(u, {
    redirect: 'follow', signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!okHost(new URL(res.url).hostname)) return { status: 'error', prize: null, message: `Redirected to ${res.url}` };
  if (!res.ok) return { status: 'pending', prize: null, message: `Result page: HTTP ${res.status}` };

  const text = pageText(decode(await res.arrayBuffer(), res.headers.get('content-type') ?? ''));
  if (/축하합니다/.test(text)) {
    const m = text.match(/총\s*([\d,]+)\s*원\s*당첨/) ?? text.match(/([\d,]{4,})\s*원\s*당첨/);
    const prize = m ? Number(m[1].replace(/,/g, '')) : null;
    return { status: 'win', prize, message: prize == null ? '축하합니다! (amount not readable)' : `축하합니다! 총 ${m![1]}원 당첨` };
  }
  if (/낙첨/.test(text)) return { status: 'lose', prize: 0, message: '아쉽게도, 낙첨되었습니다.' };
  return { status: 'pending', prize: null, message: `Result page not ready: ${text.slice(0, 120) || 'empty'}` };
}

/** Combine the official page verdict with our own comparison against the winning numbers. */
/** A real game: 6 different numbers from 1 to 45 (empty slots on a ticket's QR are all zeros). */
const isGame = (g: Game) => Array.isArray(g?.nums) && g.nums.length === 6 && new Set(g.nums).size === 6 && g.nums.every((n) => n >= 1 && n <= 45);

async function checkItem(it: QrItem, ticketRound: number | null, cache: Map<number, Draw | null>) {
  if (it.games) it.games = it.games.filter(isGame);   // older scans kept the empty slots
  const round = it.round ?? ticketRound;
  const draw = round ? await getDraw(round, cache) : null;
  if (draw && it.games?.length) for (const g of it.games) Object.assign(g, rankGame(g.nums, draw));
  const ranks = (it.games ?? []).map((g) => g.rank ?? 0);

  let page: { status: string; prize: number | null; message: string } | null = null;
  try { page = await readResultPage(it.url); } catch (e) { page = { status: 'pending', prize: null, message: `Result page: ${(e as Error).message}` }; }
  if (page.status === 'invalid' || page.status === 'error') return Object.assign(it, page, { source: 'page' });

  if (page.status === 'win' || page.status === 'lose') {
    Object.assign(it, page, { source: 'page' });
    if (draw && it.games?.length) {
      const fixedOnly = ranks.every((r) => r === 0 || r >= 4);
      const expected = ranks.reduce((s, r) => s + (FIXED_PRIZE[r] ?? 0), 0);
      if ((page.status === 'lose') !== ranks.every((r) => r === 0) || (page.status === 'win' && fixedOnly && page.prize != null && page.prize !== expected)) {
        it.message += ' · ⚠️ differs from the winning numbers';
      }
    }
    return it;
  }
  if (draw && it.games?.length) {
    if (ranks.every((r) => r === 0)) return Object.assign(it, { status: 'lose', prize: 0, source: 'numbers', message: '낙첨 (from the winning numbers)' });
    const top = Math.min(...ranks.filter((r) => r > 0));
    const amount = (r: number) => (r ? FIXED_PRIZE[r] ?? (Number(draw.prizes?.[String(r)]) || null) : 0);
    const known = ranks.every((r) => amount(r) != null);
    return Object.assign(it, {
      status: 'win', source: 'numbers',
      prize: known ? ranks.reduce((s, r) => s + (amount(r) ?? 0), 0) : null,
      message: known ? `${top}등 (from the winning numbers${top <= 3 ? ' and this draw\'s prize amounts' : ''})` : `${top}등! Enter the amount from the result page`,
    });
  }
  return Object.assign(it, page, { source: 'page' });
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  // Opening the function URL in a browser is a self-test.
  if (req.method === 'GET') {
    return json({ ok: !!(SUPABASE_URL && SERVICE_KEY), function: 'check-tickets', service_key: !!SERVICE_KEY,
      note: 'If you can read this, the function is deployed and reachable without a login.' });
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'The function has no SUPABASE_URL / service key in its environment.' }, 500);
  db ??= createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    return await handle(req);
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});

const FIRST_DRAW = Date.UTC(2002, 11, 7);   // draw #1, 2002-12-07
const roundOf = (d: string) => Math.round((Date.parse(d + 'T00:00:00Z') - FIRST_DRAW) / (7 * 864e5)) + 1;

async function handle(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));

  // Public draw history as dhlottery publishes it (used by the analysis workflow in GitHub Actions,
  // whose servers may not reach dhlottery directly). Read-only; nothing private is returned.
  if (body.export === 'history') {
    const res = await fetch('https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=all', {
      signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return json({ error: `dhlottery: HTTP ${res.status}` }, 502);
    const data = await res.json();
    return json({ list: data?.data?.list ?? data?.list ?? [] });
  }
  const memberId = await callerMember(req), member = !!memberId;
  if (body.push === 'key') return json({ publicKey: (await vapid()).publicKey });
  if (body.push === 'test') {
    if (!memberId) return json({ error: 'Sign in first.' }, 401);
    const { data: subs } = await db.from('push_subs').select('*').eq('member', memberId);
    let sent = 0;
    for (const sub of subs ?? []) {
      const r = await sendPush(sub, { ...testMessage(sub.lang as Lang), tag: 'test', url: './' }, await vapid()).catch(() => null);
      if (r?.gone) await db.from('push_subs').delete().eq('endpoint', sub.endpoint);
      else if (r?.ok) sent++;
    }
    return json({ ok: true, sent, devices: subs?.length ?? 0 });
  }
  if (body.push === 'remind') return json(await sendReminders());
  if (body.push === 'tickets') {
    if (!memberId) return json({ error: 'Sign in first.' }, 401);
    return json(await sendTicketNews(memberId, Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 50).map(String) : []));
  }
  if (body.push === 'chat') {
    if (!memberId) return json({ error: 'Sign in first.' }, 401);
    return json(await sendChatNews(memberId, Number(body.message_id)));
  }
  if (body.push === 'money') {
    if (!memberId) return json({ error: 'Sign in first.' }, 401);
    return json(await sendMoneyReminder(memberId, body));
  }
  const force = member && typeof body.ticket_id === 'string';

  let q = db.from('tickets').select('id, draw_date, qr_data').not('qr_data', 'is', null);
  if (typeof body.ticket_id === 'string') q = q.eq('id', body.ticket_id);
  else q = q.gte('draw_date', new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10));
  const { data: tickets, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const cache = new Map<number, Draw | null>();
  let checked = 0;
  const updated: Record<string, unknown>[] = [];
  for (const t of tickets ?? []) {
    if (!resultsOut(t.draw_date) || !Array.isArray(t.qr_data)) continue;
    const items: QrItem[] = t.qr_data;
    let changed = false;
    for (const it of items) {
      if (it.manual || it.status === 'invalid') continue;
      const settled = it.status === 'lose' || (it.status === 'win' && (it.prize ?? 0) > 0);
      if (settled && !force) continue;
      if (!force && it.checked_at && Date.now() - new Date(it.checked_at).getTime() < RETRY_AFTER_MS) continue;
      if (checked >= MAX_CHECKS) break;
      checked++;
      await checkItem(it, roundOf(t.draw_date), cache);
      it.checked_at = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      const { error: e2 } = await db.from('tickets').update({ qr_data: items }).eq('id', t.id);
      if (e2) return json({ error: e2.message }, 500);
      updated.push({ ticket: t.id, items: items.map(({ status, prize, source }) => ({ status, prize, source })) });
    }
  }
  // Make sure the winning numbers of every finished draw with tickets are saved (the site shows them),
  // even when all tickets of that draw were settled earlier.
  for (const t of tickets ?? []) {
    if (!resultsOut(t.draw_date) || !Array.isArray(t.qr_data)) continue;
    for (const r of new Set([roundOf(t.draw_date), ...t.qr_data.map((i: QrItem) => i.round).filter(Boolean)])) {
      if (!cache.has(r as number)) await getDraw(r as number, cache);
    }
  }
  let history = 0, historyError: string | undefined;
  try { history = await backfillHistory(body.prizes === true); } catch (e) { historyError = (e as Error).message; }
  let notified: unknown;
  try { notified = await notifyResults(cache); } catch (e) { notified = { error: (e as Error).message }; }
  return json({ ok: true, checked, draws: [...cache.values()].filter(Boolean).map((d) => d!.round), history, historyError, updated, notified });
}

// ─── Notifications ──────────────────────────────────────────────────────────────

const drawDateOf = (round: number) => new Date(FIRST_DRAW + (round - 1) * 7 * 864e5).toISOString().slice(0, 10);
let _vapid: Vapid | null = null;

/** The VAPID key pair, made once and kept in push_keys (only the service role can read it). */
async function vapid(): Promise<Vapid> {
  if (_vapid) return _vapid;
  let { data } = await db.from('push_keys').select('*').eq('id', 1).maybeSingle();
  if (!data) {
    const k = await newVapidKeys();
    await db.from('push_keys').upsert({ id: 1, public_key: k.publicKey, private_jwk: k.privateJwk }, { onConflict: 'id', ignoreDuplicates: true });
    ({ data } = await db.from('push_keys').select('*').eq('id', 1).maybeSingle());
  }
  if (!data) throw new Error('Run supabase/schema.sql again: the push_keys table is missing.');
  _vapid = { publicKey: data.public_key, privateJwk: data.private_jwk, subject: 'https://namtpham.github.io/645/' };
  return _vapid;
}

/** The games we played in a draw: QR codes of its ticket photos, or else our complete groups for it. */
async function gamesFor(round: number): Promise<number[][]> {
  const date = drawDateOf(round), seen = new Set<string>(), games: number[][] = [];
  const day = 864e5, around = (n: number) => new Date(Date.parse(date) + n * day).toISOString().slice(0, 10);
  const { data: tickets } = await db.from('tickets').select('draw_date, qr_data').gte('draw_date', around(-14)).lte('draw_date', around(14));
  for (const t of tickets ?? []) {
    for (const it of (Array.isArray(t.qr_data) ? t.qr_data : []) as QrItem[]) {
      const r = it.round ?? (t.draw_date === date ? round : null);
      if (r !== round || seen.has(it.url) || it.status === 'invalid') continue;
      seen.add(it.url);
      for (const g of (it.games ?? []).filter(isGame)) games.push(g.nums);
    }
  }
  if (games.length) return games;
  const { data: picks } = await db.from('group_picks').select('grp, num').eq('round', round);
  const byGroup = new Map<number, number[]>();
  for (const p of picks ?? []) byGroup.set(p.grp, [...(byGroup.get(p.grp) ?? []), p.num]);
  return [...byGroup.values()].filter((g) => g.length === 6);
}

const DRAW_TIME = '20:35';   // KST, the live draw

/** Saturday 20:10–20:35 KST: tell the devices that asked for it that the draw is about to start (once per draw). */
async function sendReminders() {
  const kst = new Date(Date.now() + 9 * 3600e3), day = kst.toISOString().slice(0, 10);
  const drawAt = new Date(`${day}T${DRAW_TIME}:00+09:00`).getTime(), minutes = (drawAt - Date.now()) / 60e3;
  if (kst.getUTCDay() !== 6 || minutes <= 0 || minutes > 25) return { sent: 0, note: 'only on Saturday between 20:10 and 20:35 KST' };
  const round = roundOf(day);
  const { data: subs, error } = await db.from('push_subs').select('*').eq('remind', true).or(`last_remind.is.null,last_remind.lt.${round}`);
  if (error) return { error: error.message };
  const v = subs?.length ? await vapid() : null;
  let sent = 0;
  for (const sub of subs ?? []) {
    const { data: claimed } = await db.from('push_subs').update({ last_remind: round })
      .eq('endpoint', sub.endpoint).or(`last_remind.is.null,last_remind.lt.${round}`).select('endpoint');
    if (!claimed?.length) continue;
    const r = await sendPush(sub, reminderMessage(round, minutes, sub.lang as Lang), v!, 30 * 60).catch(() => null);
    if (r?.gone) await db.from('push_subs').delete().eq('endpoint', sub.endpoint);
    else if (r?.ok) sent++;
  }
  return { round, minutes: Math.round(minutes), sent };
}

/** "New ticket photos": photos this member uploaded in the last half hour, each announced once. */
async function sendTicketNews(memberId: string, ids: string[]) {
  if (!ids.length) return { sent: 0 };
  const since = new Date(Date.now() - 30 * 60e3).toISOString();
  // claim the photos first, so a second call can't announce them again
  const { data: photos, error } = await db.from('tickets').update({ notified_at: new Date().toISOString() })
    .in('id', ids).eq('uploaded_by', memberId).is('notified_at', null).gte('created_at', since)
    .select('id, draw_date, game_count, qr_data');
  if (error) return { error: error.message };
  if (!photos?.length) return { sent: 0 };
  let games = 0;
  const rounds = new Set<number>();
  for (const p of photos) {
    const qr = (Array.isArray(p.qr_data) ? p.qr_data : []) as QrItem[];
    const n = qr.reduce((a, it) => a + (it.games ?? []).filter(isGame).length, 0);
    games += n || (p.game_count ?? 0);
    rounds.add(qr.find((it) => it.round)?.round ?? roundOf(p.draw_date));
  }
  const round = rounds.size === 1 ? [...rounds][0] : null;
  const { data: who } = await db.from('profiles').select('display_name').eq('id', memberId).maybeSingle();
  const { data: subs } = await db.from('push_subs').select('*').eq('tickets', true).neq('member', memberId);
  const v = subs?.length ? await vapid() : null;
  let sent = 0;
  for (const sub of subs ?? []) {
    const r = await sendPush(sub, ticketsMessage(who?.display_name ?? '?', photos.length, games, round, sub.lang as Lang), v!).catch(() => null);
    if (r?.gone) await db.from('push_subs').delete().eq('endpoint', sub.endpoint);
    else if (r?.ok) sent++;
  }
  return { photos: photos.length, sent };
}

/** A chat message, sent once to the other members who turned chat notifications on. */
async function sendChatNews(memberId: string, id: number) {
  if (!Number.isFinite(id)) return { sent: 0 };
  const since = new Date(Date.now() - 10 * 60e3).toISOString();
  // claim it first, so a second call can't send it again
  const { data: msg, error } = await db.from('chat_messages').update({ notified_at: new Date().toISOString() })
    .eq('id', id).eq('author', memberId).is('notified_at', null).gte('created_at', since).select('id, body').maybeSingle();
  if (error) return { error: error.message };
  if (!msg) return { sent: 0 };
  const { data } = await db.from('profiles').select('id, display_name, status');
  const people = (data ?? []) as { id: string; display_name: string; status: string }[];
  const names = Object.fromEntries(people.map((p) => [p.id, p.display_name]));
  const name = names[memberId] ?? '?', text = mentionText(msg.body, names);
  // mentioned members (@them or @everyone) get "mentioned you" on devices that allow it; the others who want chat get the message
  const m = mentionedIds(msg.body);
  const mentioned = new Set(people.filter((p) => p.status === 'active' && p.id !== memberId && (m.everyone || m.ids.includes(p.id))).map((p) => p.id));
  const { data: subs } = await db.from('push_subs').select('*').neq('member', memberId).or('chat.eq.true,mention.eq.true');
  const v = subs?.length ? await vapid() : null;
  let sent = 0, mentions = 0;
  for (const sub of subs ?? []) {
    const isMention = mentioned.has(sub.member) && sub.mention !== false;
    if (!isMention && !sub.chat) continue;
    const payload = isMention ? mentionMessage(name, text, m.everyone && !m.ids.includes(sub.member), sub.lang as Lang) : chatMessage(name, text);
    const r = await sendPush(sub, payload, v!, 6 * 3600).catch(() => null);
    if (r?.gone) await db.from('push_subs').delete().eq('endpoint', sub.endpoint);
    else if (r?.ok) { sent++; if (isMention) mentions++; }
  }
  return { sent, mentions };
}

/** 💰 "Please send B ₩5,000": a member reminds another (who allows personal notifications, like mentions). */
async function sendMoneyReminder(memberId: string, b: Record<string, unknown>) {
  const target = String(b.member ?? ''), amount = Math.round(Number(b.amount)), round = Math.round(Number(b.round));
  const to = String(b.to ?? '').slice(0, 40);
  if (!/^[0-9a-f-]{36}$/.test(target) || target === memberId || !(amount > 0 && amount < 1e9) || !(round > 0)) return { error: 'Bad reminder.' };
  const { data: who } = await db.from('profiles').select('display_name').eq('id', memberId).maybeSingle();
  const { data: subs } = await db.from('push_subs').select('*').eq('member', target);
  const v = subs?.length ? await vapid() : null;
  let sent = 0;
  for (const sub of subs ?? []) {
    if (sub.mention === false) continue;
    const r = await sendPush(sub, moneyMessage(who?.display_name ?? '?', to, amount, round, sub.lang as Lang), v!, 24 * 3600).catch(() => null);
    if (r?.gone) await db.from('push_subs').delete().eq('endpoint', sub.endpoint);
    else if (r?.ok) sent++;
  }
  return { ok: true, sent, devices: subs?.length ?? 0 };
}

/** The result bot: the draw's result in 💬 Chat, once (bot_key is unique). */
async function postResult(s: ReturnType<typeof summarize>, draw: Draw) {
  const { body, meta } = resultPost(s, draw);
  const { error } = await db.from('chat_messages').upsert(
    { author: null, bot: 'results', bot_key: `result-${draw.round}`, body, meta },
    { onConflict: 'bot_key', ignoreDuplicates: true });
  return error ? { error: error.message } : { ok: true };
}

/** Once per draw and device: the result of the latest finished draw, if the member wants it. */
async function notifyResults(cache: Map<number, Draw | null>) {
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  let sat = new Date(Date.parse(kst) - ((new Date(kst).getUTCDay() + 1) % 7) * 864e5).toISOString().slice(0, 10);
  if (!resultsOut(sat)) sat = new Date(Date.parse(sat) - 7 * 864e5).toISOString().slice(0, 10);
  const round = roundOf(sat);
  const draw = cache.get(round) ?? await getDraw(round, cache);
  if (!draw) return { round, sent: 0, waiting: 'winning numbers not published yet' };
  const s = summarize(await gamesFor(round), draw);
  const chat = await postResult(s, draw).catch((e) => ({ error: (e as Error).message }));
  const { data: subs, error } = await db.from('push_subs').select('*').neq('mode', 'none').or(`last_round.is.null,last_round.lt.${round}`);
  if (error) return { round, chat, error: error.message };
  if (!subs?.length) return { round, chat, sent: 0 };
  const v = await vapid();
  let sent = 0, skipped = 0, removed = 0;
  for (const sub of subs) {
    // claim this draw for the device first, so two runs at the same time never both send
    const { data: claimed } = await db.from('push_subs').update({ last_round: round })
      .eq('endpoint', sub.endpoint).or(`last_round.is.null,last_round.lt.${round}`).select('endpoint');
    if (!claimed?.length) continue;
    if (!shouldNotify(sub.mode as Mode, s)) { skipped++; continue; }
    const r = await sendPush(sub, message(s, draw, sub.lang as Lang), v).catch(() => null);
    if (r?.gone) { await db.from('push_subs').delete().eq('endpoint', sub.endpoint); removed++; }
    else if (r?.ok) sent++;
  }
  return { round, chat, games: s.games, best: s.best, sent, skipped, removed };
}
