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
//   (50,000 / 5,000); 1등–3등 → win, amount to be entered by hand. Nothing known yet → pending.
//
// Deploy with the GitHub Action "Deploy result checker" (recommended), or in Supabase →
// Edge Functions → Deploy a new function → Via Editor → name "check-tickets" → paste → Deploy,
// then turn OFF "Verify JWT" in its settings (this code checks who is calling itself).
//
// GET  → self-test.  POST body (optional): { "ticket_id": "<uuid>" }
//   • An active member may re-check one ticket now (manual results are never overwritten).
//   • Without a member login, only pending QR codes whose results are already out are checked,
//     so the scheduled GitHub Action can call it with the public key.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

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
type Draw = { round: number; draw_date: string | null; numbers: number[]; bonus: number };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const resultsOut = (drawDate: string) => Date.now() >= new Date(`${drawDate}T${RESULTS_TIME}:00+09:00`).getTime();
const okHost = (h: string) => /(^|\.)dhlottery\.co\.kr$/i.test(h);

async function callerIsMember(req: Request): Promise<boolean> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (token.split('.').length !== 3) return false;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return false;
  const { data: p } = await db.from('profiles').select('status').eq('id', data.user.id).maybeSingle();
  return p?.status === 'active';
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
  return { round, numbers, bonus: Number(d.bnsWnNo), draw_date: /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null };
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
  if (draw) await db.from('draws').upsert({ ...draw, fetched_at: new Date().toISOString() });
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
async function checkItem(it: QrItem, ticketRound: number | null, cache: Map<number, Draw | null>) {
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
    const fixed = ranks.every((r) => r === 0 || r >= 4);
    return Object.assign(it, {
      status: 'win', source: 'numbers',
      prize: fixed ? ranks.reduce((s, r) => s + (FIXED_PRIZE[r] ?? 0), 0) : null,
      message: fixed ? `${top}등 (from the winning numbers)` : `${top}등! Enter the amount from the result page`,
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
  const member = await callerIsMember(req);
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
  return json({ ok: true, checked, draws: [...cache.values()].filter(Boolean).map((d) => d!.round), updated });
}
