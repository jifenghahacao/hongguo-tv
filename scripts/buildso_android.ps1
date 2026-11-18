# Cross-compile the Go core into jniLibs for Android.
# CGO must stay enabled (NDK clang): CGO_ENABLED=0 breaks DNS on device.
# Usage: powershell -File scripts/buildso_android.ps1 [-Version 1.0.0]
# Without -Version the core is tagged "<appVersion>-dev" to match debug builds.
param([string]$Version = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not $Version) {
    $line = Get-Content "android\app\build.gradle" -TotalCount 10 | Select-String 'def appVersion = "([^"]+)"'
    if (-not $line) { throw "appVersion not found in build.gradle" }
    $Version = $line.Matches[0].Groups[1].Value + "-dev"
}
Write-Output "core version: $Version"
$ndk = "C:\Android\ndk\27.2.12479018\toolchains\llvm\prebuilt\windows-x86_64\bin"
if (-not (Test-Path "$ndk\clang.exe")) { throw "NDK clang missing under $ndk" }
$env:CGO_ENABLED = "1"; $env:GOOS = "android"
foreach ($arch in @(@("arm64", "aarch64", "arm64-v8a"), @("amd64", "x86_64", "x86_64"))) {
    $env:GOARCH = $arch[0]
    $env:CC = "$ndk\clang.exe --target=$($arch[1])-linux-android21"
    $env:CXX = "$ndk\clang++.exe --target=$($arch[1])-linux-android21"
    go build -trimpath -buildmode=pie -ldflags "-s -w -X main.version=$Version" -o "android\app\src\main\jniLibs\$($arch[2])\libhongguotv.so" .\core\cmd\hongguotv
    if ($LASTEXITCODE -ne 0) { throw "$($arch[2]) build failed" }
    Write-Output "$($arch[2]) OK"
}
Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
Remove-Item Env:GOOS -ErrorAction SilentlyContinue
