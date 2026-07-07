# Contributing

This project is maintained as a narrow macOS arm64 rebuild toolchain. Contributions should keep the scope small and auditable.

## Development

```bash
npm ci
npm test
```

Use focused tests for script changes. Release-path changes should also update `doc/release-runbook.md` and the workflow assertions in `test/release-workflow.test.js`.

## Pull Request Expectations

- Keep generated files out of the diff.
- Keep private keys, tokens, local paths, and personal machine details out of commits.
- Explain release-flow changes clearly, including whether they affect automatic publishing.
- Avoid broad patch expansion. New app patches need a documented reason, targeted matching, and verification coverage.

## Scope Boundaries

This repository does not accept upstream Codex application bundles, extracted upstream source trees, generated app bundles, release archives, or private signing material.
