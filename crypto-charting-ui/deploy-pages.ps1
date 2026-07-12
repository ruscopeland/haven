# Build + deploy web app to Cloudflare Pages (production).
# Always rebuilds so VITE_* env is baked correctly — wrong API host causes
# browser "Failed to fetch" (e.g. api.haven.trade is not our API).
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot "..\deploy-secrets.env"
if (-not (Test-Path $envFile)) { Write-Error "Missing $envFile"; exit 1 }

$cfToken = $null
$cfAccount = $null
$clerkKey = $null
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match "^CLOUDFLARE_API_TOKEN=(.+)$") { $cfToken = $matches[1].Split("#")[0].Trim() }
    if ($line -match "^CLOUDFLARE_ACCOUNT_ID=(.+)$") { $cfAccount = $matches[1].Split("#")[0].Trim() }
    if ($line -match "^CLERK_PUBLISHABLE_KEY=(.+)$") { $clerkKey = $matches[1].Split("#")[0].Trim() }
}
if (-not $cfToken -or -not $cfAccount) { Write-Error "Missing Cloudflare credentials"; exit 1 }
if (-not $clerkKey) { Write-Error "Missing CLERK_PUBLISHABLE_KEY"; exit 1 }

# Working Railway public URL. Custom domain api.haven.trading is registered but
# currently serves a *.up.railway.app cert (name mismatch) — do not use until TLS is fixed.
$env:VITE_API_URL = "https://api-production-0dc54.up.railway.app"
$env:VITE_CLERK_PUBLISHABLE_KEY = $clerkKey
# CRITICAL: do not bake the operator's local .env wallet into production.
# An empty value overrides crypto-charting-ui/.env VITE_WALLET_ADDRESS at build time.
$env:VITE_WALLET_ADDRESS = ""
$env:CLOUDFLARE_API_TOKEN = $cfToken
$env:CLOUDFLARE_ACCOUNT_ID = $cfAccount

Set-Location $PSScriptRoot
Write-Host "Building with VITE_API_URL=$($env:VITE_API_URL)"
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx wrangler pages deploy dist --project-name haven --commit-dirty
