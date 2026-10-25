#!/usr/bin/env node
// 645 — analysis of the number-suggestion engine against the real draw history.
//
//   node tools/analyze-picks.mjs history.json [--dump]
//
// history.json: the list dhlottery publishes (selectPstLt645Info.do?srchLtEpsd=all), either the
// raw response or just its data.list. Prints a Markdown report. --dump also prints one compact
// line per draw (round, date, numbers, bonus, winners and prize per rank, sales).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../web/picks.js');

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const out = [];
const say = (s = '') => out.push(s);

// ─── Load ──────────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const list = raw?.data?.list ?? raw?.list ?? raw;
const key = (d, re) => Object.keys(d).find((k) => re.test(k));
const num = (v) => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;
const draws = list.map((d) => {
  const k = (r, what) => key(d, new RegExp(`^rnk${r}Wn${what}$`, 'i'));
  return {
    round: Number(d.ltEpsd),
    date: String(d.ltRflYmd ?? ''),
    numbers: [1, 2, 3, 4, 5, 6].map((i) => Number(d[`tm${i}WnNo`])),
    bonus: Number(d.bnsWnNo),
    winners: [1, 2, 3, 4, 5].map((r) => num(d[k(r, 'Nope') ?? k(r, 'Cnt') ?? ''])),
    prize: [1, 2, 3, 4, 5].map((r) => num(d[k(r, 'Amt') ?? ''])),
    sales: num(d[key(d, /^wholEpsdSumNtslAmt$/i) ?? key(d, /ntsl.*amt/i) ?? '']),
  };
}).filter((d) => d.round > 0 && d.numbers.every((n) => n >= 1 && n <= 45)).sort((a, b) => a.round - b.round);

if (process.argv.includes('--dump')) {
  for (const d of draws) console.log(['D', d.round, d.date, d.numbers.join(','), d.bonus, d.winners.join(','), d.prize.join(','), d.sales].join('|'));
}

const N = draws.length;
say(`# Pick engine analysis — ${N} draws (#${draws[0].round}–#${draws[N - 1].round})`);
say();
say(`Fields in the data: ${Object.keys(list[0]).join(', ')}`);
say();

// ─── 1. Are the numbers drawn uniformly? ──────────────────────────────────────
const counts = Array(46).fill(0);
for (const d of draws) for (const n of d.numbers) counts[n]++;
const expected = N * 6 / 45;
const chi2 = sum(counts.slice(1).map((c) => (c - expected) ** 2 / expected));
// Wilson–Hilferty approximation for the chi-square upper tail
const chiP = (x, k) => { const z = (Math.cbrt(x / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k)); return 0.5 * erfc(z / Math.SQRT2); };
function erfc(x) { const t = 1 / (1 + 0.5 * Math.abs(x)); const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? y : 2 - y; }
say('## 1. Are all 45 numbers drawn equally often?');
say(`Chi-square = ${fmt(chi2, 1)} with 44 degrees of freedom, p = ${fmt(chiP(chi2, 44), 3)}. ` +
  `Most drawn: ${counts.map((c, n) => [n, c]).slice(1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join(', ')}; ` +
  `least: ${counts.map((c, n) => [n, c]).slice(1).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join(', ')}.`);
say(chiP(chi2, 44) > 0.05 ? '→ Consistent with a fair draw: the differences are the size chance produces.' : '→ Unusually uneven (p < 0.05) — worth a closer look.');
say();

// ─── 2. Do hot / cold / overdue numbers predict the next draw? ───────────────
say('## 2. Do hot, cold or overdue numbers predict the next draw?');
say('Walk forward through history: before each draw, take the 10 numbers a rule ranks highest, using only earlier draws, and count how many of the 6 winning numbers are among them. Chance alone gives 10 × 6 / 45 = 1.333.');
const START = 300;
const rules = {
  'hot (most drawn, last 52)': (st) => st.hot,
  'cold (least drawn, last 52)': (st) => [...Array(45)].map((_, i) => i + 1).sort((a, b) => st.recent[a] - st.recent[b]),
  'overdue (longest gap)': (st) => [...Array(45)].map((_, i) => i + 1).sort((a, b) => st.gap[b] - st.gap[a]),
  'most drawn all-time': (st) => [...Array(45)].map((_, i) => i + 1).sort((a, b) => st.freq[b] - st.freq[a]),
  "engine's number weight": (st) => [...Array(45)].map((_, i) => i + 1).sort((a, b) => st.p[b] - st.p[a]),
};
const hgVar = 10 * (6 / 45) * (39 / 45) * (35 / 44);
say('| rule | avg hits in top 10 | z vs chance |');
say('|---|---|---|');
const statsCache = [];
for (let i = START; i < N; i++) statsCache[i] = E.drawStats(draws.slice(0, i));
for (const [name, rank] of Object.entries(rules)) {
  const hits = [];
  for (let i = START; i < N; i++) { const top = rank(statsCache[i]).slice(0, 10); hits.push(draws[i].numbers.filter((n) => top.includes(n)).length); }
  const z = (mean(hits) - 10 * 6 / 45) / Math.sqrt(hgVar / hits.length);
  say(`| ${name} | ${fmt(mean(hits))} | ${fmt(z, 2)} |`);
}
say('→ |z| < 2 means no detectable effect.');
say();

