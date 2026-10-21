"""SSH 터널: 로컬 포워딩 / 동적(SOCKS5). 항상 127.0.0.1에만 바인딩.

브라우저 탭을 닫아도 서버가 켜져 있는 동안 유지되고, SSH 연결이 끊기면 5초마다 자동 재연결한다.
"""
import ipaddress
import socket
import struct
import threading
import time

from sshconn import describe, open_chain


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        d = sock.recv(n - len(buf))
        if not d:
            raise ConnectionError("closed")
        buf += d
    return buf


def _pipe(a_recv, b_send, closers):
    try:
        while True:
            d = a_recv(65536)
            if not d:
                break
            b_send(d)
    except Exception:
        pass
    for c in closers:
        try:
            c()
        except Exception:
            pass


class Tunnel:
    """cfg: {type: local|dynamic, listenPort, destHost, destPort, name}
    params: sshconn.open_chain 용 접속 정보(비밀값 포함, 재연결 위해 실행 중에만 메모리에 보관)."""

    def __init__(self, tid, cfg, params, on_change, ask):
        self.id, self.cfg, self.params = tid, cfg, params
        self.on_change, self.ask = on_change, ask
        self.state, self.error, self.conns = "starting", None, 0
        self.port = None
        self.client = self.jump = self.listener = None
        self.stopped = False
        self.lock = threading.Lock()

    def status(self):
        return {"state": self.state, "error": self.error, "conns": self.conns, "port": self.port}

    def _set(self, state, error=None):
        self.state, self.error = state, error
        self.on_change(self.id, self.status())

    # 실행 (블로킹, 스레드에서 호출) ─ 첫 접속 실패는 예외로 돌려줌
    def start(self):
        self._connect()
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):       # Windows: 다른 프로세스가 같은 포트를 가로채지 못하게
            self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            self.listener.bind(("127.0.0.1", int(self.cfg.get("listenPort") or 0)))
        except OSError as e:
            self._close_ssh()
            raise RuntimeError(f"로컬 포트 {self.cfg.get('listenPort')}를 열 수 없습니다 (이미 사용 중?): {e.strerror}")
        self.listener.listen(32)
        self.port = self.listener.getsockname()[1]
        self._set("on")
        threading.Thread(target=self._accept_loop, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()

    def _connect(self):
        p = dict(self.params)
        if p.get("jump"):
            p["jump"] = dict(p["jump"])
        self.client, self.jump = open_chain(p, self.ask)

    def _close_ssh(self):
        for c in (self.client, self.jump):
            if c:
                try:
                    c.close()
                except Exception:
                    pass
        self.client = self.jump = None

    def _watch(self):
        """SSH 연결이 끊기면 자동 재연결."""
        while not self.stopped:
            time.sleep(2)
            t = self.client.get_transport() if self.client else None
            if t and t.is_active():
                continue
            if self.stopped:
                return
            self._set("reconnecting", "SSH 연결 끊김 — 재연결 중")
            self._close_ssh()
            while not self.stopped:
                try:
                    self._connect()
                    self._set("on")
                    break
                except Exception as e:
                    self._set("reconnecting", describe(e)[0] + " — 5초 후 재시도")
                    time.sleep(5)

    def _accept_loop(self):
        while not self.stopped:
            try:
                sock, peer = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(sock, peer), daemon=True).start()

    def _open(self, host, port, peer):
        t = self.client.get_transport() if self.client else None
        if not t or not t.is_active():
            raise ConnectionError("SSH 연결 없음")
        return t.open_channel("direct-tcpip", (host, int(port)), peer, timeout=10)

    def _handle(self, sock, peer):
        chan = None
        try:
            if self.cfg.get("type") == "dynamic":
                host, port = self._socks5(sock)
                try:
                    chan = self._open(host, port, peer)
                except Exception:
                    sock.sendall(b"\x05\x05\x00\x01" + bytes(6))      # connection refused
                    raise
                sock.sendall(b"\x05\x00\x00\x01" + bytes(6))
            else:
                chan = self._open(self.cfg["destHost"], self.cfg["destPort"], peer)
        except Exception:
            sock.close()
            if chan:
                chan.close()
            return
        with self.lock:
            self.conns += 1
        self.on_change(self.id, self.status())
        closers = (sock.close, chan.close)
        t = threading.Thread(target=_pipe, args=(chan.recv, sock.sendall, closers), daemon=True)
        t.start()
        _pipe(sock.recv, chan.sendall, closers)
        t.join()
        with self.lock:
            self.conns -= 1
        self.on_change(self.id, self.status())

    @staticmethod
    def _socks5(sock):
        ver, n = _recv_exact(sock, 2)
        if ver != 5:
            raise ConnectionError("not socks5")
        _recv_exact(sock, n)
        sock.sendall(b"\x05\x00")                     # 인증 없음 (127.0.0.1 전용)
        ver, cmd, _, atyp = _recv_exact(sock, 4)
        if atyp == 1:
            host = str(ipaddress.IPv4Address(_recv_exact(sock, 4)))
        elif atyp == 3:
            host = _recv_exact(sock, _recv_exact(sock, 1)[0]).decode("idna")
        elif atyp == 4:
            host = str(ipaddress.IPv6Address(_recv_exact(sock, 16)))
        else:
            raise ConnectionError("bad atyp")
        port = struct.unpack(">H", _recv_exact(sock, 2))[0]
        if cmd != 1:                                  # CONNECT만 지원
            sock.sendall(b"\x05\x07\x00\x01" + bytes(6))
            raise ConnectionError("unsupported cmd")
        return host, port

    def stop(self):
        self.stopped = True
        if self.listener:
            try:
                self.listener.close()
            except Exception:
                pass
        self._close_ssh()
        self.params = None
        self.state, self.error, self.conns = "off", None, 0
        self.on_change(self.id, self.status())


class TunnelManager:
    def __init__(self):
        self.tunnels = {}
        self.listeners = []          # 상태 변경 콜백 (tid, status)

    def _notify(self, tid, st):
        for cb in list(self.listeners):
            cb(tid, st)

    def status(self):
        return {tid: t.status() for tid, t in self.tunnels.items()}

    def start(self, tid, cfg, params, ask):
        """블로킹. 성공 시 Tunnel 반환, 실패 시 예외."""
        old = self.tunnels.get(tid)
        if old and old.state in ("on", "starting", "reconnecting"):
            return old
        t = Tunnel(tid, cfg, params, self._notify, ask)
        self.tunnels[tid] = t
        self._notify(tid, t.status())
        try:
            t.start()
        except Exception as e:
            t.params = None
            t.state, t.error = "error", describe(e)[0] if not isinstance(e, RuntimeError) else str(e)
            self._notify(tid, t.status())
            raise
        return t

    def stop(self, tid):
        t = self.tunnels.get(tid)
        if t:
            t.stop()

    def stop_all(self):
        for t in list(self.tunnels.values()):
            t.stop()


manager = TunnelManager()
