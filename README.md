# Fress

A clean, curated directory of **free and open-source software** for Windows, macOS, Linux, Android, and iOS. Built as a fast desktop app with Tauri 2.

No telemetry. No ads. No sponsored entries. Every app in the catalog is real, popular, actively maintained, and genuinely free.

![Version](https://img.shields.io/badge/version-0.10.0--beta-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid — no hunting through release pages, and beta/RC builds are never offered.
- **Download manager built in.** Downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification, saved to the folder you choose (your system Downloads folder by default).
- **Device-aware downloads.** Windows, macOS, Linux, Android (GitHub APK, F-Droid, Google Play), and iOS — Fress picks the right file for your architecture.
- **Light and dark themes.** Both are first-class: a warm paper light mode and a calm dark mode, following your system preference until you choose.
- **Multiple languages.** English, Persian (full right-to-left support), Spanish, French, and German from the Settings menu.
- **Local-first.** Favorites, custom entries, and settings live in your own storage. The app makes zero network calls beyond the links you click.

## Feature tour

| Feature | Where |
|---|---|
| Live search on GitHub, add any project | "Live Search & Add" in the header |
| Batch installer scripts (winget / brew / flatpak / scoop) | Select cards, then "Batch" |
| Side-by-side comparison matrix | Select up to 4 cards, then "Compare" |
| Command palette | `Ctrl+K` |
| Keyboard shortcuts | `?` or the More menu |
| Export catalog as Markdown/JSON | More menu |
| Download manager | "Downloads" in the header |
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
