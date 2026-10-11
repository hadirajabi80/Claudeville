@echo off
title Claudeville
cd /d "%~dp0"
rem Already running? Just open it.
curl -s -o nul http://127.0.0.1:5199/api/health && (start "" http://127.0.0.1:5199 & exit /b)
if not exist node_modules call npm install
rem Starts the office and opens your browser when it is ready. Close this window to stop it.
call npm run dev -- --open
