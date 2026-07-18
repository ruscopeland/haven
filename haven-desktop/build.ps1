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
Push-Location "$root\frontend"
npm ci --no-audit --no-fund 2>&1 | Out-Null
npm run build 2>&1
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
Pop-Location

# ---- Step 2: Copy to Wails ----
Write-Host "[2/4] Copying frontend assets..." -ForegroundColor Cyan
$distDir = "$root\cmd\haven\frontend\dist"
Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
Copy-Item -Recurse "$root\frontend\dist\*" $distDir

# ---- Step 3: Go Build ----
Write-Host "[3/4] Building Go binary..." -ForegroundColor Cyan
Push-Location $root
# Get build hash for integrity checking
$buildHash = git -C (Resolve-Path "$root\..") rev-parse HEAD 2>$null
if (-not $buildHash) { $buildHash = "dev" }
$ldflags = "-X main.BuildHash=$buildHash"
if ($release) { $ldflags = "-s -w -X main.Version=$ver -X main.BuildHash=$buildHash" }
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

    # ---- Sign manifest with Ed25519 release key ----
    Write-Host ""
    $manifestPath = "$binDir\$($manifest.filename).manifest.json"
    $signScript = @"
import base64, hashlib, json, os, subprocess, time, sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

manifest_path = sys.argv[1]
manifest = json.loads(Path(manifest_path).read_text())

# Load key via DPAPI
local_dir = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'Haven'
private_path = local_dir / 'engine-release-signing.dpapi'
if not private_path.is_file():
    print('WARNING: No release signing key found — skipping signature')
    sys.exit(0)

result = subprocess.run(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
     'Add-Type -AssemblyName System.Security; ' +
     '\$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
     '\$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(' +
     '\$protected, \$null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
     '[Text.Encoding]::UTF8.GetString(\$plain)'],
    input=private_path.read_text(encoding='utf8'), text=True, capture_output=True)
if result.returncode:
    print('WARNING: Failed to unlock release key — skipping signature')
    sys.exit(0)

private_key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(result.stdout.strip()))

unsigned = {'version': manifest['version'], 'sha256': manifest['sha256'],
            'created_at': int(time.time()), 'algorithm': 'Ed25519'}
canonical = json.dumps(unsigned, sort_keys=True, separators=(',', ':')).encode()
signature = base64.b64encode(private_key.sign(canonical)).decode()

signed = {**unsigned, 'signature': signature,
          'filename': manifest.get('filename', ''),
          'platform': manifest.get('platform', '')}
Path(manifest_path).with_suffix('.signed.json').write_text(
    json.dumps(signed, indent=2) + '\n', encoding='utf8')
print(f'  Signed manifest: {Path(manifest_path).with_suffix(".signed.json")}')
"@
    
    $signScript | Out-File -Encoding UTF8 "$env:TEMP\haven_sign.py"
    python "$env:TEMP\haven_sign.py" "$manifestPath" 2>&1
    Remove-Item "$env:TEMP\haven_sign.py" -ErrorAction SilentlyContinue

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
