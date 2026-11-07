// What the Saturday-evening notification says, and who gets one (pure functions, tested in Node).

export type Mode = 'all' | 'win' | 'big' | 'none';     // every result · any win · 4등 or better · no results
export type Lang = 'en' | 'ko' | 'vi';
export type DrawLite = { round: number; numbers: number[]; bonus: number; prizes?: Record<string, number> | null };
export type Summary = { round: number; games: number; ranks: Record<number, number>; best: number; won: number; gross: number; estimated: boolean };

const FIXED: Record<number, number> = { 4: 50000, 5: 5000 };   // 1등–3등 are not fixed: the draw's own amounts

/** Korean lottery tax on one winning game: up to ₩2,000,000 none, then 22%, and 33% on the part over ₩300,000,000. */
export function prizeTax(gross: number): number {
  if (!(gross > 2_000_000)) return 0;
  return Math.round(Math.min(gross, 300_000_000) * 0.22 + Math.max(0, gross - 300_000_000) * 0.33);
}

/** What one QR code's prize leaves after tax (the app's qrNet): tax is per winning game, so the total is split
 *  back into games — 4등/5등 are fixed and tax-free, the rest belongs to the 1등–3등 games. */
export function qrNetOf(it: { status?: string; prize?: number | null; games?: { nums: number[] }[] }, d: DrawLite | null): number {
  const gross = Number(it.prize) || 0;
  if (it.status !== 'win' || gross <= 2_000_000) return gross;
  const ranks = d ? (it.games ?? []).map((g) => rankOf(g.nums, d)).filter((r) => r > 0) : [];
  if (!ranks.length) return gross - prizeTax(gross);
  const big = ranks.filter((r) => r <= 3), rest = gross - ranks.filter((r) => r > 3).reduce((t, r) => t + FIXED[r], 0);
  if (big.length <= 1) return gross - prizeTax(rest);
  const own = big.map((r) => Number(d?.prizes?.[String(r)]) || 0);
  const each = own.every((v) => v > 0) && Math.abs(own.reduce((a, b) => a + b, 0) - rest) < 1000 ? own : big.map(() => rest / big.length);
  return gross - each.reduce((t, v) => t + prizeTax(v), 0);
}

/** A week's prize from its ticket QR results (after tax), or null while some result is missing or unclear. */
export function weekPrize(items: { url: string; status?: string; prize?: number | null; round?: number | null; games?: { nums: number[] }[] }[],
  drawOf: (round: number) => DrawLite | null, round: number): number | null {
  const byUrl = new Map(items.map((i) => [i.url, i]));
  const list = [...byUrl.values()];
  if (!list.length || list.some((i) => i.status !== 'win' && i.status !== 'lose')) return null;
  if (list.some((i) => i.status === 'win' && !(Number(i.prize) > 0))) return null;
  return Math.round(list.filter((i) => i.status === 'win').reduce((t, i) => t + qrNetOf(i, drawOf(i.round ?? round)), 0));
}

export function rankOf(nums: number[], d: DrawLite): number {
  const k = nums.filter((n) => d.numbers.includes(n)).length, b = nums.includes(d.bonus);
  return k === 6 ? 1 : k === 5 && b ? 2 : k === 5 ? 3 : k === 4 ? 4 : k === 3 ? 5 : 0;
}

/** Our games of one draw against its winning numbers. 1등–3등 use the draw's own prize when known; `won` is after tax. */
export function summarize(games: number[][], d: DrawLite): Summary {
  const ranks: Record<number, number> = {};
  let won = 0, gross = 0, estimated = false;
  for (const g of games) {
    const r = rankOf(g, d);
    if (!r) continue;
    ranks[r] = (ranks[r] || 0) + 1;
    const amount = FIXED[r] ?? Number(d.prizes?.[String(r)] ?? 0);
    if (!amount) estimated = true;
    gross += amount;
    won += amount - prizeTax(amount);
  }
  const best = Math.min(...Object.keys(ranks).map(Number), 9);
  return { round: d.round, games: games.length, ranks, best: best === 9 ? 0 : best, won, gross, estimated };
}

export function shouldNotify(mode: Mode, s: Summary): boolean {
  if (mode === 'none') return false;
  if (mode === 'all') return true;
  if (mode === 'win') return s.best > 0;
  return s.best > 0 && s.best <= 4;
}

