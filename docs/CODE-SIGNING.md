# Code signing

Frameblade 0.1.0 is **unsigned**. Windows therefore reports an unknown publisher
and may show a SmartScreen warning. This document covers the selected SignPath
Foundation route, the fallback certificate route, and release verification.

Code signing is not a security audit or a "security certification". It proves:

- **Who published the file** (the certificate subject), and
- **That the file was not modified** after it was signed.

It is still important: it removes the blank "Unknown Publisher" identity and
lets SmartScreen reputation accumulate across releases signed by the same
publisher.

## What signing does and does not fix

| Signal | Unsigned | Signed with a new certificate |
|---|---|---|
| Publisher name | Unknown | Verified publisher |
| File tamper detection | None | Authenticode signature |
| SmartScreen "unrecognized app" warning | Yes, per file | May still appear until reputation accumulates |
| Reputation shared across versions | No | Yes, when signed with the same identity |

Microsoft's current guidance is explicit: **EV certificates no longer bypass
SmartScreen**. Both OV and EV certificates must build reputation. Paying for EV
only to remove a SmartScreen warning is not justified for this app.

The only practical first-download bypass is Microsoft Store distribution, which
re-signs the package with a Microsoft certificate. That is a different
distribution and policy path, and it is not required for direct downloads.

## Selected route: SignPath Foundation (application pending)

Frameblade has applied to the free SignPath Foundation program. The public
policy is [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md).

SignPath's terms require:

- an OSI-approved license without commercial dual-licensing (MIT qualifies);
- an already-released, maintained, documented project;
- verifiable project reputation and control;
- a public "Code signing policy" naming authors, reviewers, and approvers;
- MFA on GitHub and SignPath;
- manual approval for every signing request;
- no features that circumvent security measures or compromise user security.

**Known risks:** the repository is brand new (no stars, forks, or download
history yet), so the reputation review is the main risk. The catalog also
contains three opt-in Advanced tweaks that disable security features
(`disable-vbs-hyperv`, `disable-mitigations`, `disable-defender-realtime`).
They are excluded from the recommended set, require explicit acknowledgement,
and can be reverted, but SignPath may still reject the project on its security
clause. The application is being submitted as-is per the maintainer's decision;
Certum below is the fallback.

The existing local `Frameblade-0.1.0-Setup.exe` cannot be signed by SignPath:
SignPath signs artifacts produced by the automated build, not hand-built local
files. A new version must be built by the GitHub Actions workflow after approval.

### SignPath workflow

The manual workflow is `.github/workflows/signpath.yml`. It:

1. checks that `package.json` version matches the requested version;
2. runs `npm ci`, `npm test`, and `npm run dist`;
3. uploads the unsigned installer as a GitHub Actions artifact;
4. submits it to SignPath and waits for manual approval;
5. downloads the signed installer;
6. verifies the Authenticode signature and timestamp;
7. writes `SHA256SUMS.txt` and uploads the signed installer as a workflow
   artifact.

The workflow does **not** publish a release automatically. Download the signed
workflow artifact, inspect it, then upload it to the GitHub release manually.

### After SignPath approval

SignPath will provide an organization, project, signing policy, and artifact
configuration. Then:

1. Install the SignPath GitHub app on `Indiangamer001/frameblade`.
2. Create the artifact configuration from
   [`docs/signpath/artifact-configuration.xml`](signpath/artifact-configuration.xml).
3. Create an API token with submitter permission.
4. Add the repository secret `SIGNPATH_API_TOKEN`.
5. Add repository variables:
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
6. Bump the version (for example to `0.1.1`), commit, and tag it.
7. Run **SignPath signing** from the tag in GitHub Actions.
8. Approve the signing request in SignPath when prompted.
9. Download the signed installer artifact, verify it, and upload it to the
   release with the checksums.

SignPath signs the final NSIS installer. The app executable embedded inside the
installer is covered by the installer's integrity but is not separately
Authenticode-signed in this first integration. If separate signing of the app
executable becomes necessary, it requires a second signing request and a
two-pass package build.

## Fallback route: Certum Open Source Code Signing in the Cloud

If SignPath is not approved, Certum is the fastest paid fallback. It is suitable
for Frameblade's current MIT, non-commercial, open-source distribution:

- **Price:** from about US$58/year (confirm the current price and stock).
- **No hardware token:** the private key is held in Certum's SimplySign cloud
  HSM and unlocked with the SimplySign mobile app.
- **Publisher name:** `Open Source Developer, <your name>`.
- **Use restriction:** only for non-commercial open-source software. Certum can
  revoke the certificate if it is used to sign commercial software.
- **Requirements:** identity verification, a recent utility bill, and a public
  project URL that clearly connects you to the repository.
- **Product page:**
  <https://certum.store/open-source-code-signing-on-simplysign.html>

If Frameblade may become commercial (paid builds, paid support, a proprietary
edition), use **Certum Standard Code Signing in the Cloud** instead. It allows
commercial use and shows your verified name or organization instead of the
`Open Source Developer` prefix. Direct price is around €209; resellers vary, so
compare before buying.

### Activate the certificate

1. Buy the certificate and install **SimplySign Desktop** and the **SimplySign**
   mobile app.
2. Complete identity and project verification in the Certum portal.
3. Activate the certificate. Certum will put the certificate and a virtual
   private key into the Windows certificate store through SimplySign.
