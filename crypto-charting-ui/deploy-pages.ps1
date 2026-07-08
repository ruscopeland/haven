# Deploy web app to Cloudflare Pages
$envFile = "..\deploy-secrets.env"
$cfToken = $null
$cfAccount = $null
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match "^CLOUDFLARE_API_TOKEN=(.+)$") { $cfToken = $matches[1].Split("#")[0].Trim() }
    if ($line -match "^CLOUDFLARE_ACCOUNT_ID=(.+)$") { $cfAccount = $matches[1].Split("#")[0].Trim() }
}
if (-not $cfToken -or -not $cfAccount) { Write-Error "Missing Cloudflare credentials"; exit 1 }
$env:CLOUDFLARE_API_TOKEN = $cfToken
$env:CLOUDFLARE_ACCOUNT_ID = $cfAccount
npx wrangler pages deploy dist --project-name haven --commit-dirty
