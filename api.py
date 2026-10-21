"""제어용 WebSocket(/api): 세션 트리·설정 저장, 터널 시작/중지, RDP 실행, 파일 선택창, 로그 폴더 열기.

저장 파일: data/sessions.json  {"folders": [...], "sessions": [...], "tunnels": [...]}
           data/settings.json
비밀번호·키 암호는 저장하지 않는다 (사용할 때마다 브라우저가 물어보고, 탭이 열린 동안만 메모리에 둠).
"""
import asyncio
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import zlib
from pathlib import Path

from websockets.exceptions import ConnectionClosed

import common
import localterm
from i18n import L
from sshconn import describe
from tunnels import manager

EMPTY = {"folders": [], "sessions": [], "tunnels": []}
MSTSC = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "mstsc.exe"
_clients = set()


def _broadcast(obj, skip=None):
    msg = json.dumps(obj, ensure_ascii=False)
    for ws in list(_clients):
        if ws is not skip:
            asyncio.ensure_future(_safe_send(ws, msg))


async def _safe_send(ws, msg):
    try:
        await ws.send(msg)
    except ConnectionClosed:
        pass


def _find(data, kind, sid):
    for x in data.get(kind, []):
        if x.get("id") == sid:
            return x
    raise ValueError(L("저장된 항목을 찾을 수 없습니다 (다른 창에서 삭제됨?)"))


def ssh_params(s, sec):
    p = {"host": s["host"], "port": s.get("port") or 22, "username": s["username"],
         "auth": s.get("auth", "password"), "keyPath": s.get("keyPath"),
         "password": sec.get("password"), "passphrase": sec.get("passphrase")}
    j = s.get("jump") or {}
    if j.get("host"):
        p["jump"] = {"host": j["host"], "port": j.get("port") or 22, "username": j["username"],
                     "auth": j.get("auth", "password"), "keyPath": j.get("keyPath"),
                     "password": sec.get("jumpPassword"), "passphrase": sec.get("jumpPassphrase")}
    return p


# ── RDP ────────────────────────────────────────────────────
def _rdp_file(s, address):
    lines = [f"full address:s:{address}", "prompt for credentials:i:0", "authentication level:i:2",
             f"redirectclipboard:i:{1 if s.get('clipboard', True) else 0}",
             "smart sizing:i:1", "dynamic resolution:i:1", "audiomode:i:0", "autoreconnection enabled:i:1"]
    if s.get("username"):
        lines.append(f"username:s:{s['username']}")
    if s.get("screen", "full") == "full":
        lines.append("screen mode id:i:2")
        lines.append(f"use multimon:i:{1 if s.get('multimon') else 0}")
    else:
        w, _, h = (s.get("screen") or "1600x900").partition("x")
        lines += ["screen mode id:i:1", f"desktopwidth:i:{int(w)}", f"desktopheight:i:{int(h)}"]
    if s.get("drives"):
        lines.append("drivestoredirect:s:*")
    d = common.DATA / "rdp"
    d.mkdir(parents=True, exist_ok=True)
    path = d / (re.sub(r'[\\/:*?"<>|]+', "_", s.get("name") or s["host"]) + ".rdp")
    path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-16", newline="")   # mstsc는 UTF-16 .rdp를 잘 읽음
    return path


def _launch_rdp(s, data, sec, ask):
    """블로킹. 게이트웨이가 있으면 터널을 열고 mstsc가 끝날 때까지 유지."""
    address = f"{s['host']}:{s.get('port') or 3389}"
    tid = None
    if s.get("gateway"):
        gw = _find(data, "sessions", s["gateway"])
        tid = "rdp-" + s["id"]
        port = 33890 + zlib.crc32(s["id"].encode()) % 1000          # 세션마다 고정 포트 → mstsc 저장 자격증명 재사용
        cfg = {"type": "local", "listenPort": port, "destHost": s["host"], "destPort": s.get("port") or 3389}
        try:
            t = manager.start(tid, cfg, ssh_params(gw, sec), ask)
        except RuntimeError:                                          # 고정 포트 사용 중 → 임의 포트
            cfg["listenPort"] = 0
            t = manager.start(tid, cfg, ssh_params(gw, sec), ask)
        address = f"127.0.0.1:{t.port}"
    proc = subprocess.Popen([str(MSTSC), str(_rdp_file(s, address))])
    if tid:
        def keep():
            proc.wait()
            idle = 0
            while idle < 10:                        # mstsc 종료 후 연결이 10초간 없으면 터널 정리
                time.sleep(1)
                t = manager.tunnels.get(tid)
                if not t or t.state == "off":
                    return
                idle = idle + 1 if t.conns == 0 else 0
            manager.stop(tid)
        threading.Thread(target=keep, daemon=True).start()
    return address


