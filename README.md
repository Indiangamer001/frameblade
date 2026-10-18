Frameblade 0.1.0 (M1 + M2)
A reversible Windows optimization app for gamers. Every change is backed up, verified and journaled; system tweaks run in one elevated batch and can be reverted at any time (including after a restart).

Downloads
File	Size	Purpose
Frameblade-0.1.0-Setup.exe	~107 MB	Windows x64 installer (per-user)
Frameblade-0.1.0-source.zip	~159 KB	Repo-ready source snapshot
Highlights
Reversible tweak engine — inspect → backup → verify → apply → verify → journal, with automatic rollback and exact-value revert.
21-tweak catalog covering Game Bar/DVR, mouse input, timer-resolution support, power plans/throttling, TCP tuning, visual effects/transparency, Storage Sense, OneDrive autostart, telemetry, SysMain, CPU scheduling, LSO offloads, VBS/HVCI, CPU mitigations, Defender real-time, MPO, interrupt steering, NTFS last-access and disk quotas. High-risk items require an explicit acknowledgement.
Modes and profiles — Turbo Gaming preset, saved custom profiles, last-mode memory, restore-point guard, and restore / restore-and-reboot on exit.
Game Mode window — native .exe library picker, Steam library discovery, cover art pipeline, session priority boost, and an optional gated 0.5 ms timer-resolution helper (requires the Timer Resolution Support optimization + reboot; no service or driver).
Signed remote catalog pipeline — Ed25519 envelopes, schema allowlist, HTTPS/redirect/ size policy, atomic cache, union merge, retired-tweak kill switch, RES001…RES009, and a local development catalog server.
Verify applied — read-only scan that reports settings changed by another tool, a Windows update or a manual edit.
Windows 11 TCP fix — congestion provider is now set with Set-NetTCPSetting -SettingName Internet -CongestionProvider (Windows 11 rejects the legacy netsh int tcp set global congestionprovider form).
Install
Run Frameblade-0.1.0-Setup.exe.
The build is unsigned, so Windows SmartScreen may show "unrecognized app" — choose More info → Run anyway if you trust the download.
The app installs per user (no admin required). System-scope tweaks prompt for UAC once per apply batch.
Requirements: Windows 10/11 x64. The timer-resolution optimization and hidden interrupt steering setting require Windows 11 (22H2 for interrupt steering).

Known limitations
Installer is unsigned until a code-signing certificate is configured.
The default catalog endpoint (https://resources.frameblade.gg/catalog-v1.json) is a placeholder; catalog checks fail closed (RES002) and the bundled catalog stays active.
Auto-applying a tweak set when a game launches is not included yet.
Advanced tweaks trade security or stability for performance; read their warnings and use Revert All if a game or app regresses.
The source archive excludes node_modules, dist, build and release; build with npm ci && npm test && npm run dist.
