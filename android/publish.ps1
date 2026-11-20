param([Parameter(Mandatory)][string]$Notes)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$config = Get-Content -Raw build.gradle
$code = [regex]::Match($config, 'versionCode (\d+)').Groups[1].Value
$version = [regex]::Match($config, "versionName '([\d.]+)'").Groups[1].Value
if (!$code -or !$version) { throw 'Versão inválida.' }
$tools = "$env:USERPROFILE/android-dev"
$env:JAVA_HOME = "$tools/jdk-17.0.21+9"
$env:Path = "$env:JAVA_HOME/bin;$env:Path"
& "$tools/gradle-9.9.1/bin/gradle.bat" assembleRelease
if ($LASTEXITCODE) { throw 'Falha no build.' }
$keyDir = "$env:LOCALAPPDATA/HarnessAndroid/signing"
$secret = ConvertTo-SecureString (Get-Content -Raw "$keyDir/password.dpapi").Trim()
$env:HARNESS_SIGN_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
$signer = "$tools/sdk/build-tools/36.0.0/apksigner.bat"
$name = "Codex-Harness-Android-$version.apk"
$apk = "build/$name"
$unsigned = (Get-ChildItem build/outputs/apk/release/*unsigned.apk | Select-Object -First 1).FullName
try {
    & $signer sign --ks "$keyDir/release.p12" --ks-key-alias harness --ks-pass env:HARNESS_SIGN_PASSWORD --out $apk $unsigned
    if ($LASTEXITCODE) { throw 'Falha na assinatura.' }
} finally { Remove-Item Env:HARNESS_SIGN_PASSWORD }
& $signer verify $apk
if ($LASTEXITCODE) { throw 'Assinatura inválida.' }
$hash = (Get-FileHash $apk).Hash.ToLowerInvariant()
$remote = ".harness-android-$([guid]::NewGuid().ToString('N')).apk"
scp $apk "oracle:/home/ubuntu/$remote"
if ($LASTEXITCODE) { throw 'Falha na transferência.' }
$payload = @{ upload=$remote; name=$name; versionName=$version; versionCode=[int]$code; sha256=$hash; notes=$Notes } | ConvertTo-Json -Compress
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
$OutputEncoding = [Text.Encoding]::UTF8
Get-Content -Raw publish-remote.py | ssh oracle "python3 - $encoded && sudo -n systemctl restart codex-agent-ui.service"
if ($LASTEXITCODE) { throw 'Falha ao publicar.' }
$download = Join-Path $env:TEMP ("harness-verify-" + [guid]::NewGuid() + ".apk")
try {
    curl.exe -fsS --retry 5 --retry-delay 2 "https://nyxrooms.com/codex-agent/$name" -o $download
    if ($LASTEXITCODE -or (Get-FileHash $download).Hash.ToLowerInvariant() -ne $hash) { throw 'APK publicado diverge.' }
} finally { if (Test-Path $download) { Remove-Item -LiteralPath $download } }
