# Сторож «Волны»: держит сервер и публичный туннель живыми.
# Запускается планировщиком каждые 5 минут, ничего не показывает на экране.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\Пользователь\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

$cf = Join-Path $root 'tools\bin\cloudflared.exe'
$urlFile = Join-Path $root 'tools\bin\tunnel.url'
$logFile = Join-Path $root 'tools\bin\tunnel.log'
$watchLog = Join-Path $root 'tools\bin\watchdog.log'
$serverJson = Join-Path $root 'server.json'

function Write-Log([string]$message) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $watchLog -Value $line -Encoding utf8
}

# лог не должен расти бесконечно
if ((Test-Path $watchLog) -and ((Get-Item $watchLog).Length -gt 300KB)) {
  Move-Item $watchLog ($watchLog + '.old') -Force
}

function Test-Url([string]$url, [int]$timeoutSec = 8) {
  if (-not $url) { return $false }
  try {
    $response = Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing -ErrorAction Stop
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Stop-Cloudflared {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Tunnel {
  if (-not (Test-Path $cf)) {
    Write-Log 'нет cloudflared.exe — туннель не поднять'
    return $null
  }
  Stop-Cloudflared
  Start-Sleep -Milliseconds 700
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8787', '--no-autoupdate') `
    -RedirectStandardError $logFile -RedirectStandardOutput "$logFile.out" -WindowStyle Hidden

  for ($i = 0; $i -lt 30; $i += 1) {
    Start-Sleep -Seconds 2
    if (Test-Path $logFile) {
      $found = (Select-String -Path $logFile -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
        Select-Object -First 1).Matches.Value
      if ($found) { return $found }
    }
  }
  Write-Log 'туннель не выдал адрес за минуту'
  return $null
}

function Publish-Url([string]$url) {
  Set-Content -Path $urlFile -Value $url -Encoding utf8
  [System.IO.File]::WriteAllText($serverJson, ('{"api": "' + $url + '"}' + "`n"), [System.Text.UTF8Encoding]::new($false))
  & $node (Join-Path $root 'tools\make-pages.mjs') | Out-Null

  $env:GIT_TERMINAL_PROMPT = '0'
  Push-Location $root
  try {
    git add server.json docs/server.json 2>$null
    $staged = git diff --cached --name-only 2>$null
    if ($staged) {
      git commit --quiet -m ('адрес сервера: ' + $url) 2>$null
      git push --quiet origin main 2>$null
      if ($LASTEXITCODE -eq 0) { Write-Log 'новый адрес опубликован в репозитории' }
      else { Write-Log 'не удалось запушить адрес (проверь git)' }
    }
  } finally {
    Pop-Location
  }
}

# 1. сервер
if (-not (Test-Url 'http://127.0.0.1:8787/api/health' 5)) {
  Write-Log 'сервер не отвечает — запускаю'
  Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'server.js')) -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 25; $i += 1) {
    Start-Sleep -Milliseconds 800
    if (Test-Url 'http://127.0.0.1:8787/api/health' 3) { break }
  }
  if (Test-Url 'http://127.0.0.1:8787/api/health' 3) { Write-Log 'сервер поднялся' }
  else { Write-Log 'сервер не поднялся'; exit 1 }
}

# 2. туннель
$current = ''
if (Test-Path $urlFile) { $current = (Get-Content $urlFile -Raw).Trim() }

if (Test-Url ($current + '/api/health') 10) {
  Write-Log ('всё в порядке: ' + $current)
  exit 0
}

Write-Log ('туннель мёртв: ' + $(if ($current) { $current } else { '(адреса нет)' }) + ' — поднимаю новый')
$fresh = Start-Tunnel
if (-not $fresh) { exit 1 }

# ждём, пока имя начнёт разрешаться, иначе клиент увидит «сервер не отвечает»
$alive = $false
for ($i = 0; $i -lt 12; $i += 1) {
  Start-Sleep -Seconds 3
  if (Test-Url ($fresh + '/api/health') 10) { $alive = $true; break }
}
if (-not $alive) {
  ipconfig /flushdns | Out-Null
  Start-Sleep -Seconds 4
  try { $alive = Test-Url ($fresh + '/api/health') 15 } catch { $alive = $false }
}

Write-Log ('новый туннель: ' + $fresh + $(if ($alive) { ' (отвечает)' } else { ' (ещё не отвечает)' }))
Publish-Url $fresh
