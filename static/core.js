'use strict';
/* 공통: 유틸, 서버 API(/api), 비밀번호 캐시, 호스트 키 확인, 컨텍스트 메뉴 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const TOKEN = new URLSearchParams(location.search).get('t');
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
function wsUrl(path, q = {}) {
  const p = new URLSearchParams(q);
  if (TOKEN) p.set('t', TOKEN);
  const qs = p.toString();
  return WS_BASE + path + (qs ? '?' + qs : '');
}

const store = {   // 브라우저별 편의 설정 (글자 크기, 펼친 폴더 등)
  get(k, d) { try { return JSON.parse(localStorage.getItem('webssh.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('webssh.' + k, JSON.stringify(v)); } catch {} },
};

function toast(msg, ms = 1600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t * 1000), z = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
}

// 대상 문자열: user@host[:port]
function parseTarget(s) {
  const m = (s || '').trim().match(/^([^@\s]+)@(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1], host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? +m[3] : 22 };
}
const targetStr = (p) => `${p.username ? p.username + '@' : ''}${p.host}${p.port && +p.port !== 22 ? ':' + p.port : ''}`;

// ── 서버 API ─────────────────────────────────────────────
let DB = { folders: [], sessions: [], tunnels: [] };   // data/sessions.json
let SETTINGS = {};
let CAPS = { local: false, shells: [], rdp: false };
let LOGDIR = '';

const api = {
  ws: null, n: 0, pending: new Map(), handlers: {}, readyResolve: null,
  ready: null,
  connect() {
    this.ready = new Promise((r) => { this.readyResolve = r; });
    const ws = this.ws = new WebSocket(wsUrl('/api'));
    ws.onopen = () => {
      this.readyResolve();
      if (this.opened) this.onReopen?.();      // 서버 재시작 후 다시 붙으면 데이터 새로 읽기
      this.opened = true;
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) { const e = new Error(m.error); e.code = m.code; rej(e); } else res(m);
        return;
      }
      if (m.type === 'hostkey') {
        askHostKey(m).then((ok) => ws.send(JSON.stringify({ op: 'hostkey_reply', qid: m.qid, accept: ok })));
        return;
      }
      (this.handlers[m.type] || []).forEach((f) => f(m));
    };
    ws.onclose = () => {
      for (const { rej } of this.pending.values()) rej(new Error('서버 연결이 끊어졌습니다'));
      this.pending.clear();
      if (this.stopped) {
        $('#sbText').textContent = '서버를 종료했습니다. 이 창을 닫으세요.';
        return;
      }
      $('#sbText').textContent = '⚠ 중계 서버와 연결이 끊어졌습니다 — 서버를 다시 실행하세요 (자동 재연결 시도 중)';
      setTimeout(() => this.connect(), 3000);
    };
  },
  async call(op, args = {}) {
    await this.ready;
    const id = ++this.n;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, op, ...args }));
    });
  },
  on(type, f) { (this.handlers[type] ||= []).push(f); },
};

function saveDB() {
  return api.call('saveData', { data: DB }).catch((e) => toast('저장 실패: ' + e.message, 3000));
}
const findSession = (id) => DB.sessions.find((s) => s.id === id);

// ── 비밀번호 / 키 암호 (저장하지 않음, 탭이 열린 동안만 메모리) ──────
const SECRETS = new Map();
const credKey = (c) => `${c.username}@${c.host}:${c.port || 22}`;

/** spec(SSH 세션)에 필요한 비밀값을 모아 반환. 취소하면 null.
 *  ask: {password: 'target'|'jump', passphrase: 'target'|'jump'} — 실패 후 다시 묻기 */
