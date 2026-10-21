"""서버 메시지 번역: 한국어 원문을 키로 쓰는 사전(static/i18n.js 와 같은 방식). 사전에 없으면 원문 그대로.

언어는 연결마다 다를 수 있어 ContextVar 로 둔다. server.handler 가 브라우저가 보낸 ?lang= 으로 정하고,
그 연결에서 만든 작업·asyncio.to_thread 로 넘긴 스레드는 같은 값을 본다. 콘솔 출력처럼 연결과 무관한 곳은
Windows 표시 언어를 따른다.
"""
import contextvars
import os


def _os_lang():
    try:
        if os.name == "nt":
            import ctypes
            return "ko" if ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF == 0x12 else "en"  # 0x12 = 한국어
        import locale
        return "ko" if (locale.getlocale()[0] or "").lower().startswith("ko") else "en"
    except Exception:
        return "en"


DEFAULT = _os_lang()
LANG = contextvars.ContextVar("lang", default=DEFAULT)


def set_lang(lang):
    LANG.set(lang if lang in ("ko", "en") else DEFAULT)


def L(text, **kw):
    """L("원문 {x}", x=...) → 현재 언어의 문장."""
    s = EN.get(text, text) if LANG.get() == "en" else text
    return s.format(**kw) if kw else s


