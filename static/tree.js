'use strict';
/* 세션 폴더 트리 · 세션 편집 · MobaXterm 가져오기 · 설정 · 시작 */

const ICON = { ssh: '🖥', rdp: '🪟', local: '▣' };
let treeSel = null;               // {kind:'session'|'folder', id|path}
let openFolders = new Set(store.get('openFolders', []));

function allFolders() {
  const set = new Set(DB.folders || []);
  for (const s of DB.sessions) if (s.folder) set.add(s.folder);
  for (const f of [...set]) {                     // 상위 폴더도 포함
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}
const sessName = (s) => s.name || (s.type === 'local' ? shellName(s.shell) : targetStr(s));
const sessSub = (s) => s.type === 'local' ? L('로컬 터미널') : targetStr(s) + (s.type === 'rdp' ? ' · RDP' : '') + (s.jump?.host || s.gateway ? ' · ' + L('경유') : '');

// ── 트리 그리기 ─────────────────────────────────────────
function renderTree() {
  const box = $('#tree');
  const q = $('#treeSearch').value.trim().toLowerCase();
  box.innerHTML = '';
  const match = (s) => !q || [s.name, s.host, s.username, s.folder].some((v) => (v || '').toLowerCase().includes(q));
  const folders = allFolders();
  const sessionsIn = (f) => DB.sessions.filter((s) => (s.folder || '') === f && match(s))
    .sort((a, b) => sessName(a).localeCompare(sessName(b), 'ko'));
  const childFolders = (f) => folders.filter((x) => (f ? x.startsWith(f + '/') && !x.slice(f.length + 1).includes('/') : !x.includes('/')));
  const hasMatch = (f) => sessionsIn(f).length || childFolders(f).some(hasMatch);

  const addFolder = (f, depth) => {
    if (q && !hasMatch(f)) return;
    const open = q ? true : openFolders.has(f);
    const row = document.createElement('div');
    row.className = 'tr-row folder';
    row.style.paddingLeft = 6 + depth * 14 + 'px';
    row.innerHTML = `<span class="tw">${open ? '▾' : '▸'}</span><span class="ic">📁</span><span class="nm"></span><span class="cnt"></span>`;
    row.querySelector('.nm').textContent = f.split('/').pop();
    const n = DB.sessions.filter((s) => (s.folder || '') === f || (s.folder || '').startsWith(f + '/')).length;
    row.querySelector('.cnt').textContent = n || '';
    row.dataset.folder = f;
    row.draggable = true;
    row.onclick = () => { selectTree({ kind: 'folder', path: f }); toggleFolder(f); };
    row.oncontextmenu = (e) => { e.preventDefault(); selectTree({ kind: 'folder', path: f }); folderMenu(f, e.clientX, e.clientY); };
    dnd(row, { kind: 'folder', path: f }, f);
    box.appendChild(row);
    if (!open) return;
    childFolders(f).forEach((c) => addFolder(c, depth + 1));
    sessionsIn(f).forEach((s) => addSession(s, depth + 1));
  };
  const addSession = (s, depth) => {
    const row = document.createElement('div');
    row.className = 'tr-row sess';
    row.style.paddingLeft = 6 + depth * 14 + 14 + 'px';
    row.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="sub"></span>`;
    row.querySelector('.ic').textContent = ICON[s.type] || '🖥';
    row.querySelector('.nm').textContent = sessName(s);
    row.querySelector('.sub').textContent = sessSub(s);
    row.title = `${sessName(s)}\n${sessSub(s)}${s.log ? '\n' + L('세션 로그 저장') : ''}`;
    row.dataset.sid = s.id;
    row.draggable = true;
    row.onclick = () => selectTree({ kind: 'session', id: s.id });
    row.ondblclick = () => openSpec(s);
    row.oncontextmenu = (e) => { e.preventDefault(); selectTree({ kind: 'session', id: s.id }); sessionMenu(s, e.clientX, e.clientY); };
    dnd(row, { kind: 'session', id: s.id }, s.folder || '');
    box.appendChild(row);
  };

  childFolders('').forEach((f) => addFolder(f, 0));
  sessionsIn('').forEach((s) => addSession(s, 0));
  if (!box.children.length) {
    box.innerHTML = q ? '<div class="side-empty">' + L('검색 결과 없음') + '</div>'
      : '<div class="side-empty">' + L('저장된 세션이 없습니다.') + '<br>' + L('＋ 로 만들거나 ⤓ 로 MobaXterm 세션을 가져오세요.') + '</div>';
  }
  paintTreeSel();
  $('#folderList').innerHTML = folders.map((f) => `<option value="${escapeHtml(f)}">`).join('');
}

function toggleFolder(f) {
  openFolders.has(f) ? openFolders.delete(f) : openFolders.add(f);
  store.set('openFolders', [...openFolders]);
  renderTree();
}
function selectTree(sel) { treeSel = sel; paintTreeSel(); }
function paintTreeSel() {
  $$('#tree .tr-row').forEach((r) => r.classList.toggle('sel',
    !!treeSel && (treeSel.kind === 'session' ? r.dataset.sid === treeSel.id : r.dataset.folder === treeSel.path)));
}
$('#treeSearch').addEventListener('input', renderTree);
$('#tree').addEventListener('keydown', (e) => {
  if (!treeSel || treeSel.kind !== 'session') return;
  const s = findSession(treeSel.id);
  if (!s) return;
  if (e.key === 'Enter') openSpec(s);
  else if (e.key === 'F2') editSession(s);
  else if (e.key === 'Delete') deleteSession(s);
});
$('#tree').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tr-row')) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: L('새 세션'), action: () => editSession(null, '') },
    { label: L('새 폴더'), action: () => newFolder('') },
    { label: L('MobaXterm 세션 가져오기…'), action: () => $('#importFile').click() },
  ]);
});

// 드래그&드롭으로 폴더 이동
let dragItem = null;
function dnd(row, item, folderOfTarget) {
  row.addEventListener('dragstart', (e) => { dragItem = item; e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => { dragItem = null; $$('#tree .drop').forEach((r) => r.classList.remove('drop')); });
  row.addEventListener('dragover', (e) => { if (dragItem) { e.preventDefault(); row.classList.add('drop'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('drop');
    moveTo(dragItem, item.kind === 'folder' ? item.path : folderOfTarget);
  });
}
$('#tree').addEventListener('dragover', (e) => { if (dragItem) e.preventDefault(); });
$('#tree').addEventListener('drop', (e) => { e.preventDefault(); if (dragItem) moveTo(dragItem, ''); });

function moveTo(item, folder) {
  if (!item) return;
  if (item.kind === 'session') {
    const s = findSession(item.id);
    if (!s || (s.folder || '') === folder) return;
    s.folder = folder;
  } else {
    const src = item.path;
    if (folder === src || folder.startsWith(src + '/')) return;
    const dst = (folder ? folder + '/' : '') + src.split('/').pop();
    if (dst === src) return;
    renameFolderPath(src, dst);
  }
  if (folder) { openFolders.add(folder); store.set('openFolders', [...openFolders]); }
  saveDB(); renderTree();
}

// ── 메뉴 ─────────────────────────────────────────────
function sessionMenu(s, x, y) {
  showMenu(x, y, [
    { label: s.type === 'rdp' ? L('원격 데스크톱 열기') : L('접속'), hint: L('더블클릭'), action: () => openSpec(s) },
    { label: L('편집…'), hint: 'F2', action: () => editSession(s) },
    { label: L('복제'), action: () => duplicateSession(s) },
    s.log ? { label: L('로그 폴더 열기'), action: () => api.call('openLogs', { name: s.name || s.host }).catch((e) => toast(e.message)) } : null,
    '-',
    { label: L('삭제'), hint: 'Del', danger: true, action: () => deleteSession(s) },
  ]);
}
function folderMenu(f, x, y) {
  showMenu(x, y, [
    { label: L('이 폴더에 새 세션'), action: () => editSession(null, f) },
    { label: L('하위 폴더 만들기'), action: () => newFolder(f) },
    { label: L('이름 바꾸기'), action: () => renameFolder(f) },
    '-',
    { label: L('폴더 삭제'), danger: true, action: () => deleteFolder(f) },
  ]);
}

function newFolder(parent) {
  const name = prompt(L('새 폴더 이름'));
  if (!name) return;
  const path = (parent ? parent + '/' : '') + name.replace(/\//g, '／').trim();
  if (allFolders().includes(path)) return toast(L('이미 있는 폴더입니다'));
  DB.folders = [...(DB.folders || []), path];
  if (parent) openFolders.add(parent);
  openFolders.add(path);
  store.set('openFolders', [...openFolders]);
  saveDB(); renderTree();
}
function renameFolderPath(src, dst) {
  const swap = (p) => (p === src ? dst : p.startsWith(src + '/') ? dst + p.slice(src.length) : p);
  DB.folders = (DB.folders || []).map(swap);
  DB.sessions.forEach((s) => { if (s.folder) s.folder = swap(s.folder); });
  openFolders = new Set([...openFolders].map(swap));
  store.set('openFolders', [...openFolders]);
}
function renameFolder(f) {
  const name = prompt(L('새 이름'), f.split('/').pop());
  if (!name) return;
  const dst = f.split('/').slice(0, -1).concat(name.replace(/\//g, '／').trim()).join('/');
  if (dst === f) return;
  if (allFolders().includes(dst)) return toast(L('이미 있는 폴더입니다'));
  renameFolderPath(f, dst);
  saveDB(); renderTree();
}
function deleteFolder(f) {
  const inside = DB.sessions.filter((s) => s.folder === f || (s.folder || '').startsWith(f + '/'));
  if (!confirm(inside.length ? L('"{f}" 폴더와 안의 세션 {n}개를 삭제할까요?', { f, n: inside.length }) : L('"{f}" 폴더를 삭제할까요?', { f }))) return;
  DB.sessions = DB.sessions.filter((s) => !inside.includes(s));
  DB.folders = (DB.folders || []).filter((x) => x !== f && !x.startsWith(f + '/'));
  saveDB(); renderTree();
}
function deleteSession(s) {
  if (!confirm(L('세션 "{name}"을(를) 삭제할까요?', { name: sessName(s) }))) return;
  DB.sessions = DB.sessions.filter((x) => x !== s);
  saveDB(); renderTree(); renderRecent();
}
function duplicateSession(s) {
  const c = JSON.parse(JSON.stringify(s));
  c.id = uid();
  c.name = L('{name} (복사)', { name: sessName(s) });
  DB.sessions.push(c);
  saveDB(); renderTree();
  editSession(c);
}

// ── 세션 편집 대화상자 ───────────────────────────────────
function newSession() {
  const folder = treeSel?.kind === 'folder' ? treeSel.path : treeSel?.kind === 'session' ? findSession(treeSel.id)?.folder || '' : '';
  editSession(null, folder);
}
$('#tbSession').onclick = newSession;
$('#treeNewSession').onclick = newSession;
$('#homeNew').onclick = newSession;
$('#treeNewFolder').onclick = () => newFolder(treeSel?.kind === 'folder' ? treeSel.path : '');

const sForm = $('#sessionForm');
function syncSessionForm() {
  const type = sForm.stype.value;
  sForm.dataset.type = type;
  sForm.port.placeholder = type === 'rdp' ? '3389' : '22';
  sForm.querySelector('.keyfile-row').hidden = sForm.auth.value !== 'keyfile';
  sForm.querySelector('.j-keyfile-row').hidden = sForm.j_auth.value !== 'keyfile';
  $('#sdConnect').textContent = type === 'rdp' ? L('저장하고 열기') : L('저장하고 접속');
}
sForm.addEventListener('change', syncSessionForm);
$$('.pick', sForm).forEach((b) => {
  b.onclick = async () => {
    if (!CAPS.local) return toast(L('파일 선택창은 서버가 127.0.0.1로 실행 중일 때만 됩니다'));
    b.disabled = true;
    try { const r = await api.call('pickFile'); if (r.path) sForm[b.dataset.for].value = r.path; }
    catch (e) { toast(e.message, 3000); }
    finally { b.disabled = false; }
  };
});

/** s=null 이면 새 세션. preset: 빠른 접속 탭을 저장할 때 등 */
async function editSession(s, folder = '', preset = null) {
  const src = s || preset || {};
  const isNew = !s;
  $('#sdTitle').textContent = isNew ? L('새 세션') : L('세션 편집');
  sForm.stype.value = src.type || 'ssh';
  sForm.name.value = src.name || '';
  sForm.folder.value = s ? s.folder || '' : src.folder ?? folder;
  sForm.host.value = src.host || '';
  sForm.port.value = src.port && ![22, 3389].includes(+src.port) ? src.port : '';
  sForm.username.value = src.username || '';
  sForm.auth.value = src.auth === 'keyfile' ? 'keyfile' : 'password';
  sForm.keyPath.value = src.keyPath || '';
  sForm.encoding.value = src.encoding || 'utf-8';
  sForm.log.checked = src.log ?? !!SETTINGS.logDefault;
  sForm.reconnect.checked = src.reconnect !== false;
  const j = src.jump || {};
  sForm.querySelector('details.jump').open = !!j.host;
  sForm.j_host.value = j.host || '';
  sForm.j_port.value = j.port && +j.port !== 22 ? j.port : '';
  sForm.j_username.value = j.username || '';
  sForm.j_auth.value = j.auth === 'keyfile' ? 'keyfile' : 'password';
  sForm.j_keyPath.value = j.keyPath || '';
  sForm.screen.value = src.screen || 'full';
  sForm.gateway.innerHTML = '<option value="">' + L('(직접 접속)') + '</option>' + DB.sessions.filter((x) => x.type === 'ssh')
    .map((x) => `<option value="${x.id}">${escapeHtml(sessName(x))} — ${escapeHtml(targetStr(x))}</option>`).join('');
  sForm.gateway.value = src.gateway || '';
  sForm.clipboard.checked = src.clipboard !== false;
  sForm.drives.checked = !!src.drives;
  sForm.multimon.checked = !!src.multimon;
  sForm.shell.innerHTML = CAPS.shells.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('')
    || '<option value="">' + L('(사용 가능한 셸 없음)') + '</option>';
  sForm.shell.value = src.shell || CAPS.shells[0]?.id || '';
  $('#sdError').textContent = '';
  syncSessionForm();

  for (;;) {
    const r = await dialogResult($('#sessionDlg'));
    if (r !== 'save' && r !== 'connect') return null;
    const type = sForm.stype.value;
    const v = {
      id: s?.id || uid(), type, name: sForm.name.value.trim(), folder: sForm.folder.value.trim().replace(/^\/+|\/+$/g, ''),
    };
    if (type === 'ssh' || type === 'rdp') {
      const host = sForm.host.value.trim();
      const tgt = parseTarget(host);                     // user@host:port 를 호스트 칸에 붙여넣어도 됨
      Object.assign(v, tgt ? { host: tgt.host, port: tgt.port, username: tgt.username }
        : { host, port: +sForm.port.value || (type === 'rdp' ? 3389 : 22), username: sForm.username.value.trim() });
    }
    if (type === 'ssh') {
      Object.assign(v, {
        auth: sForm.auth.value, keyPath: sForm.keyPath.value.trim(), encoding: sForm.encoding.value,
        log: sForm.log.checked, reconnect: sForm.reconnect.checked, jump: null,
      });
      if (sForm.j_host.value.trim()) {
        v.jump = { host: sForm.j_host.value.trim(), port: +sForm.j_port.value || 22, username: sForm.j_username.value.trim(),
                   auth: sForm.j_auth.value, keyPath: sForm.j_keyPath.value.trim() };
      }
    } else if (type === 'rdp') {
      Object.assign(v, { screen: sForm.screen.value, gateway: sForm.gateway.value, clipboard: sForm.clipboard.checked,
                         drives: sForm.drives.checked, multimon: sForm.multimon.checked });
    } else {
      v.shell = sForm.shell.value;
    }
    const err = type !== 'local' && !v.host ? L('호스트를 입력하세요')
      : type === 'ssh' && !v.username ? L('사용자를 입력하세요')
      : type === 'ssh' && v.auth === 'keyfile' && !v.keyPath ? L('개인키 파일 경로를 입력하세요')
      : v.jump && !v.jump.username ? L('점프 호스트 사용자를 입력하세요')
      : type === 'local' && !v.shell ? L('사용할 수 있는 셸이 없습니다') : '';
    if (err) { $('#sdError').textContent = err; continue; }

    if (s) Object.keys(s).forEach((k) => delete s[k]);
    const obj = Object.assign(s || {}, v);
    if (!DB.sessions.includes(obj)) DB.sessions.push(obj);
    if (v.folder) {
      v.folder.split('/').forEach((_, i, a) => openFolders.add(a.slice(0, i + 1).join('/')));
      store.set('openFolders', [...openFolders]);
    }
    await saveDB();
    renderTree();
    selectTree({ kind: 'session', id: obj.id });
    if (r === 'connect') openSpec(obj);
    return obj;
  }
}

async function saveQuickAsSession(t) {
  const obj = await editSession(null, '', { ...t.spec, quick: false });
  if (obj) {
    t.spec = obj;
    t.tab.querySelector('.label').textContent = tabLabel(t);
    t.pane.querySelector('.pane-title').textContent = tabLabel(t);
  }
}

// ── 최근 접속 / 홈 ───────────────────────────────────────
function renderRecent() {
  const ul = $('#recentList');
  ul.innerHTML = '';
  const items = store.get('recent', []).map(findSession).filter(Boolean).slice(0, 8);
  if (!items.length) { ul.innerHTML = '<li class="dim">' + L('아직 없음') + '</li>'; return; }
  for (const s of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ic"></span><b></b><span class="dim"></span>`;
    li.querySelector('.ic').textContent = ICON[s.type];
    li.querySelector('b').textContent = sessName(s);
    li.querySelector('.dim').textContent = sessSub(s);
    li.onclick = () => openSpec(s);
    ul.appendChild(li);
  }
}

// ── MobaXterm 세션 가져오기 ──────────────────────────────
// MobaXterm.ini 또는 내보낸 .mxtsessions 의 [Bookmarks*] 섹션 (비밀번호는 가져오지 않음)
function parseMobaXterm(text) {
  const out = { folders: new Set(), sessions: [], skipped: 0 };
  let sec = null, folder = '';
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\[(.+)\]\s*$/);
    if (h) { sec = h[1]; folder = ''; continue; }
    if (!sec || !/^Bookmarks(_\d+)?$/.test(sec)) continue;
    if (line.startsWith('SubRep=')) {
      folder = line.slice(7).trim().replace(/\\/g, '/');
      if (folder) out.folders.add(folder);
      continue;
    }
    if (line.startsWith('ImgNum=')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim(), m = line.slice(eq + 1).match(/^#(\d+)#(.*)$/);
    if (!m) continue;
    const f = m[2].split('#')[0].split('%').map((x) => x.trim());
    if (m[1] === '109' && f[1]) {               // SSH: 1=host 2=port 3=user 7=gateway host 8=gateway user 9=gateway port 14=key
      const key = (f[14] || '').replace(/^_ProfileDir_/i, '%USERPROFILE%');
      out.sessions.push({
        id: uid(), type: 'ssh', name, folder, host: f[1], port: +f[2] || 22, username: f[3] || '',
        auth: key ? 'keyfile' : 'password', keyPath: key, encoding: 'utf-8', log: !!SETTINGS.logDefault, reconnect: true,
        jump: f[7] ? { host: f[7], port: +f[9] || 22, username: f[8] || '', auth: 'password', keyPath: '' } : null,
      });
    } else if (m[1] === '91' && f[1]) {          // RDP: 1=host 2=port 3=user
      out.sessions.push({ id: uid(), type: 'rdp', name, folder, host: f[1], port: +f[2] || 3389, username: f[3] || '',
                          screen: 'full', gateway: '', clipboard: true });
    } else out.skipped++;
  }
  return out;
}

$('#treeImport').onclick = () => {
  toast(L('MobaXterm.ini 또는 내보낸 .mxtsessions 파일을 선택하세요'), 2500);
  $('#importFile').click();
};
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('euc-kr').decode(buf); }       // MobaXterm은 ANSI(cp949)로 저장
  const r = parseMobaXterm(text);
  if (!r.sessions.length) return toast(L('가져올 SSH/RDP 세션을 찾지 못했습니다'), 3000);
  const key = (s) => [s.type, s.host, s.port, s.username, s.folder].join('|');
  const have = new Set(DB.sessions.map(key));
  const add = r.sessions.filter((s) => !have.has(key(s)));
  const usersMissing = add.filter((s) => s.type === 'ssh' && !s.username).length;
  if (!confirm(`${file.name}\n` + L('SSH {ssh}개, RDP {rdp}개를 찾았습니다.', { ssh: r.sessions.filter((s) => s.type === 'ssh').length, rdp: r.sessions.filter((s) => s.type === 'rdp').length }) + '\n' +
               L('새로 추가: {add}개 (이미 있는 {skip}개는 건너뜀)', { add: add.length, skip: r.sessions.length - add.length }) +
               (r.skipped ? '\n' + L('지원하지 않는 종류 {n}개는 제외', { n: r.skipped }) : '') +
               (usersMissing ? '\n' + L('※ 사용자 이름이 없는 세션 {n}개는 접속 전에 편집에서 입력하세요.', { n: usersMissing }) : '') +
               '\n\n' + L('비밀번호는 가져오지 않습니다. 계속할까요?'))) return;
  DB.sessions.push(...add);
  DB.folders = [...new Set([...(DB.folders || []), ...r.folders])];
  await saveDB();
  renderTree();
  toast(L('{n}개 세션을 가져왔습니다', { n: add.length }), 2500);
};