const money = (n: number, lang: Lang) => '₩' + n.toLocaleString(lang === 'ko' ? 'ko-KR' : lang === 'vi' ? 'vi-VN' : 'en-US');

const TEXT = {
  en: {
    title: (r: number) => `🎱 Draw #${r} results`,
    won: (m: string, list: string, g: number) => `🎉 We won ${m} (${list}) on ${g} game${g === 1 ? '' : 's'}!`,
    taxed: (net: string, gross: string) => `${net} after tax (${gross} before)`,
    wonBig: (list: string, g: number) => `🎉 We won ${list} on ${g} game${g === 1 ? '' : 's'}! Prize amount to follow.`,
    none: (g: number) => `No win this time (${g} game${g === 1 ? '' : 's'}).`,
    notPlayed: 'We did not play this draw.',
    rank: (r: number, n: number) => `${n}× ${['', '1st', '2nd', '3rd', '4th', '5th'][r] ?? r} prize`,
  },
  ko: {
    title: (r: number) => `🎱 제${r}회 추첨 결과`,
    won: (m: string, list: string, g: number) => `🎉 ${g}게임 중 ${list} 당첨, 총 ${m}!`,
    taxed: (net: string, gross: string) => `세후 ${net} (세전 ${gross})`,
    wonBig: (list: string, g: number) => `🎉 ${g}게임 중 ${list} 당첨! 당첨금은 곧 확인됩니다.`,
    none: (g: number) => `아쉽게도 낙첨입니다 (${g}게임).`,
    notPlayed: '이번 회차는 참여하지 않았습니다.',
    rank: (r: number, n: number) => `${r}등 ${n}개`,
  },
  vi: {
    title: (r: number) => `🎱 Kết quả kỳ #${r}`,
    won: (m: string, list: string, g: number) => `🎉 Chúng ta trúng ${m} (${list}) trên ${g} vé!`,
    taxed: (net: string, gross: string) => `${net} sau thuế (${gross} trước thuế)`,
    wonBig: (list: string, g: number) => `🎉 Chúng ta trúng ${list} trên ${g} vé! Số tiền thưởng sẽ được cập nhật.`,
    none: (g: number) => `Lần này không trúng (${g} vé).`,
    notPlayed: 'Chúng ta không chơi kỳ này.',
    rank: (r: number, n: number) => `${n}× giải ${r}`,
  },
};

/** Title and text of the notification for one member's language. */
export function message(s: Summary, d: DrawLite, lang: Lang) {
  const T = TEXT[lang] ?? TEXT.en;
  const nums = `${[...d.numbers].sort((a, b) => a - b).join(' ')} + ${d.bonus}`;
  const list = Object.keys(s.ranks).map(Number).sort((a, b) => a - b).map((r) => T.rank(r, s.ranks[r])).join(', ');
  const line = !s.games ? T.notPlayed
    : !s.best ? T.none(s.games)
    : s.estimated ? T.wonBig(list, s.games)
    : T.won(s.won < s.gross ? T.taxed(money(s.won, lang), money(s.gross, lang)) : money(s.won, lang), list, s.games);
  return { title: T.title(s.round), body: `${nums}\n${line}`, tag: `draw-${s.round}`, url: './#dashboard' };
}

/** Saturday before the draw: time to watch it live. */
export function reminderMessage(round: number, minutes: number, lang: Lang) {
  const m = Math.max(1, Math.round(minutes));
  const t = {
    en: { title: `📺 Draw #${round} in ${m} minute${m === 1 ? '' : 's'}`, body: 'This week\'s draw takes place soon. Watch it live and tap the numbers in 645 → Picks → Live.' },
    ko: { title: `📺 제${round}회 추첨 ${m}분 전`, body: '이번 주 추첨이 곧 시작됩니다. 생방송을 보면서 645 → 번호 → 라이브에서 번호를 눌러 보세요.' },
    vi: { title: `📺 Kỳ #${round} quay sau ${m} phút`, body: 'Kỳ quay tuần này sắp bắt đầu. Xem trực tiếp và chạm các số trong 645 → Chọn số → Trực tiếp.' },
  }[lang] ?? null;
  return { ...(t ?? { title: `📺 Draw #${round} in ${m} minutes`, body: '' }), tag: `remind-${round}`, url: './#picks-live' };
}

