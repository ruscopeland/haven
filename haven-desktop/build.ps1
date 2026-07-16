# Haven Desktop Build Script
# Builds the React frontend, Go desktop app, and platform installers.
#
# Usage:
#   powershell -File build.ps1              # Dev build
#   powershell -File build.ps1 -release      # Production build + sign + package
#   powershell -File build.ps1 -release -version "1.2.0"

param(
    [switch]$release,
    [string]$version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = "$root\bin"
New-Item -ItemType Directory -Force $binDir | Out-Null

if ($release) {
    $ver = if ($version) { $version } elseif ($env:HAVEN_VERSION) { $env:HAVEN_VERSION } else { "0.1.0" }
    Write-Host "=== Haven Desktop Release Build v$ver ===" -ForegroundColor Green
} else {
    Write-Host "=== Haven Desktop Dev Build ===" -ForegroundColor Green
}

# ---- Step 1: React Frontend ----
Write-Host "[1/4] Building React frontend..." -ForegroundColor Cyan
Push-Location "$root\..\crypto-charting-ui"
$env:VITE_API_URL = "http://localhost:8000"
$env:VITE_DESKTOP_MODE = "true"
npm ci --no-audit --no-fund 2>&1 | Out-Null
Copy-Item desktop.html index.html -Force
npm run build 2>&1
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
git checkout index.html 2>$null
Pop-Location

# ---- Step 2: Copy to Wails ----
Write-Host "[2/4] Copying frontend assets..." -ForegroundColor Cyan
$distDir = "$root\cmd\haven\frontend\dist"
Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
Copy-Item -Recurse "$root\..\crypto-charting-ui\dist\*" $distDir

# ---- Step 3: Go Build ----
Write-Host "[3/4] Building Go binary..." -ForegroundColor Cyan
Push-Location $root
$ldflags = ""
if ($release) { $ldflags = "-s -w -X main.Version=$ver" }
$exeName = if ($IsLinux) { "haven-desktop" } elseif ($IsMacOS) { "haven-desktop" } else { "haven-desktop.exe" }
go build -ldflags "$ldflags" -o "$binDir\$exeName" ./cmd/haven/
if ($LASTEXITCODE -ne 0) { throw "Go build failed" }
Pop-Location

# ---- Step 4: Release packaging ----
if ($release) {
    Write-Host "[4/4] Packaging release..." -ForegroundColor Cyan

    # Compute SHA256
    $hash = (Get-FileHash "$binDir\$exeName" -Algorithm SHA256).Hash.ToLower()

    # Create manifest
    $manifest = @{
        version = $ver
        platform = if ($IsLinux) { "linux" } elseif ($IsMacOS) { "darwin" } else { "windows" }
        filename = "haven-$ver-$($manifest.platform).exe"  # will be replaced below
        sha256 = $hash
    }

    if ($IsWindows) {
        # Rename binary
        $releaseExe = "haven-$ver-windows.exe"
        Copy-Item "$binDir\$exeName" "$binDir\$releaseExe" -Force
        $manifest.filename = $releaseExe
        $manifest.platform = "windows"

        # Build NSIS installer if makensis is available
        $nsis = Get-Command makensis -ErrorAction SilentlyContinue
        if ($nsis) {
            Write-Host "  Building NSIS installer..." -ForegroundColor DarkCyan
            $env:HAVEN_VERSION = $ver
            Push-Location "$root\installer"
            & makensis /DHAVEN_VERSION=$ver installer.nsi 2>&1
            Pop-Location
            Write-Host "  Installer: bin/haven-setup.exe" -ForegroundColor Green
        } else {
            Write-Host "  NSIS not found — skipping installer (install makensis for .exe packaging)" -ForegroundColor Yellow
        }
    } elseif ($IsLinux) {
        $releaseFile = "haven-$ver-linux.tar.gz"
        Push-Location $binDir
        tar -czf $releaseFile $exeName
        Pop-Location
        $manifest.filename = $releaseFile
        $manifest.platform = "linux"
    }

    # Write manifest
    $manifest | ConvertTo-Json | Out-File -Encoding UTF8 "$binDir\$($manifest.filename).manifest.json"
    Write-Host "  Manifest: bin/$($manifest.filename).manifest.json" -ForegroundColor Green

    # Sign manifest if release key is available
    Write-Host ""
    Write-Host "Release files in bin/:" -ForegroundColor Green
    Get-ChildItem $binDir | Where-Object { $_.Name -like "haven-$ver*" } | ForEach-Object {
        Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1MB, 1)) MB)"
    }
} else {
    Write-Host "[4/4] Dev build complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "Run: .\bin\$exeName" -ForegroundColor Yellow
}
