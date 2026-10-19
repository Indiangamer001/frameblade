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
  UAC prompt. The launcher is passed as an encoded PowerShell command, not a writable
  `.cmd`/`.ps1` file. The helper validates the job id, canonical data/result paths and
  system-tweak scope, then writes a canonical result file. A running marker lets the
  next launch distinguish a cancelled prompt from an interrupted elevated job.
- Backups carry a SHA-256 payload checksum plus a detached integrity-ledger record. The
  ledger is checked against the exact bytes read before the backup is parsed, and new
  backups are refused if their record is missing or does not match. The ledger is
  tamper-evident, not tamper-proof against a process that can rewrite both the backup
  and the ledger; the utility supports HMAC-authenticated records when the key is kept
  in a protected store. Legacy backups remain revertible.
- Stale job artifacts are reconciled on startup; interrupted jobs are journaled and
  surfaced in the UI so the user can run **Verify applied**.
- Every action is inspected and backed up before execution, verified afterwards, and
  journaled; a failed action triggers rollback.
- Game Mode is session-only. The timer helper refuses to start unless the live
  `GlobalTimerResolutionRequests` registry gate is enabled, needs no administrator rights,
  and exits with the app (the OS then drops its timer request).
- Remote catalogs are Ed25519-signed, schema-allowlisted, size-capped and cached
  atomically. The bundled catalog remains active if verification fails.

## Code signing

Frameblade 0.1.0 and 0.1.1 are unsigned. SignPath Foundation declined the free
certificate because the project is new; the active route is a Certum Open Source
certificate. Once a release installer is signed, verify it with
`Get-AuthenticodeSignature` and compare the SHA-256 in `SHA256SUMS.txt` before running
it. Until then, Windows may report an unknown publisher.
Certificate private keys stay in a hardware token or cloud HSM and are never
committed to the repository. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md),
[PRIVACY.md](PRIVACY.md) and [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md).

## Development-only secrets

`scripts/serve-catalog.js` contains an **intentionally public development signing key**
(`dev-1`) so local catalog round-trips work out of the box. It is not a production trust
root and cannot sign catalogs accepted by a release build configured with release keys.
Never deploy the `dev-1` private key or reuse it for production signing.
