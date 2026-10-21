'use strict';
/* 키워드 하이라이트
 * 출력 스트림을 바꾸지 않고 xterm 데코레이션으로 글자색만 덧칠한다 → 로그·복사 내용은 원본 그대로.
 * 전체화면 프로그램(vim, top 등 alternate buffer)에서는 동작하지 않음. */

let HL_RULES = [];
function compileHighlight(rules) {
  HL_RULES = [];
  for (const r of rules || []) {
    if (!r.on || !r.pattern) continue;
    try { HL_RULES.push({ re: new RegExp(r.pattern, 'gi'), color: typeof adaptHighlight === 'function' ? adaptHighlight(r.color) : r.color }); } catch { /* 잘못된 정규식은 무시 */ }
  }
}

class Highlighter {
  constructor(term) {
    this.term = term;
    this.mark = null;          // 마지막으로 확정한 줄 위치 (스크롤백이 잘려도 따라 움직이는 마커)
    this.live = [];            // 아직 바뀔 수 있는(커서가 있는) 줄의 데코레이션
    this.all = new Set();      // 전체 데코레이션 (테마 바꿀 때 다시 칠하기 위해)
    this.raf = 0;
    this.cell = null;
    term.onWriteParsed(() => this.schedule());
  }

  // 규칙·색이 바뀌면 기존 색칠을 지우고 최근 2000줄을 다시 칠함
  reset() {
    for (const d of [...this.all]) d.dispose();
    this.all.clear();
    this.live = [];
    this.mark?.dispose();
    this.mark = null;
    this.full = true;
    this.scan();
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.scan(); });
  }

  scan() {
    const t = this.term, b = t.buffer.active;
    if (b.type !== 'normal' || !HL_RULES.length) return;
    const cur = b.baseY + b.cursorY;
    let from = this.mark && !this.mark.isDisposed && this.mark.line >= 0 ? this.mark.line : Math.max(0, cur - (this.full ? 2000 : t.rows));
    this.full = false;
    if (from > cur) from = cur;
    if (cur - from > 2000) from = cur - 2000;           // 대량 출력 시 마지막 2000줄만
    for (const d of this.live) d.dispose();
    this.live = [];
    for (let y = from; y <= cur; y++) {
      const decos = this.line(y, cur);
      if (y === cur) this.live.push(...decos);
    }
    this.mark?.dispose();
    this.mark = t.registerMarker(0);
  }

  line(y, cur) {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return [];
    // 셀 단위로 문자열을 만들면서 문자 위치 → 열 위치 대응표 작성 (한글 등 2칸 문자 대응)
    let str = '';
    const col = [], wid = [];
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x, this.cell);
      this.cell = c;
      const w = c.getWidth();
      if (w === 0) continue;
      const ch = c.getChars() || ' ';
      for (let i = 0; i < ch.length; i++) { col.push(x); wid.push(w); }
      str += ch;
    }
    const s = str.trimEnd();
    if (!s) return [];
    const out = [];
    let marker = null;
    const taken = new Uint8Array(s.length);
    for (const r of HL_RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(s))) {
        if (!m[0]) { r.re.lastIndex++; continue; }
        const a = m.index, z = a + m[0].length - 1;
        if (taken.subarray(a, z + 1).some((v) => v)) continue;   // 앞 규칙이 이미 칠한 곳은 건너뜀
        taken.fill(1, a, z + 1);
        marker ||= this.term.registerMarker(y - cur);
        if (!marker) return out;
        const d = this.term.registerDecoration({
          marker, x: col[a], width: col[z] + wid[z] - col[a], foregroundColor: r.color, layer: 'top',
        });
        if (d) {
          out.push(d);
          this.all.add(d);
          d.onDispose(() => this.all.delete(d));
          marker.onDispose(() => d.dispose());
        }
      }
    }
    if (marker && !out.length) marker.dispose();
    if (marker && out.length) {
      const orig = out[0].dispose.bind(out[0]);
      out[0].dispose = () => { orig(); marker.dispose(); };
    }
    return out;
  }
}
