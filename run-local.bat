@echo off
REM Double-click to run Civilization Ownership on your own computer.
REM Needs Python (python.org). Close this window to stop the site.
cd /d "%~dp0"
echo Starting Civilization Ownership at http://localhost:8000
echo Close this window to stop it.
start "" http://localhost:8000
python -m http.server 8000
