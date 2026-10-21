"""SSH 접속: 키 로드, 호스트 키 TOFU, 점프 호스트 체인, 오류 설명."""
import base64
import hashlib
import io
import os
import shlex
import threading
from pathlib import Path

import paramiko

from common import KNOWN_HOSTS

_known_lock = threading.Lock()


class NeedPassphrase(Exception):
    """개인키 암호가 필요함 → 브라우저에서 물어보고 재시도."""


def _load_pkey(text, passphrase):
    if text.lstrip().startswith("PuTTY-User-Key-File"):
        raise ValueError("PuTTY .ppk 키는 지원하지 않습니다. PuTTYgen → Conversions → Export OpenSSH key로 변환하세요.")
    text = text.strip() + "\n"
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key(io.StringIO(text), password=passphrase or None)
        except paramiko.PasswordRequiredException:
            raise NeedPassphrase()
        except paramiko.SSHException as e:
            if passphrase and "decrypt" in str(e).lower():
                raise ValueError("키 암호가 틀렸습니다")
        except Exception:
            pass
    raise ValueError("개인키를 읽을 수 없습니다 (지원: Ed25519/ECDSA/RSA, OpenSSH·PEM 형식)")


def pkey_from(p):
    if p.get("auth") == "keyfile" or (p.get("keyPath") and not p.get("key")):
        if not p.get("keyPath"):
            raise ValueError("개인키 파일 경로가 비어 있습니다")
        path = Path(os.path.expandvars(os.path.expanduser(p["keyPath"])))
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            raise ValueError(f"개인키 파일을 열 수 없습니다: {path} ({e.strerror})")
        return _load_pkey(text, p.get("passphrase"))
    if p.get("key"):
        return _load_pkey(p["key"], p.get("passphrase"))
    return None


def fingerprint(key):
    """OpenSSH 스타일 지문 (SHA256:base64)."""
    raw = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(raw).decode().rstrip("=")


class AskUserPolicy(paramiko.MissingHostKeyPolicy):
    """처음 보는 호스트 키 → 브라우저에 지문을 보여주고 승인받음."""

    def __init__(self, ask):
        self.ask = ask  # (host, keytype, fingerprint) -> bool  (스레드에서 호출)

    def missing_host_key(self, client, hostname, key):
        if not self.ask(hostname, key.get_name(), fingerprint(key)):
            raise paramiko.SSHException("사용자가 호스트 키를 거부했습니다")
        with _known_lock:
            client.get_host_keys().add(hostname, key.get_name(), key)
            client.save_host_keys(str(KNOWN_HOSTS))


class HopError(Exception):
    """어느 단계(점프 호스트/대상)에서 실패했는지 표시."""

    def __init__(self, stage, err, which="target"):
        super().__init__(stage)
        self.stage, self.err, self.which = stage, err, which


def connect_one(p, ask, sock=None):
    client = paramiko.SSHClient()
    with _known_lock:
        if KNOWN_HOSTS.exists():
            client.load_host_keys(str(KNOWN_HOSTS))
    client.set_missing_host_key_policy(AskUserPolicy(ask))
    pkey = pkey_from(p)
    try:
        client.connect(
            hostname=p["host"], port=int(p.get("port") or 22), username=p["username"],
            password=p.get("password") or None, pkey=pkey, sock=sock,
            timeout=10, banner_timeout=15, auth_timeout=20,
            look_for_keys=False, allow_agent=False,
        )
    except Exception:
        client.close()
        raise
    client.get_transport().set_keepalive(30)
    return client


def open_chain(p, ask):
    """(점프 경유) 대상까지 SSH 연결. 반환: (client, jump_client|None)"""
    jump = sock = None
    j = p.get("jump")
    if j:
        try:
            jump = connect_one(j, ask)
        except Exception as e:
            raise HopError(f"점프 호스트({j['host']})", e, "jump")
        try:
            sock = jump.get_transport().open_channel(
                "direct-tcpip", (p["host"], int(p.get("port") or 22)), ("127.0.0.1", 0), timeout=10)
        except Exception as e:
            jump.close()
            raise HopError(f"점프 호스트 → {p['host']} 연결", e, "jump")
    try:
        client = connect_one(p, ask, sock)
    except Exception as e:
        if jump:
            jump.close()
        raise HopError(f"대상 서버({p['host']})" if jump else "", e, "target")
    return client, jump


def describe(e):
    """예외 → (사용자용 메시지, 코드). 코드: passphrase:<which> | auth:<which> | hostkey | None"""
    err = e.err if isinstance(e, HopError) else e
    which = e.which if isinstance(e, HopError) else "target"
    stage = f"[{e.stage}] " if isinstance(e, HopError) and e.stage else ""
    if isinstance(err, NeedPassphrase):
        return f"{stage}개인키에 암호가 걸려 있습니다.", f"passphrase:{which}"
    if isinstance(err, paramiko.BadHostKeyException):
        return (f"{stage}⚠ 호스트 키가 저장된 값과 다릅니다! (MITM 가능성)\n"
                f"저장됨: {err.expected_key.get_name()} {fingerprint(err.expected_key)}\n"
                f"수신됨: {err.key.get_name()} {fingerprint(err.key)}\n"
                f"서버를 재설치한 게 확실하면 known_hosts 파일에서 해당 줄을 지우세요."), "hostkey"
    if isinstance(err, paramiko.AuthenticationException):
        return f"{stage}인증 실패 — 사용자명/비밀번호/키를 확인하세요.", f"auth:{which}"
    if isinstance(err, paramiko.ChannelException):
        return f"{stage}실패 — 점프 호스트가 대상에 연결하지 못했습니다 (주소/포트/AllowTcpForwarding 확인)", None
    return f"{stage}접속 실패: {err}", None


def scrub(p):
    """비밀값을 메모리에서 지움."""
    for d in (p, p.get("jump") or {}):
        for k in ("password", "key", "passphrase"):
            d.pop(k, None)


def exec_sh(client, script, timeout=10):
    """같은 SSH 연결에서 sh 스크립트 실행 → (stdout 바이트, 종료코드).
    로그인 셸이 csh/fish여도 되도록 항상 sh -c 로 감싼다."""
    stdin, stdout, stderr = client.exec_command("sh -c " + shlex.quote(script), timeout=timeout)
    out = stdout.read()
    return out, stdout.channel.recv_exit_status()


def exec_text(client, script, timeout=10):
    """exec_sh의 문자열 버전 (모니터링·폴더 추적용)."""
    out, code = exec_sh(client, script, timeout)
    return out.decode("utf-8", "replace"), code
