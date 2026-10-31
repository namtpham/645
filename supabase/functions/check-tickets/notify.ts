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
    rank: (r: number, n: number) => `${n}× ${r}등`,
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