def _pick_file():
    code = ("import tkinter as t, tkinter.filedialog as f, os; r=t.Tk(); r.withdraw(); "
            "r.attributes('-topmost', 1); "
            "print(f.askopenfilename(title=" + repr(L("개인키 파일 선택")) + ", initialdir=os.path.expanduser('~/.ssh') "
            "if os.path.isdir(os.path.expanduser('~/.ssh')) else os.path.expanduser('~')))")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, encoding="utf-8",
                       creationflags=common.NO_WINDOW)
    return r.stdout.strip().replace("/", "\\") or None


# ── 핸들러 ───────────────────────────────────────────────────
async def api_handler(ws):
    loop = asyncio.get_running_loop()
    pending = {}

    async def send(**obj):
        await ws.send(json.dumps(obj, ensure_ascii=False))

    def ask(host, keytype, fp):
        """스레드에서 호출 → 브라우저에 호스트 키 확인 요청."""
        qid = secrets.token_hex(6)
        fut = loop.create_future()

        async def _ask():
            pending[qid] = fut
            await send(type="hostkey", qid=qid, host=host, keytype=keytype, fingerprint=fp)
            return await fut
        return asyncio.run_coroutine_threadsafe(_ask(), loop).result(timeout=120)

    def on_tunnel(tid, st):
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(
            _safe_send(ws, json.dumps({"type": "tunnel", "id": tid, "status": st}))))

    async def handle(m):
        rid, op = m.get("id"), m.get("op")
        try:
            if op == "load":
                r = {"data": common.load("sessions", EMPTY), "settings": common.settings(),
                     "tunnels": manager.status(), "logDir": str(common.log_dir()),
                     "caps": {"local": common.LOCAL_MODE, "shells": [{**sh, "name": L(sh["name"])} for sh in localterm.available()] if common.LOCAL_MODE else [],
                              "rdp": common.LOCAL_MODE and MSTSC.exists()}}
            elif op == "saveData":
                common.save("sessions", m["data"])
                _broadcast({"type": "data", "data": m["data"]}, skip=ws)
                r = {}
            elif op == "saveSettings":
                common.save("settings", m["settings"])
                _broadcast({"type": "settings", "settings": common.settings()}, skip=ws)
                r = {"logDir": str(common.log_dir())}
            elif op == "tunnelStart":
                data = common.load("sessions", EMPTY)
                cfg = _find(data, "tunnels", m["tid"])
                via = _find(data, "sessions", cfg["via"])
                t = await asyncio.to_thread(manager.start, m["tid"], cfg, ssh_params(via, m.get("secrets") or {}), ask)
                r = {"status": t.status()}
            elif op == "tunnelStop":
                await asyncio.to_thread(manager.stop, m["tid"])
                r = {}
            elif not common.LOCAL_MODE:
                raise PermissionError(L("이 기능은 서버가 127.0.0.1로 실행 중일 때만 쓸 수 있습니다"))
            elif op == "rdp":
                data = common.load("sessions", EMPTY)
                s = _find(data, "sessions", m["sid"])
                r = {"address": await asyncio.to_thread(_launch_rdp, s, data, m.get("secrets") or {}, ask)}
            elif op == "openLogs":
                d = common.log_dir()
                sub = d / re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", m.get("name") or "").strip(" .")
                target = sub if m.get("name") and sub.is_dir() else d
                target.mkdir(parents=True, exist_ok=True)
                os.startfile(target)
                r = {}
            elif op == "pickFile":
                r = {"path": await asyncio.to_thread(_pick_file)}
            elif op == "shutdown":
                loop.call_later(0.5, common.request_shutdown)
                r = {}
            else:
                raise ValueError(f"unknown op {op}")
            await send(id=rid, ok=True, **r)
        except ConnectionClosed:
            pass
        except Exception as e:
            msg, code = describe(e)
            if not hasattr(e, "err") and msg == L("{stage}접속 실패: {err}", stage="", err=e):   # 접속 오류가 아니면 원래 메시지
                msg = str(e)
            await send(id=rid, error=msg, code=code)

    _clients.add(ws)
    manager.listeners.append(on_tunnel)
    try:
        async for msg in ws:
            m = json.loads(msg)
            if m.get("op") == "hostkey_reply":
                f = pending.pop(m.get("qid"), None)
                if f and not f.done():
                    f.set_result(bool(m.get("accept")))
                continue
            asyncio.create_task(handle(m))
    except ConnectionClosed:
        pass
    finally:
        _clients.discard(ws)
        manager.listeners.remove(on_tunnel)
        for f in pending.values():
            if not f.done():
                f.set_result(False)
