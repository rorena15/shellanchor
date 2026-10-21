'use strict';
/* 탭·화면 분할·접속·자동 재접속·모니터링 바·로컬 터미널 */

let fontSize = store.get('fontSize', 15);
const tabs = [];                 // 열린 터미널 탭
let layout = store.get('layout', '1');
let cells = [];                  // 분할 칸마다 보여줄 탭
let focusIdx = 0;
const LAYOUT_N = { '1': 1, '2v': 2, '2h': 2, '4': 4 };
const RETRY = [3, 5, 10, 20, 30];


const focused = () => cells[focusIdx] || null;
const tabLabel = (s) => s.spec.name || (s.kind === 'local' ? shellName(s.spec.shell) : targetStr(s.spec));
const shellName = (id) => CAPS.shells.find((x) => x.id === id)?.name || id;

// ── 세션 열기 ────────────────────────────────────────────
function openSpec(spec) {
  if (spec.type === 'rdp') return launchRdp(spec);
  if (spec.type === 'local' && !CAPS.local) return toast(L('로컬 터미널은 서버가 127.0.0.1로 실행 중일 때만 쓸 수 있습니다'), 3000);
  if (!spec.quick) {
    const recent = store.get('recent', []).filter((x) => x !== spec.id);
    recent.unshift(spec.id);
    store.set('recent', recent.slice(0, 10));
    renderRecent();
  }
  openTab(spec);
}

async function launchRdp(spec) {
  try {
    let secrets = {};
    if (spec.gateway) {
      const gw = findSession(spec.gateway);
      if (!gw) return toast(L('게이트웨이 SSH 세션을 찾을 수 없습니다'), 3000);
      let ask = {};
      for (;;) {
        secrets = await ensureSecrets(gw, ask);
        if (!secrets) return;
        try {
          toast(L('SSH 게이트웨이 연결 중…'));
          const r = await api.call('rdp', { sid: spec.id, secrets });
          return toast(L('원격 데스크톱 실행 → {addr}', { addr: r.address }), 2500);
        } catch (e) {
          const [kind, which] = (e.code || '').split(':');
          if (kind === 'auth') { forgetSecret(which === 'jump' ? gw.jump : gw, 'password'); ask = { password: which }; toast(e.message, 2500); continue; }
          if (kind === 'passphrase') { ask = { passphrase: which }; continue; }
          throw e;
        }
      }
    }
    const r = await api.call('rdp', { sid: spec.id, secrets });
    toast(L('원격 데스크톱 실행 → {addr}', { addr: r.address }), 2500);
  } catch (e) {
    toast(L('RDP 실행 실패: {msg}', { msg: e.message }), 4000);
  }
}

