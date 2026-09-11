# Fress

A clean, curated directory of **free and open-source software** for Windows, macOS, Linux, Android, and iOS. Built as a fast desktop app with Tauri 2.

No telemetry. No ads. No sponsored entries. Every app in the catalog is real, popular, actively maintained, and genuinely free.

![Version](https://img.shields.io/badge/version-0.9.0--beta-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Why Fress

- **Curated, not scraped.** Every entry is checked by hand: official links, real descriptions, honest notes about what the app replaces.
- **Download manager built in.** Direct downloads stream inside the app with progress, speed, ETA, cancel, retry, and SHA-256 verification.
- **Device-aware downloads.** Pick Windows, macOS, Linux, Android, or iOS and get the right target: `.apk` for Android, App Store links for iOS, installers for desktop.
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
npm install          # or: bun install
npm run dev          # web preview at http://localhost:3000
npm run lint         # type-check

# Desktop app (requires Rust + platform deps, see https://tauri.app)
cd src-tauri
cargo tauri dev
cargo tauri build    # produces the Windows installer
```

The web preview works without Rust: download buttons hand off to your browser. Inside the Tauri desktop app, the full download manager activates.

## Releases

Releases are tagged `v0.9.0-beta` (we are in beta). Windows installers are built by GitHub Actions, and every release includes SHA-256 checksums. Verify before running:

```bash
sha256sum -c checksums.txt
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: app suggestions must be free, open-source, popular, actively maintained, and link to official pages only.

## License

MIT. The catalog lists software under its own respective licenses; each entry shows its license badge.
