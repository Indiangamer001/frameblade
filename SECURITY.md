# Security policy

## Supported versions

Frameblade is pre-1.0. Security fixes target the latest release on the `main` branch.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Advisories → Report a
vulnerability) instead of opening a public issue. Include the app version, Windows build,
a short reproduction and any relevant journal lines. Do not attach backups or registry
exports that may contain personal data.

## Privileged surface

Frameblade deliberately keeps its attack surface small:

- The UI process is unprivileged and sandboxed (`contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`); all native work goes through a narrow preload bridge.
- System-scope changes run in one elevated helper batch per apply, launched with a single
  UAC prompt. The helper accepts a fixed job-file schema and writes a result file.
- Every action is inspected and backed up before execution, verified afterwards, and
  journaled; a failed action triggers rollback.
- Game Mode is session-only. The timer helper refuses to start unless the live
  `GlobalTimerResolutionRequests` registry gate is enabled, needs no administrator rights,
  and exits with the app (the OS then drops its timer request).
- Remote catalogs are Ed25519-signed, schema-allowlisted, size-capped and cached
  atomically. The bundled catalog remains active if verification fails.

## Code signing

Frameblade 0.1.0 is unsigned. The project has applied to the SignPath Foundation
program; once approved, installers built by GitHub Actions will be signed with
SHA-256 and an RFC 3161 timestamp. Verify downloads with
`Get-AuthenticodeSignature` and compare the SHA-256 in `SHA256SUMS.txt`.
Certificate private keys stay in a hardware token or cloud HSM and are never
committed to the repository. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md),
[PRIVACY.md](PRIVACY.md) and [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md).

## Development-only secrets

`scripts/serve-catalog.js` contains an **intentionally public development signing key**
(`dev-1`) so local catalog round-trips work out of the box. It is not a production trust
root and cannot sign catalogs accepted by a release build configured with release keys.
Never deploy the `dev-1` private key or reuse it for production signing.
