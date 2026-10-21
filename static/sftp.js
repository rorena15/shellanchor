'use strict';
/* SFTP 파일 탐색기 (왼쪽 사이드바) — 탭(세션)마다 하나, 포커스된 탭의 것만 보임.
 * 탐색용 채널 1개 + 전송 작업마다 채널 1개 → 전송 중에도 탐색 가능. */

const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
const parentPath = (p) => (p === '/' ? '/' : p.replace(/\/[^/]*\/?$/, '') || '/');
const baseName = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// WebSocket을 recv() 가능한 채널로 감쌈
function openChan(sid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl('/sftp', { sid }));
    ws.binaryType = 'arraybuffer';
    const queue = [], waiters = [];
    const chan = {
      closed: false,
      send(o) { ws.send(o instanceof ArrayBuffer ? o : JSON.stringify(o)); },
      recv() {
        if (queue.length) return Promise.resolve(queue.shift());
        if (chan.closed) return Promise.reject(new Error(L('SFTP 연결이 끊어졌습니다')));
        return new Promise((res, rej) => waiters.push({ res, rej }));
      },
      async req(o) {           // JSON 요청 → 응답 (오류면 throw)
        chan.send({ id: 1, ...o });
        const m = await chan.recv();
        if (m.error) { const e = new Error(m.error); e.code = m.code; throw e; }
        return m;
      },
      get buffered() { return ws.bufferedAmount; },
      close() { ws.close(); },
    };
    ws.onopen = () => resolve(chan);
    ws.onerror = () => reject(new Error(L('SFTP 연결 실패')));
    ws.onmessage = (ev) => {
      const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (waiters.length) waiters.shift().res(d); else queue.push(d);
    };
    ws.onclose = () => {
      chan.closed = true;
      while (waiters.length) waiters.shift().rej(new Error(L('SFTP 연결이 끊어졌습니다')));
    };
  });
}

// 드롭된 항목(파일/폴더)을 [{file, rel}]로 펼침
async function collectDropped(items) {
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => {
    const acc = [];
    const step = () => reader.readEntries((ents) => { if (!ents.length) res(acc); else { acc.push(...ents); step(); } }, rej);
    step();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      out.push({ dir: true, rel: prefix + entry.name });
      for (const e of await readAll(entry.createReader())) await walk(e, prefix + entry.name + '/');
    }
  };
  const entries = [...items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, '');
  return out;
}

