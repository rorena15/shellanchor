"""SFTP over WebSocket.

터미널 세션(SSH 연결) 하나에 SFTP 채널을 여러 개 열 수 있다:
탐색용 WebSocket 1개 + 전송 묶음마다 WebSocket 1개 → 큰 파일 전송 중에도 탐색 가능.

요청(JSON):  {id, op, ...}
응답(JSON):  {id, ok: true, ...} 또는 {id, error: "...", code?}
get: {id, ok, size} → 바이너리 조각들 → {id, done}
put: {id, ok} 후 클라이언트가 바이너리 조각들 → {op: put_end} → {id, done}
"""
import asyncio
import errno
import json
import shlex
import stat

import paramiko
from websockets.exceptions import ConnectionClosed

from i18n import L
from term import term_cwd

CHUNK = 256 * 1024
EDIT_LIMIT = 10 * 1024 * 1024
WALK_LIMIT = 100_000


# 파일명이 UTF-8이 아닌 서버(EUC-KR 등)에서도 깨지지 않게, paramiko가 문자열을
# 원래 바이트로 되돌릴 수 있는 형태(surrogateescape)로 디코딩하도록 바꿈.
def _get_text(self):
    return self.get_string().decode("utf-8", "surrogateescape")


paramiko.message.Message.get_text = _get_text


