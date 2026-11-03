# Rebuild the dev link between this repository and the installed DSH profile.
#
# `dsh plugin --profile desktop add file:D:/DSH-workspace/dsh-btw` copies the
# package into the profile's node_modules. That copy goes stale as soon as you
# edit lib/client.js here, and the desktop app keeps serving the old bundle.
#
# This script replaces the copied directory with a junction that points at this
# repository, so the host picks up local edits. Restart DSH Desktop afterwards
# (the client bundle hash is baked into the boot graph at host start).
#
# Run it again if a `dsh plugin add`/`pnpm install` turns the entry back into a
# plain copy:
#   powershell -ExecutionPolicy Bypass -File tools/relink-dev.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$installed = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-btw-plugin'

if (-not (Test-Path -LiteralPath $repo)) { throw "repository not found: $repo" }
if (-not (Test-Path -LiteralPath $installed)) { throw "plugin is not installed in the desktop profile: $installed" }

$item = Get-Item -LiteralPath $installed -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  $target = $item.Target | Select-Object -First 1
  if ($target -eq $repo) { Write-Host "already linked: $installed -> $repo"; exit 0 }
  throw "already a link to somewhere else: $target"
}

$pkg = Get-Content (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-btw-plugin') { throw "target is not the dsh-btw-plugin package: $($pkg.name)" }

Remove-Item -LiteralPath $installed -Recurse -Force
cmd /c mklink /J "$installed" "$repo" | Out-Null

$hash = (Get-FileHash (Join-Path $installed 'lib/client.js')).Hash
Write-Host "linked: $installed -> $repo"
Write-Host "client.js sha256: $hash"
Write-Host 'Now fully quit and reopen DSH Desktop so the new bundle is hashed into the boot graph.'
