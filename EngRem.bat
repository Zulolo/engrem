@echo off
title EngRem
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found in PATH.
  echo Install it from https://nodejs.org/ or open index.html directly instead.
  pause
  exit /b 1
)
node server.js
pause