/** Someone uploaded ticket photos. */
export function ticketsMessage(name: string, photos: number, games: number, round: number | null, lang: Lang) {
  const r = round ? `#${round}` : '';
  const t = {
    en: { title: `🎟️ ${name} uploaded ${photos} ticket photo${photos === 1 ? '' : 's'}`,
      body: `${round ? `Draw ${r}` : 'This week'}${games ? ` · ${games} game${games === 1 ? '' : 's'}` : ''}. Tap to see them.` },
    ko: { title: `🎟️ ${name} 님이 복권 사진 ${photos}장을 올렸습니다`,
      body: `${round ? `제${round}회` : '이번 주'}${games ? ` · ${games}게임` : ''}. 눌러서 확인하세요.` },
    vi: { title: `🎟️ ${name} đã tải lên ${photos} ảnh vé`,
      body: `${round ? `Kỳ ${r}` : 'Tuần này'}${games ? ` · ${games} vé` : ''}. Chạm để xem.` },
  }[lang] ?? { title: `🎟️ ${name}: ${photos}`, body: '' };
  return { ...t, tag: `tickets-${Date.now()}`, url: './#tickets' };
}

/** Test message from the settings page. */
export function testMessage(lang: Lang) {
  return {
    en: { title: '🔔 645 notifications are on', body: 'You will get the Saturday results here.' },
    ko: { title: '🔔 645 알림이 켜졌습니다', body: '토요일 추첨 결과를 여기로 알려드립니다.' },
    vi: { title: '🔔 Đã bật thông báo 645', body: 'Bạn sẽ nhận kết quả thứ Bảy tại đây.' },
  }[lang] ?? { title: '🔔 645', body: 'Notifications are on.' };
}

/** Mentions are stored as <@member-id> / <@everyone>: shown as @Name. */
export function mentionText(text: string, names: Record<string, string>) {
  return text.replace(/<@(everyone|[0-9a-f-]{36})>/g, (_, id) => `@${id === 'everyone' ? 'everyone' : names[id] ?? '?'}`);
}
export function mentionedIds(text: string): { ids: string[]; everyone: boolean } {
  return { ids: [...new Set([...text.matchAll(/<@([0-9a-f-]{36})>/g)].map((m) => m[1]))], everyone: text.includes('<@everyone>') };
}
const short = (text: string) => { const b = text.replace(/\s+/g, ' ').trim(); return b.length > 140 ? b.slice(0, 139) + '…' : b; };

/** A new chat message, for the members who asked for chat notifications. */
export function chatMessage(name: string, text: string) {
  return { title: `💬 ${name}`, body: short(text), tag: 'chat', url: './#chat' };
}

/** Someone replied to your chat message. */
export function replyMessage(name: string, text: string, lang: Lang) {
  const title = { en: `↩️ ${name} replied to you`, ko: `↩️ ${name} 님이 답장했습니다`, vi: `↩️ ${name} đã trả lời bạn` }[lang] ?? `↩️ ${name}`;
  return { title, body: short(text), tag: 'mention', url: './#chat' };
}

/** Someone wrote @you (or @everyone) in chat. */
export function mentionMessage(name: string, text: string, everyone: boolean, lang: Lang) {
  const title = {
    en: everyone ? `📣 ${name} mentioned everyone` : `📣 ${name} mentioned you`,
    ko: everyone ? `📣 ${name} 님이 모두를 언급했습니다` : `📣 ${name} 님이 회원님을 언급했습니다`,
    vi: everyone ? `📣 ${name} đã nhắc đến mọi người` : `📣 ${name} đã nhắc đến bạn`,
  }[lang] ?? `📣 ${name}`;
  return { title, body: short(text), tag: 'mention', url: './#chat' };
}

/** What the result bot posts in 💬 Chat (the app shows it in each member's language from `meta`). */
export function resultPost(s: Summary, d: DrawLite) {
  const { title, body } = message(s, d, 'en');
  return {
    body: `${title}\n${body}`,
    meta: { type: 'result', round: d.round, numbers: [...d.numbers].sort((a, b) => a - b), bonus: d.bonus,
      games: s.games, ranks: s.ranks, best: s.best, won: s.won, gross: s.gross, estimated: s.estimated },
  };
}

