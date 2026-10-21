"""공통: 경로, 실행 모드, 세션 레지스트리, JSON 저장소."""
import json
import os
import threading
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = Path(os.environ.get("WEBSSH_DATA") or BASE / "data")   # 테스트 때 다른 폴더 지정 가능
KNOWN_HOSTS = DATA / "known_hosts"
DATA.mkdir(exist_ok=True)
if not os.environ.get("WEBSSH_DATA") and (BASE / "known_hosts").exists() and not KNOWN_HOSTS.exists():  # 이전 버전 위치에서 옮김
    (BASE / "known_hosts").replace(KNOWN_HOSTS)

# 127.0.0.1에만 바인딩된 경우에만 True → 로컬 터미널·RDP 실행·파일 선택창 등 "이 PC를 조작하는" 기능 허용
LOCAL_MODE = True

# 서버 종료 요청 (server.main이 설정)
request_shutdown = None

# 창 없이 실행할 때 하위 콘솔 프로그램(certutil, wsl 등)의 검은 창이 뜨지 않게
NO_WINDOW = getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0)

# 터미널 접속마다 발급하는 세션 ID → {"client": SSHClient, "enc": str, "shellpid": int|None}
# (SFTP·모니터링 채널을 같은 SSH 연결에 붙이기 위함)
SESSIONS = {}

_lock = threading.Lock()

DEFAULT_SETTINGS = {
    "logDir": "",               # 비우면 BASE/logs
    "logDefault": True,         # 새 SSH 세션의 로그 저장 기본값
    "monitor": True,            # 원격 모니터링 바
    "followFolder": True,       # SFTP가 터미널 폴더 따라가기
    "highlight": [
        {"pattern": r"\b(error|errors|fail|failed|failure|fatal|denied|refused|invalid|cannot|unable|critical|panic)\b", "color": "#ff6b6b", "on": True},
        {"pattern": r"\b(warn|warning|warnings|deprecated|timeout|timed out)\b", "color": "#e3b341", "on": True},
        {"pattern": r"\b(ok|success|successful|succeeded|passed|done|enabled|active \(running\))\b", "color": "#56d364", "on": True},
        {"pattern": r"\b(\d{1,3}\.){3}\d{1,3}(/\d{1,2})?\b", "color": "#79c0ff", "on": True},
    ],
}


def _path(name):
    return DATA / f"{name}.json"


def load(name, default):
    try:
        return json.loads(_path(name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except Exception:
        # 깨진 파일은 덮어쓰지 않도록 백업 후 기본값
        p = _path(name)
        p.replace(p.with_suffix(".broken.json"))
        return default


def save(name, obj):
    with _lock:
        DATA.mkdir(exist_ok=True)
        tmp = _path(name).with_suffix(".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, _path(name))


def settings():
    s = dict(DEFAULT_SETTINGS)
    s.update(load("settings", {}))
    return s


def log_dir():
    d = settings().get("logDir") or str(BASE / "logs")
    return Path(os.path.expandvars(os.path.expanduser(d)))
