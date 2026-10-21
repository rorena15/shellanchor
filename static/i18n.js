'use strict';
/* 화면 언어: 한국어 원문을 키로 쓰는 사전 번역(사전: i18n-en.js). 사전에 없는 문구는 원문 그대로 나온다.
   L('원문 {x}', { x })  — JS 에서 만드는 문구
   translateDom(el)      — HTML 의 고정 문구(글자·title·placeholder). index.html 은 불러올 때 한 번 */

// 'auto' 면 브라우저 언어(ko* → 한국어, 그 외 → 영어). 다른 스크립트보다 먼저 실행되므로 store 대신 직접 읽는다
const LANG = (() => {
  let pref = 'auto';
  try { pref = JSON.parse(localStorage.getItem('webssh.lang')) || 'auto'; } catch {}
  if (pref !== 'auto') return pref;
  return (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
})();
const I18N = LANG === 'en' ? I18N_EN : {};
document.documentElement.lang = LANG;

function L(s, vars) {
  const r = I18N[s] ?? s;
  return vars ? r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : r;
}

function translateDom(root = document.body) {
  if (LANG === 'ko') return;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n; (n = walk.nextNode());) {
    const en = I18N[norm(n.nodeValue)];
    if (en) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), en);   // 앞뒤 공백(띄어쓰기)은 유지
  }
  for (const el of [root, ...root.querySelectorAll('[title], [placeholder], [aria-label]')]) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      const en = v && I18N[norm(v)];
      if (en) el.setAttribute(a, en);
    }
  }
}
translateDom();
