@echo off
chcp 65001 >nul
setlocal
title Волна

rem Node из комплекта DSH; если его нет — обычный node из PATH.
set "BUNDLED_NODE=C:\Users\Пользователь\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "NODE_CMD=node"
if exist "%BUNDLED_NODE%" set "NODE_CMD=%BUNDLED_NODE%"

rem server.js сам поднимет фото-сервер на 8788, так что процесс один на виду.
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8787"
"%NODE_CMD%" "%~dp0server.js"

echo.
echo Сервер остановлен.
pause
