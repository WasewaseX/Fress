# Fress

A hand-checked directory of **free and open-source software** for Windows, macOS, Linux, and Android. It runs as a desktop and Android app, built with Tauri 2.

There is no telemetry and no advertising, and nothing in the catalog is sponsored. Every app in the catalog is real, popular, actively maintained, and genuinely free.

![Version](https://img.shields.io/github/v/release/WasewaseX/Fress?include_prereleases&sort=semver&label=version) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid. No hunting through release pages, and beta/RC builds are never offered.
- **Update check for Fress itself.** The header pill and the footer button compare your installed version with the latest release on GitHub, pick the right file for your platform, verify it against the release's published `SHA256SUMS.txt` entry, and only then hand it to you — when no checksum can be established, Fress links to the releases page instead of delivering an unverified installer. The same rule applies to architecture: if the release carries no installer your machine can actually run (for example an ARM64-only build while you are on Intel), Fress also links to the releases page rather than offering a wrong file. Release artifacts for the Windows installers and Linux bundles are additionally minisign-signed with the project's published updater key; [CODE_SIGNING.md](CODE_SIGNING.md) records which artifacts are signed and how to verify them.
- **Download manager built in.** Downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification, saved to the folder you choose (your system Downloads folder by default).
- **Device-aware downloads.** Windows, macOS, Linux, and Android (GitHub APK, F-Droid, Google Play): Fress picks the right file for your architecture.
- **Light and dark themes.** The light mode uses warm paper tones, the dark mode is easy on the eyes, and both follow your system preference until you pick one yourself.
- **Multiple languages.** English, Persian (full right-to-left support), Spanish, French, and German from the Settings menu, including the app descriptions, not just the menus.
- **Your data stays with you.** Favorites, custom entries, and settings live in your own storage. The only servers the app talks to are the ones hosting the apps: GitHub for release and star lookups, F-Droid for Android packages, and the download links you click.

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

# Desktop app (requires Rust + platform deps, see https://tauri.app)
npm run tauri dev
npm run tauri build

# Android (requires Android SDK + NDK)
npm run tauri android init
npm run tauri android build -- --apk
```

The web preview works without Rust: download buttons hand off to your browser. Inside the Tauri desktop app, the full download manager activates.

## Releases

Releases are tagged. Every release ships installers for all platforms, built by GitHub Actions:

| Platform | File |
| --- | --- |
| Windows x64 (installer) | `Fress_*_x64-setup.exe` |
| Windows x64 (MSI) | `Fress_*_x64_en-US.msi` |
| Windows x64 (portable, no install) | `Fress_*_x64-portable.zip` |
| Windows ARM64 (installer) | `Fress_*_arm64-setup.exe` |
| Windows ARM64 (portable) | `Fress_*_arm64-portable.zip` |
| macOS (Apple Silicon) | `Fress_*_aarch64.dmg` |
| macOS (Intel) | `Fress_*_x64.dmg` |
| Linux | `Fress_*_amd64.AppImage`, `Fress_*_amd64.deb`, `Fress-<version>-1.x86_64.rpm` (native RPM naming) |
| Android | `Fress_*_universal.apk` plus ABI splits `Fress_*_{arm64,arm,x64,x86}.apk` |

**Fress is distributed only through this repository's GitHub Releases page**, always with `SHA256SUMS.txt` next to the files. If you found a Fress installer anywhere else (a file host, a mirror, a "download site"), it is not ours.

Every release includes a `SHA256SUMS.txt` covering all assets. Verify before running:

```bash
sha256sum -c SHA256SUMS.txt
```

### Make sure you run the newest build

Each Fress app shows its exact version in the header (for example `v1.0.8-beta`), right next to the name. If your installed app does not show the version you expect, install the newest installer from this page. Old installers keep working and can silently sit on your machine next to the new one.

### Where downloads are saved (per operating system)

Fress picks each operating system's own download location, the same place your browser uses:

| Operating system | Default download folder | Change folder in-app |
| --- | --- | --- |
| Windows | `Downloads` (follows OneDrive redirection if set up) | Yes |
| macOS | `~/Downloads` | Yes |
| Linux | XDG downloads folder (usually `~/Downloads` or `~/Downloads/<locale>`) | Yes |
| Android | The app's private storage (Android does not let apps pick arbitrary folders) | No. Use Open after a download to install or share the file |

### Why Windows shows "Unknown publisher"
The Windows installer is **not code-signed today**: no Authenticode certificate is configured for CI (see [CODE_SIGNING.md](CODE_SIGNING.md) for the setup and the free routes), so Windows shows the blue "Unknown publisher" / "Windows protected your PC" warning and will keep showing it until the publisher is covered by a certificate Windows already trusts. What protects the file you download is the release integrity and authenticity chain, not a publisher certificate:

- Every release ships a `SHA256SUMS.txt` covering all assets, and the app itself verifies its own updates against that file before offering the installer. Verify manually with `sha256sum -c SHA256SUMS.txt` after downloading.
- The Windows installers and Linux bundles additionally carry a minisign updater signature produced by CI; the signatures on the releases have been verified byte-for-byte against the published public key (see the audit table in [CODE_SIGNING.md](CODE_SIGNING.md)). A checksum proves integrity with the release manifest, the signature proves who authorized the artifact — they are separate guarantees, and neither is an Authenticode publisher identity.
- [CODE_SIGNING.md](CODE_SIGNING.md) documents the signing fix, including a free signing route for open-source projects (SignPath Foundation). Until that is set up, you can:
  - Click **More info → Run anyway** after checking the checksum against `SHA256SUMS.txt`, or
  - Build the app yourself from this repository (`npm run tauri build`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
