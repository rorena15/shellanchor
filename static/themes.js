'use strict';
/* 화면 테마(라이트/다크/Windows 따라가기)와 터미널 색 구성. 브라우저별로 저장(localStorage). */

const TERM_SCHEMES = {
  light: {
    name: L('밝게 (One Half Light)'), background: '#fafafa', foreground: '#383a42', cursor: '#4f525d', cursorAccent: '#fafafa',
    selectionBackground: '#bfceff99',
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#8e9097',
    brightBlack: '#696c77', brightRed: '#ca1243', brightGreen: '#3e8f3d', brightYellow: '#986801', brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#383a42',
  },
  solarizedLight: {
    name: 'Solarized Light', background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3',
    selectionBackground: '#d3cbb7aa',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#073642',
  },
  classic: {   // 클래식 다크 (글자 236,236,236 / 배경 30,30,30 / 커서 180,180,192)
    name: L('클래식 다크'), background: '#1e1e1e', foreground: '#ececec', cursor: '#b4b4c0', cursorAccent: '#1e1e1e',
    selectionBackground: '#4a5a7a99',
    black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00', blue: '#3b78ff', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5',
    brightBlack: '#7f7f7f', brightRed: '#ff3333', brightGreen: '#33ff33', brightYellow: '#ffff33', brightBlue: '#6c8cff', brightMagenta: '#ff33ff', brightCyan: '#33ffff', brightWhite: '#ffffff',
  },
  campbell: {
    name: 'Windows Terminal (Campbell)', background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#0c0c0c',
    selectionBackground: '#ffffff40',
    black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
    brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
  },
  dark: {
    name: L('어둡게 (기본 다크)'), background: '#1e1f24', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#1e1f24',
    selectionBackground: '#4f8cff66',
    black: '#2e3036', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#4f8cff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d0d4dc',
    brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
  solarizedDark: {
    name: 'Solarized Dark', background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36',
    selectionBackground: '#0a4a5a',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  dracula: {
    name: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
};

const UI_THEMES = { light: L('라이트'), dark: L('다크'), system: L('Windows 설정 따라가기') };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function uiThemeSetting() { return store.get('uiTheme', 'light'); }
function currentUi(pref = uiThemeSetting()) { return pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref; }
function schemeKey(pref = store.get('termScheme', 'auto'), ui = currentUi()) {
  if (pref === 'moba') pref = 'classic';   // 예전 이름으로 저장된 설정 호환
  return pref === 'auto' || !TERM_SCHEMES[pref] ? (ui === 'dark' ? 'dark' : 'light') : pref;
}
function termTheme(key = schemeKey()) {
  const { name, ...t } = TERM_SCHEMES[key];
  return t;
}

// 배경이 밝은지 (하이라이트 색 보정용)
function isLightColor(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}
// 어두운 배경용으로 고른 하이라이트 색을 밝은 배경에서도 읽히게 진하게
function adaptHighlight(hex) {
  if (!isLightColor(TERM_SCHEMES[schemeKey()].background) || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * 0.62));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// 주의: id="tabs" 요소 때문에 app.js가 로드되기 전엔 전역 tabs가 DOM 요소로 보임 → 배열인지 확인
const openTabs = () => (typeof tabs !== 'undefined' && Array.isArray(tabs) ? tabs : []);

function applyTheme(uiPref = uiThemeSetting(), termPref = store.get('termScheme', 'auto')) {
  const ui = currentUi(uiPref);
  document.documentElement.dataset.theme = ui;
  const key = schemeKey(termPref, ui);
  document.documentElement.style.setProperty('--term-bg', TERM_SCHEMES[key].background);
  const t = termTheme(key);
  openTabs().forEach((s) => { s.term.options.theme = t; });
  if (typeof compileHighlight === 'function' && typeof SETTINGS !== 'undefined') {
    compileHighlight(SETTINGS.highlight);
    openTabs().forEach((s) => s.hl.reset());
  }
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = ui === 'dark' ? '☾' : '☀';
}

darkQuery.addEventListener('change', () => { if (uiThemeSetting() === 'system') applyTheme(); });
applyTheme();
