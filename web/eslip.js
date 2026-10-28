/**
 * Mobile-slip QR payloads for Lotto 6/45 (MSG_ESLIP), as made by third-party slip apps:
 *
 *   MSG_ESLIP{10645}{(5,M:081114233145,M:…)(1,M:…)}{}6B|
 *
 * - each game: its 6 numbers sorted, two digits each, after "M:" (manual pick)
 * - games go in slips of up to 5: "(count,M:…,M:…)", slips written one after another
 * - checksum: CRC-8 (poly 0x07, init 0x00, no reflection, no final XOR) over the ASCII text from
 *   "MSG_ESLIP" up to and including the empty "{}", as two upper-case hex digits, then "|"
 *
 * Reproduces the checksums of the known samples (6B for 11 games, 9E for 4 games); every other
 * CRC-8 variant and input boundary tried gives different values. Whether a shop terminal accepts
 * a code is a separate question this file can't answer.
 * Used by app.js; also loads in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const PREFIX = 'MSG_ESLIP{10645}';
  const MAX_GAMES = 20;
  const PER_SLIP = 5;

  function crc8(text) {
    let c = 0;
    for (let i = 0; i < text.length; i++) {
      c ^= text.charCodeAt(i) & 0xff;
      for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c.toString(16).toUpperCase().padStart(2, '0');
  }

  function checkGame(nums) {
    if (!Array.isArray(nums) || nums.length !== 6) throw new Error('A game needs exactly 6 numbers.');
    const s = nums.map(Number);
    if (s.some((n) => !Number.isInteger(n) || n < 1 || n > 45)) throw new Error('Numbers go from 1 to 45.');
    if (new Set(s).size !== 6) throw new Error('The 6 numbers of a game must be different.');
    return [...s].sort((a, b) => a - b);
  }

  const encodeGame = (nums) => 'M:' + checkGame(nums).map((n) => String(n).padStart(2, '0')).join('');

  /** Full QR text for 1–20 games (each an array of 6 numbers, any order). */
  function eslipPayload(games) {
    if (!games.length) throw new Error('No games to put in the QR code.');
    if (games.length > MAX_GAMES) throw new Error(`One QR code holds at most ${MAX_GAMES} games.`);
    let slips = '';
    for (let i = 0; i < games.length; i += PER_SLIP) {
      const part = games.slice(i, i + PER_SLIP);
      slips += `(${part.length},${part.map(encodeGame).join(',')})`;
    }
    const body = `${PREFIX}{${slips}}{}`;
    return body + crc8(body) + '|';
  }

  /** Split many games into QR codes of at most 20 games each. */
  function eslipPayloads(games) {
    const out = [];
    for (let i = 0; i < games.length; i += MAX_GAMES) out.push(eslipPayload(games.slice(i, i + MAX_GAMES)));
    return out;
  }

  /** Read a payload back: its games, and whether its format and checksum are right. */
  function parseEslip(text) {
    const t = String(text).trim();
    const m = t.match(/^(MSG_ESLIP\{10645\}\{((?:\(\d+(?:,M:\d{12})+\))+)\}\{\})([0-9A-Fa-f]{2})\|$/);
    if (!m) return { ok: false, error: 'Not a Lotto 6/45 mobile slip (MSG_ESLIP) code.', games: [] };
    const games = [], problems = [];
    for (const [, count, list] of m[2].matchAll(/\((\d+),((?:M:\d{12},?)+)\)/g)) {
      const slip = list.split(',').map((g) => g.slice(2).match(/\d\d/g).map(Number));
      if (+count !== slip.length) problems.push(`a slip says ${count} games but holds ${slip.length}`);
      if (slip.length > PER_SLIP) problems.push(`a slip holds ${slip.length} games (more than ${PER_SLIP})`);
      games.push(...slip);
    }
    const want = crc8(m[1]), got = m[3].toUpperCase();
    if (got !== want) problems.push(`checksum ${got}, expected ${want}`);
    return { ok: !problems.length, problems, games, checksum: got, expected: want };
  }

  const api = { PREFIX, MAX_GAMES, PER_SLIP, crc8, encodeGame, eslipPayload, eslipPayloads, parseEslip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Eslip = api;
})(typeof window !== 'undefined' ? window : globalThis);