EN = {
    # server.py — 콘솔·메시지 창
    "필요한 패키지가 없습니다: {name}\n\n'run.bat'을 한 번 실행하면 자동으로 설치됩니다.":
        "A required package is missing: {name}\n\nRun 'run.bat' once to install it automatically.",
    "시작": "started", "종료": "stopped", "접속": "connected",
    "접속 토큰이 필요합니다. 서버 콘솔에 출력된 URL로 접속하세요.":
        "An access token is required. Open the URL printed in the server console.",
    "로컬 CA 생성: {path}": "Created local CA: {path}",
    "인증서 신뢰 등록 중… Windows 보안 경고 창에서 '예'를 누르세요.":
        "Registering the certificate as trusted… click 'Yes' in the Windows security warning.",
    "  → 등록 완료 (크롬이 이미 켜져 있었다면 크롬을 다시 시작하세요)":
        "  → Done (restart Chrome if it was already running)",
    "  → 등록 안 됨. 브라우저에서 '고급 → 계속'으로 접속하거나 다시 --trust로 실행하세요.":
        "  → Not registered. Proceed via 'Advanced → Continue' in the browser, or run again with --trust.",
    "※ 로컬 CA가 아직 신뢰되지 않음 → 브라우저 경고가 뜹니다. `python server.py --trust` 1회 실행 권장.":
        "※ The local CA is not trusted yet, so the browser will warn. Run `python server.py --trust` once.",
    "브라우저 창이 닫혀 있어 자동 종료합니다.": "All browser windows are closed — exiting automatically.",
    "바인딩 주소 (기본 127.0.0.1)": "bind address (default 127.0.0.1)",
    "접속 토큰 (외부 바인딩 시 미지정이면 자동 생성)": "access token (generated automatically when binding externally)",
    "크롬 앱 창으로 열기": "open in a Chrome app window",
    "로컬 CA를 현재 사용자 신뢰 루트에 등록 (최초 1회)": "trust the local CA for the current user (once)",
    "HTTPS 끄기 (평문 HTTP)": "disable HTTPS (plain HTTP)",
    "브라우저 창을 모두 닫고 1분 지나면 종료 (터널 실행 중이면 유지)":
        "exit 1 minute after all browser windows close (stays up while a tunnel runs)",
    "이미 실행 중 → 창만 엽니다.": "Already running → opening a window only.",
    "포트 {port}를 다른 프로그램이 쓰고 있습니다. --port 로 다른 포트를 지정하세요.":
        "Port {port} is used by another program. Choose another port with --port.",
    "{app} 실행 중 → {url}": "{app} running → {url}",
    "  (다른 PC에서는 이 PC의 IP로 접속, 인증서 경고 없애려면 /ca.crt 받아서 신뢰 등록)":
        "  (From other PCs, use this PC's IP. To avoid certificate warnings, download /ca.crt and trust it.)",
    "  ※ 외부 바인딩이라 로컬 터미널·RDP 실행·파일 선택 기능은 꺼져 있습니다.":
        "  ※ Bound externally: local terminal, RDP launch and file picker are disabled.",
    "종료: 화면의 ⚙설정 → 서버 종료": "To stop: ⚙ Settings → Stop server", " 또는 Ctrl+C": " or Ctrl+C",
    "종료됨": "Stopped",
    "실행 중 오류로 종료됐습니다:\n{e}\n\n자세한 내용: data\\server.log":
        "Stopped because of an error:\n{e}\n\nDetails: data\\server.log",
    # api.py
    "저장된 항목을 찾을 수 없습니다 (다른 창에서 삭제됨?)": "Saved item not found (deleted in another window?)",
    "개인키 파일 선택": "Select private key file",
    "이 기능은 서버가 127.0.0.1로 실행 중일 때만 쓸 수 있습니다": "This is only available when the server runs on 127.0.0.1",
    "명령 프롬프트": "Command Prompt",
    # localterm.py
    "실행 실패: {e}": "Failed to start: {e}",
    # sftp.py
    "파일/폴더가 없습니다": "No such file or folder", "권한이 없습니다": "Permission denied", "이미 존재합니다": "Already exists",
    "실패 (폴더가 비어 있지 않거나 권한 문제일 수 있음)": "Failed (the folder may not be empty, or permission denied)",
    "SFTP를 열 수 없습니다: {err}": "Cannot open SFTP: {err}",
    "파일이 너무 많습니다 ({n}개 초과)": "Too many files (over {n})",
    "같은 이름의 파일이 있습니다": "A file with the same name exists",
    "소유자/그룹 이름이 올바르지 않습니다": "Invalid owner/group name",
    "chown 실패 (root 권한이 필요할 수 있음)": "chown failed (root may be required)",
    "파일이 너무 큽니다 ({mb}MB 초과) — 다운로드해서 여세요": "File too large (over {mb} MB) — download it instead",
    "바이너리 파일이라 편집할 수 없습니다": "Binary files cannot be edited",
    "편집하는 동안 서버의 파일이 바뀌었습니다": "The file changed on the server while you were editing",
    "{enc}로 저장할 수 없는 문자가 있습니다: {ch}": "Some characters cannot be saved as {enc}: {ch}",
    # sshconn.py
    "PuTTY .ppk 키는 지원하지 않습니다. PuTTYgen → Conversions → Export OpenSSH key로 변환하세요.":
        "PuTTY .ppk keys are not supported. Convert with PuTTYgen → Conversions → Export OpenSSH key.",
    "키 암호가 틀렸습니다": "Wrong key passphrase",
    "개인키를 읽을 수 없습니다 (지원: Ed25519/ECDSA/RSA, OpenSSH·PEM 형식)":
        "Cannot read the private key (supported: Ed25519/ECDSA/RSA in OpenSSH or PEM format)",
    "개인키 파일 경로가 비어 있습니다": "The private key file path is empty",
    "개인키 파일을 열 수 없습니다: {path} ({err})": "Cannot open the private key file: {path} ({err})",
    "사용자가 호스트 키를 거부했습니다": "The host key was rejected by the user",
    "점프 호스트({host})": "jump host ({host})", "점프 호스트 → {host} 연결": "jump host → {host}",
    "대상 서버({host})": "target ({host})",
    "{stage}개인키에 암호가 걸려 있습니다.": "{stage}The private key is encrypted.",
    "{stage}⚠ 호스트 키가 저장된 값과 다릅니다! (MITM 가능성)\n저장됨: {expected}\n수신됨: {got}\n"
    "서버를 재설치한 게 확실하면 known_hosts 파일에서 해당 줄을 지우세요.":
        "{stage}⚠ The host key does not match the saved one! (possible MITM)\nSaved: {expected}\nReceived: {got}\n"
        "If you are sure the server was reinstalled, delete its line from the known_hosts file.",
    "{stage}인증 실패 — 사용자명/비밀번호/키를 확인하세요.": "{stage}Authentication failed — check the user name, password or key.",
    "{stage}실패 — 점프 호스트가 대상에 연결하지 못했습니다 (주소/포트/AllowTcpForwarding 확인)":
        "{stage}Failed — the jump host could not reach the target (check address, port, AllowTcpForwarding)",
    "{stage}접속 실패: {err}": "{stage}Connection failed: {err}",
    # term.py
    "로그 파일을 만들 수 없습니다: {e}": "Cannot create the log file: {e}",
    # tunnels.py
    "로컬 포트 {port}를 열 수 없습니다 (이미 사용 중?): {err}": "Cannot open local port {port} (already in use?): {err}",
    "SSH 연결 끊김 — 재연결 중": "SSH disconnected — reconnecting",
    " — 5초 후 재시도": " — retrying in 5s",
    "SSH 연결 없음": "No SSH connection",
}