function openTab(spec) {
  const s = {
    id: uid(), spec, kind: spec.type === 'local' ? 'local' : 'ssh',
    ws: null, sid: null, state: 'idle', sftp: null, mon: null, retryN: 0, retryTimer: null, ask: {},
  };
  s.tab = document.createElement('div');
  s.tab.className = 'tab';
  s.tab.innerHTML = `<span class="dot"></span><span class="label"></span><button class="x" title="${L('닫기')}">✕</button>`;
  s.tab.querySelector('.label').textContent = tabLabel(s);
  $('#tabs').appendChild(s.tab);

  s.pane = document.createElement('section');
  s.pane.className = 'pane';
  s.pane.innerHTML = `<div class="pane-title"></div><div class="term"></div>
    <div class="banner" hidden><span class="msg"></span><span class="grow"></span>
      <button class="re primary">${L('재접속 (R)')}</button><button class="cancel" hidden>${L('취소')}</button><button class="cl">${L('탭 닫기 (Enter)')}</button></div>`;
  s.pane.querySelector('.pane-title').textContent = tabLabel(s);
  $('#workspace').appendChild(s.pane);

  const term = s.term = new Terminal({
    fontFamily: 'D2Coding, "Cascadia Mono", Consolas, "Malgun Gothic", monospace',
    fontSize, theme: termTheme(), cursorBlink: true, scrollback: 10000,
    allowProposedApi: true, rightClickSelectsWord: false,
  });
  s.fit = new FitAddon.FitAddon();
  term.loadAddon(s.fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(s.pane.querySelector('.term'));
  s.hl = new Highlighter(term);
  tabs.push(s);

  // 복사·붙여넣기
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).then(() => toast(L('복사됨'), 800), () => {});
  });
  s.pane.querySelector('.term').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    try { const txt = await navigator.clipboard.readText(); if (txt) term.paste(txt); }
    catch { toast(L('클립보드 읽기 권한이 필요합니다')); }
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).then(() => toast(L('복사됨'), 800));
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard?.readText().then((t) => t && term.paste(t));
      return false;
    }
    if (globalShortcut(e)) return false;
    // 끊긴 탭: R = 재접속, Enter = 탭 닫기
    if (s.state === 'closed' || s.state === 'waiting') {
      if (e.code === 'KeyR' && !e.ctrlKey && !e.altKey) { reconnectNow(s); return false; }
      if (e.key === 'Enter') { closeTab(s, true); return false; }
    }
    return true;
  });

  term.onData((d) => {
    sendInput(s, new TextEncoder().encode(d));
    if (d.includes('\r')) s.cwdPending = true;       // 명령 실행 → 끝나면 SFTP 폴더 따라가기
  });
  term.onBinary((d) => sendInput(s, Uint8Array.from(d, (c) => c.charCodeAt(0))));
  term.onResize(({ cols, rows }) => sendCtl(s, { type: 'resize', cols, rows }));
  term.onTitleChange((t) => { s.tab.title = t; });

  new ResizeObserver(() => { if (cells.includes(s)) safeFit(s); }).observe(s.pane.querySelector('.term'));
  s.pane.addEventListener('pointerdown', () => { const i = cells.indexOf(s); if (i >= 0 && i !== focusIdx) setFocus(i); }, true);

  s.tab.onclick = () => show(s);
  s.tab.onauxclick = (e) => { if (e.button === 1) closeTab(s); };
  s.tab.oncontextmenu = (e) => { e.preventDefault(); tabMenu(s, e.clientX, e.clientY); };
  s.tab.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(s); };
  s.pane.querySelector('.re').onclick = () => reconnectNow(s);
  s.pane.querySelector('.cancel').onclick = () => { clearTimeout(s.retryTimer); s.retryTimer = null; setState(s, 'closed', L('자동 재접속 취소됨')); };
  s.pane.querySelector('.cl').onclick = () => closeTab(s);

  show(s);
  connect(s);
  return s;
}

const isOpen = (s) => s.ws?.readyState === WebSocket.OPEN && s.state === 'on';
function sendInput(s, bytes) { if (isOpen(s)) s.ws.send(bytes); }
function sendCtl(s, obj) { if (isOpen(s)) s.ws.send(JSON.stringify(obj)); }
function safeFit(s) { try { s.fit.fit(); } catch {} }

function setState(s, state, msg) {
  s.state = state;
  s.tab.querySelector('.dot').className = 'dot' + (state === 'on' ? ' on' : state === 'closed' || state === 'waiting' ? ' off' : '');
  const banner = s.pane.querySelector('.banner');
  banner.hidden = !(state === 'closed' || state === 'waiting');
  banner.querySelector('.cancel').hidden = state !== 'waiting';
  if (msg) banner.querySelector('.msg').textContent = msg;
  if (state !== 'on') { s.sid = null; s.mon = null; }
  s.sftp?.sessionChanged();
  if (focused() === s) { renderStatus(); updateToolbar(); }
}

