@echo off
chcp 65001 >nul
title Волна — публичная ссылка

set "DIR=%~dp0"
set "CF=%DIR%tools\bin\cloudflared.exe"

if not exist "%DIR%tools\bin" mkdir "%DIR%tools\bin"

if not exist "%CF%" (
  echo Скачиваю cloudflared, это один раз и около 55 МБ...
  curl.exe -L -o "%CF%" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)

echo.
echo Проверяю, запущен ли сервер на 8787...
curl.exe -s -m 3 -o NUL http://127.0.0.1:8787/api/health
if errorlevel 1 (
  echo Сервер не отвечает — сначала запусти start.cmd в другом окне.
  pause
  exit /b 1
)

echo.
echo Сейчас появится ссылка вида https://что-то.trycloudflare.com
echo Окно нельзя закрывать: пока оно открыто — друг может зайти.
echo.

"%CF%" tunnel --url http://127.0.0.1:8787 --no-autoupdate
pause
