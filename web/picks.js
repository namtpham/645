/*
 * 645 — number suggestion engine (shared by the website and tools/analyze-picks.mjs).
 *
 * Lotto 6/45 draws are independent: every set of 6 numbers has the same 1-in-8,145,060 chance,
 * and no history can change that. What the analysis below does (and says so on the page):
 * • picks numbers using their past frequency, recent "hot" streaks and how overdue they are;
 * • keeps sets whose overall shape matches real winning draws (sum, odd/even, low/high,
 * consecutive numbers, spread over decades, repeats from last week);
 * • prefers sets other people are less likely to pick, so a win is shared with fewer people.
 * The score is how well a set matches those patterns, as a percentile of random sets.
 */
(function (root) {
  'use strict';
  const sum = (arr) => arr.reduce((a, b) => a + (+b || 0), 0);

  const TOTAL_COMBOS = 8145060;
  const RECENT_DRAWS = 52;

  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function comboFeatures(nums, prev) {
    const s = [...nums].sort((a, b) => a - b), total = sum(s);
    return {
      sum: Math.min(26, Math.floor(total / 10)),
      odd: s.filter((n) => n % 2).length,
      low: s.filter((n) => n <= 22).length,
      consec: s.filter((n, i) => i && n - s[i - 1] === 1).length,
      decades: new Set(s.map((n) => Math.floor((n - 1) / 10))).size,
      repeat: prev ? s.filter((n) => prev.includes(n)).length : 0,
      total,
    };
  }
  const FEATURE_KEYS = ['sum', 'odd', 'low', 'consec', 'decades', 'repeat'];

  /** What past draws (oldest first) say about numbers and about the shape of winning sets. */
  function drawStats(history) {
    const N = history.length, freq = Array(46).fill(0), recent = Array(46).fill(0), lastSeen = Array(46).fill(-1);
    const feat = Object.fromEntries(FEATURE_KEYS.map((k) => [k, {}]));
    const seen = new Set();
    history.forEach((d, i) => {
      for (const n of d.numbers) { freq[n]++; if (i >= N - RECENT_DRAWS) recent[n]++; lastSeen[n] = i; }
      const f = comboFeatures(d.numbers, history[i - 1]?.numbers);
      for (const k of FEATURE_KEYS) feat[k][f[k]] = (feat[k][f[k]] || 0) + 1;
      seen.add([...d.numbers].sort((a, b) => a - b).join(','));
    });
    const gap = lastSeen.map((v) => (v < 0 ? N : N - 1 - v));
    const avg = (a) => sum(a.slice(1)) / 45 || 1;
    const mf = avg(freq), mr = avg(recent), mg = avg(gap);
    // number weight: overall frequency + recent streak + how overdue it is
    const w = Array(46).fill(0);
    for (let n = 1; n <= 45; n++) w[n] = 0.45 * (freq[n] / mf) + 0.35 * (recent[n] / mr) + 0.2 * Math.min(3, gap[n] / mg);
    const wSum = sum(w), p = w.map((x) => x / wSum);
    const byRecent = [...Array(45)].map((_, i) => i + 1).sort((a, b) => recent[b] - recent[a] || freq[b] - freq[a]);
    const byGap = [...Array(45)].map((_, i) => i + 1).sort((a, b) => gap[b] - gap[a]);
    return { N, freq, recent, gap, feat, p, seen, last: history[N - 1], hot: byRecent.slice(0, 10), cold: byRecent.slice(-8).reverse(), overdue: byGap.slice(0, 8) };
  }

  function featLogP(st, k, v) {
    const counts = st.feat[k], keys = Object.keys(counts).length + 1;
    return Math.log(((counts[v] || 0) + 1) / (st.N + keys));
  }

  /** Higher = closer to the shape of past winning sets, better-weighted numbers, less popular. */
  function scoreCombo(nums, st) {
    const f = comboFeatures(nums, st.last?.numbers);
    let s = 0;
    for (const k of FEATURE_KEYS) s += featLogP(st, k, f[k]);
    for (const n of nums) s += 0.6 * Math.log(45 * st.p[n]);
    // fewer people pick these → a win is shared less
    const high = nums.filter((n) => n >= 32).length;
    s += high === 0 ? -0.8 : high === 1 ? -0.25 : 0;
    const d = [...nums].sort((a, b) => a - b), diffs = d.slice(1).map((x, i) => x - d[i]);
    if (diffs.every((x) => x === diffs[0])) s -= 2.5;              // 1-2-3-4-5-6, 5-10-15-…
    if (diffs.some((x, i) => x === 1 && diffs[i + 1] === 1)) s -= 0.5;
    if (st.seen.has(d.join(','))) s -= 3;                           // a past winning set people copy
    return s;
  }

  function weightedSet(rng, p) {
    const out = [];
    while (out.length < 6) {
      let r = rng() * sum(p.filter((_, n) => n && !out.includes(n))), n = 0;
      for (n = 1; n <= 45; n++) { if (out.includes(n)) continue; r -= p[n]; if (r <= 0) break; }
      out.push(Math.min(n, 45));
    }
    return out.sort((a, b) => a - b);
  }

  function randomSet(rng) {
    const out = new Set();
    while (out.size < 6) out.add(1 + Math.floor(rng() * 45));
    return [...out].sort((a, b) => a - b);
  }

  /** Ranked suggestions: varied sets (at most 2 numbers in common) with their score and reasons. */
  function suggestSets(history, { seed = 1, count = 10, candidates = 12000, reference = 3000 } = {}) {
    const st = drawStats(history), rng = mulberry32(seed);
    const ref = Array.from({ length: reference }, () => scoreCombo(randomSet(rng), st)).sort((a, b) => a - b);
    const pct = (s) => { let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < s) lo = m + 1; else hi = m; } return lo / ref.length * 100; };
    const cand = new Map();
    for (let i = 0; i < candidates; i++) { const c = weightedSet(rng, st.p); cand.set(c.join(','), c); }
    const ranked = [...cand.values()].map((nums) => ({ nums, score: scoreCombo(nums, st) })).sort((a, b) => b.score - a.score);
    // varied sets: at most 2 numbers in common, and no number in more than 3 of every 10 sets
    const picks = [], used = Array(46).fill(0);
    for (const c of ranked) {
      const cap = 3 * Math.ceil((picks.length + 1) / 10);
      if (c.nums.some((n) => used[n] >= cap)) continue;
      if (picks.some((p) => p.nums.filter((n) => c.nums.includes(n)).length > 2)) continue;
      picks.push(c);
      c.nums.forEach((n) => used[n]++);
      if (picks.length >= count) break;
    }
    // "fit": 0 = a typical random set, 100 = the best set found this week
    const median = ref[ref.length >> 1] ?? 0, best = picks[0]?.score ?? 1;
    return { st, picks: picks.map((c) => ({ ...c, percentile: pct(c.score),
      fit: Math.max(0, Math.min(100, 100 * (c.score - median) / (best - median || 1))), reasons: pickReasons(c.nums, st) })) };
  }

  function pickReasons(nums, st) {
    const f = comboFeatures(nums, st.last?.numbers), out = [];
    const sumP = (st.feat.sum[f.sum] || 0) / st.N;
    out.push(`Sum ${f.total}${sumP >= 0.08 ? ' · typical' : sumP < 0.03 ? ' · unusual' : ''}`);
    out.push(`${f.odd} odd · ${6 - f.odd} even`);
    out.push(`${f.low} low · ${6 - f.low} high`);
    const hot = nums.filter((n) => st.hot.includes(n)), od = nums.filter((n) => st.overdue.includes(n));
    if (hot.length) out.push(`🔥 hot: ${hot.join(', ')}`);
    if (od.length) out.push(`⏳ overdue: ${od.slice(0, 3).map((n) => `${n} (${st.gap[n]} draws)`).join(', ')}`);
    out.push(f.repeat ? `${f.repeat} from last draw` : 'none from last draw');
    const high = nums.filter((n) => n >= 32).length;
    if (high >= 2) out.push(`${high} numbers above 31 — fewer people pick these`);
    return out;
  }

  /** Replay the last `n` draws: suggestions made only from earlier draws vs random sets. */
  function backtest(history, n = 100, perDraw = 5) {
    const res = { draws: 0, games: 0, matches: 0, hit3: 0, rGames: 0, rMatches: 0, rHit3: 0 };
    const rng = mulberry32(12345);
    for (let i = Math.max(150, history.length - n); i < history.length; i++) {
      const past = history.slice(0, i), actual = history[i].numbers;
      const { picks } = suggestSets(past, { seed: history[i].round, count: perDraw, candidates: 800, reference: 1 });
      for (const p of picks) { const m = p.nums.filter((x) => actual.includes(x)).length; res.games++; res.matches += m; res.hit3 += m >= 3; }
      for (let k = 0; k < perDraw; k++) { const m = randomSet(rng).filter((x) => actual.includes(x)).length; res.rGames++; res.rMatches += m; res.rHit3 += m >= 3; }
      res.draws++;
    }
    return res;
  }

  const api = { TOTAL_COMBOS, RECENT_DRAWS, mulberry32, comboFeatures, drawStats, scoreCombo, randomSet, weightedSet, suggestSets, pickReasons, backtest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PicksEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
