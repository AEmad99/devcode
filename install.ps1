# DevCode installer for Windows (PowerShell 5.1+ / PowerShell 7+)
#
# One-liner (after the repo is on GitHub):
#   irm https://raw.githubusercontent.com/AEmad99/devcode/main/install.ps1 | iex
#
# Options:
#   $env:DEVCODE_INSTALL_DIR = "D:\tools\devcode"   # custom install root
#   $env:DEVCODE_REPO        = "https://github.com/AEmad99/devcode.git"
#   $env:DEVCODE_REF         = "main"

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:DEVCODE_REPO) { $env:DEVCODE_REPO } else { "https://github.com/AEmad99/devcode.git" }
$Ref = if ($env:DEVCODE_REF) { $env:DEVCODE_REF } else { "main" }
$InstallRoot = if ($env:DEVCODE_INSTALL_DIR) {
  $env:DEVCODE_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "devcode"
}
$SrcDir = Join-Path $InstallRoot "src"
$BinDir = Join-Path $InstallRoot "bin"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Ensure-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Ensure-Bun {
  if (Ensure-Command "bun") {
    Write-Host "Bun: $(bun --version)"
    return
  }
  Write-Step "Bun not found — installing Bun"
  # Official Windows install (adds bun to user PATH for new shells)
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
  $bunPaths = @(
    (Join-Path $env:USERPROFILE ".bun\bin"),
    (Join-Path $env:LOCALAPPDATA "bun\bin")
  )
  foreach ($p in $bunPaths) {
    if (Test-Path (Join-Path $p "bun.exe")) {
      $env:Path = "$p;$env:Path"
      break
    }
  }
  if (-not (Ensure-Command "bun")) {
    throw "Bun was installed but is not on PATH yet. Open a new PowerShell window and re-run this installer."
  }
  Write-Host "Bun: $(bun --version)"
}

function Ensure-Git {
  if (Ensure-Command "git") { return }
  throw "Git is required. Install from https://git-scm.com/download/win and re-run."
}

function Add-ToUserPath([string]$dir) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $parts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
  $normalized = $parts | ForEach-Object { $_.TrimEnd("\").ToLowerInvariant() }
  $target = $dir.TrimEnd("\").ToLowerInvariant()
  if ($normalized -contains $target) {
    Write-Host "PATH already contains $dir"
    return
  }
  $newPath = if ($userPath.Trim()) { "$userPath;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$dir;$env:Path"
  Write-Host "Added to user PATH: $dir"
}

Write-Host @"

  DevCode installer (Windows)
  Repo:  $RepoUrl ($Ref)
  Root:  $InstallRoot

"@ -ForegroundColor Green

Ensure-Git
Ensure-Bun

Write-Step "Preparing install directories"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (Test-Path (Join-Path $SrcDir ".git")) {
  Write-Step "Updating existing clone"
  Push-Location $SrcDir
  try {
    git fetch --tags --force origin 2>$null
    git checkout $Ref 2>$null
    git pull --ff-only origin $Ref 2>$null
    if ($LASTEXITCODE -ne 0) {
      # Detached or first fetch of ref
      git fetch origin $Ref
      git checkout -B $Ref "origin/$Ref"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Step "Cloning repository"
  if (Test-Path $SrcDir) {
    Remove-Item -Recurse -Force $SrcDir
  }
  git clone --branch $Ref --depth 1 $RepoUrl $SrcDir
  if ($LASTEXITCODE -ne 0) {
    # Branch might be master on first publish
    git clone --depth 1 $RepoUrl $SrcDir
  }
}

Write-Step "Installing dependencies"
Push-Location $SrcDir
try {
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed" }

  Write-Step "Building dist/index.js (Node-compatible)"
  bun run build
  if ($LASTEXITCODE -ne 0) { throw "bun run build failed" }

  Write-Step "Compiling native Windows binary"
  bun run compile
  if ($LASTEXITCODE -ne 0) {
    Write-Host "compile failed — falling back to node launcher" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}

Write-Step "Installing launchers into $BinDir"

# Prefer compiled exe when present
$compiled = Join-Path $SrcDir "dist\devcode.exe"
$jsEntry = Join-Path $SrcDir "dist\index.js"

if (Test-Path $compiled) {
  Copy-Item -Force $compiled (Join-Path $BinDir "devcode.exe")
  Write-Host "Installed binary: $BinDir\devcode.exe"
} elseif (Test-Path $jsEntry) {
  # Fallback: cmd shim that runs via bun or node
  $shim = @"
@echo off
setlocal
set "ENTRY=$jsEntry"
where bun >nul 2>&1 && (
  bun "%ENTRY%" %*
  exit /b %ERRORLEVEL%
)
where node >nul 2>&1 && (
  node "%ENTRY%" %*
  exit /b %ERRORLEVEL%
)
echo DevCode: need bun or node on PATH to run.
exit /b 1
"@
  Set-Content -Path (Join-Path $BinDir "devcode.cmd") -Value $shim -Encoding ASCII
  Write-Host "Installed shim: $BinDir\devcode.cmd"
} else {
  throw "Build did not produce dist/devcode.exe or dist/index.js"
}

# Convenience: also write a small PowerShell wrapper
$ps1 = @"
#!/usr/bin/env pwsh
`$exe = Join-Path `$PSScriptRoot "devcode.exe"
`$cmd = Join-Path `$PSScriptRoot "devcode.cmd"
if (Test-Path `$exe) { & `$exe @args; exit `$LASTEXITCODE }
if (Test-Path `$cmd) { & `$cmd @args; exit `$LASTEXITCODE }
Write-Error "DevCode binary missing under `$PSScriptRoot"
exit 1
"@
Set-Content -Path (Join-Path $BinDir "devcode.ps1") -Value $ps1 -Encoding UTF8

Add-ToUserPath $BinDir

Write-Host ""
Write-Host "DevCode installed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "  Open a NEW terminal, then run:" -ForegroundColor Yellow
Write-Host "    devcode"
Write-Host ""
Write-Host "  First-time setup:"
Write-Host "    devcode          # start TUI"
Write-Host "    /login           # connect a provider"
Write-Host "    /model           # pick a model"
Write-Host ""
Write-Host "  Install root: $InstallRoot"
Write-Host "  Source:       $SrcDir"
Write-Host ""
