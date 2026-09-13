# Fress

A short, checked directory of **free and open-source software** for Windows, macOS, Linux, Android, and iOS. Built as a fast desktop and mobile app with Tauri 2.

No telemetry. No ads. No sponsored entries. Every app in the catalog is real, popular, actively maintained, and genuinely free.

![Version](https://img.shields.io/badge/version-0.12.0--beta-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid — no hunting through release pages, and beta/RC builds are never offered.
- **Update check for Fress itself.** The button in the footer compares your installed version with the latest release on GitHub and only downloads when there is something newer.
- **Download manager built in.** Downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification, saved to the folder you choose (your system Downloads folder by default).
- **Device-aware downloads.** Windows, macOS, Linux, Android (GitHub APK, F-Droid, Google Play), and iOS — Fress picks the right file for your architecture.
- **Light and dark themes.** Both are first-class: a warm paper light mode and a calm dark mode, following your system preference until you choose.
- **Multiple languages.** English, Persian (full right-to-left support), Spanish, French, and German from the Settings menu — including the app descriptions, not just the menus.
- **Local-first.** Favorites, custom entries, and settings live in your own storage. The app makes zero network calls beyond the links you click.

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

Releases are tagged (we are in beta). Every release ships installers for all platforms, built by GitHub Actions:

| Platform | File |
| --- | --- |
| Windows | `Fress_*_x64-setup.exe` |
| macOS (Apple Silicon) | `Fress_*_aarch64.dmg` |
| macOS (Intel) | `Fress_*_x64.dmg` |
| Linux | `Fress_*_amd64.AppImage`, `.deb`, `.rpm` |
| Android | `Fress_*_universal.apk` |

Every release includes a `SHA256SUMS.txt` covering all assets. Verify before running:

```bash
sha256sum -c SHA256SUMS.txt
```

### Make sure you run the newest build

Each Fress app shows its exact version in the header (for example `v0.11.0-beta`), right next to the name. If your installed app does not show the version you expect, install the newest installer from this page — old installers keep working and can silently sit on your machine next to the new one.

### Where downloads are saved (per operating system)

Fress picks each operating system's own download location, the same place your browser uses:

| Operating system | Default download folder | Change folder in-app |
| --- | --- | --- |
| Windows | `Downloads` (follows OneDrive redirection if set up) | Yes |
| macOS | `~/Downloads` | Yes |
| Linux | XDG downloads folder (usually `~/Downloads` or `~/Downloads/<locale>`) | Yes |
| Android | The app's private storage (Android does not let apps pick arbitrary folders) | No — use Open after a download to install or share the file |

### Why Windows shows "Unknown publisher"

The Windows installer is signed with a timestamp, which proves the file is exactly the one CI produced and has not been altered. Windows still shows the blue "Unknown publisher" / "Windows protected your PC" warning because it only hides for a certificate that chains to a root Windows already trusts — that's the fix, and the build pipeline already supports it end to end. [CODE_SIGNING.md](CODE_SIGNING.md) documents the one-time setup (Microsoft's Trusted Signing service, or the free SignPath Foundation route for open-source projects); until it's done, you can:

- Click **More info → Run anyway** after checking the checksum against `SHA256SUMS.txt`, or
- Build the app yourself from this repository (`npm run tauri build`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
