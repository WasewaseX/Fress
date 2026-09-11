# Changelog

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