// ─── 3. Shape of winning sets vs all possible sets ────────────────────────────
say('## 3. Do winning sets have an unusual shape?');
const rng = E.mulberry32(7);
const sim = {}, act = {};
const feats = ['sum', 'odd', 'low', 'consec', 'decades'];
for (const f of feats) { sim[f] = {}; act[f] = {}; }
const M = 400000;
for (let i = 0; i < M; i++) { const f = E.comboFeatures(E.randomSet(rng)); for (const k of feats) sim[k][f[k]] = (sim[k][f[k]] || 0) + 1; }
for (const d of draws) { const f = E.comboFeatures(d.numbers); for (const k of feats) act[k][f[k]] = (act[k][f[k]] || 0) + 1; }
say('Compare each feature of the real winning sets with its distribution over all possible sets (400,000 random sets):');
say('| feature | chi-square | df | p |');
say('|---|---|---|---|');
for (const f of feats) {
  let x = 0, df = -1;
  for (const v of Object.keys(sim[f])) { const e = sim[f][v] / M * N; if (e < 5) continue; x += ((act[f][v] || 0) - e) ** 2 / e; df++; }
  say(`| ${f} | ${fmt(x, 1)} | ${df} | ${fmt(chiP(x, df), 3)} |`);
}
say('→ Winning sets look exactly like random sets. "Typical shape" sets are common because there are more such combinations, not because each one is more likely.');
say();

// ─── 4. Backtest with real prizes ─────────────────────────────────────────────
say('## 4. Backtest: engine vs random sets, real prizes');
const BT = Math.min(500, N - START), PER = 10;
const prizeOf = (rank, d) => (rank ? d.prize[rank - 1] || [0, 2e9, 5.5e7, 1.45e6, 5e4, 5e3][rank] : 0);
const rankOf = (nums, d) => { const m = nums.filter((n) => d.numbers.includes(n)).length, b = nums.includes(d.bonus); return m === 6 ? 1 : m === 5 && b ? 2 : m === 5 ? 3 : m === 4 ? 4 : m === 3 ? 5 : 0; };
const res = { engine: { m: 0, h3: 0, won: 0, g: 0, ranks: [0, 0, 0, 0, 0, 0] }, random: { m: 0, h3: 0, won: 0, g: 0, ranks: [0, 0, 0, 0, 0, 0] } };
const rr = E.mulberry32(99);
for (let i = N - BT; i < N; i++) {
  const d = draws[i];
  const picks = E.suggestSets(draws.slice(0, i), { seed: d.round * 7919, count: PER, candidates: 2000, reference: 1 }).picks.map((p) => p.nums);
  for (const [who, sets] of [['engine', picks], ['random', Array.from({ length: PER }, () => E.randomSet(rr))]]) {
    for (const s of sets) {
      const r = rankOf(s, d), m = s.filter((n) => d.numbers.includes(n)).length;
      res[who].g++; res[who].m += m; res[who].h3 += m >= 3; res[who].won += prizeOf(r, d); res[who].ranks[r]++;
    }
  }
}
say(`Last ${BT} draws, ${PER} sets per draw each.`);
say('| | games | matched / game | 3+ matches | 4등 | 5등 | won | return per ₩1,000 |');
say('|---|---|---|---|---|---|---|---|');
for (const [who, r] of Object.entries(res)) {
  say(`| ${who} | ${r.g} | ${fmt(r.m / r.g)} | ${fmt(r.h3 / r.g * 100, 2)}% | ${r.ranks[4]} | ${r.ranks[5]} | ₩${Math.round(r.won).toLocaleString('en-US')} | ₩${Math.round(r.won / r.g).toLocaleString('en-US')} |`);
}
say('Theory for any set: 0.800 matched / game, 2.38% with 3+ matches, about ₩500 back per ₩1,000 on average.');
say();

