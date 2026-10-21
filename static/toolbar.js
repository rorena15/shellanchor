'use strict';
/* 상단 바 편집: 보일 항목·순서·아이콘만 표시를 브라우저별로 저장(store 'toolbar').
   index.html 의 기존 버튼은 각 파일이 id 로 동작을 연결해 두었으므로 요소를 옮겨 배치만 바꾸고,
   상단 바에 새로 올릴 수 있는 동작(ic/text/run 이 있는 항목)은 여기서 버튼을 만들어 붙인다. */

const withTab = (fn) => () => { const s = focused(); if (s) fn(s); else toast(L('열린 탭이 없습니다')); };

// 상단 바에 올릴 수 있는 항목 (이 순서가 기본 순서)
const TB_ITEMS = [
  { id: 'tbSession', label: L('새 세션') },
  { id: 'quick', label: L('빠른 접속 입력칸'), ic: '⌨' },
  { id: 'tbSep1', label: L('구분선'), ic: '│', kind: 'sep' },
  { id: 'tbSplit', label: L('화면 분할') },
  { id: 'tbTunnel', label: L('SSH 터널') },
  { id: 'tbLocal', label: L('로컬 터미널') },
  { id: 'tbLogs', label: L('로그 폴더 열기') },
  { id: 'tbSettings', label: L('설정') },
  { id: 'tbSftp', label: L('SFTP 패널'), ic: '⇅', text: 'SFTP', title: L('SFTP 패널 (Ctrl+Alt+F)'), run: () => setSide('sftp') },
  { id: 'tbSidebar', label: L('사이드바 접기/펴기'), ic: '◧', text: L('사이드바'), title: L('사이드바 접기/펴기'), run: () => toggleSidebar() },
  { id: 'tbDup', label: L('현재 탭 복제'), ic: '⧉', text: L('복제'), title: L('현재 탭 복제'), run: withTab((s) => openTab(s.spec)) },
  { id: 'tbReconnect', label: L('현재 탭 재접속'), ic: '↻', text: L('재접속'), title: L('현재 탭 재접속'), run: withTab((s) => reconnectNow(s)) },
  { id: 'tbCloseTab', label: L('현재 탭 닫기'), ic: '✕', text: L('탭 닫기'), title: L('현재 탭 닫기 (Ctrl+Alt+W)'), run: withTab((s) => closeTab(s)) },
  { id: 'tbNewFolder', label: L('새 세션 폴더'), ic: '📁', text: L('새 폴더'), title: L('새 세션 폴더'), run: () => $('#treeNewFolder').click() },
  { id: 'tbImport', label: L('MobaXterm 세션 가져오기'), ic: '⤓', text: L('가져오기'), title: L('MobaXterm 세션 가져오기'), run: () => $('#importFile').click() },
  { id: 'tbSep2', label: L('구분선'), ic: '│', kind: 'sep' },
  { id: 'tbSpacer', label: L('빈 공간 — 이 뒤의 항목은 오른쪽 끝에 붙음'), ic: '↔', kind: 'spacer' },
  { id: 'themeBtn', label: L('라이트/다크 전환') },
  { id: 'fontDown', label: L('글자 작게') },
  { id: 'fontUp', label: L('글자 크게') },
  { id: 'fullBtn', label: L('전체화면') },
];
const TB_DEFAULT = {   // 처음 모습은 예전 상단 바와 같게
  order: TB_ITEMS.map((i) => i.id),
  hidden: ['tbSftp', 'tbSidebar', 'tbDup', 'tbReconnect', 'tbCloseTab', 'tbNewFolder', 'tbImport', 'tbSep2'],
  iconOnly: false,
};
const tbItem = (id) => TB_ITEMS.find((i) => i.id === id);
const tbCopy = (c) => ({ order: [...c.order], hidden: [...c.hidden], iconOnly: !!c.iconOnly });

// 저장값을 읽고, 저장 이후 새로 생긴 항목은 기본 순서상 바로 앞 항목 뒤에 기본 표시 여부로 끼워 넣는다
function tbLoad() {
  const c = store.get('toolbar', null);
  if (!c?.order) return tbCopy(TB_DEFAULT);
  const order = c.order.filter((id) => tbItem(id));
  const hidden = (c.hidden || []).filter((id) => tbItem(id));
  TB_DEFAULT.order.forEach((id, i) => {
    if (order.includes(id)) return;
    const at = order.indexOf(TB_DEFAULT.order[i - 1]);
    order.splice(at < 0 ? order.length : at + 1, 0, id);
    if (TB_DEFAULT.hidden.includes(id)) hidden.push(id);
  });
  return { order, hidden, iconOnly: !!c.iconOnly };
}

// 항목의 요소: 기존 요소가 있으면 그대로, 없으면 버튼을 만든다
function tbEl(id) {
  let el = document.getElementById(id);
  if (el) return el;
  const it = tbItem(id);
  el = document.createElement('button');
  el.id = id;
  el.className = 'tb';
  el.title = it.title;
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.textContent = it.ic;
  el.append(ic, it.text);
  el.onclick = it.run;
  return el;
}

