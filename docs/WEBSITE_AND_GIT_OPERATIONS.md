# Website and Git operations

This is the durable handoff for maintaining and publishing the Haven website.
A fresh task must read this file, `AGENTS.md`, `README.md`, and the relevant
component before changing the website or publishing it. This document contains
no passwords, tokens, private keys, or other credential values.

## Current production state

- **GitHub repository:** `ruscopeland/haven`; normal integration branch: `main`.
- **Website source:** `crypto-charting-ui/` (React 19 and Vite).
- **Public site:** `https://haven.trading`.
- **Cloudflare Pages project:** `haven`.
- **Production API:** `https://api.haven.trading`.
- **Publishing command:** `crypto-charting-ui/deploy-pages.ps1`.

The website was last republished on 2026-07-15 after the signed Windows and
Linux engine installers were released. Cloudflare Pages uses the existing local
Wrangler sign-in, which is stored outside the repository in Windows Credential
Manager. A fresh task can safely run `npx.cmd wrangler whoami` from
`crypto-charting-ui/` to confirm that publishing access is connected; it must
never print, copy, or commit the underlying token.

## Engine-download user interface

The user-facing controls are in
`crypto-charting-ui/src/components/EngineConnect.jsx`, displayed from Settings
under **Desktop engine**. The interface must continue to show two distinct
download choices:

- **Download Windows installer** — requests `GET /engine/download?platform=windows`
  and saves `haven-engine-windows-installer.exe`.
- **Download Linux installer** — requests `GET /engine/download?platform=linux`
  and saves `haven-engine-linux.tar.gz`.

The API has its own access control: downloads require a signed-in user who is
entitled to use the engine. The browser-wide auth wrapper in
`crypto-charting-ui/src/authFetch.js` supplies the Clerk token to the production
API. Do not replace the authenticated request with a public static download,
remove entitlement checks, or put engine files in Cloudflare.

When changing these choices or their instructions, keep all of the following
in sync:

1. `EngineConnect.jsx` — button labels, platform arguments, filenames, and
   on-screen setup language.
2. `docs/USER_GUIDE.md` — the same Windows and Linux installation steps.
3. `crypto-charting-ui/src/legal/content.js` — the public product/legal
   description of the engine workflow.
4. `docs/ENGINE_RELEASE_OPERATIONS.md` — release artifact names and API
   contract, if the package format or endpoint changes.

## Safe website change and publishing procedure

1. Inspect the relevant source and existing behavior before editing. Preserve
   the authenticated API integration and the rule that wallet private keys never
   enter the website.
2. Make the focused source and documentation changes. Do not add `.env` files,
   Cloudflare credentials, Clerk secrets, or build output to Git.
3. From `crypto-charting-ui/`, run:

   ```text
   npm run lint
   npm run build
   ```

4. Review `git status --short` and `git diff --check`. Preserve unrelated
   changes. Commit only the intentional files and push them to `main` after the
   user has authorized publishing source changes.
5. When the user has authorized website publishing, run from
   `crypto-charting-ui/`:

   ```text
   .\deploy-pages.ps1
   ```

   The script builds the production website with `VITE_API_URL` set to the Haven
   API and deploys `dist/` to Cloudflare Pages project `haven`. It checks for
   either the existing secure Wrangler sign-in or a complete protected CI token
   pair. It never reads a workspace plaintext credential file.
6. Check the deployment URL emitted by Cloudflare and `https://haven.trading`.
   For an engine-download interface change, also sign in with an authorized test
   user and confirm both buttons reach the protected API; record any missing
   paid-user verification in `ISSUES.md`.

## Clerk environment boundary

The publishing script intentionally defaults to the existing Clerk **test**
environment. Do not set `HAVEN_CLERK_ENVIRONMENT=live`, provide a live Clerk
publishable key, change billing plans, or alter Cloudflare DNS/TLS/proxy
settings unless the owner has specifically authorized that separate production
change. Those are not necessary for ordinary website text, layout, or engine
download-control updates.

## Git handoff rules

Git is the durable record that lets a new task continue safely:

- Start with `git status --short`, `git log --oneline -n 10`, and the documents
  above; do not rely on a prior chat.
- Use `main` unless the owner asks for a different branch. Never force-push,
  rewrite history, reset unrelated work, or commit credentials.
- Keep commits narrow and descriptive. Run the checks appropriate to the files
  changed before pushing.
- After a successful Cloudflare publish, record a material operational change in
  this document or `ISSUES.md` when it affects a future task. Do not record
  short-lived preview URLs as permanent configuration.
