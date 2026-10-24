// 645 — check-tickets
//
// Opens the result page behind each ticket's QR code and records the outcome:
//   "축하합니다! … 총 5,000원 당첨"  → win, prize 5000
//   "아쉽게도, 낙첨되었습니다."        → no win
//   anything else (results not out yet, page changed) → stays "pending" and is retried later
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "check-tickets",
// paste this file, Deploy. Then in the function's settings turn OFF "Verify JWT" (this code
// checks who is calling itself). See README → "Automatic result check".
//
// Body (all optional): { "ticket_id": "<uuid>" }
//   • An active member may re-check one ticket now (manual results are never overwritten).
//   • Without a member login, only pending QR codes whose draw results are already out are
//     checked, so the scheduled GitHub Action can call it with the public key.

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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const RESULTS_TIME = '20:50';          // KST, results published on draw day
const RETRY_AFTER_MS = 10 * 60e3;      // don't hit the same QR more than every 10 minutes
const MAX_CHECKS = 60;                 // per call

type QrItem = {
  url: string; round?: number | null; status?: string; prize?: number | null;
  manual?: boolean; checked_at?: string | null; message?: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const resultsOut = (drawDate: string) => Date.now() >= new Date(`${drawDate}T${RESULTS_TIME}:00+09:00`).getTime();

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

async function checkQr(url: string): Promise<{ status: string; prize: number | null; message: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { status: 'invalid', prize: null, message: 'Not a URL' }; }
  const okHost = (h: string) => /(^|\.)dhlottery\.co\.kr$/i.test(h);
  if (!okHost(u.hostname)) return { status: 'invalid', prize: null, message: `Not a dhlottery link (${u.hostname})` };

  const res = await fetch(u, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!okHost(new URL(res.url).hostname)) return { status: 'error', prize: null, message: `Redirected to ${res.url}` };
  if (!res.ok) return { status: 'pending', prize: null, message: `HTTP ${res.status}` };

  const text = pageText(decode(await res.arrayBuffer(), res.headers.get('content-type') ?? ''));
  if (/축하합니다/.test(text)) {
    const m = text.match(/총\s*([\d,]+)\s*원\s*당첨/) ?? text.match(/([\d,]{4,})\s*원\s*당첨/);
    const prize = m ? Number(m[1].replace(/,/g, '')) : null;
    return { status: 'win', prize, message: prize == null ? 'Won, but the amount could not be read' : `총 ${m![1]}원 당첨` };
  }
  if (/낙첨/.test(text)) return { status: 'lose', prize: 0, message: '낙첨되었습니다' };
  return { status: 'pending', prize: null, message: text.slice(0, 160) || 'Empty page' };
}

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

async function handle(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const member = await callerIsMember(req);
  const force = member && typeof body.ticket_id === 'string';

  let q = db.from('tickets').select('id, draw_date, qr_data').not('qr_data', 'is', null);
  if (typeof body.ticket_id === 'string') q = q.eq('id', body.ticket_id);
  else q = q.gte('draw_date', new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10));
  const { data: tickets, error } = await q;
  if (error) return json({ error: error.message }, 500);

  let checked = 0;
  const summary: Record<string, unknown>[] = [];
  for (const t of tickets ?? []) {
    if (!resultsOut(t.draw_date) || !Array.isArray(t.qr_data)) continue;
    const items: QrItem[] = t.qr_data;
    let changed = false;
    for (const it of items) {
      if (it.manual || it.status === 'win' || it.status === 'lose' || it.status === 'invalid') continue;
      if (!force && it.checked_at && Date.now() - new Date(it.checked_at).getTime() < RETRY_AFTER_MS) continue;
      if (checked >= MAX_CHECKS) break;
      checked++;
      try {
        Object.assign(it, await checkQr(it.url));
      } catch (e) {
        Object.assign(it, { status: 'pending', message: `Fetch failed: ${(e as Error).message}` });
      }
      it.checked_at = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      const { error: e2 } = await db.from('tickets').update({ qr_data: items }).eq('id', t.id);
      if (e2) return json({ error: e2.message }, 500);
      summary.push({ ticket: t.id, items: items.map(({ status, prize }) => ({ status, prize })) });
    }
  }
  return json({ ok: true, checked, updated: summary });
}
