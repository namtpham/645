// Checks the mobile-slip QR encoder (web/eslip.js) against known payloads from a third-party
// slip app, and prints random cases to type into that app and compare.
//   node tools/eslip-check.mjs [number of random cases] [seed]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const E = require('../web/eslip.js');
const { mulberry32 } = require('../web/picks.js');

const KNOWN = [
  { games: [[8, 11, 23, 14, 31, 45], [16, 44, 18, 33, 12, 2], [13, 15, 16, 17, 22, 26], [2, 4, 6, 8, 10, 12], [13, 16, 17, 22, 24, 39],
      [14, 16, 18, 31, 44, 45], [2, 12, 13, 15, 16, 33], [2, 12, 17, 22, 26, 33], [13, 15, 16, 17, 22, 26], [2, 4, 6, 8, 10, 12], [13, 16, 17, 22, 24, 39]],
    payload: 'MSG_ESLIP{10645}{(5,M:081114233145,M:021216183344,M:131516172226,M:020406081012,M:131617222439)(5,M:141618314445,M:021213151633,M:021217222633,M:131516172226,M:020406081012)(1,M:131617222439)}{}6B|' },
  { games: [[31, 45, 16, 44, 18, 33], [12, 2, 13, 16, 15, 17], [22, 26, 2, 4, 6, 8], [10, 12, 13, 16, 17, 22]],
    payload: 'MSG_ESLIP{10645}{(4,M:161831334445,M:021213151617,M:020406082226,M:101213161722)}{}9E|' },
];

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) fails++; };
for (const k of KNOWN) {
  const ours = E.eslipPayload(k.games);
  check(ours === k.payload, `${k.games.length} games → checksum ${ours.slice(-3, -1)} (known ${k.payload.slice(-3, -1)})`);
  check(E.parseEslip(k.payload).ok, `reads back ${k.games.length} games`);
}
const rng = mulberry32(+(process.argv[3] || 645));
const game = () => { const s = new Set(); while (s.size < 6) s.add(1 + Math.floor(rng() * 45)); return [...s]; };
for (let n = 1; n <= 20; n++) {
  const gs = Array.from({ length: n }, game), p = E.eslipPayload(gs), back = E.parseEslip(p);
  check(back.ok && E.eslipPayload(back.games) === p, `round trip, ${n} game${n > 1 ? 's' : ''}`);
}

const cases = +(process.argv[2] || 0);
for (let c = 1; c <= cases; c++) {
  const n = 1 + Math.floor(rng() * 20), gs = Array.from({ length: n }, game);
  console.log(`\nCase ${c}: ${n} game${n > 1 ? 's' : ''}`);
  gs.forEach((g, i) => console.log(`  ${String(i + 1).padStart(2)}. ${g.join(' ')}`));
  console.log(`  → ${E.eslipPayload(gs)}`);
}
process.exit(fails ? 1 : 0);
