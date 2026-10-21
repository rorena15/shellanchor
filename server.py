"""ShellAnchor — 브라우저 SSH 클라이언트의 중계 서버.

실행:  python server.py --open --trust  → 크롬 앱 창 + 로컬 CA 신뢰 등록(최초 1회)
       python server.py                 → https://127.0.0.1:8022 (이 PC에서만)
       python server.py --host 0.0.0.0  → 다른 PC에서도 접속 (토큰 필수, 로컬 터미널·RDP 실행은 꺼짐)

WebSocket 경로
  /ws     SSH 터미널 (term.py)          /sftp   SFTP (sftp.py, 터미널 세션에 붙음)
  /local  로컬 터미널 (localterm.py)    /api    세션 트리·설정·터널·RDP (api.py)

보안 메모
- 기본 바인딩 127.0.0.1. 외부 바인딩 시 토큰 없으면 403, 이 PC를 조작하는 기능(로컬 터미널/RDP/파일 선택)은 비활성.
- HTTPS: certs/ 로컬 CA(Name Constraints로 localhost·사설 IP만 발급 가능).
- WebSocket Origin 검사로 CSWSH 차단. 비밀번호/키 암호는 저장하지 않음.
- 호스트 키 TOFU (known_hosts), 키가 바뀌면 접속 거부.
"""
import argparse
import asyncio
import hmac
import mimetypes
import os
import secrets
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
import webbrowser
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from i18n import L, set_lang

APP_NAME = "ShellAnchor"
HIDDEN = sys.stdout is None          # pythonw(창 없음)로 실행됨


def msgbox(text, error=True):
    """창 없이 실행 중일 때 사용자에게 알릴 방법 (Windows 메시지 상자)."""
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, APP_NAME, (0x10 if error else 0x40) | 0x40000)


if HIDDEN:   # 콘솔이 없으면 출력을 로그 파일로 (1MB 넘으면 새로 시작)
    _log = Path(os.environ.get("WEBSSH_DATA") or Path(__file__).resolve().parent / "data") / "server.log"
    _log.parent.mkdir(exist_ok=True)
    if _log.exists() and _log.stat().st_size > 1 << 20:
        _log.unlink()
    sys.stdout = sys.stderr = open(_log, "a", encoding="utf-8", buffering=1)
    print(f"\n----- {time.strftime('%Y-%m-%d %H:%M:%S')} {L('시작')} -----")

try:
    from websockets.asyncio.server import serve
    from websockets.datastructures import Headers
    from websockets.http11 import Response

    import common
    import tls
    from api import api_handler
    from localterm import local_handler
    from sftp import sftp_handler
    from term import terminal_handler
    from tunnels import manager
except ImportError as e:
    if HIDDEN:
        msgbox(L("필요한 패키지가 없습니다: {name}\n\n'run.bat'을 한 번 실행하면 자동으로 설치됩니다.", name=e.name))
    raise

TOKEN = None  # 외부 바인딩 시 설정
WS_PATHS = ("/ws", "/sftp", "/local", "/api")

# Windows 에선 mimetypes 가 레지스트리(HKCR\.js "Content Type")를 우선하는데, 다른 프로그램이
# 이를 text/plain 으로 바꿔 두는 경우가 있다. nosniff 헤더 때문에 그러면 브라우저가 JS 실행을
# 거부해 화면이 먹통이 되므로, 정적 파일에 쓰는 형식은 여기서 고정한다.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"),
                    (".css", "text/css"), (".html", "text/html"),
                    (".json", "application/json"), (".svg", "image/svg+xml"),
                    (".woff2", "font/woff2")):
    mimetypes.add_type(_type, _ext)


# ── HTTP (정적 파일) ──────────────────────────────────────────
def _resp(status, body=b"", ctype="text/plain; charset=utf-8", extra=()):
    st = HTTPStatus(status)
    headers = Headers([
        ("Content-Type", ctype),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        *extra,
    ])
    return Response(st.value, st.phrase, headers, body)


def _token_ok(query):
    if TOKEN is None:
        return True
    given = parse_qs(query).get("t", [""])[0]
    return hmac.compare_digest(given, TOKEN)


