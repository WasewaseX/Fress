# Changelog

## 0.12.1-beta (2026-09-13)

### Fixed
- Star counts were hand-entered and had drifted into nonsense — VLC showed 3k (it really has 19.6k on its official GitHub mirror), 7-Zip showed 0, Immich showed 70k instead of 114k. Every number was replaced with the live value from each project's code hosting, and the catalog now refreshes them automatically every 24 hours (cards, table view, and the detail modal all show the same live count; offline it falls back to the last known value).
- VLC, GIMP, and Inkscape now link their repo to the official GitHub mirror so the star count reflects where their community actually tracks the project.
- Selected buttons in light mode (platform and category chips, grid/table toggle, command palette rows) had near-white text on a white background — invisible. They now use a muted cocoa-brown chip with white text: easy to spot, easy on the eyes. Dark mode looks exactly as before.
- The "Unknown Publisher" blue warning on Windows: releases now sign through Azure Trusted Signing the moment the signing account is configured in repo secrets, which makes Windows show Fress as a verified publisher — no warning. Until that one-time setup is done (see CODE_SIGNING.md), releases keep the timestamped self-signature and the release page says so plainly.

### Changed
- Git history rewritten so every commit is authored by WasewaseX — the placeholder "Fress" identity no longer appears anywhere in the repository.

## 0.12.0-beta (2026-09-13)

### Added
- Update check for Fress itself: the footer button (replacing "Get Fress") compares your installed version with the latest release on GitHub and only downloads when a newer build exists — it picks the right file for your platform automatically.
- The whole catalog is translated: app descriptions, taglines, highlights, and setup notes now follow the selected language (English, Persian, Spanish, French, German) instead of staying English.

### Fixed
- Windows installer: the exe now carries a real Authenticode signature (subject "Fress", timestamped). The blue "Unknown Publisher" warning still appears because removing it requires a paid certificate; see the README for what the signature does and does not prove.
- Misplaced and crowded card buttons: the card footer is now one clean row (Guide left; Download and GitHub right). The install-command chip and site link moved into the detail modal where they belong.
- A stray "Advanced: paste these..." help line appeared inside the About section of the detail modal; it moved back to the install-commands section.
- The download platform picker no longer shows every platform as a disabled button — only the platforms the app actually ships for, with your device preselected.
- "Other official options" in the detail modal is capped at two entries so the download section stays readable.
- Android download panel no longer offers the change-folder control (Android cannot pick arbitrary folders); it explains where files go instead.

### Changed
- One way to add apps: the header "Add app" button opens a single dialog with two tabs (Search GitHub / Enter manually). The duplicate "Search GitHub live" hero button and the separate "Add manually" menu item are gone.
- Text rewrite across the interface: plain human wording instead of template/marketing filler ("The Pick" → "Our pick", no more "Privacy-First Storage Notice", no more refund-policy boilerplate for a free directory).
- The live-search dialog says "Add" instead of "Add to My Fress", and no longer talks like Fress is a user account.

## 0.11.0-beta (2025-09-13)

### Fixed
- Android launcher icon: the APK shipped the Tauri template icon by mistake; every Android launcher/adaptive icon is now the blue Fress leaf.
- Android opens on the Android catalog: each device now starts with its own platform preselected (Android shows Android apps first, desktop shows everything), and your last chosen platform is remembered.
- Header and filter bar no longer scroll away: the filter bar pins itself directly under the header, on every screen size.
- Downloads land in one consistent folder: the engine's fallback matched the Settings display (the previous fallback silently added a "Fress" subfolder when no folder was set).
- Per-OS download locations: Windows uses the real Downloads folder (including OneDrive redirection), macOS uses ~/Downloads, Linux uses the XDG download folder, and Android uses the app's storage with a clear note (Android does not permit arbitrary folder picking, so the change-folder control is desktop-only).

### Changed
- The header now shows the exact version (for example `v0.11.0-beta`) next to the app name, so it is always obvious which build you are running.
- Installer metadata: the Windows uninstaller entry now lists Fress as the publisher.

## 0.10.0-beta (2025-09-12)

### Added
- One-click stable downloads: Fress now resolves the app's real installer straight from GitHub Releases. Pick a platform and Fress fetches the latest STABLE file for it (Windows `.exe`/`.msi`, macOS `.dmg` for your architecture, Linux `.AppImage`/`.deb`/`.rpm`, Android `.apk`) — beta, RC, and draft releases are never offered.
- F-Droid integration: Android apps with an F-Droid package download the current stable APK directly from f-droid.org; if the package is not in the main repository, Fress opens the correct F-Droid page instead.
- Google Play links for Android apps with an official Play listing.
- Download folder settings in the header menu: change the folder, or reset to the system Downloads folder (now the default, like every other app).
- Release pipeline now ships every platform: Windows NSIS + MSI, macOS DMG for Apple Silicon and Intel, Linux AppImage + deb + rpm, Android universal + arm64 APK, plus a SHA256SUMS.txt covering all assets.

### Fixed
- All external buttons (GitHub, official websites, store links) now open reliably from the desktop app; the webview previously swallowed plain `window.open` and `target="_blank"` links, so nothing happened on click.
- App icon redesigned: a blue leaf on a fully transparent background — no tile, no white ball — consistent between the taskbar, Windows Settings, and the app itself.

## 0.9.0-beta (2025-09-12)

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