4. Start SimplySign Desktop and sign in before building.
5. Confirm Windows can see the certificate:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Format-Table Subject, NotAfter, Thumbprint -AutoSize
```

Copy the thumbprint. It is public information; the PIN and private key are not.

### Build and sign locally

From the repository root:

```powershell
npm run dist:signed -- -Thumbprint <THUMBPRINT>
```

The script:

- refuses to run if the certificate is missing, expired, or lacks the Code
  Signing EKU;
- builds the app and installer;
- signs the app executable and the NSIS installer with SHA-256 and an RFC 3161
  timestamp;
- verifies both signatures with `signtool verify /pa /v`;
- refuses to publish if either signature is invalid or lacks a timestamp;
- writes `release\SHA256SUMS.txt`.

The signing hook is `scripts/sign-windows.js`. It can also use a PFX for local
testing:

```powershell
$env:FRAMEBLADE_CERT_FILE = 'C:\path\to\test.pfx'
$env:FRAMEBLADE_CERT_PASSWORD = 'test-only'
$env:FRAMEBLADE_CERT_SHA1 = ''
npm run dist
```

Do not use a self-signed certificate for a public release. It produces the same
warnings as an unsigned file on other people's PCs.

## Other signing options

| Option | Cost | Fit for Frameblade | Notes |
|---|---|---|---|
| **SignPath Foundation** | Free for qualifying OSS | **Selected; application pending** | OV-level certificate; requires project reputation, signing policy, MFA, manual approval per release |
| **Certum Open Source Cloud** | ~US$58/year | **Fallback** | Individual, non-commercial OSS only; no token; publisher shows `Open Source Developer, <name>` |
| **Certum Standard OV Cloud** | ~US$99–249/year | Good if the project may become commercial | Individual or organization; own name or company; no token |
| **Azure Artifact Signing** | US$9.99/month | Only if eligible | Cloud and CI-friendly; individual public trust is limited to the US/Canada; organization public trust is limited to specific countries |
| **Traditional OV/EV certificate** | ~US$200–900/year | Works, but more friction | Private key on a hardware token or cloud HSM; EV does not bypass SmartScreen |
| **Self-signed certificate** | Free | Internal testing only | Still shows an unknown/untrusted publisher to everyone else |
| **Microsoft Store** | Store account | Different distribution path | Microsoft re-signs the package and avoids first-download SmartScreen warnings; Store policy and MSIX packaging apply |

### Azure Artifact Signing

Azure Artifact Signing (formerly Trusted Signing) is Microsoft's recommended
non-Store signing service. It is inexpensive and CI-friendly, but public-trust
certificates have geographic restrictions:

- individual developers: United States or Canada only;
- organizations: United States, Canada, EU, UK, Australia, New Zealand, Japan,
  South Korea, Singapore, Switzerland, Norway, or Israel.

An individual developer in India, for example, cannot use a Public Trust
certificate through Azure. Private Trust certificates do not remove public
SmartScreen warnings. Check the current rules before subscribing:
<https://learn.microsoft.com/azure/artifact-signing/quickstart>

## CI signing

SignPath is the selected CI signing route. The workflow waits for manual
approval and downloads the signed artifact.

Certum SimplySign is designed around the SimplySign Desktop application and a
mobile approval. It is not a headless signing API. If Certum is used, build and
sign locally, then upload the signed installer and checksums to GitHub.

Never commit a PFX, PIN, private key, or signing credentials. If a PFX is used
in CI, store it in GitHub encrypted secrets and rotate it after any exposure.
Prefer a cloud HSM so the private key is not exportable.

## Verify a release

```powershell
Get-AuthenticodeSignature .\Frameblade-0.1.0-Setup.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate

Get-FileHash .\Frameblade-0.1.0-Setup.exe -Algorithm SHA256
```

Requirements:

- `Status` is `Valid`.
- `SignerCertificate.Subject` matches the expected publisher.
- `TimeStamperCertificate` is present.
- The SHA-256 matches `SHA256SUMS.txt`.

## SignPath release checklist

- [ ] Application approved; SignPath project and signing policy configured.
- [ ] GitHub app installed; API token and repository variables set.
- [ ] `package.json` version bumped and tagged.
- [ ] `npm test` passes.
- [ ] **SignPath signing** workflow succeeds.
- [ ] Signing request approved in SignPath.
- [ ] Signed installer downloaded and `Get-AuthenticodeSignature` returns `Valid`.
- [ ] Timestamp is present.
- [ ] `SHA256SUMS.txt` lists the installer and source ZIP.
- [ ] Public release asset replaced, not duplicated ambiguously.
- [ ] Public installer downloaded again and verified.

## Certum fallback checklist

- [ ] Certificate is valid and has the Code Signing EKU.
- [ ] SimplySign Desktop is running and the certificate is unlocked.
- [ ] `npm test` passes.
- [ ] `npm run dist:signed -- -Thumbprint <thumbprint>` succeeds.
- [ ] `release\win-unpacked\Frameblade.exe` is `Valid` and timestamped.
- [ ] `release\Frameblade-<version>-Setup.exe` is `Valid` and timestamped.
- [ ] `release\SHA256SUMS.txt` lists the installer and source ZIP.
- [ ] Public release asset is replaced, not added as a second ambiguous copy.
- [ ] Download the public installer and verify its signature and hash again.