def process_request(connection, request):
    url = urlsplit(request.path)
    path = url.path

    if path in WS_PATHS:
        if not _token_ok(url.query):
            return _resp(403, b"forbidden")
        origin = request.headers.get("Origin")
        host = request.headers.get("Host", "")
        if origin not in (f"http://{host}", f"https://{host}"):
            return _resp(403, b"bad origin")
        return None  # WebSocket 핸드셰이크 진행

    if path == "/ca.crt" and tls.CA_CRT.exists():   # 다른 PC에서 CA 받아 신뢰 등록할 때
        return _resp(200, tls.CA_CRT.read_bytes(), "application/x-x509-ca-cert",
                     [("Content-Disposition", 'attachment; filename="webssh-ca.crt"')])

    if not _token_ok(url.query) and path in ("/", "/index.html"):
        return _resp(403, L("접속 토큰이 필요합니다. 서버 콘솔에 출력된 URL로 접속하세요.").encode())

    if path == "/":
        path = "/index.html"
    target = (common.STATIC / path.lstrip("/")).resolve()
    if common.STATIC not in target.parents or not target.is_file():
        return _resp(404, b"not found")
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype.endswith("javascript"):
        ctype += "; charset=utf-8"
    return _resp(200, target.read_bytes(), ctype)


async def handler(ws):
    url = urlsplit(ws.request.path)
    set_lang(parse_qs(url.query).get("lang", [""])[0])   # 이 연결에서 보내는 메시지의 언어
    if url.path == "/sftp":
        sess = common.SESSIONS.get(parse_qs(url.query).get("sid", [""])[0])
        if not sess:
            await ws.close(1008, "no session")
            return
        await sftp_handler(ws, sess)
    elif url.path == "/local":
        await local_handler(ws)
    elif url.path == "/api":
        await api_handler(ws)
    else:
        await terminal_handler(ws)


# ── 실행 ─────────────────────────────────────────────────────
def _find_chrome():
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            exe = Path(base) / "Google/Chrome/Application/chrome.exe"
            if exe.exists():
                return exe
    return None


def _open_browser(url):
    chrome = _find_chrome()
    if chrome:
        subprocess.Popen([str(chrome), f"--app={url}"])   # 주소창 없는 앱 창
    else:
        webbrowser.open(url)


def _setup_tls(want_trust):
    new_ca = tls.ensure_certs()
    if new_ca:
        print(L("로컬 CA 생성: {path}", path=tls.CA_CRT))
    trusted = tls.ca_trusted()
    if trusted is False and want_trust:
        print(L("인증서 신뢰 등록 중… Windows 보안 경고 창에서 '예'를 누르세요."))
        trusted = tls.trust_ca()
        print(L("  → 등록 완료 (크롬이 이미 켜져 있었다면 크롬을 다시 시작하세요)") if trusted
              else L("  → 등록 안 됨. 브라우저에서 '고급 → 계속'으로 접속하거나 다시 --trust로 실행하세요."))
    elif trusted is False:
        print(L("※ 로컬 CA가 아직 신뢰되지 않음 → 브라우저 경고가 뜹니다. `python server.py --trust` 1회 실행 권장."))


def _who_has_port(port, scheme):
    """None = 비어 있음, 'ours' = 이미 이 프로그램이 실행 중, 'other' = 다른 프로그램이 사용 중."""
    try:
        socket.create_connection(("127.0.0.1", port), 1).close()
    except OSError:
        return None
    try:
        body = urllib.request.urlopen(f"{scheme}://127.0.0.1:{port}/", timeout=3,
                                      context=ssl._create_unverified_context()).read()
        return "ours" if APP_NAME.encode() in body else "other"
    except Exception:
        return "other"


async def _idle_exit(stop, grace=60):
    """브라우저 창이 모두 닫히고 터미널·터널도 없이 grace초가 지나면 종료 (창 없이 실행할 때)."""
    import api
    idle = 0
    while not stop.is_set():
        await asyncio.sleep(5)
        busy = api._clients or common.SESSIONS or any(t.state != "off" for t in manager.tunnels.values())
        idle = 0 if busy else idle + 5
        if idle >= grace:
            print(L("브라우저 창이 닫혀 있어 자동 종료합니다."))
            stop.set()


