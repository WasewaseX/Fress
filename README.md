<!-- ============================================================================
STATUS: stable-release edition (Agent 3 release qualification, 2026-10-14).
The stable v1.0.0 release IS PUBLISHED (2026-10-14T16:40Z, prerelease=false,
22 assets) from commit 78d5e8ff8e1bc38ca8789539da005fdea4b15613 (Release
workflow run #43, conclusion success). Every byte-level claim below was
re-proven against the PUBLISHED v1.0.0 bytes on 2026-10-14: all 22 assets
downloaded and re-hashed (21/21 SHA256SUMS.txt entries match, no orphans),
the repository's own verifier scripts/ci/verify-release-artifacts.py exits 0
on the downloaded bytes, an independent Ed25519 implementation minisign-verifies
all 5 sidecars (negative control rejected), and latest.json carries version
1.0.0 with eight windows-*/linux-* entries pointing at v1.0.0 assets. The
evidence lives in the v1.0.0 audit section of [CODE_SIGNING.md](CODE_SIGNING.md).
============================================================================ -->

# Fress

A hand-checked directory of **free and open-source software** for Windows, macOS, Linux, and Android. It runs as a desktop and Android app, built with Tauri 2.

There is no telemetry and no advertising, and nothing in the catalog is sponsored. Every app in the catalog is checked by hand against the rules in [CONTRIBUTING.md](CONTRIBUTING.md) — free and open-source, official links only, popular and actively maintained at the time it is added — and a catalog validator re-checks the mechanical parts (links, licenses, duplicates) on every change.

![Version](https://img.shields.io/github/v/release/WasewaseX/Fress?include_prereleases&sort=semver&label=version) ![Stable](https://img.shields.io/github/v/release/WasewaseX/Fress?label=stable) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid. No hunting through release pages, and beta/RC builds are never offered.
- **Update check for Fress itself.** The header pill and the footer button compare your installed version with the newest release on your update channel, pick the right file for your platform, and verify it against the release's published `SHA256SUMS.txt` entry AND the release's minisign signature before the app calls the update "verified" — after the download finishes, the app checks the completed file's bytes against the release's `<file>.sig` sidecar with the updater public key embedded in the binary, and only then reports it as verified and ready (it is never launched automatically). When a check cannot be established — no checksum entry, no signature sidecar, an unreachable signature document, or a failed verification — Fress does not deliver the file and instead links to the releases page with the reason spelled out, rather than passing an unverified installer off as an update. The same rule applies to architecture: if the release carries no installer your machine can actually run (for example an ARM64-only build while you are on Intel), Fress also links to the releases page rather than offering a wrong file.
  On every release so far — including stable `v1.0.0` (verified from its published bytes 2026-10-14) — the Windows setup installers (the two `*-setup.exe` files) and the Linux bundles carry updater signatures, so those are the artifacts delivered in-app; the Windows MSI, the portable zips, the macOS dmgs and the Android APKs do not, so for those Fress routes you to the releases page. By default a stable build like this one is offered only releases from the stable track — never a newer-numbered beta — and the updater never moves you down a track in the background: if you explicitly pick a channel whose newest release is older than your build, the app says so and links to the releases page instead of offering a downgrade. [CODE_SIGNING.md](CODE_SIGNING.md) records which artifacts are signed, which platforms get cryptographically verified in-app updates, and how to verify a download manually.
- **Download manager built in.** Downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification, saved to the folder you choose (your system Downloads folder by default).
- **Device-aware downloads.** Windows, macOS, Linux, and Android (GitHub APK, F-Droid, Google Play): Fress picks the right file for your architecture.
- **Light and dark themes.** The light mode uses warm paper tones, the dark mode is easy on the eyes, and both follow your system preference until you pick one yourself.
- **Multiple languages.** English, Persian (full right-to-left support), Spanish, French, and German from the Settings menu, including the app descriptions, not just the menus.
- **Your data stays with you.** Favorites, custom entries, and settings live in your own storage. The only servers the app talks to are the ones hosting the apps: GitHub for release and star lookups, F-Droid for Android packages, and the official download servers the catalog's links point at. Every request is HTTPS, and the native layer refuses private addresses and unexpected hosts for its own document reads.

## Feature tour

| Feature | Where |
|---|---|
| Add apps: search GitHub or enter them | "Add app" in the header |
| Batch installer scripts (winget / brew / flatpak / scoop) | Select cards, then "Batch" |
| Side-by-side comparison matrix | Select up to 4 cards, then "Compare" |
| Command palette | `Ctrl+K` |
| Keyboard shortcuts | `?` or the More menu |
| Export catalog as Markdown/JSON | More menu |
| Download manager | "Downloads" in the header |
| Update check for Fress | Footer button |
| Language & theme | Settings (gear icon) |

## Development

```bash
npm install
npm run dev          # web preview at http://localhost:3000
npm run lint         # type-check
npm test             # unit tests (vitest)

# Desktop app (requires Rust + platform deps, see https://tauri.app)
npm run tauri dev
npm run tauri build

# Android (requires Android SDK + NDK)
npm run tauri android init
npm run tauri android build -- --apk
```

The web preview works without Rust: download buttons hand off to your browser. Inside the Tauri desktop app, the full download manager activates.

## Releases

Releases are tagged and published on the [official Releases page](https://github.com/WasewaseX/Fress/releases). Every published release ships installers for all platforms, built by GitHub Actions. The table below uses `*` in place of the version, so it does not go stale.

The shapes below were re-verified file-by-file against release [`v1.0.0`](https://github.com/WasewaseX/Fress/releases/tag/v1.0.0) (published 2026-10-14, 22 files: the 15 installers/archives below, their 5 minisign `.sig` sidecars, plus `SHA256SUMS.txt` and the updater manifest `latest.json`).

| Platform | File | Updater signature | In-app update |
| --- | --- | --- | --- |
| Windows x64 (installer) | `Fress_*_x64-setup.exe` | minisign `.sig` | Yes — checksum + signature verified in-app |
| Windows x64 (MSI) | `Fress_*_x64_en-US.msi` | none | No — Releases page |
| Windows x64 (portable, no install) | `Fress_*_x64-portable.zip` | none | No — Releases page |
| Windows ARM64 (installer) | `Fress_*_arm64-setup.exe` | minisign `.sig` | Yes — checksum + signature verified in-app |
| Windows ARM64 (portable) | `Fress_*_arm64-portable.zip` | none | No — Releases page |
| macOS (Apple Silicon) | `Fress_*_aarch64.dmg` | none | No — Releases page |
| macOS (Intel) | `Fress_*_x64.dmg` | none | No — Releases page |
| Linux x64 | `Fress_*_amd64.AppImage`, `Fress_*_amd64.deb`, `Fress-<version>-1.x86_64.rpm` (native RPM naming) | minisign `.sig` per file | Yes — checksum + signature verified in-app |
| Android | `Fress_*_universal.apk` plus ABI splits `Fress_*_{arm64,arm,x64,x86}.apk` | none (Android checks the installer's signing key itself at install time) | No — Releases page (in-app **Open** hands a completed APK to the system installer; see the Android note below) |

"In-app update" means Fress downloads the file itself and verifies it against both the release's `SHA256SUMS.txt` entry and its minisign signature before calling it verified. Platforms without that signature get the official Releases page instead — a checksum alone is an integrity check, not proof of who published the file, and a checksum match is **not** publisher identity: if the release account itself were compromised, both the file and the manifest would match. The full per-artifact signing matrix, including what is *not* signed today, is in [CODE_SIGNING.md](CODE_SIGNING.md).

**Fress is distributed only through this repository's GitHub Releases page**, always with `SHA256SUMS.txt` next to the files. If you found a Fress installer anywhere else (a file host, a mirror, a "download site"), it is not ours.

Every published release includes a `SHA256SUMS.txt` covering every other asset on the release (21 entries on every 22-file release — a checksum file cannot cover itself; on `v1.0.0` all 21 entries match the published bytes, re-hashed 2026-10-14). Verify before running:

```bash
sha256sum -c SHA256SUMS.txt
```

Two platform notes, so nothing surprises you: on **macOS**, the dmgs are unsigned today, so the first launch may need a right-click → **Open** confirmation (newer macOS versions may refuse from Finder until you do). On **Android**, release-to-release APK upgrades install normally because every release is signed with the same project key — but an APK from a different source (a different build or a re-pack) will refuse to update-over-install and must be uninstalled first; that is Android enforcing the matching signature, not Fress.

### Coming from a 1.0.x-beta? (moving to the stable track)

<!-- HYPOTHESIS-PENDING-INSTALLER-TEST: every step below is the CHANGELOG's
proposed migration, written from source knowledge, NOT from a executed
install test. The packaged-os / physical-device rows that would prove them
(docs/testing/stable-release-smoke.md install + migration rows;
docs/testing/download-open-smoke.md A1-A6) are all NOT RUN. Do not remove
this caveat until those rows have real PASS entries. Note also that
1.0.12-beta is numerically NEWER than 1.0.0 on the beta track; no updater on
the stable track will downgrade you, and the move is a deliberate manual
install. -->

Stable (`1.0.0`) and beta (`1.0.13-beta` and onward) are separate tracks; the app's updater never moves you between them automatically — a stable build defaults to the Stable channel, your own channel choice in the app's More menu is always respected, and the updater never offers a downgrade (if your build is newer than the channel's newest release, it says so and links here instead). To switch deliberately:

- **Windows (NSIS installer):** run the `Fress_1.0.0_x64-setup.exe` (or `_arm64-`) installer over your existing install. Your settings are kept in the app's WebView profile, which the installer update does not delete — the packaged test that proves it end to end (W-1 in the testing docs) has not run yet. <sub>*HYPOTHESIS-PENDING-INSTALLER-TEST — no packaged-os install row has run yet.*</sub>
- **Windows (MSI):** two hypotheses are on the record and only a real install test (W-3 in the testing docs) decides: the toolchain evidence (Tauri's `allowDowngrades` defaults to enabled and the beta MSI carries the matching bytes) predicts the v1.0.0 MSI installs straight over the beta MSI as a normal major upgrade, while the release notes' current wording says the beta must be uninstalled first. Either way your WebView profile is not touched by the install itself. <sub>*HYPOTHESIS-PENDING-INSTALLER-TEST.*</sub>
- **macOS:** replace the app in `/Applications` with the one from the `Fress_1.0.0_*.dmg`. <sub>*HYPOTHESIS-PENDING-INSTALLER-TEST.*</sub>
- **Linux:** install the v1.0.0 bundle. `deb` and `rpm` need an explicit downgrade flag because 1.0.12-beta sorts above 1.0.0: `sudo apt install ./Fress_1.0.0_amd64.deb --allow-downgrades` or `sudo rpm -U --oldpackage Fress-1.0.0-1.x86_64.rpm`. AppImage: replace the file. <sub>*HYPOTHESIS-PENDING-INSTALLER-TEST.*</sub>
- **Android:** uninstall the beta APK first (Android refuses a downgrade install, and uninstalling clears the app's private data — favorites and custom entries), then install the v1.0.0 APK from the Releases page. <sub>*HYPOTHESIS-PENDING-INSTALLER-TEST — physical-device rows NOT RUN.*</sub>

Settings, favorites and custom entries are stored in the app's own profile storage; no installer or updater in the pipeline deletes that storage. Whether the profile location survives each specific installer transition is exactly what the packaged qualification rows (W-1/W-2/W-5/M-1/L-1/L-2/L-3 in the testing docs) exist to prove — none of them has run yet, so treat survival as the expected outcome, not a tested guarantee. The one path where data loss is certain by design is the Android uninstall-first transition, which is documented as data loss, not papered over.

### Make sure you run the newest build

Each Fress app shows its exact version in the header, right next to the name — the version you see is the release tag the build was published as (for example, a build published as `v1.0.0` shows `v1.0.0`).

The badges at the top of this page track the two release tracks separately: the **version** badge shows the newest published release of any kind, the **stable** badge shows the newest stable release — because a newer beta number does not mean a newer stable build. The development sources on `main` carry the version that will ship next (`package.json` is the source of truth — it moves ahead of the badges as soon as a release is published), so a newer version number in the repository does not always mean that version has been published yet. If your installed app does not show the version you expect, install the newest installer for your channel from the [Releases page](https://github.com/WasewaseX/Fress/releases). Old installers keep working and can silently sit on your machine next to the new one.

### Where downloads are saved (per operating system)

Fress picks each operating system's own download location, the same place your browser uses:

| Operating system | Default download folder | Change folder in-app |
| --- | --- | --- |
| Windows | `Downloads` (follows OneDrive redirection if set up) | Yes |
| macOS | `~/Downloads` | Yes |
| Linux | XDG downloads folder (usually `~/Downloads` or `~/Downloads/<locale>`) | Yes |
| Android | The app's private storage (Android does not let apps pick arbitrary folders) | No — completed downloads open through Android's own handlers: an APK is handed to the **system package installer** (the same consent flow a file manager uses; Fress never bypasses it), and any other file opens with a viewer or the share sheet, read-grant only. The handoff is registry-validated in the app, but its on-device behavior is proven only by mocked tests so far — the physical-device QA pass is tracked as NOT RUN in the testing docs. You can still download an APK with your **browser** from the [Releases page](https://github.com/WasewaseX/Fress/releases) |

### Why Windows shows "Unknown publisher"
The Windows installer is **not Authenticode-signed today**: no signing certificate is configured for CI, and the published installers carry no certificate table (verified on the current stable release's bytes, `v1.0.0`: both setup exes' PE certificate tables are empty and the v1.0.0 CI run took the no-signing-certificate path — see [CODE_SIGNING.md](CODE_SIGNING.md) for the audit and the free routes), so Windows shows the blue "Unknown publisher" / "Windows protected your PC" warning and will keep showing it until the publisher is covered by a certificate Windows already trusts. What protects the file you download is the release integrity and authenticity chain, not a publisher certificate:

- Every release ships a `SHA256SUMS.txt` covering every other asset on the release, and the app itself verifies its own updates against that file before offering the installer. Verify manually with `sha256sum -c SHA256SUMS.txt` after downloading. A checksum match is an integrity guarantee — it is not publisher identity.
- The Windows setup installers and Linux bundles additionally carry a minisign updater signature produced by CI; the signatures on the current stable release (`v1.0.0`) have been verified byte-for-byte against the published public key over the exact downloaded bytes (repository verifier + an independent Ed25519 implementation, 2026-10-14 — see the release signature audit in [CODE_SIGNING.md](CODE_SIGNING.md)). For its own in-app updates, Fress checks the downloaded file against that signature — through the key embedded in the app — before it reports the update as verified, and an update without a verifiable signature is routed to the releases page instead. A checksum proves integrity with the release manifest, the signature proves who authorized the artifact — they are separate guarantees, and neither is an Authenticode publisher identity.
- [CODE_SIGNING.md](CODE_SIGNING.md) documents the signing fix, including a free signing route for open-source projects (SignPath Foundation). Until that is set up, you can:
  - Click **More info → Run anyway** after checking the checksum against `SHA256SUMS.txt`, or
  - Build the app yourself from this repository (`npm run tauri build`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
