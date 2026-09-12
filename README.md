# Fress

A clean, curated directory of **free and open-source software** (with one clearly-labeled freeware exception) for Windows, macOS, Linux, Android, and iOS. Built as a fast desktop app with Tauri 2.

No telemetry. No ads. No sponsored entries. Every app in the catalog is real, popular, and genuinely free to use — two clearly-labeled exceptions (one freeware, one fair-source rather than OSI open source) say so on their entries.

![Version](https://img.shields.io/badge/version-0.10.1--beta-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **One-click stable downloads.** Pick your platform and Fress resolves the app's actual latest STABLE file straight from GitHub Releases or F-Droid — no hunting through release pages, and beta/RC builds are never offered.
- **Download manager built in.** Downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification, saved to the folder you choose (your system Downloads folder by default).
- **Device-aware downloads.** Windows, macOS, Linux, Android (GitHub APK, F-Droid, Google Play), and iOS — Fress picks the right file for your architecture.
- **Light and dark themes.** Both are first-class: a warm paper light mode and a calm dark mode, following your system preference until you choose.
- **Multiple languages.** English, Persian (full right-to-left support), Spanish, French, and German from the Settings menu.
- **Local-first.** Favorites, custom entries, and settings live in your own storage. There is no telemetry; the only network traffic Fress itself makes is the release lookup, search, and download traffic you trigger (GitHub, F-Droid, and Mozilla's download CDN for Thunderbird).

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

Download the latest build from [github.com/WasewaseX/Fress/releases](https://github.com/WasewaseX/Fress/releases) — releases are tagged (we are in beta). Every release ships installers for all platforms, built by GitHub Actions:

| Platform | File |
| --- | --- |
| Windows | `Fress_*_x64-setup.exe` |
| macOS (Apple Silicon) | `Fress_*_aarch64.dmg` |
| macOS (Intel) | `Fress_*_x64.dmg` |
| Linux | `Fress_*_amd64.AppImage`, `Fress_*_amd64.deb`, `Fress_*_x86_64.rpm` |
| Android | `Fress_*_universal.apk` (one APK covering all device architectures) |

Every release includes a `SHA256SUMS.txt` covering all assets. Verify before running:

> **Beta note:** installers are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper may show a standard warning on first run. Compare the SHA-256 with the release's `SHA256SUMS.txt` if you want extra assurance — that is exactly why the manifest ships with every release.

```bash
sha256sum -c SHA256SUMS.txt
```

## Contributing

Maintainers: see [docs/android-signing.md](docs/android-signing.md) for the release signing setup, and `scripts/data_check.py` / `scripts/i18n_check.py` for catalog and translation sanity checks, and `scripts/gen_llms.py` to regenerate `public/llms.txt` from the catalog.

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
