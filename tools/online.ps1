# Поднимает всё, что нужно для входа: сервер, публичный туннель и ссылка в браузере.
# Запускается из online.cmd (двойной клик).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\Пользователь\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

$cf = Join-Path $root 'tools\bin\cloudflared.exe'
$urlFile = Join-Path $root 'tools\bin\tunnel.url'
$logFile = Join-Path $root 'tools\bin\tunnel.log'

function Test-Server {
  try { return (Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 3).ok -eq $true }
  catch { return $false }
}

# 1. сервер
if (-not (Test-Server)) {
  Write-Host 'Запускаю сервер...'
  Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'server.js')) -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Test-Server); $i += 1) { Start-Sleep -Milliseconds 400 }
}
if (-not (Test-Server)) { throw 'Сервер не поднялся — посмотри, что пишет node server.js' }
Write-Host 'Сервер работает: http://127.0.0.1:8787'

# 2. туннель: старый переиспользуем, если он жив
$url = $null
if (Test-Path $urlFile) {
  $cached = (Get-Content $urlFile -Raw).Trim()
  if ($cached) {
    try {
      if ((Invoke-RestMethod "$cached/api/health" -TimeoutSec 6).ok) { $url = $cached }
    } catch { }
  }
}

if (-not $url) {
  if (-not (Test-Path $cf)) { throw 'Нет tools\bin\cloudflared.exe — скачай его заново' }
  Write-Host 'Открываю публичный туннель...'
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8787', '--no-autoupdate') `
    -RedirectStandardError $logFile -RedirectStandardOutput "$logFile.out" -WindowStyle Hidden

  for ($i = 0; $i -lt 30 -and -not $url; $i += 1) {
    Start-Sleep -Seconds 1
    if (Test-Path $logFile) {
      $url = (Select-String -Path $logFile -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
        Select-Object -First 1).Matches.Value
    }
  }
  if (-not $url) { throw 'Туннель не выдал ссылку — смотри tools\bin\tunnel.log' }
  Set-Content -Path $urlFile -Value $url -Encoding utf8
}

$link = "https://skarbovoleg.github.io/volna/#api=$url"
Write-Host ''
Write-Host "Публичная ссылка: $url"
Write-Host "Открываю: $link"
if ($env:VOLNA_NO_BROWSER -ne '1') { Start-Process $link }
Write-Host ''
Write-Host 'Готово. Окно можно закрыть — сервер и туннель остаются работать в фоне.'
# 3. публикуем адрес в репозиторий: обычная ссылка github.io/volna подхватит его сама
try {
  Set-Content -Path (Join-Path $root 'server.json') -Value ("{""api"": ""$url""}") -Encoding utf8
  & $node (Join-Path $root 'tools\make-pages.mjs') | Out-Null
  Push-Location $root
  git add server.json docs/server.json 2>$null
  git commit --quiet -m "адрес сервера: $url" 2>$null
  git push --quiet origin main 2>$null
  Pop-Location
  Write-Host 'Адрес опубликован в репозитории — github.io/volna откроется без хвоста.'
} catch {
  Write-Host 'Не удалось опубликовать адрес (не критично):' $_.Exception.Message
}