"""SSH 터미널 중계 + 세션 로그 + 원격 모니터링 + 터미널 폴더 추적."""
import asyncio
import codecs
import datetime as dt
import json
import re
import secrets
import threading

from websockets.exceptions import ConnectionClosed

import common
from i18n import L
from sshconn import describe, exec_sh, exec_text, open_chain, scrub

ENCODINGS = {"utf-8": "utf-8", "euc-kr": "cp949"}   # cp949 = EUC-KR 확장(똠·햏 등 포함)


# ── 세션 로그 ─────────────────────────────────────────────────
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]"          # CSI
                  r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
                  r"|\x1b[PX^_][^\x1b]*\x1b\\"           # DCS 등
                  r"|\x1b[@-Z\\-_]"                       # 2바이트 ESC
                  r"|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _safe(name):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name).strip(" .") or "session"


class SessionLog:
    """터미널 출력을 색상·제어문자 뺀 텍스트로 저장: logs/<세션이름>/<날짜_시각>_<host>.log"""

    def __init__(self, name, target):
        d = common.log_dir() / _safe(name)
        d.mkdir(parents=True, exist_ok=True)
        now = dt.datetime.now()
        self.path = d / f"{now:%Y-%m-%d_%H%M%S}_{_safe(target.split('@')[-1])}.log"
        self.f = open(self.path, "a", encoding="utf-8", newline="\n")
        self.pending = ""
        self.f.write(f"===== {now:%Y-%m-%d %H:%M:%S} {target} {L('접속')} =====\n")
        self.f.flush()

    def write(self, text):
        text = self.pending + text
        self.pending = ""
        i = text.rfind("\x1b")
        if i != -1 and len(text) - i < 512 and not ANSI.match(text, i):
            self.pending, text = text[i:], text[:i]     # 잘린 ESC 시퀀스는 다음 조각과 합쳐서 처리
        text = ANSI.sub("", text.replace("\r\n", "\n")).replace("\r", "")
        if text:
            self.f.write(text)
            self.f.flush()

    def close(self):
        self.f.write(f"\n===== {dt.datetime.now():%Y-%m-%d %H:%M:%S} {L('종료')} =====\n")
        self.f.close()


# ── 원격 모니터링 (Linux /proc) ───────────────────────────────
MON_CMD = ("export LC_ALL=C; head -1 /proc/stat; echo @@; "
           "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo @@; "
           "df -kP / | tail -1; echo @@; cat /proc/net/dev; echo @@; "
           "cat /proc/loadavg; echo @@; cat /proc/uptime")


def _parse_mon(out, prev):
    sec = out.split("@@\n")
    if len(sec) < 6 or not sec[0].startswith("cpu"):
        raise ValueError("unsupported")
    cpu = [int(x) for x in sec[0].split()[1:]]
    idle, total = cpu[3] + (cpu[4] if len(cpu) > 4 else 0), sum(cpu)
    mem = dict(re.findall(r"^(\w+):\s+(\d+)", sec[1], re.M))
    df = sec[2].split()
    rx = tx = 0
    for line in sec[3].splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == "lo":
            continue
        f = rest.split()
        rx, tx = rx + int(f[0]), tx + int(f[8])
    now = dt.datetime.now().timestamp()
    r = {
        "mem": [int(mem["MemTotal"]) - int(mem["MemAvailable"]), int(mem["MemTotal"])],   # KB
        "disk": [int(df[2]), int(df[1])] if len(df) >= 4 else None,                        # KB
        "load": sec[4].split()[:3],
        "uptime": int(float(sec[5].split()[0])),
    }
    if prev:
        dt_ = now - prev["t"]
        dtot = total - prev["total"]
        r["cpu"] = round(100 * (1 - (idle - prev["idle"]) / dtot), 1) if dtot > 0 else 0
        r["net"] = [max(0, int((rx - prev["rx"]) / dt_)), max(0, int((tx - prev["tx"]) / dt_))]
    return r, {"t": now, "idle": idle, "total": total, "rx": rx, "tx": tx}


# ── 터미널 폴더 추적 ──────────────────────────────────────────
# 같은 SSH 연결의 exec 채널은 셸과 SSH_CONNECTION 값이 같다 → 그걸로 셸 PID를 찾고,
# 그 TTY의 포그라운드 프로세스(중첩 bash 등)의 cwd를 읽는다.
FIND_SHELL = (r'C="$SSH_CONNECTION"; for d in /proc/[0-9]*; do [ -O "$d" ] || continue; '
              r't=$(readlink "$d/fd/0" 2>/dev/null); case "$t" in /dev/pts/*|/dev/tty*) ;; *) continue;; esac; '
              r'tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -qxF "SSH_CONNECTION=$C" && echo "${d#/proc/}"; done')
CWD_OF = (r'p={pid}; [ -d /proc/$p ] || exit 3; f=$(ps -o tpgid= -p $p 2>/dev/null | tr -d " "); '
          r'{{ [ -n "$f" ] && [ "$f" -gt 0 ] && readlink /proc/$f/cwd 2>/dev/null; }} || readlink /proc/$p/cwd')


