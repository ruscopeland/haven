# Build + deploy the production web app to the existing Cloudflare Pages site.
# Cloudflare authentication comes from Wrangler's encrypted login by default.
# A CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID pair can still be supplied by a
# protected CI environment; this script never reads credentials from a workspace
# plaintext file.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$hasToken = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)
$hasAccount = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)
if ($hasToken -xor $hasAccount) {
    Write-Error "Set both CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or neither when using Wrangler login."
    exit 1
}
if (-not $hasToken) {
    npx.cmd wrangler whoami *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cloudflare login is unavailable. Run 'npx wrangler login' once, then retry."
        exit $LASTEXITCODE
    }
}

# Haven stays on Clerk's test gateway until the owner deliberately launches
# real billing. This public key identifies the existing Haven development
# instance; it is not a credential. For launch, set HAVEN_CLERK_ENVIRONMENT=live
# and supply the production VITE_CLERK_PUBLISHABLE_KEY.
$clerkEnvironment = if ($env:HAVEN_CLERK_ENVIRONMENT) {
    $env:HAVEN_CLERK_ENVIRONMENT.ToLowerInvariant()
} else {
    "test"
}
if ($clerkEnvironment -eq "test") {
    $clerkKey = "pk_test_cHJlcGFyZWQtc2t5bGFyay0xMi5jbGVyay5hY2NvdW50cy5kZXYk"
} elseif ($clerkEnvironment -eq "live") {
    $clerkKey = $env:VITE_CLERK_PUBLISHABLE_KEY
    if ([string]::IsNullOrWhiteSpace($clerkKey) -or -not $clerkKey.StartsWith("pk_live_")) {
        Write-Error "Live billing requires the production VITE_CLERK_PUBLISHABLE_KEY."
        exit 1
    }
} else {
    Write-Error "HAVEN_CLERK_ENVIRONMENT must be 'test' or 'live'."
    exit 1
}

# Haven's stable production API address.
$env:VITE_API_URL = "https://api.haven.trading"
$env:VITE_CLERK_PUBLISHABLE_KEY = $clerkKey
# CRITICAL: do not bake the operator's local .env wallet into production.
# An empty value overrides crypto-charting-ui/.env VITE_WALLET_ADDRESS at build time.
$env:VITE_WALLET_ADDRESS = ""
# Make all JavaScript asset URLs deployment-specific. The Cloudflare domain
# cache deliberately holds assets longer than HTML, and this prevents an old
# shell from resolving a lazy editor import to an obsolete chunk.
$env:VITE_BUILD_ID = (git rev-parse --short HEAD).Trim()

Write-Host "Building Haven with Clerk $clerkEnvironment billing"
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx.cmd wrangler pages deploy dist --project-name haven --commit-dirty
