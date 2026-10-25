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

  // How much more (+) or less (−) often other players pick each number, on a log scale
  // (+0.03 ≈ 3 % more people share a prize won with it). Measured from 5등 winner counts vs
  // tickets sold in draws #1–#1247 by tools/analyze-picks.mjs; re-run the "Analyze picks"
  // workflow to refresh. Fitted on the first half of history it predicted the second half
  // (correlation 0.43), and the most popular fifth of winning sets had ~15 % more 1등 winners.
  const POPULARITY = [0, 0.013, -0.014, 0.006, 0.016, 0.017, 0.004, 0.011, 0.006, 0.031, 0.009, 0.044, 0.028, 0.009,
    -0.005, -0.022, -0.009, 0.007, 0.005, 0.011, 0.015, -0.005, 0.009, -0.016, 0.026, -0.011, -0.014, 0.013, 0.015, -0.025,
    -0.02, 0.009, -0.01, 0.013, 0.017, -0.011, -0.031, -0.025, -0.002, -0.016, -0.015, -0.006, -0.021, -0.032, -0.024, 0.001];
  // Tested out of sample (tools/analyze-picks.mjs): 25 puts the top picks around the 32nd popularity
  // percentile of random sets while keeping their shape close to typical winning draws.
  const POP_WEIGHT = 25;

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

  const popularityOf = (nums, pop = POPULARITY) => nums.reduce((a, n) => a + pop[n], 0);
  let _popRef = null;
  /** Share of random sets that are less popular than this one (0–100). */
  function popPercentile(nums) {
    if (!_popRef) { const r = mulberry32(31); _popRef = Array.from({ length: 20000 }, () => popularityOf(randomSet(r))).sort((a, b) => a - b); }
    const x = popularityOf(nums);
    let lo = 0, hi = _popRef.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (_popRef[m] < x) lo = m + 1; else hi = m; }
    return lo / _popRef.length * 100;
  }

  /** Higher = closer to the shape of past winning sets, better-weighted numbers, less popular. */
  function scoreCombo(nums, st, { pop = POPULARITY, wPop = POP_WEIGHT } = {}) {
    const f = comboFeatures(nums, st.last?.numbers);
    let s = 0;
    for (const k of FEATURE_KEYS) s += featLogP(st, k, f[k]);
    for (const n of nums) s += 0.6 * Math.log(45 * st.p[n]);
    // numbers other players pick less → a win is shared with fewer people (measured, see POPULARITY)
    s -= wPop * popularityOf(nums, pop);
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
  function suggestSets(history, { seed = 1, count = 10, candidates = 12000, reference = 3000, pop = POPULARITY, wPop = POP_WEIGHT } = {}) {
    const st = drawStats(history), rng = mulberry32(seed), so = { pop, wPop };
    const ref = Array.from({ length: reference }, () => scoreCombo(randomSet(rng), st, so)).sort((a, b) => a - b);
    const pct = (s) => { let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < s) lo = m + 1; else hi = m; } return lo / ref.length * 100; };
    const cand = new Map();
    for (let i = 0; i < candidates; i++) { const c = weightedSet(rng, st.p); cand.set(c.join(','), c); }
    const ranked = [...cand.values()].map((nums) => ({ nums, score: scoreCombo(nums, st, so) })).sort((a, b) => b.score - a.score);
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
    const pp = popPercentile(nums);
    if (pp <= 40) out.push(`👥 less picked than ${Math.round(100 - pp)}% of sets — a win is shared less`);
    else if (pp >= 70) out.push(`👥 popular numbers — a win may be shared more`);
    return out;
  }

  /**
   * Suggest only `k` numbers (1–6) for players who choose the rest themselves.
   * `fixed`: numbers the player already chose (0–5). If fixed + k = 6 the set is complete and is
   * scored like any set; otherwise each suggestion is scored as the average over many random
   * ways of filling the remaining slots, i.e. how good these numbers are whatever the player adds.
   */
  function suggestPartial(history, { fixed = [], k = 3, seed = 1, count = 10, candidates = 5000, samples = 20, pop = POPULARITY, wPop = POP_WEIGHT } = {}) {
    const st = drawStats(history), rng = mulberry32(seed), so = { pop, wPop };
    fixed = [...new Set(fixed)].filter((n) => n >= 1 && n <= 45).slice(0, 5);
    k = Math.max(1, Math.min(6 - fixed.length, k));
    const open = 6 - fixed.length - k;
    // the same random fillings for every candidate, so scores are comparable
    const fills = Array.from({ length: open ? samples : 1 }, () => Array.from({ length: 45 }, () => rng()));
    const evaluate = (part) => {
      const base = [...fixed, ...part];
      if (!open) return scoreCombo(base, st, so);
      let total = 0;
      for (const f of fills) {
        const rest = [...Array(45)].map((_, i) => i + 1).filter((n) => !base.includes(n)).sort((x, y) => f[x - 1] - f[y - 1]).slice(0, open);
        total += scoreCombo([...base, ...rest], st, so);
      }
      return total / fills.length;
    };
    const pool = st.p.map((w, n) => (fixed.includes(n) ? 0 : w));
    const cand = new Map();
    for (let i = 0; i < candidates && cand.size < candidates; i++) {
      const c = weightedSet(rng, pool).slice(0, 6).filter((n) => !fixed.includes(n));
      const part = c.sort(() => rng() - 0.5).slice(0, k).sort((x, y) => x - y);
      if (part.length === k) cand.set(part.join(','), part);
    }
    const scored = [...cand.values()].slice(0, open ? 1500 : candidates).map((part) => ({ part, score: evaluate(part) }))
      .sort((x, y) => y.score - x.score);
    const ref = Array.from({ length: 300 }, () => {
      const r = [...Array(45)].map((_, i) => i + 1).filter((n) => !fixed.includes(n)).sort(() => rng() - 0.5).slice(0, k);
      return evaluate(r);
    }).sort((x, y) => x - y);
    // varied: k ≤ 2 → never the same suggestion twice; k ≥ 3 → at most 2 in common; each number in ≤ 3 of 10
    const maxCommon = k <= 2 ? k - 1 : 2, picks = [], used = Array(46).fill(0);
    for (const c of scored) {
      const cap = k === 1 ? 1 : 3 * Math.ceil((picks.length + 1) / 10);
      if (c.part.some((n) => used[n] >= cap)) continue;
      if (picks.some((p) => p.part.filter((n) => c.part.includes(n)).length > maxCommon)) continue;
      picks.push(c);
      c.part.forEach((n) => used[n]++);
      if (picks.length >= count) break;
    }
    const median = ref[ref.length >> 1], best = picks[0]?.score ?? 1;
    const below = (x) => ref.filter((r) => r < x).length / ref.length * 100;
    return {
      st, fixed, k, open,
      picks: picks.map((c) => ({
        part: c.part, nums: [...fixed, ...c.part].sort((x, y) => x - y), score: c.score, percentile: below(c.score),
        fit: Math.max(0, Math.min(100, 100 * (c.score - median) / (best - median || 1))),
        reasons: open ? partReasons(c.part, st) : pickReasons([...fixed, ...c.part], st),
      })),
    };
  }

  function partReasons(part, st) {
    const out = [];
    const hot = part.filter((n) => st.hot.includes(n)), od = part.filter((n) => st.overdue.includes(n));
    if (hot.length) out.push(`🔥 hot: ${hot.join(', ')}`);
    if (od.length) out.push(`⏳ overdue: ${od.map((n) => `${n} (${st.gap[n]} draws)`).join(', ')}`);
    const low = part.filter((n) => POPULARITY[n] < -0.01), popular = part.filter((n) => POPULARITY[n] > 0.015);
    if (low.length) out.push(`👥 less picked: ${low.join(', ')}`);
    if (popular.length) out.push(`👥 popular: ${popular.join(', ')}`);
    out.push(`drawn ${part.map((n) => `${n}: ${st.recent[n]}×`).join(', ')} in the last ${RECENT_DRAWS} draws`);
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

  const api = { POPULARITY, POP_WEIGHT, popularityOf, popPercentile, TOTAL_COMBOS, RECENT_DRAWS, mulberry32, comboFeatures, drawStats, scoreCombo, randomSet, weightedSet, suggestSets, suggestPartial, pickReasons, backtest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PicksEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
