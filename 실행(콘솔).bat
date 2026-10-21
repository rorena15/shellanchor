@echo off
rem 설치·문제 확인용: 콘솔 창에 서버 로그가 보입니다. 평소에는 바로가기(.lnk)로 창 없이 실행
rem 이 폴더의 .venv 를 사용합니다.
rem .venv 가 없으면 만들고 requirements.txt 를 설치합니다.
chcp 65001 >nul
cd /d "%~dp0"
set "VPY=%~dp0.venv\Scripts\python.exe"
if exist "%VPY%" goto run

echo [.venv 없음] 가상환경을 만들고 패키지를 설치합니다...
where py >nul 2>nul
if %errorlevel%==0 (py -3 -m venv .venv) else (python -m venv .venv)
if not exist "%VPY%" (
    echo 가상환경 생성 실패 - 파이썬 설치를 확인하세요.
    pause
    exit /b 1
)
"%VPY%" -m pip install -q --upgrade pip

:run
"%VPY%" -c "import paramiko, websockets, cryptography, winpty" 2>nul || "%VPY%" -m pip install -q -r requirements.txt
"%VPY%" server.py --open --trust %*
pause