async def main():
    global TOKEN
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--host", default="127.0.0.1", help=L("바인딩 주소 (기본 127.0.0.1)"))
    ap.add_argument("--port", type=int, default=8022)
    ap.add_argument("--token", help=L("접속 토큰 (외부 바인딩 시 미지정이면 자동 생성)"))
    ap.add_argument("--open", action="store_true", help=L("크롬 앱 창으로 열기"))
    ap.add_argument("--trust", action="store_true", help=L("로컬 CA를 현재 사용자 신뢰 루트에 등록 (최초 1회)"))
    ap.add_argument("--no-tls", action="store_true", help=L("HTTPS 끄기 (평문 HTTP)"))
    ap.add_argument("--auto-exit", action="store_true", help=L("브라우저 창을 모두 닫고 1분 지나면 종료 (터널 실행 중이면 유지)"))
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # cp949 콘솔에서 출력 오류 방지

    # 이미 실행 중이면 새로 띄우지 않고 기존 서버의 창만 연다
    scheme = "http" if a.no_tls else "https"
    who = _who_has_port(a.port, scheme)
    if who == "ours":
        print(L("이미 실행 중 → 창만 엽니다."))
        if a.open:
            _open_browser(f"{scheme}://127.0.0.1:{a.port}/")
        return
    if who == "other":
        msg = L("포트 {port}를 다른 프로그램이 쓰고 있습니다. --port 로 다른 포트를 지정하세요.", port=a.port)
        print(msg)
        if HIDDEN:
            msgbox(msg)
        return

    # 브라우저가 TLS 연결을 끊을 때 Windows Proactor가 내는 무해한 ConnectionResetError 로그 숨김
    loop = asyncio.get_running_loop()

    def _quiet(lp, ctx):
        if isinstance(ctx.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
            return
        lp.default_exception_handler(ctx)
    loop.set_exception_handler(_quiet)

    loopback = a.host in ("127.0.0.1", "localhost", "::1")
    common.LOCAL_MODE = loopback
    if not loopback:
        TOKEN = a.token or secrets.token_urlsafe(16)
    elif a.token:
        TOKEN = a.token

    ssl_ctx = None
    if not a.no_tls:
        _setup_tls(a.trust)
        ssl_ctx = tls.ssl_context()

    async with serve(handler, a.host, a.port, process_request=process_request, ssl=ssl_ctx,
                     max_size=4 << 20, ping_interval=20, close_timeout=2):
        scheme = "http" if a.no_tls else "https"
        shown = "127.0.0.1" if a.host in ("0.0.0.0", "::") else a.host
        url = f"{scheme}://{shown}:{a.port}/" + (f"?t={TOKEN}" if TOKEN else "")
        print(L("{app} 실행 중 → {url}", app=APP_NAME, url=url))
        if not loopback:
            print(L("  (다른 PC에서는 이 PC의 IP로 접속, 인증서 경고 없애려면 /ca.crt 받아서 신뢰 등록)"))
            print(L("  ※ 외부 바인딩이라 로컬 터미널·RDP 실행·파일 선택 기능은 꺼져 있습니다."))
        print(L("종료: 화면의 ⚙설정 → 서버 종료") + ("" if HIDDEN else L(" 또는 Ctrl+C")))
        if a.open:
            _open_browser(url)
        stop = asyncio.Event()
        common.request_shutdown = lambda: loop.call_soon_threadsafe(stop.set)
        if a.auto_exit:
            asyncio.create_task(_idle_exit(stop))
        try:
            await stop.wait()
        finally:
            manager.stop_all()
            print(L("종료됨"))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        if HIDDEN:
            import traceback
            traceback.print_exc()
            msgbox(L("실행 중 오류로 종료됐습니다:\n{e}\n\n자세한 내용: data\\server.log", e=e))
        raise
