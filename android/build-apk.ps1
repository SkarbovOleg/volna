# Сборка APK «Волны» без Gradle и без интернета: aapt2 + javac + d8 + zipalign + apksigner.
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
param(
  [string]$Sdk = "$env:LOCALAPPDATA\Android\Sdk",
  [string]$BuildTools = "34.0.0",
  [string]$Platform = "android-34"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$android = $PSScriptRoot
$bt = Join-Path $Sdk "build-tools\$BuildTools"
$jar = Join-Path $Sdk "platforms\$Platform\android.jar"
$build = Join-Path $android "build"

foreach ($tool in @("aapt2.exe", "d8.bat", "zipalign.exe", "apksigner.bat")) {
  if (-not (Test-Path (Join-Path $bt $tool))) { throw "Не найден $tool в $bt" }
}
if (-not (Test-Path $jar)) { throw "Не найден android.jar: $jar" }

if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Path $build, "$build\gen", "$build\classes", "$build\dex" | Out-Null

Write-Host "1/6 ресурсы"
& (Join-Path $bt "aapt2.exe") compile --dir "$android\res" -o "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile" }

Write-Host "2/6 манифест и ресурсы"
& (Join-Path $bt "aapt2.exe") link -o "$build\base.apk" -I $jar `
  --manifest "$android\AndroidManifest.xml" `
  --java "$build\gen" `
  --min-sdk-version 23 --target-sdk-version 34 `
  "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link" }

Write-Host "3/6 Java"
$sources = Get-ChildItem -Path "$android\java", "$build\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& javac -encoding UTF-8 -source 8 -target 8 -nowarn -bootclasspath $jar -classpath $jar -d "$build\classes" $sources
if ($LASTEXITCODE -ne 0) { throw "javac" }

Write-Host "4/6 dex"
$classes = Get-ChildItem -Path "$build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& (Join-Path $bt "d8.bat") --lib $jar --min-api 23 --output "$build\dex" $classes
if ($LASTEXITCODE -ne 0) { throw "d8" }

Write-Host "5/6 сборка архива"
$python = if ($env:VOLNA_PYTHON) { $env:VOLNA_PYTHON } else { "python" }
& $python -c @"
import zipfile
apk = r'$build\base.apk'
dex = r'$build\dex\classes.dex'
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('classes.dex добавлен')
"@
if ($LASTEXITCODE -ne 0) { throw "добавление classes.dex" }

& (Join-Path $bt "zipalign.exe") -f -p 4 "$build\base.apk" "$build\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign" }

Write-Host "6/6 подпись"
$keystore = Join-Path $android "volna-debug.jks"
if (-not (Test-Path $keystore)) {
  cmd /c "keytool -genkeypair -v -keystore `"$keystore`" -alias volna -storepass volna123 -keypass volna123 -keyalg RSA -keysize 2048 -validity 10000 -dname `"CN=Volna, OU=Volna, O=Volna, C=RU`" >nul 2>&1"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $keystore)) { throw "keytool" }
}

cmd /c "`"$(Join-Path $bt 'apksigner.bat')`" sign --ks `"$keystore`" --ks-pass pass:volna123 --key-pass pass:volna123 --out `"$build\volna.apk`" `"$build\aligned.apk`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "apksigner" }

cmd /c "`"$(Join-Path $bt 'apksigner.bat')`" verify `"$build\volna.apk`" 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "проверка подписи" }

$size = [math]::Round((Get-Item "$build\volna.apk").Length / 1KB, 0)
Write-Host ""
Write-Host "Готово: $build\volna.apk ($size КБ)"
