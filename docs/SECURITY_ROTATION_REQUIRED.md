# Credential rotation status

Haven's plaintext workspace credentials were removed on 2026-07-13. The local
trading private key was first migrated to the current Windows user's
DPAPI-encrypted credential store outside this workspace.

Before a production launch, rotate or revoke every credential that previously
appeared here:

- Clerk secret key.
- Cloudflare API token.
- Railway API token.
- DeepSeek API key.
- Any old Stripe live/test keys or webhook secrets that Haven once held. Haven
  no longer uses them directly; Stripe stays connected only inside Clerk Billing.
- Alchemy and GoPlus credentials (those providers are retired from Haven).
- Any RPC-provider credentials embedded in old RPC URLs.

The old trading private key must be treated as historically exposed. If its
wallet has or will hold funds, create a new local wallet and transfer assets
on-chain after independently confirming the destination. Haven cannot safely
move funds automatically.

Set `HAVEN_SECRET_ROTATION_CONFIRMED=1` in the production secret manager only
after completing the rotations. Never place replacement values in this file.