class OpError(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


def _err(e):
    if isinstance(e, OpError):
        return str(e)
    code = getattr(e, "errno", None)
    msg = {errno.ENOENT: L("파일/폴더가 없습니다"), errno.EACCES: L("권한이 없습니다"),
           errno.EEXIST: L("이미 존재합니다")}.get(code)
    if msg:
        return msg
    s = str(e)
    if "Failure" in s:
        return L("실패 (폴더가 비어 있지 않거나 권한 문제일 수 있음)")
    return s or type(e).__name__


async def sftp_handler(ws, sess):
    T = asyncio.to_thread
    enc = sess["enc"]
    client = sess["client"]

    def to_srv(s):            # 화면 문자열 → 서버 바이트 경로
        return s.encode(enc, "replace")

    def to_disp(s):           # paramiko 문자열(surrogateescape) → 화면 문자열
        return s.encode("utf-8", "surrogateescape").decode(enc, "replace")

    def raw(s):
        return s.encode("utf-8", "surrogateescape")

    def join(a, b):
        return a.rstrip(b"/") + b"/" + b

    async def reply(**obj):
        await ws.send(json.dumps(obj, ensure_ascii=False))

    try:
        sftp = await T(client.open_sftp)
    except Exception as e:
        await reply(id=0, error=L("SFTP를 열 수 없습니다: {err}", err=_err(e)))
        return

    def is_dir(a):
        return stat.S_ISDIR(a.st_mode or 0)

    def do_list(path):
        real = sftp.normalize(to_srv(path or "."))
        rb = raw(real)
        out = []
        for a in sftp.listdir_attr(rb):
            mode = a.st_mode or 0
            is_link = stat.S_ISLNK(mode)
            d = stat.S_ISDIR(mode)
            if is_link:
                try:
                    d = stat.S_ISDIR(sftp.stat(join(rb, raw(a.filename))).st_mode)
                except OSError:
                    pass
            ln = (getattr(a, "longname", "") or "").split()
            owner = to_disp(ln[2]) if len(ln) >= 8 else str(a.st_uid)
            group = to_disp(ln[3]) if len(ln) >= 8 else str(a.st_gid)
            out.append({"name": to_disp(a.filename), "dir": d, "link": is_link,
                        "size": a.st_size or 0, "mtime": a.st_mtime or 0,
                        "perm": stat.filemode(mode), "mode": stat.S_IMODE(mode),
                        "owner": owner, "group": group})
        out.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        return to_disp(real), out

    def do_walk(path):
        """폴더 전체 목록 (폴더 다운로드용). 심볼릭 링크 폴더는 따라가지 않음."""
        root = to_srv(path)
        res, stack = [], [(root, "")]
        while stack:
            d, rel = stack.pop()
            for a in sftp.listdir_attr(d):
                name = to_disp(a.filename)
                r = f"{rel}/{name}" if rel else name
                if is_dir(a):
                    res.append({"rel": r, "dir": True})
                    stack.append((join(d, raw(a.filename)), r))
                elif stat.S_ISREG(a.st_mode or 0):
                    res.append({"rel": r, "dir": False, "size": a.st_size or 0})
                if len(res) > WALK_LIMIT:
                    raise OpError(L("파일이 너무 많습니다 ({n}개 초과)", n=f"{WALK_LIMIT:,}"))
        return res

    def do_mkdirs(path):
        parts = to_srv(path).split(b"/")
        cur = b"/" if path.startswith("/") else b""
        for p in parts:
            if not p:
                continue
            cur = join(cur, p) if cur not in (b"", b"/") else cur + p
            try:
                if not is_dir(sftp.stat(cur)):
                    raise OpError(L("같은 이름의 파일이 있습니다"))
            except FileNotFoundError:
                sftp.mkdir(cur)

    def do_rmtree(path):
        n = 0

        def rm(p):
            nonlocal n
            for a in sftp.listdir_attr(p):
                c = join(p, raw(a.filename))
                if is_dir(a):           # lstat 기준 → 심볼릭 링크 폴더는 링크만 삭제
                    rm(c)
                else:
                    sftp.remove(c)
                    n += 1
            sftp.rmdir(p)
            n += 1
        rm(to_srv(path))
        return n

    def do_chmod(path, mode, recursive):
        n = 0

        def ch(p):
            nonlocal n
            sftp.chmod(p, mode)
            n += 1
            if recursive and is_dir(sftp.lstat(p)):
                for a in sftp.listdir_attr(p):
                    c = join(p, raw(a.filename))
                    if stat.S_ISLNK(a.st_mode or 0):
                        continue
                    if is_dir(a):
                        ch(c)
                    else:
                        sftp.chmod(c, mode)
                        n += 1
        ch(to_srv(path))
        return n

    def do_chown(path, owner, group, recursive):
        spec = owner + (f":{group}" if group else "")
        if not spec or any(c in spec for c in " /'\"\\"):
            raise OpError(L("소유자/그룹 이름이 올바르지 않습니다"))
        cmd = b"chown " + (b"-R " if recursive else b"") + b"-- " + \
            shlex.quote(spec).encode(enc) + b" " + shlex.quote(path).encode(enc, "replace")
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        err = stderr.read().decode(enc, "replace").strip()
        if stdout.channel.recv_exit_status() != 0:
            raise OpError(err or L("chown 실패 (root 권한이 필요할 수 있음)"))

    def do_read(path):
        p = to_srv(path)
        st = sftp.stat(p)
        if (st.st_size or 0) > EDIT_LIMIT:
            raise OpError(L("파일이 너무 큽니다 ({mb}MB 초과) — 다운로드해서 여세요", mb=EDIT_LIMIT // 1024 // 1024), "toobig")
        with sftp.open(p, "rb") as f:
            f.prefetch(st.st_size)
            data = f.read()
        if b"\x00" in data[:8192]:
            raise OpError(L("바이너리 파일이라 편집할 수 없습니다"), "binary")
        try:
            text, lossy = data.decode(enc), False
        except UnicodeDecodeError:
            alt = "cp949" if enc == "utf-8" else "utf-8"
            try:
                text, lossy, enc_used = data.decode(alt), False, alt
                return {"text": text, "mtime": st.st_mtime, "size": st.st_size,
                        "enc": enc_used, "crlf": b"\r\n" in data}
            except UnicodeDecodeError:
                text, lossy = data.decode(enc, "replace"), True
        return {"text": text, "mtime": st.st_mtime, "size": st.st_size, "enc": enc,
                "lossy": lossy, "crlf": b"\r\n" in data}

    def do_write(path, text, file_enc, expect_mtime, force):
        p = to_srv(path)
        try:
            st = sftp.stat(p)
            if expect_mtime and st.st_mtime != expect_mtime and not force:
                raise OpError(L("편집하는 동안 서버의 파일이 바뀌었습니다"), "conflict")
        except FileNotFoundError:
            pass
        try:
            data = text.encode(file_enc or enc)
        except UnicodeEncodeError as e:
            raise OpError(L("{enc}로 저장할 수 없는 문자가 있습니다: {ch}", enc=file_enc or enc, ch=repr(e.object[e.start:e.end])))
        with sftp.open(p, "wb") as f:
            f.set_pipelined(True)
            f.write(data)
        return sftp.stat(p).st_mtime

    async def do_get(rid, path):
        f = await T(sftp.open, to_srv(path), "rb")
        try:
            size = (await T(f.stat)).st_size
            f.prefetch(size)
            await reply(id=rid, ok=True, size=size)
            while chunk := await T(f.read, CHUNK):
                await ws.send(chunk)
            await reply(id=rid, done=True)
        finally:
            await T(f.close)

    async def do_put(rid, path):
        sp = to_srv(path)
        f = await T(sftp.open, sp, "wb")
        f.set_pipelined(True)
        finished = False
        try:
            await reply(id=rid, ok=True)
            async for m in ws:
                if isinstance(m, bytes):
                    await T(f.write, m)
                elif json.loads(m).get("op") == "put_end":
                    await T(f.close)
                    finished = True
                    await reply(id=rid, done=True)
                    return
        finally:
            if not finished:          # 중단된 업로드 → 반쪽 파일 삭제
                await T(f.close)
                try:
                    await T(sftp.remove, sp)
                except Exception:
                    pass

    try:
        async for msg in ws:
            if not isinstance(msg, str):
                continue
            m = json.loads(msg)
            rid, op = m.get("id"), m.get("op")
            try:
                if op == "list":
                    path, entries = await T(do_list, m.get("path"))
                    await reply(id=rid, ok=True, path=path, entries=entries)
                elif op == "walk":
                    await reply(id=rid, ok=True, entries=await T(do_walk, m["path"]))
                elif op == "mkdir":
                    await T(sftp.mkdir, to_srv(m["path"]))
                    await reply(id=rid, ok=True)
                elif op == "mkdirs":
                    await T(do_mkdirs, m["path"])
                    await reply(id=rid, ok=True)
                elif op == "remove":
                    await T(sftp.remove, to_srv(m["path"]))
                    await reply(id=rid, ok=True)
                elif op == "rmdir":
                    await T(sftp.rmdir, to_srv(m["path"]))
                    await reply(id=rid, ok=True)
                elif op == "rmtree":
                    await reply(id=rid, ok=True, count=await T(do_rmtree, m["path"]))
                elif op == "rename":
                    await T(sftp.rename, to_srv(m["from"]), to_srv(m["to"]))
                    await reply(id=rid, ok=True)
                elif op == "chmod":
                    n = await T(do_chmod, m["path"], int(m["mode"]) & 0o7777, bool(m.get("recursive")))
                    await reply(id=rid, ok=True, count=n)
                elif op == "chown":
                    await T(do_chown, m["path"], m.get("owner", ""), m.get("group", ""), bool(m.get("recursive")))
                    await reply(id=rid, ok=True)
                elif op == "read":
                    await reply(id=rid, ok=True, **await T(do_read, m["path"]))
                elif op == "write":
                    mt = await T(do_write, m["path"], m["text"], m.get("enc"), m.get("mtime"), m.get("force"))
                    await reply(id=rid, ok=True, mtime=mt)
                elif op == "termcwd":
                    await reply(id=rid, ok=True, path=await T(term_cwd, sess))
                elif op == "get":
                    await do_get(rid, m["path"])
                elif op == "put":
                    await do_put(rid, m["path"])
                else:
                    await reply(id=rid, error=f"unknown op {op}")
            except ConnectionClosed:
                raise
            except Exception as e:
                await reply(id=rid, error=_err(e), code=getattr(e, "code", None))
    except ConnectionClosed:
        pass
    finally:
        await T(sftp.close)