async function connect(s) {
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (s.ws) { s.ws.onclose = null; s.ws.close(); }
  s.closedExit = undefined;
  setState(s, 'connecting');
  const p = s.spec;
  let first;
  if (s.kind === 'local') {
    first = { type: 'connect', shell: p.shell };
  } else {
    const secrets = await ensureSecrets(p, s.ask);
    s.ask = {};
    if (!secrets) { setState(s, 'closed', L('접속 취소됨')); return; }
    const hop = (c, pw, pp) => ({ host: c.host, port: c.port || 22, username: c.username, auth: c.auth || 'password',
                                   keyPath: c.keyPath || '', password: pw, passphrase: pp });
    first = {
      type: 'connect', ...hop(p, secrets.password, secrets.passphrase), encoding: p.encoding || 'utf-8',
      jump: p.jump?.host ? hop(p.jump, secrets.jumpPassword, secrets.jumpPassphrase) : null,
      log: { on: !!p.log, name: p.name || p.host }, monitor: SETTINGS.monitor && focused() === s,
    };
    s.term.write(`\r\n\x1b[90m${targetStr(p)}${p.jump?.host ? ' (via ' + targetStr(p.jump) + ')' : ''} ${L('접속 중...')}\x1b[0m\r\n`);
  }

  const ws = new WebSocket(wsUrl(s.kind === 'local' ? '/local' : '/ws'));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  let errorShown = false;

  ws.onopen = () => {
    safeFit(s);
    ws.send(JSON.stringify({ ...first, cols: s.term.cols, rows: s.term.rows }));
  };
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') {
      s.term.write(new Uint8Array(ev.data));
      if (s.cwdPending) {
        clearTimeout(s.cwdTimer);
        s.cwdTimer = setTimeout(() => { s.cwdPending = false; s.sftp?.followTerminal(); }, 400);
      }
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.type === 'connected') {
      s.sid = m.sid;
      s.retryN = 0;
      s.logPath = m.log;
      s.tab.title = m.log ? L('로그: {path}', { path: m.log }) : '';
      setState(s, 'on');
      if (s.kind === 'ssh') onSshConnected(s);
      if (focused() === s) s.term.focus();
    } else if (m.type === 'hostkey') {
      const ok = await askHostKey(m);
      ws.send(JSON.stringify({ type: 'hostkey_reply', accept: ok }));
    } else if (m.type === 'error') {
      errorShown = true;
      s.term.write(`\r\n\x1b[31m${m.message.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      const [kind, which] = (m.code || '').split(':');
      const hop = which === 'jump' ? p.jump : p;
      if (kind === 'auth' && (hop.auth || 'password') === 'password') {
        forgetSecret(hop, 'password');
        s.ask = { password: which };
        setState(s, 'closed', L('인증 실패'));
        setTimeout(() => connect(s), 50);           // 비밀번호 다시 묻기
      } else if (kind === 'passphrase') {
        s.ask = { passphrase: which };
        setState(s, 'closed', L('키 암호 필요'));
        setTimeout(() => connect(s), 50);
      } else {
        setState(s, 'closed', L('접속 실패'));
      }
    } else if (m.type === 'closed') {
      s.closedExit = m.exit;
      s.term.write(`\r\n\x1b[90m[${L('연결 종료')}${m.exit != null ? ` · exit ${m.exit}` : ''}]\x1b[0m\r\n`);
    } else if (m.type === 'monitor') {
      s.mon = m;
      if (focused() === s) renderStatus();
    } else if (m.type === 'notice') {
      toast(m.message, 3000);
    }
  };
  ws.onclose = (ev) => {
    if (s.ws !== ws) return;
    const wasOn = s.state === 'on';
    if (!errorShown && !wasOn) {
      s.term.write(`\r\n\x1b[31m${L('중계 서버에 연결할 수 없습니다')} (${ev.code}${ev.reason ? ' ' + ev.reason : ''})\x1b[0m\r\n`);
    }
    if (errorShown) return;
    // 사용자가 exit로 끝낸 경우(종료 코드 있음)는 재접속하지 않음 — 네트워크 끊김만 자동 재접속
    const dropped = wasOn && s.closedExit == null;
    if (dropped && s.kind === 'ssh' && s.spec.reconnect !== false && !api.stopped) scheduleReconnect(s);
    else setState(s, 'closed', s.closedExit != null ? L('세션 종료 (exit {code})', { code: s.closedExit }) : L('연결이 끊어졌습니다'));
  };
}

function scheduleReconnect(s) {
  const wait = RETRY[Math.min(s.retryN, RETRY.length - 1)];
  s.retryN++;
  let left = wait;
  const tick = () => {
    if (left <= 0) { connect(s); return; }
    setState(s, 'waiting', L('연결 끊김 — {sec}초 후 자동 재접속 ({n}번째)', { sec: left, n: s.retryN }));
    left--;
    s.retryTimer = setTimeout(tick, 1000);
  };
  tick();
}
function reconnectNow(s) { s.retryN = 0; connect(s); }

function onSshConnected(s) {
  if (!s.sftp) s.sftp = new SftpPanel(s);
  s.sftp.sessionChanged();
  if (focused() === s) {
    showSftpPanel();
    if (!store.get('sidebarCollapsed', false) && $('.side-tabs .on')?.dataset.side === 'sessions' && !s.autoSwitched) {
      s.autoSwitched = true;
      setSide('sftp');                               // 접속하면 SFTP 탭으로
    }
  }
  setTimeout(() => s.sftp?.followTerminal(true), 1200);
}

function closeTab(s, force) {
  if (!force && s.state === 'on' && !confirm(L('{name} 연결을 끊을까요?', { name: tabLabel(s) }))) return;
  clearTimeout(s.retryTimer);
  s.sftp?.destroy();
  if (s.ws) { s.ws.onclose = null; s.ws.close(); }
  s.term.dispose();
  s.tab.remove();
  s.pane.remove();
  const i = tabs.indexOf(s);
  tabs.splice(i, 1);
  const ci = cells.indexOf(s);
  if (ci >= 0) {
    cells[ci] = tabs.find((t) => !cells.includes(t)) || null;   // 빈 칸은 숨겨진 탭으로 채움
  }
  renderLayout();
}

// ── 화면 분할 ───────────────────────────────────────────
function show(s) {
  const i = cells.indexOf(s);
  if (i >= 0) { setFocus(i); return; }
  // 분할 화면에 빈 칸이 있으면 그 칸부터 채우고, 없으면 포커스된 칸을 바꿈
  const n = LAYOUT_N[layout];
  const empty = cells[focusIdx] ? [...Array(n).keys()].find((k) => !cells[k]) : focusIdx;
  if (empty != null && empty !== focusIdx) {
    const prev = focused();
    if (prev) sendCtl(prev, { type: 'monitor', on: false });
    focusIdx = empty;
  }
  cells[focusIdx] = s;
  renderLayout();
}

function setFocus(i) {
  const prev = focused();
  focusIdx = i;
  if (prev && prev !== focused()) sendCtl(prev, { type: 'monitor', on: false });
  renderLayout();
}

function setLayout(mode) {
  layout = mode;
  store.set('layout', mode);
  const n = LAYOUT_N[mode];
  cells = cells.slice(0, n);
  while (cells.length < n) cells.push(tabs.find((t) => !cells.includes(t)) || null);
  if (focusIdx >= n) focusIdx = 0;
  renderLayout();
}

function renderLayout() {
  const n = LAYOUT_N[layout];
  while (cells.length < n) cells.push(null);
  const wsEl = $('#workspace');
  wsEl.className = 'layout-' + layout;
  $$('.cell-empty', wsEl).forEach((e) => e.remove());
  $('#home').hidden = tabs.length > 0;
  for (const t of tabs) {
    const i = cells.indexOf(t);
    t.pane.hidden = i < 0;
    t.pane.style.gridArea = i >= 0 ? 'c' + i : '';
    t.pane.classList.toggle('focused', i === focusIdx && n > 1);
    t.tab.classList.toggle('active', i === focusIdx);
    t.tab.classList.toggle('visible', i >= 0);
  }
  if (tabs.length) {
    cells.forEach((c, i) => {
      if (c) return;
      const e = document.createElement('div');
      e.className = 'cell-empty' + (i === focusIdx ? ' focused' : '');
      e.style.gridArea = 'c' + i;
      e.textContent = L('탭을 클릭하거나 세션을 더블클릭하면 여기에 열립니다');
      e.onclick = () => setFocus(i);
      wsEl.appendChild(e);
    });
  }
  const f = focused();
  if (f) {
    requestAnimationFrame(() => { cells.forEach((c) => c && safeFit(c)); f.term.focus(); });
    f.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = `${tabLabel(f)} — ShellAnchor`;
    if (SETTINGS.monitor) sendCtl(f, { type: 'monitor', on: true });
  } else {
    document.title = 'ShellAnchor';
  }
  showSftpPanel();
  renderStatus();
  updateToolbar();
}

// ── 상태 표시줄 (원격 모니터링) ───────────────────────────
function renderStatus() {
  const el = $('#sbText');
  const s = focused();
  if (!api.ws || api.ws.readyState !== WebSocket.OPEN) return;
  if (!s) { el.textContent = tabs.length ? L('빈 칸') : L('준비'); return; }
  if (s.kind === 'local') { el.textContent = `▣ ${L('로컬')} · ${shellName(s.spec.shell)}`; return; }
  const who = `● ${targetStr(s.spec)}${s.spec.encoding === 'euc-kr' ? ' · EUC-KR' : ''}${s.spec.log ? ' · ' + L('로그 기록 중') : ''}`;
  const m = s.mon;
  if (s.state !== 'on') { el.textContent = `${targetStr(s.spec)} · ${s.state === 'connecting' ? L('접속 중…') : L('끊김')}`; return; }
  if (!SETTINGS.monitor) { el.textContent = who; return; }
  if (!m) { el.textContent = who + ' · ' + L('모니터링 준비 중…'); return; }
  if (m.unsupported) { el.textContent = who + ' · ' + L('모니터링: 지원 안 함 (Linux 아님)'); return; }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const bar = (p) => `<span class="meter${p >= 90 ? ' hot' : p >= 75 ? ' warm' : ''}"><i style="width:${p}%"></i></span>`;
  const parts = [`<b>${escapeHtml(who)}</b>`];
  if (m.cpu != null) parts.push(`CPU ${bar(m.cpu)} ${Math.round(m.cpu)}%`);
  const mp = pct(m.mem[0], m.mem[1]);
  parts.push(`RAM ${bar(mp)} ${fmtSize(m.mem[0] * 1024)} / ${fmtSize(m.mem[1] * 1024)}`);
  if (m.disk) { const dp = pct(m.disk[0], m.disk[1]); parts.push(`${L('디스크')} / ${bar(dp)} ${dp}%`); }
  if (m.net) parts.push(`↓ ${fmtSize(m.net[0])}/s ↑ ${fmtSize(m.net[1])}/s`);
  parts.push(`Load ${m.load.join(' ')}`, `Up ${fmtUptime(m.uptime)}`);
  el.innerHTML = parts.join('<span class="sep">│</span>');
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ── 탭 메뉴 ───────────────────────────────────────────
function tabMenu(s, x, y) {
  showMenu(x, y, [
    { label: L('탭 복제'), action: () => openTab(s.spec) },
    { label: L('재접속'), action: () => reconnectNow(s) },
    s.spec.quick ? { label: L('세션으로 저장…'), action: () => saveQuickAsSession(s) } : null,
    !s.spec.quick && findSession(s.spec.id) ? { label: L('세션 편집…'), action: () => editSession(findSession(s.spec.id)) } : null,
    s.logPath ? { label: L('로그 폴더 열기'), action: () => api.call('openLogs', { name: s.spec.name || s.spec.host }).catch((e) => toast(e.message)) } : null,
    '-',
    { label: L('닫기'), action: () => closeTab(s) },
    { label: L('다른 탭 모두 닫기'), action: () => tabs.filter((t) => t !== s).forEach((t) => closeTab(t, true)) },
  ]);
}

// ── 사이드바 ─────────────────────────────────────────
function setSide(name) {
  $$('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === name));
  $$('.side-pane').forEach((p) => p.classList.toggle('on', p.id === 'side-' + name));
  if (store.get('sidebarCollapsed', false)) toggleSidebar(false);
  if (name === 'sftp') showSftpPanel();
}
$$('.side-tabs button').forEach((b) => { b.onclick = () => setSide(b.dataset.side); });

function showSftpPanel() {
  const f = focused();
  let any = false;
  for (const t of tabs) {
    if (!t.sftp) continue;
    const on = t === f;
    t.sftp.el.hidden = !on;
    if (on) { any = true; t.sftp.onShow(); }
  }
  $('#sftpEmpty').hidden = any;
}

function toggleSidebar(collapse) {
  const c = collapse ?? !document.body.classList.contains('side-collapsed');
  document.body.classList.toggle('side-collapsed', c);
  store.set('sidebarCollapsed', c);
  requestAnimationFrame(() => cells.forEach((t) => t && safeFit(t)));
}
(() => {
  const side = $('#sidebar');
  side.style.width = store.get('sidebarWidth', 300) + 'px';
  if (store.get('sidebarCollapsed', false)) document.body.classList.add('side-collapsed');
  const rz = $('#sideResizer');
  rz.addEventListener('dblclick', () => toggleSidebar());
  rz.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('side-collapsed')) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = side.offsetWidth;
    const move = (ev) => { side.style.width = Math.max(200, Math.min(innerWidth * 0.6, w0 + ev.clientX - x0)) + 'px'; };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      store.set('sidebarWidth', side.offsetWidth);
      cells.forEach((t) => t && safeFit(t));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
})();

// ── 툴바 ──────────────────────────────────────────────
function updateToolbar() {
  $('#tbLocal').disabled = !CAPS.local || !CAPS.shells.length;
  $('#homeLocal').disabled = $('#tbLocal').disabled;
}

$('#tbSplit').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const it = (mode, label) => ({ label: (layout === mode ? '✓ ' : '　') + label, action: () => setLayout(mode) });
  showMenu(r.left, r.bottom + 2, [it('1', L('한 화면')), it('2v', L('좌우 2분할')), it('2h', L('상하 2분할')), it('4', L('4분할'))]);
};

function localMenu(x, y) {
  if (!CAPS.shells.length) return toast(L('사용할 수 있는 로컬 셸이 없습니다'));
  showMenu(x, y, CAPS.shells.map((sh) => ({
    label: sh.name, action: () => openSpec({ id: 'local-' + sh.id, type: 'local', shell: sh.id, name: sh.name, quick: true }),
  })));
}
$('#tbLocal').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); localMenu(r.left, r.bottom + 2); };
$('#homeLocal').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); localMenu(r.left, r.bottom + 2); };
$('#tbLogs').onclick = () => api.call('openLogs', {}).catch((e) => toast(e.message, 3000));
$('#tbTunnel').onclick = () => setSide('tunnels');

$('#quick').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = parseTarget(e.target.value);
  if (!t) return toast(L('형식: user@host 또는 user@host:port'), 2500);
  e.target.value = '';
  openSpec({ id: 'q-' + uid(), type: 'ssh', quick: true, name: '', ...t, auth: 'password', encoding: 'utf-8',
             log: !!SETTINGS.logDefault, reconnect: true, jump: null });
});

// ── 단축키 / 글자 크기 / 전체화면 ──────────────────────────
function globalShortcut(e) {
  if (!(e.ctrlKey && e.altKey)) return false;
  if (e.code === 'KeyN') { newSession(); return true; }
  if (e.code === 'KeyW' && focused()) { closeTab(focused()); return true; }
  if (e.code === 'KeyF') { setSide($('#side-sftp').classList.contains('on') ? 'sessions' : 'sftp'); return true; }
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    if (!tabs.length) return true;
    const i = Math.max(0, tabs.indexOf(focused()));
    const n = tabs.length;
    show(tabs[(i + (e.code === 'ArrowRight' ? 1 : -1) + n) % n]);
    return true;
  }
  return false;
}
document.addEventListener('keydown', (e) => { if (globalShortcut(e)) e.preventDefault(); });

function setFont(n) {
  fontSize = Math.max(9, Math.min(32, n));
  store.set('fontSize', fontSize);
  tabs.forEach((s) => { s.term.options.fontSize = fontSize; });
  cells.forEach((t) => t && safeFit(t));
  toast(L('글자 크기 {n}', { n: fontSize }));
}
$('#fontUp').onclick = () => setFont(fontSize + 1);
$('#fontDown').onclick = () => setFont(fontSize - 1);

$('#fullBtn').onclick = async () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  await document.documentElement.requestFullscreen();
  try { await navigator.keyboard?.lock(); } catch {}
  toast(L('전체화면 — 나가려면 Esc를 길게 누르세요'), 2500);
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) navigator.keyboard?.unlock();
  $('#fullBtn').classList.toggle('on', !!document.fullscreenElement);
});

window.addEventListener('beforeunload', (e) => {
  if (tabs.some((s) => s.state === 'on')) e.preventDefault();
});
