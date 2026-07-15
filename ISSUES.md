# Open issues

## Verify paid-user engine downloads in production

Release `1.1.0` was successfully built, signed, and deployed through the
GitHub-to-Railway workflow on 2026-07-15. Production health returned `200`, and
unauthenticated Windows and Linux download requests returned `401`, as intended.
The signing key, Railway deployment token, public verification key, and four
release files are connected.

Next action: sign in as a paid test user and download both
`platform=windows` and `platform=linux`. Confirm the expected installer is
returned and that `X-Haven-Release` and `X-Haven-SHA256` headers are present.

Evidence required to close: successful paid authenticated downloads for both
platforms, with the version and checksum headers recorded without copying any
credential or private-key material.
