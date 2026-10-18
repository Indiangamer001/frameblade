# Changelog

All notable changes to Frameblade are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/).

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
- Auto-applying tweak sets on game launch, restart-resilient job reconciliation and
  tamper checks for job/backup files are not implemented yet.
