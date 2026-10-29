/**
 * Languages: English (as written in the code), 한국어 and Tiếng Việt.
 *
 * The app writes its text in English; this file translates whatever appears on the page — text and
 * the placeholder / title / aria-label attributes — as it is drawn (a MutationObserver), using the
 * dictionary in i18n-dict.js. Lookup, in order:
 *   1. the exact text
 *   2. the text with its numbers replaced by {0}, {1}, … (the translation puts them back)
 *   3. patterns with {*} (any text, e.g. a name or a date) and {#} (a number); the translation
 *      refers to them in order as {*1}, {*2}, …
 * Anything not in the dictionary stays in English. The choice is kept on this device.
 */
(function () {
  'use strict';
  const LANGS = { en: 'English', ko: '한국어', vi: 'Tiếng Việt' };
  const LOCALES = { en: 'en-GB', ko: 'ko-KR', vi: 'vi-VN' };
  let lang = null;
  try { lang = localStorage.getItem('645-lang'); } catch { /* private mode */ }
  if (!LANGS[lang]) {
    const nav = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).slice(0, 2).toLowerCase());
    lang = nav.find((l) => LANGS[l]) || 'en';
  }

  const exact = new Map(), wild = [], bits = [];
  const col = { ko: 1, vi: 2 }[lang];
  if (col) {
    for (const row of window.I18N_DICT || []) {
      const [en, tr] = [row[0], row[col]];
      if (!tr) continue;
      if (en.startsWith('~')) bits.push([new RegExp(en.slice(1), 'g'), tr]);   // a small phrase inside longer text
      else if (/\{[*#]\}/.test(en)) {
        const re = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\\*\\\}/g, '(.+?)').replace(/\\\{#\\\}/g, '(\\{\\d+\\})');
        wild.push([new RegExp(`^${re}$`), tr, en.replace(/\{[*#]\}/g, '').length]);
      } else exact.set(en, tr);
    }
    wild.sort((a, b) => b[2] - a[2]);   // the most specific pattern (most fixed text) wins
  }

  /** The translation of one piece of text, or null when the dictionary has none. */
  function lookup(text, depth = 0) {
    if (!col || !/[A-Za-z]/.test(text)) return null;
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key) return null;
    if (exact.has(key)) return exact.get(key);
    const nums = [];
    const tpl = key.replace(/\d+(?:[,.:]\d+)*/g, (m) => `{${nums.push(m) - 1}}`);
    const fill = (s) => s.replace(/\{(\d+)\}/g, (_, i) => nums[+i] ?? '');
    if (exact.has(tpl)) return fill(exact.get(tpl));
    // what a {*} stands for can be a phrase of its own ("the last 52 draws"): translate it too
    const apply = (m, tr) => tr.replace(/\{\*(\d+)\}|\{(\d+)\}/g, (_, k, i) => {
      if (!k) return nums[+i] ?? '';
      const raw = fill(m[+k] ?? '');
      return (depth < 4 && lookup(raw, depth + 1)) || raw;
    });
    // first the patterns that cover a whole part, then "A · B · C" part by part, then the rest
    for (const [re, tr] of wild) {
      const m = tpl.match(re);
      if (m && !m.slice(1).some((c) => c.includes(' · '))) return apply(m, tr);
    }
    if (depth < 4 && key.includes(' · ')) {
      const parts = key.split(' · ').map((p) => lookup(p, depth + 1) ?? p);
      if (parts.join(' · ') !== key) return parts.join(' · ');
    }
    for (const [re, tr] of wild) {
      const m = tpl.match(re);
      if (m) return apply(m, tr);
    }
    // small phrases such as "(11 draws)" inside text that has no translation as a whole
    if (depth > 0 && bits.length) {
      let out = key;
      for (const [re, tr] of bits) out = out.replace(re, tr);
      if (out !== key) return out;
    }
    return null;
  }

  /** Translate a string (keeps the spaces around it), for code that builds text itself. */
  function t(text) {
    if (typeof text !== 'string') return text;
    const out = lookup(text);
    if (out == null) return text;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    return lead + out + trail;
  }

  // ── on the page
  const SKIP = 'script,style,code,textarea,.qr-text,svg,[data-no-i18n]';
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const doneText = new WeakMap(), doneAttr = new WeakMap();
  function textNode(n) {
    if (doneText.get(n) === n.data) return;
    const p = n.parentElement;
    if (!p || p.closest(SKIP)) return;
    const out = t(n.data);
    if (out !== n.data) n.data = out;
    doneText.set(n, n.data);
  }
  function attrs(el) {
    let seen = doneAttr.get(el);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || seen?.[a] === v) continue;
      const out = t(v);
      if (out !== v) el.setAttribute(a, out);
      (seen ||= {})[a] = out;
    }
    if (seen) doneAttr.set(el, seen);
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1 || root.closest?.(SKIP)) return;
    attrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) textNode(n);
      else if (n.closest(SKIP)) continue;
      else attrs(n);
    }
  }
  function start() {
    document.documentElement.lang = lang;
    if (!col) return;
    walk(document.body);
    document.title = t(document.title);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') textNode(m.target);
        else if (m.type === 'attributes') attrs(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    // the browser's own dialogs
    for (const fn of ['confirm', 'alert']) { const orig = window[fn].bind(window); window[fn] = (msg) => orig(t(String(msg))); }
    const origPrompt = window.prompt.bind(window);
    window.prompt = (msg, def) => origPrompt(t(String(msg)), def);
  }

  function setLang(l) {
    if (!LANGS[l] || l === lang) return;
    try { localStorage.setItem('645-lang', l); } catch { /* private mode */ }
    location.reload();
  }

  window.I18N = { lang, locale: LOCALES[lang], LANGS, t, setLang, start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
