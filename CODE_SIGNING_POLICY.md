# Code signing policy

Frameblade is an open-source, reversible Windows performance tuner for gamers,
distributed under the MIT License. The project source is at
<https://github.com/Indiangamer001/frameblade>. This policy covers Windows
release installers and executables.

## Signing provider

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org).

**Status:** Frameblade has applied to the SignPath Foundation program as of
2026-10-19. The application is pending. Frameblade 0.1.0 is currently unsigned.
After approval, release installers built by GitHub Actions will be submitted to
SignPath and signed with the SignPath Foundation certificate.

The signing certificate is issued to SignPath Foundation, not to the Frameblade
maintainer. SignPath Foundation verifies the project and the origin of each
signed build. A valid signature means the installer was produced by the
project's automated build from the public source at the recorded commit.

## Team roles

Frameblade currently has one maintainer. The same person holds each role; this
is disclosed for transparency.

| Role | Member | Responsibility |
|---|---|---|
| Authors / committers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Trusted to modify the source repository. |
| Reviewers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Review every external pull request before merge. As a solo project, the maintainer reviews all changes. |
| Approvers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Approve every signing request. No release is signed automatically. |

All maintainers use multi-factor authentication for both GitHub and SignPath.
There are no shared accounts or shared signing credentials.

## Build and signing process

- **Source:** <https://github.com/Indiangamer001/frameblade>
- **Build system:** GitHub Actions on GitHub-hosted Windows runners.
- **Workflow:** `.github/workflows/signpath.yml`.
- **Build steps:** `npm ci`, `npm test`, then `npm run dist` to produce the NSIS
  installer. The build is reproducible from the public source and lockfile.
- **Origin verification:** the unsigned installer is uploaded as a GitHub Actions
  artifact, then submitted to SignPath from the same workflow. SignPath verifies
  the artifact's origin and requires manual approval for the signing request.
- **Artifact configuration:** `docs/signpath/artifact-configuration.xml`.
- **Signed scope:** SignPath signs the final NSIS installer. The application
  executable embedded inside the installer is covered by the installer's
  integrity but is not separately Authenticode-signed in this first integration.
- **Publication:** the signed installer is downloaded, verified with
  `Get-AuthenticodeSignature`, hashed with SHA-256, and only then uploaded to a
  GitHub release. The release includes `SHA256SUMS.txt`.

No local, hand-built installer is submitted to SignPath. Only artifacts built by
the GitHub Actions workflow from the public repository are eligible.

## Privacy policy

Frameblade does not collect telemetry, analytics, accounts, or personal data.
The full privacy policy is in [PRIVACY.md](PRIVACY.md).

## System changes and uninstallation

Frameblade announces and previews every system change. Before an action runs,
the app inspects the current value, writes a backup, verifies the change, and
records it in a journal. The default and recommended sets exclude high-risk
changes. The app includes a one-click **Revert All**, including after a restart.

The NSIS installer registers a standard uninstaller. Uninstalling removes the
application. User data under `%LOCALAPPDATA%\Frameblade` is left in place so
backups and journals are not destroyed silently; users can delete that folder
manually.

## Advanced security trade-offs

Frameblade is a performance tuner, not a security diagnostic or exploitation
tool. It does not scan for vulnerabilities, exploit software, or bypass
authentication. The default and recommended sets do not include actions that
disable security features.

For transparency, three Advanced tweaks are opt-in and clearly labeled as
security trade-offs:

- `disable-vbs-hyperv` — turns off virtualization-based security, HVCI,
  Credential Guard, and the Hyper-V hypervisor launch setting.
- `disable-mitigations` — disables the kernel Spectre/Meltdown-class
  side-channel mitigations system-wide.
- `disable-defender-realtime` — sets policy values intended to turn off Windows
  Defender real-time monitoring.

Each of these is excluded from the recommended set, requires an explicit
acknowledgement of the risk, and can be reverted. They are intended only for
dedicated gaming machines where the user understands the trade-off. They are
disclosed here so SignPath Foundation can evaluate the project against its
eligibility rules.

## Contact

- Bugs and feature requests:
  <https://github.com/Indiangamer001/frameblade/issues>
- Security reports: use GitHub private vulnerability reporting as described in
  [SECURITY.md](SECURITY.md).
