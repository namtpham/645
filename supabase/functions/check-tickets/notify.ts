// What the Saturday-evening notification says, and who gets one (pure functions, tested in Node).

export type Mode = 'all' | 'win' | 'big';     // every result · any win · 4등 or better
export type Lang = 'en' | 'ko' | 'vi';
export type DrawLite = { round: number; numbers: number[]; bonus: number; prizes?: Record<string, number> | null };
export type Summary = { round: number; games: number; ranks: Record<number, number>; best: number; won: number; estimated: boolean };

const FIXED: Record<number, number> = { 4: 50000, 5: 5000 };

export function rankOf(nums: number[], d: DrawLite): number {
  const k = nums.filter((n) => d.numbers.includes(n)).length, b = nums.includes(d.bonus);
  return k === 6 ? 1 : k === 5 && b ? 2 : k === 5 ? 3 : k === 4 ? 4 : k === 3 ? 5 : 0;
}

/** Our games of one draw against its winning numbers. 1등–3등 use the draw's own prize when known. */
export function summarize(games: number[][], d: DrawLite): Summary {
  const ranks: Record<number, number> = {};
  let won = 0, estimated = false;
  for (const g of games) {
    const r = rankOf(g, d);
    if (!r) continue;
    ranks[r] = (ranks[r] || 0) + 1;
    const amount = FIXED[r] ?? Number(d.prizes?.[String(r)] ?? 0);
    if (!amount) estimated = true;
    won += amount;
  }
  const best = Math.min(...Object.keys(ranks).map(Number), 9);
  return { round: d.round, games: games.length, ranks, best: best === 9 ? 0 : best, won, estimated };
}

export function shouldNotify(mode: Mode, s: Summary): boolean {
  if (mode === 'all') return true;
  if (mode === 'win') return s.best > 0;
  return s.best > 0 && s.best <= 4;
}

const money = (n: number, lang: Lang) => '₩' + n.toLocaleString(lang === 'ko' ? 'ko-KR' : lang === 'vi' ? 'vi-VN' : 'en-US');

const TEXT = {
  en: {
    title: (r: number) => `🎱 Draw #${r} results`,
    won: (m: string, list: string, g: number) => `🎉 We won ${m} (${list}) on ${g} game${g === 1 ? '' : 's'}!`,
    wonBig: (list: string, g: number) => `🎉 We won ${list} on ${g} game${g === 1 ? '' : 's'}! Prize amount to follow.`,
    none: (g: number) => `No win this time (${g} game${g === 1 ? '' : 's'}).`,
    notPlayed: 'We did not play this draw.',
    rank: (r: number, n: number) => `${n}× ${r}등`,
  },
  ko: {
    title: (r: number) => `🎱 제${r}회 추첨 결과`,
    won: (m: string, list: string, g: number) => `🎉 ${g}게임 중 ${list} 당첨, 총 ${m}!`,
    wonBig: (list: string, g: number) => `🎉 ${g}게임 중 ${list} 당첨! 당첨금은 곧 확인됩니다.`,
    none: (g: number) => `아쉽게도 낙첨입니다 (${g}게임).`,
    notPlayed: '이번 회차는 참여하지 않았습니다.',
    rank: (r: number, n: number) => `${r}등 ${n}개`,
  },
  vi: {
    title: (r: number) => `🎱 Kết quả kỳ #${r}`,
    won: (m: string, list: string, g: number) => `🎉 Chúng ta trúng ${m} (${list}) trên ${g} vé!`,
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
    : T.won(money(s.won, lang), list, s.games);
  return { title: T.title(s.round), body: `${nums}\n${line}`, tag: `draw-${s.round}`, url: './#tab=dashboard' };
}

/** Test message from the settings page. */
export function testMessage(lang: Lang) {
  return {
    en: { title: '🔔 645 notifications are on', body: 'You will get the Saturday results here.' },
    ko: { title: '🔔 645 알림이 켜졌습니다', body: '토요일 추첨 결과를 여기로 알려드립니다.' },
    vi: { title: '🔔 Đã bật thông báo 645', body: 'Bạn sẽ nhận kết quả thứ Bảy tại đây.' },
  }[lang] ?? { title: '🔔 645', body: 'Notifications are on.' };
}