def term_cwd(sess):
    """터미널(셸)의 현재 폴더. 알 수 없으면 None. (블로킹 → 스레드에서 호출)"""
    client = sess["client"]
    for _ in range(2):
        pid = sess.get("shellpid")
        if not pid:
            out, _ = exec_text(client, FIND_SHELL)
            pids = sorted(int(x) for x in out.split() if x.isdigit())
            if not pids:
                return None
            pid = sess["shellpid"] = pids[0]
        raw, code = exec_sh(client, CWD_OF.format(pid=pid))
        raw = raw.strip()
        if code == 3:                                   # 셸이 바뀜 → 다시 찾기
            sess["shellpid"] = None
            continue
        return raw.decode(sess["enc"], "replace") or None
    return None


# ── 터미널 WebSocket ─────────────────────────────────────────
async def terminal_handler(ws):
    loop = asyncio.get_running_loop()
    peer = ws.remote_address

    async def send_json(**obj):
        await ws.send(json.dumps(obj, ensure_ascii=False))

    try:
        p = json.loads(await asyncio.wait_for(ws.recv(), 30))
        assert p.get("type") == "connect" and p.get("host") and p.get("username")
        if p.get("jump"):
            assert p["jump"].get("host") and p["jump"].get("username")
    except Exception:
        await ws.close(1008, "bad connect message")
        return
    enc = ENCODINGS.get(p.get("encoding"), "utf-8")

    def ask_hostkey(host, keytype, fp):
        async def _ask():
            await send_json(type="hostkey", host=host, keytype=keytype, fingerprint=fp)
            while True:
                m = await ws.recv()
                if isinstance(m, str):
                    r = json.loads(m)
                    if r.get("type") == "hostkey_reply":
                        return bool(r.get("accept"))
        return asyncio.run_coroutine_threadsafe(_ask(), loop).result(timeout=120)

    target = f'{p["username"]}@{p["host"]}:{p.get("port") or 22}'
    if p.get("jump"):
        target += f' (via {p["jump"]["host"]})'

    def _open():
        client, jump = open_chain(p, ask_hostkey)
        try:
            chan = client.invoke_shell(term="xterm-256color",
                                       width=int(p.get("cols") or 80), height=int(p.get("rows") or 24))
        except Exception:
            client.close()
            if jump:
                jump.close()
            raise
        return client, jump, chan

    try:
        client, jump, chan = await asyncio.to_thread(_open)
    except Exception as e:
        msg, code = describe(e)
        await send_json(type="error", message=msg, code=code)
        await ws.close()
        return
    finally:
        scrub(p)

    sid = secrets.token_urlsafe(18)
    sess = common.SESSIONS[sid] = {"client": client, "enc": enc, "shellpid": None}
    log = None
    if (p.get("log") or {}).get("on"):
        try:
            log = SessionLog(p["log"].get("name") or p["host"], target)
        except OSError as e:
            await send_json(type="notice", message=L("로그 파일을 만들 수 없습니다: {e}", e=e))
    print(f"[+] {peer[0]} → {target}")
    await send_json(type="connected", sid=sid, log=str(log.path) if log else None)

    def pump_output():
        dec = codecs.getincrementaldecoder(enc)("replace")
        try:
            while True:
                data = chan.recv(65536)
                if not data:
                    break
                text = dec.decode(data)
                if log:
                    log.write(text)
                asyncio.run_coroutine_threadsafe(ws.send(text.encode("utf-8") if enc != "utf-8" else data),
                                                 loop).result()
        except Exception:
            pass
        code = chan.recv_exit_status() if chan.exit_status_ready() else None
        if code == -1:          # paramiko: 종료 코드 없이 끊김(네트워크 단절 등) → 자동 재접속 대상
            code = None

        async def _end():
            try:
                await send_json(type="closed", exit=code)
                await ws.close()
            except ConnectionClosed:
                pass
        asyncio.run_coroutine_threadsafe(_end(), loop)

    threading.Thread(target=pump_output, daemon=True).start()

    monitor = {"task": None}

    async def monitor_loop():
        prev = None
        while True:
            try:
                out, _ = await asyncio.to_thread(exec_text, client, MON_CMD)
                r, prev = _parse_mon(out, prev)
                await send_json(type="monitor", **r)
            except ConnectionClosed:
                return
            except Exception:
                await send_json(type="monitor", unsupported=True)
                return
            await asyncio.sleep(3)

    def set_monitor(on):
        if on and not monitor["task"]:
            monitor["task"] = asyncio.create_task(monitor_loop())
        elif not on and monitor["task"]:
            monitor["task"].cancel()
            monitor["task"] = None

    set_monitor(bool(p.get("monitor")))

    in_dec = codecs.getincrementaldecoder("utf-8")("replace")
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                if enc != "utf-8":
                    msg = in_dec.decode(msg).encode(enc, "replace")
                await asyncio.to_thread(chan.sendall, msg)
            else:
                m = json.loads(msg)
                if m.get("type") == "resize":
                    chan.resize_pty(width=int(m["cols"]), height=int(m["rows"]))
                elif m.get("type") == "monitor":
                    set_monitor(bool(m.get("on")))
    except ConnectionClosed:
        pass
    finally:
        set_monitor(False)
        common.SESSIONS.pop(sid, None)
        chan.close()
        client.close()
        if jump:
            jump.close()
        if log:
            log.close()
        print(f"[-] {peer[0]} → {target}")
