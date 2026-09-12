# Changelog

## 0.11.0-beta (2026-09-13)

### Added
- Downloads are verified against the checksum the publisher itself ships whenever the release provides one (sibling `.sha256` file or a `SHA256SUMS` manifest). A mismatch discards the file before it is ever named as finished, and the download panel shows a green "checksum verified" badge when a file matched.
- First launch opens the guide once on a short "why open source matters" page — plain words, no jargon, dismissible like any dialog.
- The Picks filter now curates ten beginner-proof essentials (VLC, LocalSend, 7-Zip, Bitwarden, KeePassXC, Signal, GIMP, Audacity, Joplin, F-Droid) instead of a single app.
- The guide is rebuilt as a real beginner walkthrough: per-OS install steps (including moving an Android APK to the phone, "install unknown apps", and Play Protect), a why-open-source page with licenses in plain words, and the developer build notes in their own tab. Every button in it does something real.
- The download panel explains the next step per file type (run the .exe, drag the .dmg, allow executing the AppImage, transfer the .apk) and links straight into the guide.
- Release lookups are cached on disk (fresh for six hours, F-Droid for a day) and served stale when GitHub is unreachable, so browsing the catalog survives rate limits and offline restarts.
- A pacing gate in front of the public JSON APIs keeps casual browsing from burning the IP-wide GitHub quota.

### Changed
- The hero now leads with "Browse the Picks"; live GitHub search moved to a quiet third option. First impression defaults stay curated-first.
- The interface guide entry is renamed "How to install apps"; the build-it-yourself instructions moved under "For developers" (the footer link opens that tab directly).
- Cookie banner removed: the app stores nothing beyond your own preferences and has no tracking, so consent theater helped nobody. The privacy audit panel still documents every byte written to disk.
- Light mode regains its structure: hairline borders, table row lines, input boundaries and hover fills are visible again. Modals share one theme-aware backdrop instead of a flat black scrim.
- Right-to-left layouts mirror correctly (search field, table alignment, floating bars), and the whole shortcuts dialog, batch bar and every download toast are translated in all five languages.
- Escape now closes only the topmost panel; the command palette sits above other dialogs and traps focus like the rest.
- "Browse the Picks" hero filters honestly, the header no longer shouts live search over curated browsing, and the footer build link opens the developer tab.

### Fixed
- The detail modal's download button now verifies checksums too, and retrying a failed download keeps the verification (it previously downgraded to unchecked silently).
- Downloads finish correctly on filesystems without hard links (exFAT/FAT USB drives and SD cards); previously the file could be discarded after a full download.
- A symlinked folder inside Downloads can no longer redirect downloads or folder opening outside the real Downloads tree; the resolved path is checked before writing and re-checked before finalizing.
- Individual downloads are capped at 4 GiB (checked both up front and against received bytes), release-cache entries are bounded, and cache keys can no longer collide across similar repository names.
- The folder-approvals file is created with owner-only permissions on Unix from the first byte.
- Keyboard focus can no longer escape an open dialog when focus starts on the backdrop, and stacked dialogs no longer unlock page scroll for each other.
- Light-mode contrast: warning rows, the Pick badge, small accent text and dark-theme star counts all pass WCAG AA.
- Pop-up blocked in the browser preview now says so honestly instead of claiming a tab was opened.
- Data corrections: Bitwarden entry points at the client repository with its real license situation (GPL-3.0, some parts under the Bitwarden License) and live star count; removed dead winget entries for RustDesk and LosslessCut, dead scoop entry for DevToys; repointed dead download pages for Immich, NocoDB and LibreOffice; noted that the F-Droid build of Krita lags upstream; Obsidian and NocoDB are clearly labeled as the catalog's only non-OSI entries.

## 0.10.1-beta (2026-09-12)

### Fixed
- Large downloads no longer die after 30 seconds: the engine previously applied a whole-request timeout, so big APKs and installers on slower lines were cut off mid-stream. It now only times out on an idle connection.
- Failed downloads no longer leave a corrupt partial file that looked finished: files stream into a temporary `.part` file and are renamed into place only when complete (and cleaned up on cancel/error).
- The build guide's "Download .bat" button actually works again — it now generates the script locally instead of asking a server that does not exist inside the packaged app.
- Keyboard shortcuts no longer swallow Ctrl+C / Ctrl+V / Ctrl+F or fire while a modal is open; single-letter shortcuts only act on the unobstructed catalog and no longer repeat when a key is held.
- A failed release lookup (offline, rate limit) is no longer remembered forever — the next click retries instead of staying stuck until restart.
- Version labels like "ver1.2" are cleaned up correctly (previously showed "er1.2").
- Asset picker no longer skips a valid installer just because its penalty score hit the old "wrong type" sentinel.
- Default download folder is consistent everywhere: the system Downloads folder (no hidden "Fress" subfolder).
- The download panel no longer shows the stale "Default (Downloads/Fress)" text.
- Custom apps no longer store a fake "#" website that silently did nothing when clicked.
- Winget command template in "Add a tool" no longer breaks when a repository name contains spaces.

