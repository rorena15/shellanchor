'use strict';
/* SSH 터널 — 목록·시작/중지·편집. 실행은 서버가 담당(탭을 닫아도 유지). */

let TUNNEL_STATUS = {};
function setTunnelStatus(st) { TUNNEL_STATUS = st || {}; }
api.on('tunnel', (m) => { TUNNEL_STATUS[m.id] = m.status; renderTunnels(); });

const TSTATE = { on: '실행 중', starting: '연결 중…', reconnecting: '재연결 중…', error: '오류', off: '중지됨' };

function renderTunnels() {
  const box = $('#tunnelList');
  box.innerHTML = '';
  const list = DB.tunnels || [];
  if (!list.length) {
    box.innerHTML = '<div class="side-empty">터널이 없습니다.<br>＋ 로 추가하세요.<br><small>예: 내 PC 13306 → (S400 경유) → DB 3306</small></div>';
  }
  for (const t of list) {
    const st = TUNNEL_STATUS[t.id] || { state: 'off' };
    const via = findSession(t.via);
    const row = document.createElement('div');
    row.className = 'tn-row ' + st.state;
    row.innerHTML = `<button class="tn-toggle" title="시작/중지"></button>
      <div class="tn-main"><b></b><span class="tn-desc"></span><span class="tn-st"></span></div>`;
    row.querySelector('.tn-toggle').textContent = ['on', 'starting', 'reconnecting'].includes(st.state) ? '■' : '▶';
    row.querySelector('b').textContent = t.name || `터널 ${t.listenPort}`;
    row.querySelector('.tn-desc').textContent = t.type === 'dynamic'
      ? `SOCKS5 127.0.0.1:${t.listenPort} · via ${via ? sessName(via) : '(세션 없음)'}`
      : `127.0.0.1:${t.listenPort} → ${t.destHost}:${t.destPort} · via ${via ? sessName(via) : '(세션 없음)'}`;
    row.querySelector('.tn-st').textContent = (TSTATE[st.state] || st.state) + (st.conns ? ` · 연결 ${st.conns}` : '') + (st.error ? ` — ${st.error}` : '');
    row.querySelector('.tn-toggle').onclick = () => toggleTunnel(t);
    row.ondblclick = () => editTunnel(t);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: ['on', 'starting', 'reconnecting'].includes(st.state) ? '중지' : '시작', action: () => toggleTunnel(t) },
        { label: '편집…', action: () => editTunnel(t) },
        t.type === 'local' ? { label: '주소 복사 (127.0.0.1:' + t.listenPort + ')', action: () => navigator.clipboard.writeText(`127.0.0.1:${t.listenPort}`) } : null,
        '-',
        { label: '삭제', danger: true, action: () => deleteTunnel(t) },
      ]);
    };
    box.appendChild(row);
  }
}

async function toggleTunnel(t) {
  const st = TUNNEL_STATUS[t.id]?.state;
  if (['on', 'starting', 'reconnecting'].includes(st)) {
    await api.call('tunnelStop', { tid: t.id }).catch((e) => toast(e.message, 3000));
    return;
  }
  const via = findSession(t.via);
  if (!via) return toast('경유할 SSH 세션이 없습니다. 터널을 편집하세요.', 3000);
  let ask = {};
  for (;;) {
    const secrets = await ensureSecrets(via, ask);
    if (!secrets) return;
    try {
      await api.call('tunnelStart', { tid: t.id, secrets });
      toast(`터널 시작: ${t.name || t.listenPort}`, 1500);
      return;
    } catch (e) {
      const [kind, which] = (e.code || '').split(':');
      if (kind === 'auth') { forgetSecret(which === 'jump' ? via.jump : via, 'password'); ask = { password: which }; toast(e.message, 2500); continue; }
      if (kind === 'passphrase') { ask = { passphrase: which }; continue; }
      toast('터널 시작 실패: ' + e.message, 4000);
      return;
    }
  }
}

async function editTunnel(t) {
  const dlg = $('#tunnelDlg'), f = dlg.querySelector('form');
  const sshs = DB.sessions.filter((s) => s.type === 'ssh');
  if (!sshs.length) return toast('먼저 경유할 SSH 세션을 만드세요', 3000);
  $('#tdTitle').textContent = t ? '터널 편집' : '새 터널';
  f.via.innerHTML = sshs.map((s) => `<option value="${s.id}">${escapeHtml(sessName(s))} — ${escapeHtml(targetStr(s))}</option>`).join('');
  f.name.value = t?.name || '';
  f.type.value = t?.type || 'local';
  f.listenPort.value = t?.listenPort || '';
  f.via.value = t?.via || (treeSel?.kind === 'session' && findSession(treeSel.id)?.type === 'ssh' ? treeSel.id : sshs[0].id);
  f.destHost.value = t?.destHost || '';
  f.destPort.value = t?.destPort || '';
  $('#tdError').textContent = '';
  const sync = () => {
    const dyn = f.type.value === 'dynamic';
    f.querySelector('.dest-row').hidden = dyn;
    $('#tdHint').textContent = dyn
      ? '브라우저·프로그램의 프록시를 SOCKS5 127.0.0.1:포트로 지정하면 SSH 서버를 거쳐 나갑니다.'
      : '내 PC의 127.0.0.1:포트로 접속하면 SSH 서버를 거쳐 원격 대상에 연결됩니다. 대상 주소는 SSH 서버 기준입니다.';
  };
  f.type.onchange = sync;
  sync();
  for (;;) {
    if ((await dialogResult(dlg)) !== 'save') return;
    const v = {
      id: t?.id || uid(), name: f.name.value.trim(), type: f.type.value, listenPort: +f.listenPort.value, via: f.via.value,
      destHost: f.destHost.value.trim() || '127.0.0.1', destPort: +f.destPort.value,
    };
    const used = (DB.tunnels || []).find((x) => x.listenPort === v.listenPort && x.id !== v.id);
    const err = !v.listenPort ? '내 PC 포트를 입력하세요'
      : used ? `포트 ${v.listenPort}는 "${used.name || '다른 터널'}"이 쓰고 있습니다`
      : v.type === 'local' && !v.destPort ? '원격 대상 포트를 입력하세요' : '';
    if (err) { $('#tdError').textContent = err; continue; }
    if (t) Object.assign(t, v); else (DB.tunnels ||= []).push(v);
    await saveDB();
    renderTunnels();
    if (t && TUNNEL_STATUS[t.id]?.state === 'on') toast('실행 중인 터널은 다시 시작해야 변경 내용이 적용됩니다', 3000);
    return;
  }
}

async function deleteTunnel(t) {
  if (!confirm(`터널 "${t.name || t.listenPort}"을(를) 삭제할까요?`)) return;
  await api.call('tunnelStop', { tid: t.id }).catch(() => {});
  DB.tunnels = DB.tunnels.filter((x) => x !== t);
  delete TUNNEL_STATUS[t.id];
  await saveDB();
  renderTunnels();
}

$('#tunnelAdd').onclick = () => editTunnel(null);