/** 💰 A member reminds another to send money (from the Money tab). */
export function moneyMessage(from: string, to: string, amount: number, round: number, lang: Lang) {
  const m = money(amount, lang);
  const t = {
    en: { title: `💸 ${from}: please send ${to} ${m}`, body: `For draw #${round}. Then tap Done in 645 → Money.` },
    ko: { title: `💸 ${from}: ${to} 님에게 ${m} 보내 주세요`, body: `제${round}회분입니다. 보낸 뒤 645 → 돈에서 완료를 눌러 주세요.` },
    vi: { title: `💸 ${from}: hãy gửi ${to} ${m}`, body: `Cho kỳ #${round}. Sau đó chạm Xong trong 645 → Tiền.` },
  }[lang] ?? { title: `💸 ${to} ${m}`, body: '' };
  return { ...t, tag: `money-${round}`, url: './#money' };
}

/** 🛒 Saturday morning (12 hours before the draw): a buyer has no ticket photos for the draw yet. */
export function buyerMessage(round: number, manual: number, auto: number, lang: Lang) {
  const n = manual + auto;
  const t = {
    en: { title: `🛒 Draw #${round}: you buy ${n} game${n > 1 ? 's' : ''} today`, body: `${manual} manual (수동, from the QR code) + ${auto} auto (자동), ${money(n * 1000, lang)}. Sales close at 20:00 KST: upload the ticket photos once bought.` },
    ko: { title: `🛒 제${round}회: 오늘 ${n}게임을 사 주세요`, body: `수동 ${manual}게임 (QR 코드) + 자동 ${auto}게임, ${money(n * 1000, lang)}. 판매는 20:00에 마감됩니다: 산 뒤 복권 사진을 올려 주세요.` },
    vi: { title: `🛒 Kỳ #${round}: hôm nay bạn mua ${n} vé`, body: `${manual} tự chọn (수동, theo mã QR) + ${auto} ngẫu nhiên (자동), ${money(n * 1000, lang)}. Bán đến 20:00 giờ Hàn Quốc: mua xong hãy tải ảnh vé lên.` },
  }[lang] ?? { title: `🛒 #${round}: ${n}`, body: '' };
  return { ...t, tag: `buy-${round}`, url: './#picks-buy' };
}

/** 🧹 The bot proposes deleting the photos of a draw that won nothing. */
/** 🧹 Delete the photos of draws that won nothing? `approved` names who already said yes (a reminder). */
export function cleanupMessage(rounds: number[], photos: number, approved: string[], lang: Lang, need = 0) {
  const r = rounds.map((x) => `#${x}`).join(', '), many = rounds.length > 1, who = approved.join(', ');
  const t = {
    en: { title: `🧹 Delete ${photos} ticket photo${photos === 1 ? '' : 's'} of draw${many ? 's' : ''} ${r}?`,
      body: approved.length ? `${who} already approved (${need} needed). Your vote? Tap to vote in 645 → Tickets.` : 'They won nothing. More than half of us need to approve: tap to vote in 645 → Tickets.' },
    ko: { title: `🧹 ${r}회 복권 사진 ${photos}장을 지울까요?`,
      body: approved.length ? `${who} 님이 이미 찬성했습니다 (${need}명 필요). 투표해 주세요: 645 → 복권.` : '당첨되지 않았습니다. 회원 과반수가 찬성해야 합니다: 645 → 복권에서 투표하세요.' },
    vi: { title: `🧹 Xóa ${photos} ảnh vé của kỳ ${r}?`,
      body: approved.length ? `${who} đã đồng ý (cần ${need} người). Bạn bỏ phiếu nhé: 645 → Vé.` : 'Không trúng gì. Cần hơn một nửa thành viên đồng ý: chạm để bỏ phiếu trong 645 → Vé.' },
  }[lang] ?? { title: `🧹 ${r}`, body: '' };
  return { ...t, tag: 'cleanup', url: './#tickets' };
}

/** The chat post when the checker records a week's prize (stored in English; the app shows it in each language). */
export function prizeAutoText(round: number, prize: number) {
  return `🤖 Draw #${round}: the ticket QR codes say we won ${money(prize, 'en')} (after tax). I recorded it as the week's prize. ` +
    'Please check: ✓ confirm it or edit the week. Without changes it stays as the final result.';
}