// 이전 버전(브라우저에 저장된 접속 목록) 옮기기
function migrateOldProfiles() {
  const old = store.get('profiles', []);
  if (!old.length || store.get('migratedProfiles', false)) return false;
  for (const p of old) {
    if (DB.sessions.some((s) => s.host === p.host && s.username === p.username && (s.port || 22) === (p.port || 22))) continue;
    DB.sessions.push({
      id: uid(), type: 'ssh', name: p.name || '', folder: L('이전 접속 기록'), host: p.host, port: p.port || 22, username: p.username,
      auth: 'password', keyPath: '', encoding: p.encoding || 'utf-8', log: !!SETTINGS.logDefault, reconnect: true,
      jump: p.jump ? { ...p.jump, auth: 'password', keyPath: '' } : null,
    });
  }
  store.set('migratedProfiles', true);
  return true;
}

// ── 설정 ─────────────────────────────────────────────
function applySettings(s) {
  SETTINGS = s;
  compileHighlight(s.highlight);
  tabs.forEach((t) => t.hl.reset());
  renderStatus();
}
function hlRow(r = { pattern: '', color: '#ff6b6b', on: true }) {
  const row = document.createElement('div');
  row.className = 'hl-row';
  row.innerHTML = `<input type="checkbox" class="on"><input class="pat mono" spellcheck="false" placeholder="${L('정규식 예:')} \\bfail\\w*"><input type="color" class="col"><button type="button" title="${L('삭제')}">✕</button>`;
  row.querySelector('.on').checked = r.on !== false;
  row.querySelector('.pat').value = r.pattern;
  row.querySelector('.col').value = r.color;
  row.querySelector('button').onclick = () => row.remove();
  $('#hlRules').appendChild(row);
}
$('#hlAdd').onclick = () => hlRow();
// 툴바 ☀/☾: 라이트 ↔ 다크 바로 전환
$('#themeBtn').onclick = () => {
  store.set('uiTheme', currentUi() === 'dark' ? 'light' : 'dark');
  applyTheme();
};
$('#shutdownBtn').onclick = async () => {
  const running = Object.values(TUNNEL_STATUS).filter((s) => s.state !== 'off').length;
  const live = tabs.filter((t) => t.state === 'on').length;
  if (!confirm(L('중계 서버를 종료할까요?') + (live ? '\n' + L('열린 접속 {n}개가 끊깁니다.', { n: live }) : '') + (running ? '\n' + L('실행 중인 터널 {n}개도 멈춥니다.', { n: running }) : ''))) return;
  $('#settingsDlg').close();
  api.stopped = true;          // 이후 끊김은 자동 재접속하지 않음
  try { await api.call('shutdown'); } catch {}
};
$('#tbSettings').onclick = async () => {
  const dlg = $('#settingsDlg'), f = dlg.querySelector('form');
  f.logDir.value = SETTINGS.logDir || '';
  f.logDir.placeholder = LOGDIR;
  f.logDefault.checked = !!SETTINGS.logDefault;
  f.monitor.checked = !!SETTINGS.monitor;
  f.followFolder.checked = SETTINGS.followFolder !== false;
  $('#hlRules').innerHTML = '';
  (SETTINGS.highlight || []).forEach(hlRow);
  // 화면 테마 (브라우저별 저장, 고르면 바로 미리보기)
  const ui0 = uiThemeSetting(), term0 = store.get('termScheme', 'auto');
  f.uiTheme.innerHTML = Object.entries(UI_THEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  f.termScheme.innerHTML = '<option value="auto">' + L('화면 테마에 맞춤') + '</option>' +
    Object.entries(TERM_SCHEMES).map(([k, v]) => `<option value="${k}">${escapeHtml(v.name)}</option>`).join('');
  f.uiTheme.value = ui0;
  f.termScheme.value = term0;
  // 언어 (브라우저별 저장). 언어 이름은 번역하지 않고 각 언어로 표시
  const lang0 = store.get('lang', 'auto');
  f.lang.innerHTML = `<option value="auto">${L('자동 (브라우저 언어)')}</option><option value="ko">한국어</option><option value="en">English</option>`;
  f.lang.value = lang0;
  const preview = () => {
    applyTheme(f.uiTheme.value, f.termScheme.value);
    const t = TERM_SCHEMES[schemeKey(f.termScheme.value, currentUi(f.uiTheme.value))];
    const el = $('#schemePreview');
    el.style.background = t.background;
    el.style.color = t.foreground;
    const span = (txt, col) => `<span style="color:${col}">${txt}</span>`;
    el.innerHTML = `${span('root@web01', t.green)}:${span('~/app', t.blue)}# systemctl status nginx
` +
      `● nginx.service ${span('active (running)', adaptHighlight('#56d364'))}  ${span('192.0.2.10', adaptHighlight('#79c0ff'))}
` +
      `${span('error', adaptHighlight('#ff6b6b'))}: connection ${span('refused', adaptHighlight('#ff6b6b'))} · ${span('warning', adaptHighlight('#e3b341'))}: disk 85%  ` +
      ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((k) => span('■', t[k])).join('');
  };
  f.uiTheme.onchange = f.termScheme.onchange = preview;
  preview();
  if ((await dialogResult(dlg)) !== 'save') { applyTheme(ui0, term0); return; }
  store.set('uiTheme', f.uiTheme.value);
  store.set('termScheme', f.termScheme.value);
  applyTheme();
  const highlight = $$('.hl-row', dlg).map((r) => ({
    pattern: r.querySelector('.pat').value.trim(), color: r.querySelector('.col').value, on: r.querySelector('.on').checked,
  })).filter((r) => r.pattern);
  const bad = highlight.find((r) => { try { new RegExp(r.pattern); return false; } catch { return true; } });
  if (bad) return toast(L('잘못된 정규식: {p}', { p: bad.pattern }), 3500);
  const next = { ...SETTINGS, logDir: f.logDir.value.trim(), logDefault: f.logDefault.checked, monitor: f.monitor.checked,
                 followFolder: f.followFolder.checked, highlight };
  try {
    const r = await api.call('saveSettings', { settings: next });
    LOGDIR = r.logDir;
    applySettings(next);
    tabs.forEach((t) => sendCtl(t, { type: 'monitor', on: next.monitor && t === focused() }));
    toast(L('설정 저장됨'), 1000);
  } catch (e) { toast(L('저장 실패: {msg}', { msg: e.message }), 3000); }
  // 언어는 화면 전체를 다시 그려야 해서 새로고침으로 적용. 열린 접속이 있으면 끊기지 않게 다음에 열 때 적용
  if (f.lang.value !== lang0) {
    store.set('lang', f.lang.value);
    if (tabs.length) toast(L('언어는 창을 다시 열면 적용됩니다'), 3000);
    else location.reload();
  }
};

// ── 시작 ─────────────────────────────────────────────
async function loadAll() {
  const r = await api.call('load');
  DB = r.data;
  CAPS = r.caps;
  LOGDIR = r.logDir;
  applySettings(r.settings);
  setTunnelStatus(r.tunnels);
  if (migrateOldProfiles()) await saveDB();
  renderTree();
  renderTunnels();
  renderRecent();
  updateToolbar();
}

(async () => {
  api.connect();
  api.on('data', (m) => { DB = m.data; renderTree(); renderTunnels(); renderRecent(); });
  api.on('settings', (m) => applySettings(m.settings));
  api.onReopen = () => loadAll().catch(() => {});
  renderLayout();
  try { await loadAll(); }
  catch (e) { toast(L('서버에서 설정을 읽지 못했습니다: {msg}', { msg: e.message }), 4000); }
  $('#sbText').textContent = L('준비');
})();
