# Fress

A hand-checked directory of **free and open-source software** for Windows, macOS, Linux, and Android. It runs as a desktop and Android app, built with Tauri 2.

There is no telemetry and no advertising, and nothing in the catalog is sponsored. Every app in the catalog is checked by hand against the rules in [CONTRIBUTING.md](CONTRIBUTING.md) — free and open-source, official links only, popular and actively maintained at the time it is added — and a catalog validator re-checks the mechanical parts (links, licenses, duplicates) on every change.

![Version](https://img.shields.io/github/v/release/WasewaseX/Fress?include_prereleases&sort=semver&label=version) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid. No hunting through release pages, and beta/RC builds are never offered.
- **Update check for Fress itself.** The header pill and the footer button compare your installed version with the latest release on GitHub, pick the right file for your platform, and verify it against the release's published `SHA256SUMS.txt` entry AND the release's minisign signature before the app calls the update "verified" — after the download finishes, the app checks the completed file's bytes against the release's `<file>.sig` sidecar with the updater public key embedded in the binary, and only then reports it as verified and ready (it is never launched automatically). When a check cannot be established — no checksum entry, no signature sidecar, an unreachable signature document, or a failed verification — Fress does not deliver the file and instead links to the releases page with the reason spelled out, rather than passing an unverified installer off as an update. The same rule applies to architecture: if the release carries no installer your machine can actually run (for example an ARM64-only build while you are on Intel), Fress also links to the releases page rather than offering a wrong file. Today the Windows installers and Linux bundles carry updater signatures (so those artifacts are the ones delivered in-app); the macOS dmgs and Android APKs do not, so for those platforms Fress routes you to the releases page. [CODE_SIGNING.md](CODE_SIGNING.md) records which artifacts are signed, which platforms get cryptographically verified in-app updates, and how to verify a download manually.
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

Releases are tagged and published on the [official Releases page](https://github.com/WasewaseX/Fress/releases). Every published release ships installers for all platforms, built by GitHub Actions (artifact names from release `v1.0.9-beta`; later releases use the same shapes with their own version):

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
| Android | `Fress_*_universal.apk` plus ABI splits `Fress_*_{arm64,arm,x64,x86}.apk` | none (Android checks the installer's signing key itself at install time) | No — Releases page |

"In-app update" means Fress downloads the file itself and verifies it against both the release's `SHA256SUMS.txt` entry and its minisign signature before calling it verified. Platforms without that signature get the official Releases page instead — a checksum alone is an integrity check, not proof of who published the file. The full per-artifact signing matrix, including what is *not* signed today, is in [CODE_SIGNING.md](CODE_SIGNING.md).

**Fress is distributed only through this repository's GitHub Releases page**, always with `SHA256SUMS.txt` next to the files. If you found a Fress installer anywhere else (a file host, a mirror, a "download site"), it is not ours.

Every published release includes a `SHA256SUMS.txt` covering all assets. Verify before running:

```bash
sha256sum -c SHA256SUMS.txt
```

Two platform notes, so nothing surprises you: on **macOS**, the dmgs are unsigned today, so the first launch may need a right-click → **Open** confirmation (newer macOS versions may refuse from Finder until you do). On **Android**, release-to-release APK upgrades install normally because every release is signed with the same project key — but an APK from a different source (a different build or a re-pack) will refuse to update-over-install and must be uninstalled first; that is Android enforcing the matching signature, not Fress.

### Make sure you run the newest build

Each Fress app shows its exact version in the header, right next to the name — a released build of `v1.0.9-beta` shows `v1.0.9-beta`. The version badge at the top of this page tracks the newest **published** release; the development sources on `main` build the next version (currently `1.0.10-beta`), so a newer version number in the repository does not mean a release has been published yet. If your installed app does not show the version you expect, install the newest installer from the [Releases page](https://github.com/WasewaseX/Fress/releases). Old installers keep working and can silently sit on your machine next to the new one.

### Where downloads are saved (per operating system)

Fress picks each operating system's own download location, the same place your browser uses:

| Operating system | Default download folder | Change folder in-app |
| --- | --- | --- |
| Windows | `Downloads` (follows OneDrive redirection if set up) | Yes |
| macOS | `~/Downloads` | Yes |
| Linux | XDG downloads folder (usually `~/Downloads` or `~/Downloads/<locale>`) | Yes |
| Android | The app's private storage (Android does not let apps pick arbitrary folders) | No. Use Open after a download to install or share the file |

### Why Windows shows "Unknown publisher"
The Windows installer is **not Authenticode-signed today**: no signing certificate is configured for CI, and the published installers carry no certificate table (verified on the `v1.0.9-beta` release bytes — see [CODE_SIGNING.md](CODE_SIGNING.md) for the audit and the free routes), so Windows shows the blue "Unknown publisher" / "Windows protected your PC" warning and will keep showing it until the publisher is covered by a certificate Windows already trusts. What protects the file you download is the release integrity and authenticity chain, not a publisher certificate:

- Every release ships a `SHA256SUMS.txt` covering all assets, and the app itself verifies its own updates against that file before offering the installer. Verify manually with `sha256sum -c SHA256SUMS.txt` after downloading.
- The Windows installers and Linux bundles additionally carry a minisign updater signature produced by CI; the signatures on the releases have been verified byte-for-byte against the published public key (see the release signature audit in [CODE_SIGNING.md](CODE_SIGNING.md)). For its own in-app updates, Fress checks the downloaded file against that signature — through the key embedded in the app — before it reports the update as verified, and an update without a verifiable signature is routed to the releases page instead. A checksum proves integrity with the release manifest, the signature proves who authorized the artifact — they are separate guarantees, and neither is an Authenticode publisher identity.
- [CODE_SIGNING.md](CODE_SIGNING.md) documents the signing fix, including a free signing route for open-source projects (SignPath Foundation). Until that is set up, you can:
  - Click **More info → Run anyway** after checking the checksum against `SHA256SUMS.txt`, or
  - Build the app yourself from this repository (`npm run tauri build`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