async function ensureSecrets(spec, ask = {}) {
  const hops = [['target', spec]];
  if (spec.jump?.host) hops.unshift(['jump', spec.jump]);
  const fields = [];
  for (const [which, c] of hops) {
    const cache = SECRETS.get(credKey(c)) || {};
    const label = which === 'jump' ? `점프 호스트 ${targetStr(c)}` : targetStr(c);
    if ((c.auth || 'password') === 'password' && (cache.password == null || ask.password === which)) {
      fields.push({ which, key: 'password', label: `${label} 비밀번호` });
    }
    if (ask.passphrase === which) fields.push({ which, key: 'passphrase', label: `${label} 개인키 암호` });
  }
  if (fields.length) {
    const vals = await promptSecrets(fields, spec.name || targetStr(spec));
    if (!vals) return null;
    for (const [which, c] of hops) {
      const k = credKey(c);
      const cache = { ...(SECRETS.get(k) || {}) };
      for (const f of fields.filter((f) => f.which === which)) cache[f.key] = vals[`${which}.${f.key}`];
      if (vals.remember) SECRETS.set(k, cache); else c._oneShot = cache;
    }
  }
  const get = (c) => { const v = c._oneShot || SECRETS.get(credKey(c)) || {}; delete c._oneShot; return v; };
  const t = get(spec), j = spec.jump?.host ? get(spec.jump) : {};
  return { password: t.password, passphrase: t.passphrase, jumpPassword: j.password, jumpPassphrase: j.passphrase };
}

function forgetSecret(c, key) {
  const k = credKey(c), v = SECRETS.get(k);
  if (v) { delete v[key]; }
}

function promptSecrets(fields, title) {
  const dlg = $('#secretDlg');
  $('#secTitle').textContent = title;
  const box = $('#secFields');
  box.innerHTML = '';
  for (const f of fields) {
    const l = document.createElement('label');
    l.textContent = f.label;
    const i = document.createElement('input');
    i.type = 'password';
    i.name = `${f.which}.${f.key}`;
    l.appendChild(i);
    box.appendChild(l);
  }
  dlg.returnValue = '';
  dlg.showModal();
  box.querySelector('input')?.focus();
  return new Promise((res) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return res(null);
      const vals = { remember: $('#secRemember').checked };
      $$('input', box).forEach((i) => { vals[i.name] = i.value; i.value = ''; });
      res(vals);
    }, { once: true });
  });
}

// ── 호스트 키 확인 (여러 요청이 와도 하나씩) ─────────────────
const hostkeyQueue = [];
function askHostKey(m) {
  return new Promise((res) => {
    hostkeyQueue.push({ m, res });
    if (hostkeyQueue.length === 1) showNextHostKey();
  });
}
function showNextHostKey() {
  const item = hostkeyQueue[0];
  if (!item) return;
  const dlg = $('#hostkeyDlg');
  $('#hkHost').textContent = item.m.host;
  $('#hkFp').textContent = `${item.m.keytype}  ${item.m.fingerprint}`;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    hostkeyQueue.shift();
    item.res(dlg.returnValue === 'yes');
    showNextHostKey();
  }, { once: true });
}

// ── 컨텍스트 메뉴 ────────────────────────────────────────
function showMenu(x, y, items) {
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = it.hint; b.appendChild(h); }
    if (it.danger) b.classList.add('danger');
    b.disabled = !!it.disabled;
    b.onclick = () => { hideMenu(); it.action(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
}
function hideMenu() { $('#ctxMenu').hidden = true; }
addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) hideMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
addEventListener('blur', hideMenu);

// 폼에서 Enter를 누르면 브라우저는 '첫 번째' 제출 버튼을 누른다 → 취소가 앞에 있으면 Enter = 취소가 됨.
// 기본(파란) 버튼이 아닌 버튼은 제출 버튼에서 빼서, Enter는 항상 기본 버튼으로 가게 한다.
$$('dialog form[method=dialog] button[value]:not(.primary)').forEach((b) => {
  b.type = 'button';
  b.addEventListener('click', () => b.closest('dialog').close(b.value));
});

// 대화상자 열고 닫힐 때까지 대기 → returnValue
function dialogResult(dlg) {
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
}
