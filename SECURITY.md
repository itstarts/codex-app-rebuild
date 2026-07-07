# Security Policy

## Sensitive Material

Never commit or print:

- Sparkle private keys
- Apple signing identities, certificates, provisioning profiles, or account data
- GitHub tokens or personal access tokens
- generated app bundles, zips, appcasts, runtime request captures, or screenshots containing user data

Sparkle private keys must be provided through `SPARKLE_PRIVATE_KEY` or `SPARKLE_PRIVATE_KEY_FILE`. GitHub Actions uses the repository secret `SPARKLE_PRIVATE_KEY`.

## Reporting Issues

For vulnerabilities or accidental secret exposure, open a private report through the repository owner's preferred private channel. Do not include secrets in public issues, logs, screenshots, or pull requests.

## Maintainer Response

When a secret is exposed, rotate the secret first, then remove the exposure from the current tree. If the exposed value reached public Git history, assume it is compromised even after history cleanup.
