# AGENTS.md - Project Rules

This file applies to the whole repository. Follow the user's direct instructions first, then these project rules.

## Communication

- Use Chinese for user-facing summaries unless the user asks otherwise.
- Keep technical identifiers, commands, env vars, file names, and API fields in English.
- State verification commands and results before claiming a change is ready.

## Repository Hygiene

- Do not commit generated or local-only paths: `src/`, `out/`, `.cache/`, `node_modules/`, `.DS_Store`, logs, screenshots, request captures, `.app`, `.zip`, or `.dmg` files.
- Do not commit secret material: `config/sparkle/private-*`, `*.p8`, `*.pem`, `.env*`, Apple credentials, GitHub tokens, or Sparkle private keys.
- Do not introduce local machine paths, user names, or personal filesystem details into docs, tests, logs, or commits.
- Keep `config/sparkle/public-ed-key.txt` public-key only.

## High-Risk Areas

Treat these as release-critical:

- `.github/workflows/release-candidate.yml`
- `scripts/generate-appcast.js`
- `scripts/lib/github-release-utils.js`
- `scripts/patch-update-channel.js`
- `scripts/build-mac-arm64.js`
- Sparkle key handling, appcast generation, feed URL, bundle id, codesign, and GitHub Release publishing

Changes in these areas need targeted tests and a clear release-risk note.

## Command Boundaries

- Read-only commands and `npm test` are allowed for normal verification.
- Run `npm run sync:mac`, `npm run build:mac-arm64`, `npm run appcast`, or `npm run verify` only when the task explicitly needs download/build/sign/release material.
- Do not push, publish releases, rewrite history, or force update remote refs without explicit user approval in the current task.

## Release Expectations

- The daily workflow checks for upstream macOS arm64 updates at 07:00 Asia/Shanghai and automatically publishes a signed latest release when a new upstream update is missing from this rebuild channel.
- The release workflow must keep private keys in GitHub secrets or temporary runner files only.
- Release artifacts belong in GitHub Releases or workflow artifacts, not in Git.

## Documentation

- `README.md` is the public entry point.
- `doc/release-runbook.md` is the operational source for manual release and recovery.
- Keep docs current when changing workflow inputs, schedules, release modes, secrets, or generated artifact names.
