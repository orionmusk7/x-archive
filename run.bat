@echo off
cd /d "%~dp0"
python -m pip install -r requirements.txt
if errorlevel 1 (
  pause
  exit /b 1
)
start "X Thread Saver" http://127.0.0.1:5000
python app.py
pause