class SftpPanel {
  constructor(s) {
    this.s = s;
    this.cwd = null;
    this.entries = [];
    this.sel = new Set();
    this.anchor = null;
    this.chan = null;
    this.chanSid = null;
    this.lock = Promise.resolve();
    this.jobs = Promise.resolve();
    this.follow = SETTINGS.followFolder !== false;
    this.followPending = false;
    this.followBroken = false;

    const el = this.el = document.createElement('div');
    el.className = 'sftp';
    el.hidden = true;
    el.innerHTML = `
      <div class="sf-head"><span class="sf-who"></span></div>
      <div class="sf-bar">
        <button data-a="up" title="상위 폴더 (Backspace)">↑</button>
        <button data-a="home" title="홈 폴더">⌂</button>
        <input class="sf-path" spellcheck="false" title="경로 입력 후 Enter">
        <button data-a="refresh" title="새로고침 (F5)">⟳</button>
      </div>
      <div class="sf-bar">
        <button data-a="upFiles" title="파일 업로드">⬆ 파일</button>
        <button data-a="upFolder" title="폴더 업로드">⬆ 폴더</button>
        <button data-a="mkdir" title="새 폴더">＋📁</button>
        <button data-a="mkfile" title="새 파일">＋📄</button>
        <span class="grow"></span>
        <label class="sf-follow" title="터미널에서 cd 하면 따라감"><input type="checkbox"> 따라가기</label>
        <button data-a="cd" title="터미널을 이 폴더로 이동">cd↵</button>
      </div>
      <div class="sf-cols"><span>이름</span><span>크기</span><span class="c-perm">권한</span><span class="c-own">소유자</span><span class="c-time">수정</span></div>
      <div class="sf-list" tabindex="0"></div>
      <div class="sf-msg" hidden></div>
      <div class="sf-drop">여기에 놓으면 현재 폴더로 업로드<br><small>폴더도 됩니다</small></div>
      <div class="sf-xfers"></div>
      <input type="file" multiple hidden class="sf-files">
      <input type="file" webkitdirectory hidden class="sf-folder">`;
    translateDom(el);
    $('#side-sftp').appendChild(el);
    el.querySelector('.sf-who').textContent = targetStr(s.spec);

    const act = {
      up: () => this.list(parentPath(this.cwd || '/')),
      home: () => this.list(null),
      refresh: () => this.list(this.cwd),
      upFiles: () => el.querySelector('.sf-files').click(),
      upFolder: () => el.querySelector('.sf-folder').click(),
      mkdir: () => this.mkdir(),
      mkfile: () => this.mkfile(),
      cd: () => this.cwdToTerminal(),
    };
    el.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => act[b.dataset.a](); });
    el.querySelector('.sf-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.list(e.target.value.trim() || '/');
    });
    el.querySelector('.sf-files').onchange = (e) => {
      this.upload([...e.target.files].map((f) => ({ file: f, rel: f.name })));
      e.target.value = '';
    };
    el.querySelector('.sf-folder').onchange = (e) => {
      const items = [...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
      this.upload(items);
      e.target.value = '';
    };
    const fol = el.querySelector('.sf-follow input');
    fol.checked = this.follow;
    fol.onchange = () => { this.follow = fol.checked; if (this.follow) this.followTerminal(true); };

    // 드래그&드롭 업로드 (파일·폴더)
    let depth = 0;
    el.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); depth++; el.classList.add('dragging'); } });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('dragging'); } });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    el.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; el.classList.remove('dragging');
      this.upload(await collectDropped(e.dataTransfer.items));
    });

    const list = el.querySelector('.sf-list');
    list.addEventListener('keydown', (e) => this.onKey(e));
    list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.sf-row')) return;
      e.preventDefault();
      this.sel.clear(); this.paintSel();
      showMenu(e.clientX, e.clientY, [
        { label: L('새 폴더'), action: () => this.mkdir() },
        { label: L('새 파일'), action: () => this.mkfile() },
        '-',
        { label: L('파일 업로드…'), action: act.upFiles },
        { label: L('폴더 업로드…'), action: act.upFolder },
        { label: L('새로고침'), action: act.refresh },
        { label: L('경로 복사'), action: () => this.copyPath(this.cwd) },
      ]);
    });
    list.addEventListener('click', (e) => { if (!e.target.closest('.sf-row')) { this.sel.clear(); this.paintSel(); } });
  }

  // ── 상태 ──
  get visible() {
    return !this.el.hidden && $('#side-sftp').classList.contains('on') && !document.body.classList.contains('side-collapsed');
  }
  onShow() {
    if (!this.s.sid) return;
    if (this.cwd === null) this.list(null);
    if (this.followPending) this.followTerminal(true);
  }
  sessionChanged() {
    if (!this.s.sid) {
      this.chan?.close();
      this.chan = null;
      this.showMsg(L('SSH 연결이 끊어져 있습니다.\n재접속하면 다시 연결됩니다.'));
    } else {
      this.showMsg('');
      if (this.chanSid !== this.s.sid && this.visible) this.list(this.cwd);
    }
  }
  destroy() { this.chan?.close(); this.el.remove(); }
  showMsg(text) {
    const m = this.el.querySelector('.sf-msg');
    m.textContent = text || '';
    m.hidden = !text;
  }

  call(op, args = {}) {
    const run = async () => {
      if (!this.s.sid) throw new Error(L('SSH 연결이 끊어져 있습니다'));
      if (!this.chan || this.chan.closed || this.chanSid !== this.s.sid) {
        this.chan?.close();
        this.chan = await openChan(this.s.sid);
        this.chanSid = this.s.sid;
      }
      return this.chan.req({ op, ...args });
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  async list(path, keepSel) {
    try {
      const r = await this.call('list', { path: path || '.' });
      if (r.path !== this.cwd || !keepSel) this.sel.clear();
      this.cwd = r.path;
      this.entries = r.entries;
      this.showMsg('');
      this.render();
    } catch (e) {
      toast(e.message, 2500);
      if (this.cwd === null) this.showMsg(e.message);
    }
  }

  // 터미널 폴더 따라가기
  async followTerminal(force) {
    if (!this.follow || this.followBroken || !this.s.sid) return;
    if (!this.visible) { this.followPending = true; return; }
    this.followPending = false;
    const broken = () => {
      this.followBroken = true;
      this.el.querySelector('.sf-follow').title = L('이 서버에서는 지원되지 않습니다 (Linux /proc 필요)');
      this.el.querySelector('.sf-follow').classList.add('broken');
    };
    try {
      const r = await this.call('termcwd');
      if (!r.path) { if (force) broken(); return; }
      if (r.path !== this.cwd) await this.list(r.path);
    } catch { if (force) broken(); }
  }

  cwdToTerminal() {
    if (!this.cwd) return;
    sendInput(this.s, new TextEncoder().encode(`cd ${shQuote(this.cwd)}\r`));
    this.s.term.focus();
  }

  copyPath(p) { navigator.clipboard?.writeText(p).then(() => toast(L('경로 복사됨'), 900)); }

  // ── 목록 ──
  render() {
    this.el.querySelector('.sf-path').value = this.cwd;
    const box = this.el.querySelector('.sf-list');
    box.innerHTML = '';
    if (this.cwd !== '/') {
      const up = document.createElement('div');
      up.className = 'sf-row dir up';
      up.innerHTML = '<span class="nm"><i>📁</i>..</span>';
      up.ondblclick = () => this.list(parentPath(this.cwd));
      box.appendChild(up);
    }
    if (!this.entries.length) {
      const e = document.createElement('div');
      e.className = 'sf-empty';
      e.textContent = L('빈 폴더');
      box.appendChild(e);
    }
    this.entries.forEach((e, idx) => {
      const row = document.createElement('div');
      row.className = 'sf-row' + (e.dir ? ' dir' : '');
      row.dataset.name = e.name;
      row.title = `${e.perm}  ${e.owner}:${e.group}  ${e.name}`;
      row.innerHTML = `<span class="nm"><i></i><b></b></span><span class="sz"></span><span class="c-perm"></span><span class="c-own"></span><span class="c-time"></span>`;
      row.querySelector('i').textContent = e.dir ? '📁' : e.link ? '🔗' : '📄';
      row.querySelector('b').textContent = e.name + (e.link && e.dir ? '/' : '');
      row.querySelector('.sz').textContent = e.dir ? '' : fmtSize(e.size);
      row.querySelector('.c-perm').textContent = e.perm;
      row.querySelector('.c-own').textContent = e.owner;
      row.querySelector('.c-time').textContent = fmtTime(e.mtime);
      row.onclick = (ev) => this.select(idx, ev);
      row.ondblclick = () => this.open(e);
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        if (!this.sel.has(e.name)) { this.sel = new Set([e.name]); this.anchor = idx; this.paintSel(); }
        this.rowMenu(ev.clientX, ev.clientY);
      };
      box.appendChild(row);
    });
    this.paintSel();
  }

  select(idx, ev) {
    const name = this.entries[idx].name;
    if (ev.shiftKey && this.anchor != null) {
      const [a, b] = [Math.min(this.anchor, idx), Math.max(this.anchor, idx)];
      if (!ev.ctrlKey) this.sel.clear();
      for (let i = a; i <= b; i++) this.sel.add(this.entries[i].name);
    } else if (ev.ctrlKey || ev.metaKey) {
      this.sel.has(name) ? this.sel.delete(name) : this.sel.add(name);
      this.anchor = idx;
    } else {
      this.sel = new Set([name]);
      this.anchor = idx;
    }
    this.paintSel();
    this.el.querySelector('.sf-list').focus();
  }
  paintSel() {
    $$('.sf-row[data-name]', this.el).forEach((r) => r.classList.toggle('sel', this.sel.has(r.dataset.name)));
  }
  selected() { return this.entries.filter((e) => this.sel.has(e.name)); }

  onKey(e) {
    const sel = this.selected();
    if (e.key === 'Backspace') { e.preventDefault(); this.list(parentPath(this.cwd)); }
    else if (e.key === 'F5') { e.preventDefault(); this.list(this.cwd, true); }
    else if (e.key === 'Delete' && sel.length) { e.preventDefault(); this.remove(sel); }
    else if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); this.rename(sel[0]); }
    else if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); this.open(sel[0]); }
    else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); this.sel = new Set(this.entries.map((x) => x.name)); this.paintSel(); }
  }

  rowMenu(x, y) {
    const sel = this.selected();
    const one = sel.length === 1 ? sel[0] : null;
    const n = sel.length;
    showMenu(x, y, [
      one?.dir ? { label: L('열기'), action: () => this.open(one) } : null,
      one && !one.dir ? { label: L('편집'), hint: L('더블클릭'), action: () => openEditor(this, one) } : null,
      { label: n > 1 ? L('다운로드 ({n}개)', { n }) : one.dir ? L('폴더 다운로드…') : L('다운로드'), action: () => this.download(sel) },
      '-',
      one ? { label: L('이름 바꾸기'), hint: 'F2', action: () => this.rename(one) } : null,
      { label: L('권한 / 소유자…'), action: () => openChmod(this, sel) },
      one ? { label: L('경로 복사'), action: () => this.copyPath(joinPath(this.cwd, one.name)) } : null,
      one?.dir ? { label: L('터미널에서 이 폴더로 cd'), action: () => { this.cwd = joinPath(this.cwd, one.name); this.cwdToTerminal(); this.list(this.cwd); } } : null,
      '-',
      { label: n > 1 ? L('삭제 ({n}개)', { n }) : L('삭제'), hint: 'Del', danger: true, action: () => this.remove(sel) },
    ]);
  }

  open(e) {
    if (e.dir) return this.list(joinPath(this.cwd, e.name));
    if (e.size > 10 * 1024 * 1024) return this.download([e]);
    openEditor(this, e);
  }

  // ── 파일 작업 ──
  async mkdir() {
    const name = prompt(L('새 폴더 이름'));
    if (!name) return;
    try { await this.call('mkdirs', { path: joinPath(this.cwd, name) }); this.list(this.cwd); }
    catch (e) { toast(e.message, 2500); }
  }
  async mkfile() {
    const name = prompt(L('새 파일 이름'));
    if (!name) return;
    if (this.entries.some((x) => x.name === name)) return toast(L('이미 있는 이름입니다'));
    try {
      await this.call('write', { path: joinPath(this.cwd, name), text: '' });
      await this.list(this.cwd);
      const e = this.entries.find((x) => x.name === name);
      if (e) openEditor(this, e);
    } catch (e) { toast(e.message, 2500); }
  }
  async rename(e) {
    const name = prompt(L('새 이름'), e.name);
    if (!name || name === e.name) return;
    try { await this.call('rename', { from: joinPath(this.cwd, e.name), to: joinPath(this.cwd, name) }); this.list(this.cwd); }
    catch (err) { toast(err.message, 2500); }
  }
  async remove(sel) {
    const dirs = sel.filter((e) => e.dir).length;
    const names = sel.slice(0, 8).map((e) => (e.dir ? '📁 ' : '📄 ') + e.name).join('\n') + (sel.length > 8 ? '\n…' : '');
    if (!confirm(L('{n}개 항목을 삭제할까요?', { n: sel.length }) + (dirs ? '\n' + L('⚠ 폴더 {n}개는 안의 내용까지 모두 삭제됩니다.', { n: dirs }) : '') + '\n\n' + names)) return;
    let n = 0;
    for (const e of sel) {
      try {
        const r = await this.call(e.dir ? 'rmtree' : 'remove', { path: joinPath(this.cwd, e.name) });
        n += r.count || 1;
      } catch (err) { toast(`${e.name}: ${err.message}`, 3000); }
    }
    toast(L('{n}개 삭제됨', { n }));
    this.list(this.cwd);
  }

  // ── 전송 ──
  addXfer(icon, name) {
    const row = document.createElement('div');
    row.className = 'sf-xfer';
    row.innerHTML = `<span class="d"></span><span class="n"></span><progress max="1" value="0"></progress><span class="p"></span><button title="${L('취소')}">✕</button>`;
    row.querySelector('.d').textContent = icon;
    row.querySelector('.n').textContent = name;
    row.title = name;
    this.el.querySelector('.sf-xfers').appendChild(row);
    const x = {
      finished: false, onCancel: null,
      progress(done, total) {
        row.querySelector('progress').value = total ? done / total : 0;
        row.querySelector('.p').textContent = total ? Math.floor((done / total) * 100) + '%' : fmtSize(done);
      },
      note(t) { row.querySelector('.p').textContent = t; },
      ok(msg) {
        x.finished = true;
        row.classList.add('ok');
        row.querySelector('progress').value = 1;
        row.querySelector('.p').textContent = msg || L('완료');
        setTimeout(() => row.remove(), 4000);
      },
      fail(msg) {
        if (x.finished) return;
        x.finished = true;
        row.classList.add('bad');
        row.querySelector('.p').textContent = msg;
        row.title = `${name}\n${msg}`;
      },
    };
    row.querySelector('button').onclick = () => {
      if (x.finished) return row.remove();
      x.onCancel?.();
      x.fail(L('취소됨'));
    };
    return x;
  }

  // 전송 작업은 탭마다 하나씩 순서대로 (각 작업은 전용 채널 사용)
  job(fn) {
    const p = this.jobs.then(fn, fn);
    this.jobs = p.catch(() => {});
    return p;
  }

  async getInto(c, path, size, sink, x, base, total) {
    c.send({ id: 1, op: 'get', path });
    const head = await c.recv();
    if (head.error) throw new Error(`${baseName(path)}: ${head.error}`);
    let got = 0;
    for (;;) {
      const d = await c.recv();
      if (d instanceof ArrayBuffer) {
        await sink(d);
        got += d.byteLength;
        x.progress(base + got, total || head.size);
        continue;
      }
      if (d.error) throw new Error(d.error);
      if (d.done) return got;
    }
  }

  download(sel) {
    const multi = sel.length > 1 || sel.some((e) => e.dir);
    if (!multi) return this.job(() => this.downloadFile(sel[0]));
    if (!window.showDirectoryPicker) return toast(L('폴더 다운로드는 크롬/엣지에서만 됩니다'), 3000);
    // 사용자 제스처 안에서 폴더 선택창을 먼저 띄움
    window.showDirectoryPicker({ id: 'webssh-dl', mode: 'readwrite' }).then(
      (dir) => this.job(() => this.downloadTree(sel, dir)),
      () => {});
  }

  async downloadFile(e) {
    const path = joinPath(this.cwd, e.name);
    const x = this.addXfer('⬇', e.name);
    let c;
    try {
      c = await openChan(this.s.sid);
      x.onCancel = () => c.close();
      const chunks = [];
      await this.getInto(c, path, e.size, (d) => chunks.push(d), x, 0, e.size);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks));
      a.download = e.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      x.ok();
    } catch (err) { x.fail(err.message); } finally { c?.close(); }
  }

  async downloadTree(sel, dirHandle) {
    const label = sel.length === 1 ? sel[0].name : L('{n}개 항목', { n: sel.length });
    const x = this.addXfer('⬇', label);
    let c;
    try {
      c = await openChan(this.s.sid);
      x.onCancel = () => c.close();
      x.note(L('목록 읽는 중…'));
      const files = [];
      const dirs = [];
      for (const e of sel) {
        const path = joinPath(this.cwd, e.name);
        if (e.dir) {
          dirs.push(e.name);
          const r = await c.req({ op: 'walk', path });
          for (const w of r.entries) {
            if (w.dir) dirs.push(`${e.name}/${w.rel}`);
            else files.push({ rel: `${e.name}/${w.rel}`, path: `${path}/${w.rel}`, size: w.size });
          }
        } else files.push({ rel: e.name, path, size: e.size });
      }
      const total = files.reduce((a, f) => a + f.size, 0);
      const dirCache = new Map([['', dirHandle]]);
      const getDir = async (rel) => {
        if (dirCache.has(rel)) return dirCache.get(rel);
        const i = rel.lastIndexOf('/');
        const parent = await getDir(i < 0 ? '' : rel.slice(0, i));
        const h = await parent.getDirectoryHandle(rel.slice(i + 1), { create: true });
        dirCache.set(rel, h);
        return h;
      };
      for (const d of dirs) await getDir(d);
      let done = 0;
      for (const f of files) {
        if (c.closed) throw new Error(L('취소됨'));
        const i = f.rel.lastIndexOf('/');
        const dir = await getDir(i < 0 ? '' : f.rel.slice(0, i));
        const fh = await dir.getFileHandle(f.rel.slice(i + 1), { create: true });
        const w = await fh.createWritable();
        try {
          done += await this.getInto(c, f.path, f.size, (d) => w.write(d), x, done, total);
        } finally { await w.close(); }
      }
      x.ok(L('{n}개 파일', { n: files.length }));
    } catch (err) { x.fail(err.message); } finally { c?.close(); }
  }

  upload(items) {
    if (!items.length || !this.cwd) return;
    const files = items.filter((i) => i.file);
    const names = new Set(this.entries.map((e) => e.name));
    const tops = [...new Set(items.map((i) => i.rel.split('/')[0]))];
    const dup = tops.filter((n) => names.has(n));
    if (dup.length && !confirm(`${L('이미 있는 항목을 덮어씁니다:')}\n${dup.slice(0, 10).join('\n')}${dup.length > 10 ? '\n…' : ''}`)) return;
    const dir = this.cwd;
    const label = items.length === 1 ? items[0].rel : tops.length === 1 ? `${tops[0]} (${L('{n}개', { n: files.length })})` : L('{n}개 파일', { n: files.length });
    const x = this.addXfer('⬆', label);
    this.job(() => this.uploadJob(items, dir, x)).then(() => { if (this.cwd === dir) this.list(dir, true); });
  }

  async uploadJob(items, dir, x) {
    if (x.finished) return;
    const CHUNK = 256 * 1024, HIGH = 4 * 1024 * 1024;
    let c;
    try {
      c = await openChan(this.s.sid);
      x.onCancel = () => c.close();
      const dirs = new Set();
      for (const it of items) {
        const parts = it.rel.split('/');
        const upto = it.dir ? parts.length : parts.length - 1;
        for (let i = 1; i <= upto; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      for (const d of [...dirs].sort()) await c.req({ op: 'mkdirs', path: joinPath(dir, d) });
      const files = items.filter((i) => i.file);
      const total = files.reduce((a, i) => a + i.file.size, 0);
      let done = 0;
      for (const { file, rel } of files) {
        await c.req({ op: 'put', path: joinPath(dir, rel) });
        for (let off = 0; off < file.size; off += CHUNK) {
          while (c.buffered > HIGH) {
            if (c.closed) throw new Error(L('연결 끊김'));
            await sleep(15);
          }
          if (c.closed) throw new Error(x.finished ? L('취소됨') : L('연결 끊김'));
          c.send(await file.slice(off, off + CHUNK).arrayBuffer());
          x.progress(Math.max(0, done + off + CHUNK - c.buffered), total);
        }
        c.send({ op: 'put_end' });
        const d = await c.recv();
        if (d.error) throw new Error(`${rel}: ${d.error}`);
        done += file.size;
      }
      x.ok(files.length > 1 ? L('{n}개 파일', { n: files.length }) : L('완료'));
    } catch (err) { x.fail(err.message); } finally { c?.close(); }
  }
}

// ── 원격 파일 편집기 ─────────────────────────────────────
const editor = { panel: null, path: null, info: null, dirty: false };

async function openEditor(panel, e) {
  if (editor.dirty && $('#editorDlg').open && !confirm(L('저장하지 않은 변경 내용이 있습니다. 버리고 다른 파일을 열까요?'))) return;
  const path = joinPath(panel.cwd, e.name);
  let r;
  try { r = await panel.call('read', { path }); }
  catch (err) {
    if (err.code === 'binary' || err.code === 'toobig') {
      if (confirm(`${err.message}\n${L('대신 다운로드할까요?')}`)) panel.download([e]);
    } else toast(err.message, 3000);
    return;
  }
  Object.assign(editor, { panel, path, info: r, dirty: false });
  $('#edPath').textContent = `${targetStr(panel.s.spec)}:${path}`;
  const ta = $('#edText');
  ta.value = r.text;
  ta.readOnly = false;
  const warn = $('#edWarn');
  warn.hidden = !r.lossy;
  warn.textContent = r.lossy ? L('⚠ {enc}로 읽을 수 없는 바이트가 있어 일부 글자가 깨져 보입니다. 저장하면 그 부분이 손상됩니다.', { enc: r.enc }) : '';
  edInfo();
  edGutter();
  const dlg = $('#editorDlg');
  if (!dlg.open) dlg.showModal();
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

function edInfo() {
  const r = editor.info;
  $('#edInfo').textContent = `${r.enc.toUpperCase()} · ${r.crlf ? 'CRLF' : 'LF'} · ${L('{n}줄', { n: $('#edText').value.split('\n').length })}${editor.dirty ? ' · ' + L('수정됨') : ''}`;
}
function edGutter() {
  const n = $('#edText').value.split('\n').length;
  const g = $('#edGutter');
  if (g.dataset.n != n) {
    g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    g.dataset.n = n;
  }
  g.scrollTop = $('#edText').scrollTop;
}

async function edSave(force) {
  const { panel, path, info } = editor;
  if (!panel) return;
  if (info.lossy && !force && !confirm(L('깨진 글자가 있는 파일입니다. 그래도 저장할까요?'))) return;
  let text = $('#edText').value;
  if (info.crlf) text = text.replace(/\r?\n/g, '\r\n');
  try {
    const r = await panel.call('write', { path, text, enc: info.enc, mtime: force ? null : info.mtime, force: !!force });
    info.mtime = r.mtime;
    editor.dirty = false;
    edInfo();
    toast(L('저장됨'), 900);
    if (panel.cwd === parentPath(path)) panel.list(panel.cwd, true);
  } catch (e) {
    if (e.code === 'conflict') {
      if (confirm(L('편집하는 동안 서버에서 파일이 바뀌었습니다.\n내 내용으로 덮어쓸까요?'))) edSave(true);
    } else toast(L('저장 실패: {msg}', { msg: e.message }), 3500);
  }
}

(() => {
  const ta = $('#edText');
  ta.addEventListener('input', () => { if (!editor.dirty) { editor.dirty = true; } edInfo(); edGutter(); });
  ta.addEventListener('scroll', () => { $('#edGutter').scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      edSave();
    }
  });
  $('#edSave').onclick = () => edSave();
  const close = () => {
    if (editor.dirty && !confirm(L('저장하지 않은 변경 내용이 있습니다. 닫을까요?'))) return false;
    editor.dirty = false;
    $('#editorDlg').close();
    editor.panel?.s.term.focus();
    return true;
  };
  $('#edClose').onclick = close;
  $('#editorDlg').addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Esc
})();

// ── 권한 / 소유자 ──────────────────────────────────────
async function openChmod(panel, sel) {
  const dlg = $('#chmodDlg');
  const f = dlg.querySelector('form');
  const first = sel[0];
  $('#cmPath').textContent = sel.length === 1 ? joinPath(panel.cwd, first.name) : L('{n}개 항목', { n: sel.length });
  const boxes = $$('input[data-bit]', dlg);
  const setMode = (m) => {
    boxes.forEach((b) => { b.checked = !!(m & +b.dataset.bit); });
    f.octal.value = (m & 0o7777).toString(8).padStart(3, '0');
  };
  setMode(first.mode);
  boxes.forEach((b) => { b.onchange = () => setMode((parseInt(f.octal.value, 8) & 0o7000) | boxes.reduce((a, x) => a | (x.checked ? +x.dataset.bit : 0), 0)); });
  f.octal.oninput = () => { if (/^[0-7]{3,4}$/.test(f.octal.value)) boxes.forEach((b) => { b.checked = !!(parseInt(f.octal.value, 8) & +b.dataset.bit); }); };
  f.owner.value = first.owner;
  f.group.value = first.group;
  f.recursive.checked = false;
  $('#cmRecRow').hidden = !sel.some((e) => e.dir);
  if ((await dialogResult(dlg)) !== 'ok') return;
  if (!/^[0-7]{3,4}$/.test(f.octal.value)) return toast(L('8진수 권한 형식이 올바르지 않습니다 (예: 755)'));
  const mode = parseInt(f.octal.value, 8);
  const rec = f.recursive.checked;
  let errs = 0;
  for (const e of sel) {
    const path = joinPath(panel.cwd, e.name);
    try {
      if (mode !== e.mode || rec) await panel.call('chmod', { path, mode, recursive: rec && e.dir });
      if (f.owner.value !== e.owner || f.group.value !== e.group) {
        await panel.call('chown', { path, owner: f.owner.value, group: f.group.value, recursive: rec && e.dir });
      }
    } catch (err) { errs++; toast(`${e.name}: ${err.message}`, 3500); }
  }
  if (!errs) toast(L('적용됨'), 900);
  panel.list(panel.cwd, true);
}
