# Publishing Frameblade to GitHub

The project is source-ready: `.gitignore` excludes dependencies, build output and
binaries. The Windows installer is **not** committed because it is roughly 107 MB,
which is above GitHub's 100 MB per-file repository limit. Publish it as a Release
asset instead.

## 1. Get the source

Use the repository folder directly, or extract
`release\Frameblade-0.1.0-source.zip` (created by `npm run source:zip`). The zip already
contains `.gitignore`, `.github/`, `LICENSE` and `package-lock.json`.

## 2. Create the repository

Create an empty repository on GitHub (no README, no .gitignore) and copy its URL.

### Option A — git command line

```powershell
cd C:\path\to\frameblade
git init
git add .
git commit -m "Frameblade 0.1.0"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```

### Option B — GitHub Desktop

1. **File → Add local repository…** and select the unzipped `frameblade` folder.
2. Choose **create a repository** when prompted, then **Publish repository**.

### Option C — GitHub web UI (no tools)

1. On the empty repository page choose **uploading an existing file**.
2. Open the unzipped `frameblade` folder, select **all files and folders** (enable
   hidden items so `.github`, `.gitignore` and `.editorconfig` are included), drag them
   onto the upload page, and commit.
3. Upload the zip itself only if you want it in the repository; normally you do not.

## 3. Verify CI

`.github/workflows/ci.yml` runs on every push/PR: `npm ci` + `npm test` on
`windows-latest`. The first run downloads Electron and takes a few minutes.

## 4. Publish the installer as a release

1. On GitHub: **Releases → Draft a new release**.
2. Create tag `v0.1.0` (target `main`) and title it `Frameblade 0.1.0`.
3. Attach:
   - `release\Frameblade-0.1.0-Setup.exe`
   - `release\SHA256SUMS.txt`
4. Paste the notes from `release\RELEASE_NOTES.md` and publish.

Alternatively, push the tag and let `.github/workflows/release.yml` build and attach
the installer automatically:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## 5. Notes

- Builds are unsigned until the SignPath Foundation application is approved. The
  release body must keep its **Code signing policy** section with the required
  SignPath phrase, roles and privacy link. See
  [CODE-SIGNING.md](CODE-SIGNING.md), [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md)
  and [PRIVACY.md](../PRIVACY.md).
- After approval, use `.github/workflows/signpath.yml`; do not upload a
  hand-built local installer. The Certum local-signing fallback is documented in
  [CODE-SIGNING.md](CODE-SIGNING.md).
- The default catalog endpoint (`https://resources.frameblade.gg/catalog-v1.json`) is a
  placeholder; keep the development key out of production and replace `TRUSTED_KEYS` in
  `src/engine/resources.ts` before shipping a catalog service.
- The private `HONE-Replication-Report.md` research document is intentionally not part
  of the repository.
