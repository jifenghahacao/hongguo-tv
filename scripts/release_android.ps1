# One-command Android release: signed APK -> GitHub Release -> auto-update manifest.
# Installed users pick the new version up on next launch (<=1 check/day) or via
# "Mine -> Check for updates"; download is SHA-256 + signature verified.
#
# Prereqs (one-time):
#   1. Keystore:  keytool -genkeypair -keystore %USERPROFILE%\.hongguotv\release.keystore -alias hongguotv -keyalg RSA -keysize 2048 -validity 10000
#   2. Env vars:  ANDROID_KEYSTORE_FILE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD
#   3. GH_TOKEN:  GitHub PAT with public_repo scope (for the Releases API)
#   4. First commit the version bump (build.gradle appVersion/versionCode) + CHANGELOG.md section.
#
# Usage: powershell -File scripts/release_android.ps1 -Version 1.0.1 -Code 101 [-Mpv]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][int]$Code,
    [switch]$Mpv,
    [string]$Proxy = "http://127.0.0.1:7890"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
$api = "https://api.github.com/repos/jifenghahacao/hongguo-tv"
$gradleBat = "C:\Gradle\gradle-8.13\bin\gradle.bat"

# --- guards -------------------------------------------------------------
$gradle = Get-Content "android\app\build.gradle" -Raw
if ($gradle -notmatch ('def appVersion = "' + [regex]::Escape($Version) + '"')) { throw "build.gradle appVersion != $Version; bump and commit it first" }
foreach ($v in @("ANDROID_KEYSTORE_FILE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")) {
    if (-not (Get-Item "Env:$v").Value) { throw "missing signing env var $v (see script header)" }
}
if (-not $env:GH_TOKEN) { throw "GH_TOKEN is required to publish the GitHub Release" }
$dirty = & git status --porcelain
if ($dirty) { throw "working tree not clean; commit the release changes first" }

# --- build --------------------------------------------------------------
# CORE_VERSION baked into the APK must equal the -X main.version of the .so,
# otherwise the startup handshake fails ("本机服务连接失败").
$env:HONGGUO_CORE_VERSION = $Version
& powershell -File scripts\buildso_android.ps1 -Version $Version
if ($LASTEXITCODE) { throw "core .so build failed" }
& $gradleBat -p android assembleStandardRelease -q
if ($LASTEXITCODE) { throw "gradle assembleStandardRelease failed" }
$flavors = @("standard")
if ($Mpv) {
    & $gradleBat -p android assembleMpvRelease -q
    if ($LASTEXITCODE) { throw "gradle assembleMpvRelease failed" }
    $flavors += "mpv"
}

# --- release notes for this version -------------------------------------
# Read with explicit UTF-8: Windows PowerShell 5.1 would otherwise decode
# the BOM-less UTF-8 CHANGELOG as ANSI/GBK and corrupt every Chinese note.
$grab = $false; $notes = @()
foreach ($line in (([System.IO.File]::ReadAllText("$repoRoot\CHANGELOG.md", [System.Text.Encoding]::UTF8)) -split "`n")) {
    if ($line -match '^## v') { $grab = ($line -match ('^## v' + [regex]::Escape($Version) + '(?![0-9])')); continue }
    if ($grab) { $notes += $line.TrimEnd("`r") }
}
if (-not $notes.Count) { throw "CHANGELOG.md has no '## v$Version' section" }
$notesFile = Join-Path $env:TEMP "hongguo-notes-$Version.txt"
# BOM-free UTF-8: generate_update.py reads the notes as plain utf-8.
[System.IO.File]::WriteAllText($notesFile, (($notes -join "`n").Trim()), (New-Object System.Text.UTF8Encoding($false)))

# --- GitHub Release -------------------------------------------------------
# An empty -Proxy means "direct": curl rejects "-x ''", so drop the flag.
$px = if ($Proxy) { @("-x", $Proxy) } else { @() }
$tag = "v$Version"
# ReadAllText (not Get-Content) so the body stays a plain string for ConvertTo-Json.
$body = @{ tag_name = $tag; name = "红果漫剧 $tag"; body = [System.IO.File]::ReadAllText($notesFile); draft = $false; prerelease = $false } | ConvertTo-Json
$bodyFile = Join-Path $env:TEMP "hongguo-release-$Version.json"
[System.IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))
# Reuse an existing release for this tag (reruns after a partial failure).
$rel = (& curl.exe -s @px -H "Authorization: token $env:GH_TOKEN" "$api/releases/tags/$tag") | ConvertFrom-Json
if ($rel.id) {
    # Refresh the body too: earlier runs may have posted mojibake notes.
    $patch = @{ body = [System.IO.File]::ReadAllText($notesFile) } | ConvertTo-Json
    $patchFile = Join-Path $env:TEMP "hongguo-patch-$Version.json"
    [System.IO.File]::WriteAllText($patchFile, $patch, (New-Object System.Text.UTF8Encoding($false)))
    & curl.exe -s @px -X PATCH -H "Authorization: token $env:GH_TOKEN" -H "Content-Type: application/json" --data-binary "@$patchFile" "$api/releases/$($rel.id)" | Out-Null
} else {
    $relJson = & curl.exe -s @px -H "Authorization: token $env:GH_TOKEN" -H "Content-Type: application/json" --data-binary "@$bodyFile" "$api/releases"
    $rel = $relJson | ConvertFrom-Json
    if (-not $rel.id) { throw "release create failed: $relJson" }
}
Write-Output "release: $($rel.html_url)"

# --- manifest + assets ----------------------------------------------------
foreach ($flavor in $flavors) {
    $prefix = if ($flavor -eq "standard") { "" } else { "$flavor-" }
    $src = "android\app\build\outputs\apk\$flavor\release\app-$flavor-release.apk"
    if (-not (Test-Path $src)) { throw "missing $src" }
    $asset = "hongguo-tv-$prefix$Version.apk"
    $dst = Join-Path $env:TEMP $asset
    Copy-Item $src $dst -Force
    & python scripts\generate_update.py --apk $dst --version $Version --code $Code --min-sdk 23 --notes $notesFile --out "update$prefix.json" --variant $flavor
    if ($LASTEXITCODE) { throw "generate_update.py failed for $flavor" }
    # Asset uploads must go to uploads.github.com, not the REST host.
    # Replace a same-named asset from a previous partial run so the uploaded
    # APK always matches the freshly computed sha256 in update.json.
    # (The assets endpoint returns a bare JSON array.)
    $existing = (& curl.exe -s @px -H "Authorization: token $env:GH_TOKEN" "$api/releases/$($rel.id)/assets") | ConvertFrom-Json
    foreach ($a in @($existing | Where-Object { $_.name -eq $asset })) {
        & curl.exe -s @px -X DELETE -H "Authorization: token $env:GH_TOKEN" $a.url | Out-Null
    }
    $upl = & curl.exe -s @px -H "Authorization: token $env:GH_TOKEN" -H "Content-Type: application/vnd.android.package-archive" --data-binary "@$dst" "https://uploads.github.com/repos/jifenghahacao/hongguo-tv/releases/$($rel.id)/assets?name=$asset"
    if (-not (($upl | ConvertFrom-Json).browser_download_url)) { throw "asset upload failed: $upl" }
    Write-Output "uploaded $asset"
}

# --- push the update manifest ----------------------------------------------
git add update.json
if ($Mpv) { git add update-mpv.json }
git commit -m "release: v$Version update manifest"
& git -c http.proxy=$Proxy push origin HEAD:main
Write-Output "DONE: v$Version published. Installed apps will offer the update on next launch."