### Changed
- Release engineering: releases are built as drafts and only published once every platform build succeeded and SHA256SUMS.txt is attached; the version job also rejects a pushed tag that does not match the project version; a manual run doubles as a draft rehearsal unless "publish" is checked; a new CI workflow (type-check, build, cargo check + clippy) runs on every push; Android builds are signed with a persistent keystore loaded from the ANDROID_KEYSTORE_B64 secret (see docs/android-signing.md) instead of a new key every run; the Android release is a universal APK covering all device architectures.
- Security hardening, round two: every redirect hop of a download is now validated against the official-host allowlist (and the final URL is re-checked); download folders must be the system Downloads folder or picked through the app's own native dialog (persisted across restarts); "Open file"/"Show in folder" only work on files the engine itself wrote; concurrent engine downloads are capped; interrupted downloads leave no temp-file litter.
- Download filenames: the server's real Content-Disposition name wins unless the app itself supplies a proper file name, so curated direct downloads (e.g. Thunderbird) no longer save as extensionless label text; non-Latin file names are preserved.
- Security: the desktop app now runs under a strict Content Security Policy (no inline scripts, no remote script/style sources; only the GitHub API and F-Droid API are reachable). The theme bootstrap moved to an external file to stay CSP-clean.
- The build guide was rewritten for beginners: an "Easy way" tab with a one-click build script, plain-language steps, correct output paths, and the real workflow name for CI builds.
- Filter bar and the detail modal now respect the selected language (previously large parts stayed English); iOS is now a first-class filter chip.

## 0.10.0-beta (2026-09-12)

### Added
- One-click stable downloads: Fress now resolves the app's real installer straight from GitHub Releases. Pick a platform and Fress fetches the latest STABLE file for it (Windows `.exe`/`.msi`, macOS `.dmg` for your architecture, Linux `.AppImage`/`.deb`/`.rpm`, Android `.apk`) — beta, RC, and draft releases are never offered.
- F-Droid integration: Android apps with an F-Droid package download the current stable APK directly from f-droid.org; if the package is not in the main repository, Fress opens the correct F-Droid page instead.
- Google Play links for Android apps with an official Play listing.
- Download folder settings in the header menu: change the folder, or reset to the system Downloads folder (now the default, like every other app).
- Release pipeline now ships every platform: Windows NSIS installer, macOS DMG for Apple Silicon and Intel, Linux AppImage + deb + rpm, Android universal APK, plus a SHA256SUMS.txt covering all assets. (The Windows MSI mentioned here was dropped later in CI; the arm64 APK mentioned here was folded into the universal APK in 0.10.1 — WiX rejects beta version suffixes; NSIS is the Windows installer.)

### Fixed
- All external buttons (GitHub, official websites, store links) now open reliably from the desktop app; the webview previously swallowed plain `window.open` and `target="_blank"` links, so nothing happened on click.
- App icon redesigned: a blue leaf on a fully transparent background — no tile, no white ball — consistent between the taskbar, Windows Settings, and the app itself.

## 0.9.0-beta (2026-09-11)

This is the first public beta. We are in beta until the catalog and download manager have survived real-world use; version numbers will stay below 1.0.0 until then.

### Added
- Real download manager: streaming downloads with progress, speed, ETA, cancel, retry, and SHA-256 verification.
- Device-aware downloads: pick Windows, macOS, Linux, Android, or iOS per app and get correct targets (direct `.apk` and installer links where projects publish them stably).
- Download folder selection, remembered between sessions, with "open file" and "show in folder" actions.
- Download queue in the header with an active-count badge.
- Light theme rebuilt from the token level: warm paper surfaces, no pure-white inversion, soft shadows.
- Theme toggle rewritten as a single source of truth; the icon can no longer disagree with the page on startup.
- Five interface languages: English, Persian (full RTL), Spanish, French, German. Language picker in Settings.
- 28 new curated apps, including GIMP, OBS Studio, Thunderbird, qBittorrent, Signal, Tor Browser, Sumatra PDF, PowerToys, Calibre, Kdenlive, balenaEtcher, Zotero, Jitsi Meet, F-Droid, Immich, Nextcloud, Home Assistant, Pi-hole, SearXNG, Vaultwarden, Stirling PDF, AppFlowy, Upscayl, NocoDB, Cal.com, listmonk, Formbricks, and Whisper Desktop.
- App icon set generated for the Windows installer and the UI brand mark.
- CONTRIBUTING.md, MIT LICENSE, and this changelog.

### Changed
- Exactly one Owner Pick remains (VLC); per-app "Pick" badges were removed.
- Header simplified: no hub button, no application-count subtitle, app icon instead of the letter F.
- Source zip ships clean (no node_modules, build output, or git metadata).
- Release tagging moved to the 0.9.0-beta scheme.

### Removed
- Template leftovers: AI studio scaffold files, PWA scaffolding, unused server entry, unused environment examples.
