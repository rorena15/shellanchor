@echo off
rem ShellAnchor - run with a console window (for first setup and troubleshooting).
rem Uses .venv in this folder; creates it and installs requirements.txt if missing.
rem For everyday use, a shortcut to .venv\Scripts\pythonw.exe runs it without a console (see README).
chcp 65001 >nul
cd /d "%~dp0"
set "VPY=%~dp0.venv\Scripts\python.exe"
if exist "%VPY%" goto start

echo [setup] Creating .venv and installing packages... / 가상환경을 만들고 패키지를 설치합니다...
where py >nul 2>nul
if %errorlevel%==0 (py -3 -m venv .venv) else (python -m venv .venv)
if not exist "%VPY%" (
    echo Failed to create .venv - check that Python 3.11+ is installed. / 가상환경 생성 실패 - Python 3.11 이상 설치를 확인하세요.
    pause
    exit /b 1
)
"%VPY%" -m pip install -q --upgrade pip

:start
"%VPY%" -c "import paramiko, websockets, cryptography, winpty" 2>nul || "%VPY%" -m pip install -q -r requirements.txt
"%VPY%" server.py --open --trust %*
pause
