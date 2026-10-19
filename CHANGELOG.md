# Changelog

All notable changes to Frameblade are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-19

### Added

- Installed-game auto-detection: Steam libraries, Epic manifests, GOG metadata and
  common launcher/`Games` folders are scanned read-only. New finds join the library with
  a one-time per-game auto-apply prompt; removing a game remembers the choice.
- Opt-in session-safe auto-apply in Game Mode. Only recommended, user-scope,
  no-reboot tweaks are applied while an opted-in game runs, through the normal
  backup/journal/revert engine. System, UAC and reboot-required tweaks stay manual.
- Restart-resilient elevated jobs: encoded UAC launches without writable launcher
  scripts, canonical job/path/scope validation, running markers, a canonical result
  path, and startup reconciliation that journals completed or interrupted work.
- Backup integrity: new backups carry a SHA-256 checksum and are refused before revert
  if their contents changed after capture. Legacy backups remain revertible.
- Code-signing pipeline: `npm run dist:signed -- -Thumbprint <thumbprint>` signs the
  app and NSIS installer, adds an RFC 3161 timestamp, verifies both signatures, and
  writes release checksums. Certificate options and the Certum/SimplySign setup are
  documented in [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md).
- SignPath Foundation application package: public [code signing policy](CODE_SIGNING_POLICY.md),
  [privacy policy](PRIVACY.md), manual `.github/workflows/signpath.yml` signing workflow,
  and the [artifact configuration](docs/signpath/artifact-configuration.xml).
- SignPath application answer sheet in
  [docs/SIGNPATH-APPLICATION.md](docs/SIGNPATH-APPLICATION.md).

### Changed

- `npm test` enumerates compiled test files instead of passing a directory to
  `node --test`, so the suite behaves the same on Node 22 and newer.
- The app version is read from `package.json` instead of a hard-coded constant, so
  backups, the helper and the UI report the release version after a bump.
- The elevated helper runs through the app's own executable with a private flag; the
  previous Electron `ELECTRON_RUN_AS_NODE` batch/launcher path is removed.

## [0.1.0] — 2026-10-19

First packaged release (M1 core + M2 mode/runtime wave).

### Added

- Reversible tweak engine with per-action inspect → backup → verify → apply → verify →
  journal, automatic rollback on failure, and exact-value revert (including after restart).
- Elevated helper: one UAC prompt per system batch, running on the app's own Electron
  binary in Node mode (no system Node.js required).
- 21-tweak catalog: Game Bar/DVR, mouse input, timer-resolution support, power plan and
  throttling, network tuning, visual effects/transparency, Storage Sense, OneDrive
  autostart, telemetry, SysMain, priority separation, LSO offloads, VBS/HVCI, CPU
  mitigations, Defender real-time, MPO, dynamic interrupt steering, NTFS last-access, and
  disk quotas.
- Neon-glass desktop UI with category filters, risk badges, explainers, per-tweak
  preview, recommended set, and a hideable activity journal.
- M2 modes and profiles: Turbo Gaming preset, saved custom profiles, last-mode memory,
  restore-point guard, and an exit dialog with restore / restore-and-reboot.
- Game Mode window: native `.exe` library picker, Steam library discovery, cover art
  (local cache → Steam CDN → icon/monogram fallback), session priority boost, and a
  gated 0.5 ms timer-resolution helper. Session-only; no services or drivers.
- Signed remote catalog pipeline: Ed25519 envelopes, schema allowlist, HTTPS/redirect/
  size policy, atomic cache, union merge, retired-tweak kill switch, `RES001…RES009`,
  and a local development catalog server.
- NSIS installer (`per-user`, no admin required to install) and GitHub Actions CI +
  tagged-release workflow.
- **Verify applied**: a read-only scan that re-plans every applied tweak and reports
  settings whose live values no longer match their targets (another tool, a Windows
  update or a manual change).

### Known limitations

- The default catalog endpoint is a placeholder and fails closed (`RES002`) until the
  resource service is deployed.
- The installer is unsigned; SmartScreen shows an unrecognized-publisher warning.
- Auto-applying arbitrary tweak sets or full modes on game launch is not implemented;
  Game Mode only offers the per-game, user-scope, no-reboot session-safe subset.
  Restart-resilient job reconciliation and tamper checks for job/backup files are not
  implemented yet.
