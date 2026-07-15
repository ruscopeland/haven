# Engine release operations

This is the durable handoff for the downloadable Haven engine. It contains no
credential values. A fresh task must read this file, `AGENTS.md`, and the
production runbook before changing engine downloads or attempting a release.

## Current state

The repository now defines two signed platform packages:

- `haven-engine-windows-installer.exe` — an NSIS Windows installer.
- `haven-engine-linux.tar.gz` — a Linux current-user installer bundle.

The API serves only these files and verifies each adjacent manifest before
serving it. Both the artifact and its manifest must be present in
`crypto-data-collector/api/static/` in the source deployed to Railway:

```text
haven-engine-windows-installer.exe
haven-engine-windows-installer.exe.manifest.json
haven-engine-linux.tar.gz
haven-engine-linux.tar.gz.manifest.json
```

`.github/workflows/engine-release.yml` is the protected, manually triggered
GitHub workflow that builds these files. It can also deploy them to Railway only
when the person launching it explicitly selects **Deploy the verified release to
Railway**. Do not claim a downloadable production release exists until the four
files above are in the deployed Railway source and the endpoint has verified
them.

## Ownership and safe locations

| System | Owns | Safe action boundary |
| --- | --- | --- |
| GitHub (`ruscopeland/haven`) | Source, CI, protected release build | The `engine-release` protected environment stores `HAVEN_ENGINE_RELEASE_PRIVATE_KEY`. The `production` protected environment stores `HAVEN_RAILWAY_PROJECT_TOKEN`; repository/environment variables select the Railway project, environment, and API service. Never commit, paste, or expose those values. |
| Railway | API, PostgreSQL, production API configuration | Set `HAVEN_ENGINE_RELEASE_PUBLIC_KEY` to the public half of the existing release-signing key. Railway serves the already-built files through the API. |
| Cloudflare | DNS, HTTPS, and edge proxy | No engine signing key or engine artifact belongs here. Do not change DNS/TLS/proxy settings for a release without explicit owner approval. |
| Clerk | Identity, plans, checkout, subscriptions | No engine signing key or release artifact belongs here. Entitlements are enforced by the API. |

The private signing key and the Railway public key must be the matching halves
of the same existing Ed25519 key pair. Creating, rotating, moving, exposing, or
replacing that key is an owner-authorized security operation, not a routine
build step.

## Local recovery copy

The authorized Windows release operator keeps a recovery copy outside Git using
`crypto-data-collector/tools/engine_release_key.py`. It stores the private key
in `%LOCALAPPDATA%\Haven\engine-release-signing.dpapi`, encrypted for that
Windows user by DPAPI; the public half is stored alongside it. The tool never
prints the private key. A fresh task can run `python
crypto-data-collector/tools/engine_release_key.py status` to confirm that this
machine has the protected recovery copy.

Only during an explicitly authorized key rotation should a task run
`initialize`. To place the existing local key in GitHub's encrypted secret
entry, use `copy-private-for-github`; it writes only to the local clipboard for
that one entry and never writes the key into this workspace.

### Confirmed production target

The target was confirmed in the Railway dashboard on 2026-07-15. These are
identifiers, not credentials, and may be used to configure the GitHub workflow:

- Railway project: `haven` (`28ad7d1e-51bd-4df4-b47c-2bd9ee65b827`)
- Railway environment: `production`
  (`51044258-3ee9-41f1-8f02-51fa62e85c3d`)
- Railway API service: `api` (`99c398a9-5acf-4d70-bed8-212ba0b3af8e`)

Railway currently reports that its automatic GitHub repository connection is
not accessible. The release workflow intentionally deploys through Railway's
project-scoped CLI token instead, so it does not depend on that broken automatic
connection.

## Build and deployment contract

`crypto-data-collector/tools/build_engine_release.py` is the only approved
builder. It reads these **injected** build-time values:

- `HAVEN_ENGINE_RELEASE_PRIVATE_KEY` — existing raw-base64 Ed25519 private key.
- `HAVEN_ENGINE_RELEASE_VERSION` — a human-readable release version.

The build host must be Windows with Python 3.12 and NSIS (`makensis`) available.
It produces and signs both platform packages. The private key must never be
written into the repository, a release artifact, build log, or local plaintext
environment file.

After the build, deploy the four generated files with the API source to
Railway. The API needs the matching `HAVEN_ENGINE_RELEASE_PUBLIC_KEY` already
configured in Railway. The deployment is valid only when:

1. `GET /engine/download?platform=windows` returns the Windows installer for a
   paid authenticated user.
2. `GET /engine/download?platform=linux` returns the Linux bundle for the same
   user.
3. Both responses include `X-Haven-Release` and `X-Haven-SHA256`.
4. A missing, altered, or mismatched manifest makes the API refuse the download.

## First-time GitHub setup

An owner needs only to sign into GitHub; the person performing the release can
then use the workflow's **Run workflow** button. Before that first run, the
protected GitHub environments must contain the existing values named below:

- `engine-release` secret: `HAVEN_ENGINE_RELEASE_PRIVATE_KEY`.
- `production` secret: `HAVEN_RAILWAY_PROJECT_TOKEN` (a Railway project token,
  scoped only to the target production environment).
- `production` variables: `HAVEN_RAILWAY_PROJECT_ID`,
  `HAVEN_RAILWAY_ENVIRONMENT`, and `HAVEN_RAILWAY_SERVICE`.

The matching `HAVEN_ENGINE_RELEASE_PUBLIC_KEY` remains a Railway production API
variable. Keep environment approval enabled for `engine-release` and
`production`; it is the deliberate confirmation before signing or deploying.

As of 2026-07-15, the `engine-release` and `production` GitHub environments
exist, but neither has the release-specific secrets/variables yet. Railway has
`HAVEN_ENGINE_RELEASE_PUBLIC_KEY`, while GitHub does not have its matching
private signing key. A future task must locate that existing private key in its
approved secret store; it must not generate a substitute.

## What a fresh task should do

1. Inspect this document and `ISSUES.md` first.
2. Check the `engine-release` workflow and whether its protected environments
   contain the named secret/variables (never their values), then check whether
   the four signed files are present in the Railway deployment path.
3. If the signing-key location or protected environment is not connected to the
   current session, report that exact missing access. Do not create a substitute
   key or unsigned package.
4. Keep any personal access notes in `docs/LOCAL_RELEASE_ACCESS.md`, which is
   ignored by Git. That file may name a dashboard or account owner, but must
   never contain passwords, tokens, private keys, recovery codes, or secret
   values.
