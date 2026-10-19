# Code signing

Frameblade 0.1.0 is **unsigned**. Windows therefore shows an unknown publisher
and may show a SmartScreen warning. This document covers how to move the release
to a publicly trusted code-signing certificate.

Code signing is not a security audit or a "security certification". It proves:

- **Who published the file** (the certificate subject), and
- **That the file was not modified** after it was signed.

It is still important: it removes the blank "Unknown Publisher" identity and
lets SmartScreen reputation accumulate across releases signed by the same
publisher.

## What signing does and does not fix

| Signal | Unsigned | Signed with a new OV/EV certificate |
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

## Recommended route: Certum Open Source Code Signing in the Cloud

This is the best fit for Frameblade's current MIT, non-commercial, open-source
distribution:

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

### Before buying

1. Decide whether Frameblade will stay non-commercial. The Open Source tier
   cannot be used for commercial distribution.
2. Prepare a government-issued ID and a recent utility bill or bank statement
   showing your address.
3. Make sure the GitHub repository is public and the project URL is visible in
   the application: <https://github.com/Indiangamer001/frameblade>.
4. Check that the product is in stock. Certum's Open Source cloud page has shown
   "out of stock" at times; if it stays unavailable, use the Standard OV cloud
   tier or ask Certum support.

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

### Build and sign

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
| **Certum Open Source Cloud** | ~US$58/year | **Recommended now** | Individual, non-commercial OSS only; no token; publisher shows `Open Source Developer, <name>` |
| **Certum Standard OV Cloud** | ~US$99–249/year | Good if the project may become commercial | Individual or organization; own name or company; no token |
| **SignPath Foundation** | Free for qualifying OSS | Apply after the repo has traction | OV-level certificate; requires project reputation, code-signing policy, MFA, manual approval per release |
| **Azure Artifact Signing** | US$9.99/month | Only if eligible | Cloud and CI-friendly; individual public trust is limited to the US/Canada; organization public trust is limited to specific countries |
| **Traditional OV/EV certificate** | ~US$200–900/year | Works, but more friction | Private key on a hardware token or cloud HSM; EV does not bypass SmartScreen |
| **Self-signed certificate** | Free | Internal testing only | Still shows an unknown/untrusted publisher to everyone else |
| **Microsoft Store** | Store account | Different distribution path | Microsoft re-signs the package and avoids first-download SmartScreen warnings; Store policy and MSIX packaging apply |

### SignPath Foundation

SignPath Foundation is worthwhile for a mature open-source project, but it is not
an instant fallback for a brand-new repository. Its terms require:

- an OSI-approved license without commercial dual-licensing (MIT qualifies);
- an already-released, maintained, documented project;
- verifiable project reputation and control;
- a public "Code signing policy" naming authors, reviewers, and approvers;
- MFA on GitHub and SignPath;
- manual approval for every signing request.

If the project is rejected now, apply again after the X launch and the first
hundreds of downloads. Do not sign a release with an unapproved workflow.

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

Certum SimplySign is designed around the SimplySign Desktop application and a
mobile approval. It is not a headless signing API. For now, build and sign
locally, then upload the signed installer and checksums to GitHub.

If CI signing becomes necessary:

- use Azure Artifact Signing with GitHub OIDC if the project is eligible; or
- use a self-hosted Windows runner with SimplySign Desktop and an approval step;
  or
- use another cloud-HSM provider with a documented GitHub Actions integration.

Never commit a PFX, PIN, private key, or SimplySign credentials. If a PFX is used
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

## Release checklist

- [ ] Certificate is valid and has the Code Signing EKU.
- [ ] SimplySign Desktop is running and the certificate is unlocked.
- [ ] `npm test` passes.
- [ ] `npm run dist:signed -- -Thumbprint <thumbprint>` succeeds.
- [ ] `release\win-unpacked\Frameblade.exe` is `Valid` and timestamped.
- [ ] `release\Frameblade-<version>-Setup.exe` is `Valid` and timestamped.
- [ ] `release\SHA256SUMS.txt` lists the installer and source ZIP.
- [ ] The public release asset is replaced, not added as a second ambiguous copy.
- [ ] Download the public installer and verify its signature and hash again.
