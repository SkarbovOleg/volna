@echo off
chcp 65001 >nul
title Волна — онлайн
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\online.ps1"
echo.
pause
