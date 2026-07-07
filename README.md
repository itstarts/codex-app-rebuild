# Codex App Rebuild

Unofficial macOS arm64 rebuild tooling for a personal `Codex-rebuild.app` release channel.

This repository contains scripts, tests, and documentation for rebuilding a locally downloaded Codex Desktop app with a narrow set of patches:

- app identity is changed to `Codex-rebuild.app` / `io.github.itstarts.codex-rebuild`
- the Sparkle update feed points to this repository's GitHub Releases
- the About copyright string is adjusted
- selected client-side gates for fast mode and bundled capabilities are patched

## Important Boundaries

This project is not affiliated with, endorsed by, or supported by OpenAI. `OpenAI`, `Codex`, and related names are trademarks or identifiers of their owners.

The repository is intended to store rebuild automation only. It does not vendor upstream Codex application bundles, extracted ASAR contents, generated apps, release zips, private keys, tokens, or runtime verification captures.

Release artifacts are generated from upstream software. Review the upstream terms, licenses, and distribution rights before making any release public or sharing artifacts beyond your own permitted use.

## Requirements

- Node.js 24+
- macOS arm64 for local app build and codesign steps
- GitHub repository secret `SPARKLE_PRIVATE_KEY` for automated signed releases
- Sparkle `sign_update` for local appcast generation

## Common Commands

```bash
npm ci
npm test
npm run sync:mac
npm run patch:check
npm run patch
npm run build:mac-arm64
npm run appcast
npm run verify
```

`npm run sync:mac`, `npm run build:mac-arm64`, and `npm run appcast` download, generate, or sign release material. Run them only when you intend to refresh a build.

## Automated Release Flow

`.github/workflows/release-candidate.yml` runs once per day at 07:00 Asia/Shanghai. It checks the official macOS arm64 appcast. When a new official update is missing from this rebuild channel, the workflow builds, signs, uploads, and publishes a latest GitHub Release automatically.

Manual dispatch supports:

- `latest-release`: build and publish as latest
- `draft-release`: build and upload to a draft release
- `artifact-only`: build workflow artifacts without writing a GitHub Release

## Repository Hygiene

Do not commit:

- `src/`, `out/`, `.cache/`, `node_modules/`
- `.DS_Store`, logs, screenshots, runtime request captures
- `config/sparkle/private-*`, `*.p8`, `*.pem`, `.env*`
- generated `.app`, `.zip`, or `.dmg` artifacts

See [AGENTS.md](AGENTS.md) for project-specific rules for future automated work.
