# Code signing policy

Frameblade is an open-source, reversible Windows performance tuner for gamers,
distributed under the MIT License. The project source is at
<https://github.com/Indiangamer001/frameblade>. This policy covers Windows
release installers and executables.

## Signing provider

**Current route:** [Certum Open Source Code Signing in the Cloud](https://certum.store/open-source-code-signing-on-simplysign.html).
The certificate will be issued to the maintainer as `Open Source Developer,
Vasim Pathan` and used only for this non-commercial open-source project.

**SignPath status:** SignPath Foundation declined the free-certificate
application on 2026-10-19 because the new project does not yet have enough
public visibility. The project may reapply after it has gained broader
adoption. The previous application was made under the SignPath Foundation
policy:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Frameblade 0.1.0 is unsigned. A later installer will not be published unless its
Authenticode signature verifies against a publicly trusted certificate. A valid
signature means the installer was produced from the public source and was not
modified after signing.

## Team roles

Frameblade currently has one maintainer. The same person holds each role; this
is disclosed for transparency.

| Role | Member | Responsibility |
|---|---|---|
| Authors / committers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Trusted to modify the source repository. |
| Reviewers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Review every external pull request before merge. As a solo project, the maintainer reviews all changes. |
| Approvers | [Vasim Pathan (@Indiangamer001)](https://github.com/Indiangamer001) | Approve every signing request. No release is signed automatically. |

All maintainers use multi-factor authentication for GitHub and the certificate
portal. There are no shared accounts or shared signing credentials.

## Build and signing process

- **Source:** <https://github.com/Indiangamer001/frameblade>
- **Build and test:** GitHub Actions on GitHub-hosted Windows runners and the
  same commands locally (`npm ci`, `npm test`).
- **Signing:** the maintainer builds the release locally with
  `npm run dist:signed -- -Thumbprint <thumbprint>` while SimplySign Desktop is
  unlocked. The script signs both the app executable and the final NSIS
  installer, applies an RFC 3161 timestamp, and verifies both signatures.
- **Publication:** the signed installer is verified with
  `Get-AuthenticodeSignature`, hashed with SHA-256, and only then uploaded to a
  GitHub release. The release includes `SHA256SUMS.txt`. An installer is never
  published merely because a build succeeded.

The previous SignPath workflow (`.github/workflows/signpath.yml`) and artifact
configuration are retained for a possible future reapplication, but they are not
an active signing route.

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
