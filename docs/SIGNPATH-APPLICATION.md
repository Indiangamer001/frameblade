# SignPath Foundation application

> **Status (2026-10-19):** SignPath Foundation declined the application because
> the project does not yet have enough public visibility. A duplicate submission
> was withdrawn. Do not resubmit until the project has broader adoption. The
> Certum Open Source Code Signing fallback is the active route.

Use this page to submit the application at <https://signpath.org/apply>. The
form requires a SignPath account, your personal details, and agreement to the
SignPath Foundation Code of Conduct, so the maintainer must submit it. Do not
send private keys, passwords, or identity documents through chat.

## Project fields (copy and paste)

| Field | Value |
|---|---|
| Project Name | `Frameblade` |
| Repository URL | `https://github.com/Indiangamer001/frameblade` |
| Homepage URL | `https://github.com/Indiangamer001/frameblade` |
| Download URL | `https://github.com/Indiangamer001/frameblade/releases/tag/v0.1.0` |
| Privacy Policy URL | `https://github.com/Indiangamer001/frameblade/blob/main/PRIVACY.md` |
| Wikipedia URL | leave blank |
| Tagline | `A reversible Windows performance tuner for gamers, with evidence-based tweaks and one-click revert.` |
| Category | `Gaming` |
| Maintainer Type | `Individual maintainer(s)` |
| Build System | `GitHub Actions` |
| Primary Discovery Channel | `Organic search` |
| Exact source | `Web search for Windows code signing options; Microsoft Learn code-signing options page linked to SignPath Foundation.` |
| Company Name | leave blank |

### Description

```text
Frameblade is an open-source Windows desktop application that applies
evidence-based gaming performance tweaks with a reversible engine. Each action
is inspected, backed up, verified, journaled, and can be reverted, including
after a restart. It also provides game profiles, a Game Mode session watcher,
installed-game detection, and an opt-in session-safe auto-apply subset.
```

### Reputation

Be accurate. The project is new, so do not invent download counts or press
coverage. Use this:

```text
Frameblade is a newly released project. The first public release (v0.1.0) was
published on 2026-10-19 and includes a Windows installer, a source snapshot,
documentation, and SHA-256 checksums:

- Repository: https://github.com/Indiangamer001/frameblade
- Release: https://github.com/Indiangamer001/frameblade/releases/tag/v0.1.0
- CI: https://github.com/Indiangamer001/frameblade/actions
- Tests: 79 automated tests pass on the GitHub Actions Windows runner.

The project is a solo-maintained, MIT-licensed codebase with a public commit
history and a documented security model. It has no third-party press coverage,
stars, forks, or download history yet; it is being launched to the gaming
community on X. We are providing the source and release artifacts for inspection
and will update adoption metrics as they become available.
```

This is the main rejection risk. If SignPath rejects the application, the
Certum fallback in [CODE-SIGNING.md](CODE-SIGNING.md) keeps the full catalog and
does not require a reputation review.

## Personal fields

Fill these yourself:

- First Name
- Last Name
- Email
- Company Name (optional)

Also read and check:

- [ ] I have read and agree to the SignPath Foundation Code of Conduct.
- [ ] I agree to allow SignPath to store and process my personal data.
- [ ] Optional: I agree to receive other communications from SignPath.

The form is protected by reCAPTCHA.

## Before submitting

- [ ] GitHub two-factor authentication is enabled for `Indiangamer001`.
- [ ] The README has a **Code signing policy** section with the required phrase,
      roles, and privacy link.
- [ ] The v0.1.0 release page has a **Code signing policy** section and links to
      the policy.
- [ ] `PRIVACY.md` is public on `main`.
- [ ] GitHub Actions CI is green on `main`.
- [ ] You understand the application is being submitted as-is with the three
      opt-in security-disabling tweaks disclosed in the policy.
- [ ] You understand a rejection is likely because the repository has no
      verifiable reputation yet.

## After approval

1. Create the SignPath project and attach the GitHub trusted build system.
2. Create the artifact configuration from
   [`signpath/artifact-configuration.xml`](signpath/artifact-configuration.xml).
3. Create a signing policy that requires manual approval by the maintainer.
4. Create an API token with submitter permission.
5. In GitHub, set the secret `SIGNPATH_API_TOKEN` and the variables listed in
   [CODE-SIGNING.md](CODE-SIGNING.md).
6. Bump `package.json` to the next version, commit, and tag it.
7. Run the **SignPath signing** workflow from that tag.
8. Approve the request in SignPath, download the signed artifact, verify it, and
   upload it to the release.