function renderToolbar(cfg = tbLoad()) {
  const bar = $('#toolbar'), more = $('#tbMore');
  for (const id of cfg.order) {
    const el = tbEl(id);
    el.hidden = cfg.hidden.includes(id);
    bar.insertBefore(el, more);
  }
  bar.classList.toggle('icon-only', cfg.iconOnly);
}

function tbSave(cfg) {
  store.set('toolbar', cfg);
  renderToolbar(cfg);
}

// ── 편집 대화상자 ─────────────────────────────────────────
let tbDraft = null;   // 편집 중인 설정 (바꾸는 즉시 상단 바에 미리 보기)
let tbDrag = null;

function tbRow(id) {
  const it = tbItem(id);
  const li = document.createElement('li');
  li.dataset.id = id;
  li.draggable = true;
  li.tabIndex = 0;
  if (it.kind) li.classList.add('k-' + it.kind);
  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.textContent = '⠿';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !tbDraft.hidden.includes(id);
  cb.onchange = () => {
    tbDraft.hidden = tbDraft.hidden.filter((x) => x !== id);
    if (!cb.checked) tbDraft.hidden.push(id);
    li.classList.toggle('off', !cb.checked);
    renderToolbar(tbDraft);
  };
  const ic = document.createElement('span');
  ic.className = 'ic';
  const el = document.getElementById(id);
  ic.textContent = it.ic || el?.querySelector('.ic')?.textContent || el?.textContent.trim() || '';
  const name = document.createElement('span');
  name.className = 'name grow';
  name.textContent = it.label;
  li.classList.toggle('off', !cb.checked);
  li.append(grip, cb, ic, name);
  li.addEventListener('click', (e) => { if (e.target !== cb && e.target !== grip) cb.click(); });
  return li;
}

function tbFillList() {
  $('#tbList').replaceChildren(...tbDraft.order.map(tbRow));
  $('#tbIconOnly').checked = tbDraft.iconOnly;
}

function tbSyncOrder() {
  tbDraft.order = $$('#tbList li').map((li) => li.dataset.id);
  renderToolbar(tbDraft);
}

async function editToolbar() {
  const saved = tbLoad();
  tbDraft = tbCopy(saved);
  tbFillList();
  const r = await dialogResult($('#toolbarDlg'));
  if (r === 'ok') {
    tbSave(tbDraft);
    toast(L('상단 바를 저장했습니다'));
  } else {
    renderToolbar(saved);   // 취소/Esc: 미리 보기 되돌림
  }
  tbDraft = null;
}

(() => {
  const list = $('#tbList');
  list.addEventListener('dragstart', (e) => {
    tbDrag = e.target.closest('li');
    if (!tbDrag) return;
    tbDrag.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tbDrag.dataset.id);
  });
  list.addEventListener('dragover', (e) => {
    if (!tbDrag) return;
    e.preventDefault();
    const li = e.target.closest('li');
    if (!li || li === tbDrag) return;
    const r = li.getBoundingClientRect();
    list.insertBefore(tbDrag, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
  });
  list.addEventListener('drop', (e) => e.preventDefault());
  list.addEventListener('dragend', () => {
    tbDrag?.classList.remove('dragging');
    tbDrag = null;
    tbSyncOrder();
  });
  // 키보드: Alt+↑↓ 로 순서 이동, Space 로 보이기/숨기기
  list.addEventListener('keydown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling?.nextElementSibling;
      if (e.key === 'ArrowUp' && !to) return;
      list.insertBefore(li, to);
      li.focus();
      tbSyncOrder();
    } else if (e.key === ' ' && e.target === li) {
      e.preventDefault();
      li.querySelector('input').click();
    }
  });

  $('#tbIconOnly').onchange = (e) => { tbDraft.iconOnly = e.target.checked; renderToolbar(tbDraft); };
  $('#tbReset').onclick = () => { tbDraft = tbCopy(TB_DEFAULT); tbFillList(); renderToolbar(tbDraft); };
  $('#tbMore').onclick = editToolbar;

  // 상단 바 우클릭: 이 버튼 숨기기 / 아이콘만 표시 / 편집
  $('#toolbar').addEventListener('contextmenu', (e) => {
    if (e.target.closest('input')) return;   // 입력칸은 브라우저 기본 메뉴(붙여넣기 등)
    e.preventDefault();
    const cfg = tbLoad();
    const btn = e.target.closest('#toolbar > [id]');
    const it = btn && tbItem(btn.id);
    showMenu(e.clientX, e.clientY, [
      it && !it.kind ? { label: L("'{name}' 숨기기", { name: it.label }), action: () => { cfg.hidden.push(btn.id); tbSave(cfg); } } : null,
      { label: (cfg.iconOnly ? '✓ ' : '　') + L('아이콘만 표시'), action: () => { cfg.iconOnly = !cfg.iconOnly; tbSave(cfg); } },
      '-',
      { label: L('상단 바 편집…'), action: editToolbar },
    ]);
  });

  renderToolbar();
})();