// ─── 5. Number popularity from winner counts ──────────────────────────────────
say('## 5. Which numbers do people over-pick? (from 5등 / 4등 winner counts)');
const usable = draws.filter((d) => d.sales > 0 && d.winners[4] > 0);
if (usable.length < 200) {
  say('Not enough draws with sales and winner counts in the data — skipped.');
} else {
  // If tickets were spread evenly, 5등 winners ≈ tickets × 2.244 %. More winners = the drawn numbers were popular.
  const P5 = 20 * 9139 / 8145060, P4 = 15 * 741 / 8145060;
  const rows = usable.map((d) => {
    const tickets = d.sales / 1000;
    return { d, y: Math.log(d.winners[4] / (tickets * P5)), y4: d.winners[3] > 0 ? Math.log(d.winners[3] / (tickets * P4)) : null };
  });
  const fit = (rs) => ridge(rs.map((r) => indicator(r.d.numbers)), rs.map((r) => r.y), 5);
  const beta = fit(rows);
  const half = rows.length >> 1;
  const b1 = fit(rows.slice(0, half)), b2 = fit(rows.slice(half));
  const stable = corr(b1.slice(1), b2.slice(1));
  const order = [...Array(45)].map((_, i) => i + 1).sort((a, b) => beta[b] - beta[a]);
  say(`${usable.length} draws with sales and winner counts. For each, 5등 winners ÷ (tickets × 2.244 %) measures how popular the drawn numbers were; a regression splits that over the 45 numbers.`);
  const pctOf = (n) => `${n} (${(Math.exp(beta[n]) - 1) * 100 >= 0 ? '+' : ''}${fmt((Math.exp(beta[n]) - 1) * 100, 0)}%)`;
  say(`- Most over-picked: ${order.slice(0, 10).map(pctOf).join(', ')}`);
  say(`- Least picked: ${order.slice(-10).reverse().map(pctOf).join(', ')}`);
  say(`- Stable over time? Correlation between estimates from the first and second half of history: ${fmt(stable, 2)} (near 0 = noise, near 1 = a real habit).`);
  const feat = (nums) => [nums.filter((n) => n <= 31).length, nums.filter((n) => n <= 12).length, nums.filter((n) => n % 7 === 0).length, E.comboFeatures(nums).consec];
  const fb = ridge(rows.map((r) => [1, ...feat(r.d.numbers)]), rows.map((r) => r.y), 1);
  say(`- Per extra number ≤ 31 (birthdays): ${fmt((Math.exp(fb[1]) - 1) * 100, 1)}% more co-winners; per number ≤ 12 (months): ${fmt((Math.exp(fb[2]) - 1) * 100, 1)}%; per multiple of 7: ${fmt((Math.exp(fb[3]) - 1) * 100, 1)}%; per consecutive pair: ${fmt((Math.exp(fb[4]) - 1) * 100, 1)}%.`);
  // Does it matter for the jackpot? Popularity fitted on the older half vs 1등 winners in the newer half.
  const older = rows.slice(0, half), newer = rows.slice(half), bOld = fit(older);
  const P1 = 1 / 8145060;
  const scored = newer.map((r) => ({ pred: sum(r.d.numbers.map((n) => bOld[n])), w1: (r.d.winners[0] + 0.5) / (r.d.sales / 1000 * P1) })).sort((a, b) => a.pred - b.pred);
  const q = (k) => scored.slice(Math.floor(k * scored.length / 5), Math.floor((k + 1) * scored.length / 5));
  say(`- 1등 winners ÷ expected in the newer half, by popularity predicted from the older half (least → most popular fifth): ${[0, 1, 2, 3, 4].map((k) => fmt(mean(q(k).map((x) => x.w1)), 2)).join(' · ')}`);
  // how popular are the engine's picks compared with random sets?
  const popOf = (nums) => sum(nums.map((n) => beta[n]));
  const randPop = Array.from({ length: 20000 }, () => popOf(E.randomSet(rr))).sort((a, b) => a - b);
  const pctl = (x) => randPop.filter((r) => r < x).length / randPop.length * 100;
  const top = E.suggestSets(draws, { seed: 1, count: 20 }).picks.map((p) => pctl(popOf(p.nums)));
  say(`- The engine's current top 20 sets sit at the ${fmt(mean(top), 0)}th popularity percentile of random sets (50 = average; lower = shared less).`);
  console.log('\nPOPULARITY_BETA=' + JSON.stringify(beta.map((b) => Math.round(b * 1000) / 1000)));
}
say();

function indicator(nums) { const x = Array(46).fill(0); x[0] = 1; for (const n of nums) x[n] = 1; return x; }
function corr(a, b) { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); }
function ridge(X, y, lambda) {
  const p = X[0].length, A = Array.from({ length: p }, () => Array(p).fill(0)), v = Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) { if (!X[i][j]) continue; v[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  for (let j = 1; j < p; j++) A[j][j] += lambda;
  for (let c = 0; c < p; c++) {                       // Gauss–Jordan
    let m = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]]; [v[c], v[m]] = [v[m], v[c]];
    for (let r = 0; r < p; r++) { if (r === c || !A[r][c]) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < p; k++) A[r][k] -= f * A[c][k]; v[r] -= f * v[c]; }
  }
  return v.map((x, i) => x / A[i][i]);
}

console.log(out.join('\n'));
