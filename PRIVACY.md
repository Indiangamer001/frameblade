# Privacy policy

**Effective date:** 2026-10-19

Frameblade is a local Windows desktop application. It does not require an
account and does not collect telemetry, analytics, advertising identifiers, or
personal data.

## Data stored on your PC

Frameblade stores its settings, backups, operation journal, and cached data
under `%LOCALAPPDATA%\Frameblade\`. This data stays on your PC. It is not
uploaded by Frameblade.

The uninstaller removes the application but intentionally leaves this folder in
place so backups and journals are not destroyed without warning. You can delete
the folder manually after uninstalling.

## Network requests

Frameblade does not operate an account or telemetry service. It makes only these
network requests:

1. **Signed catalog check (user-initiated).** When you press **Check** in the
   catalog panel, the app requests the signed catalog from the configured HTTPS
   endpoint. The default is
   `https://resources.frameblade.gg/catalog-v1.json`; it is currently a
   placeholder and fails closed. The request contains no account, telemetry, or
   personal data. The server necessarily sees standard HTTP information such as
   your IP address and user agent. If the request fails, the app keeps using the
   bundled catalog.
2. **Steam cover art (Game Mode).** When Game Mode displays a Steam game, the
   app may request the public cover image from
   `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/...` using the
   Steam app ID from your local library. No Steam credentials, account details,
   or library contents are sent. If the request fails, the app uses a generated
   fallback tile.
3. **Links you click.** Opening a release, documentation, or community link
   opens it in your default browser. Those websites have their own privacy
   policies.

Frameblade does not sell, rent, or share personal data. It does not use
third-party analytics or crash-reporting SDKs.

## Games and system information

Game Mode reads local Steam library metadata and executable paths to build your
game library. This information is processed locally and is not transmitted by
Frameblade. System tweaks read and write Windows settings only as part of the
action you preview and confirm.

## Security

Release installers are published with SHA-256 checksums. Once the SignPath
Foundation application is approved, installers will also carry an Authenticode
signature. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) and
[docs/CODE-SIGNING.md](docs/CODE-SIGNING.md).

## Changes

Material changes to this policy will be committed to this repository and noted
in the release notes. The effective date above is the date of the latest change.

## Contact

Questions about this policy can be opened at
<https://github.com/Indiangamer001/frameblade/issues>. Security reports should
use GitHub private vulnerability reporting as described in
[SECURITY.md](SECURITY.md).
