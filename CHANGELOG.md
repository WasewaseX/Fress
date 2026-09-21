# Changelog

## 1.0.3-beta (2026-09-21)

The "look closer" release: every app got its official icon, a new Combos tab groups apps into kits, the email recommendations now follow the strict vetting rules the project uses for privacy, and the privacypack idea is carried through the whole catalog, from mail to browser, with stricter picks.

### Added
- Official icons: every app in the catalog now shows its real project icon next to the name, in cards, the table view and the detail popup. All 75 icons ship with the app itself, so nothing is loaded from third-party servers at startup. Custom entries and anything without artwork fall back to a clean letter tile.
- Combos tab: a new tab in the header groups apps into kits that solve one problem together, like "Private messaging", "Photo backup" or "Video studio". Each combo explains why the apps belong together, has a one-click install script (winget, Homebrew and Flatpak lines) and can hand the whole kit over to the batch selection bar. The idea comes from ente's PrivacyPack, rebuilt strictly with apps already in this catalog.
- Twelve more picks from the PrivacyPack lists that pass the vetting bar, covering the domains the catalog was missing: LibreWolf (Firefox with telemetry stripped, the daily-driver browser next to Tor Browser), Mullvad VPN and Proton VPN (two audited no-logs VPNs, one anonymous by design and one Swiss), SimpleX Chat and Element (messaging with no user IDs at all, and the Matrix network), Mastodon (federated social), Jellyfin (the Plex experience that runs at home), Cryptomator (audited vaults for any cloud folder), LibreTranslate (self-hosted translation), Fossify Calendar and Fossify Contacts (Android apps with no internet permission), and Cake Wallet (the open-source Monero wallet). Three new combos came with them: "Complete privacy pack", "Encrypted cloud" and "Media server".
- Two other PrivacyPack picks that had already passed earlier vetting rounds: Ente Auth and Aegis Authenticator (the two honest answers to Google Authenticator and Authy, one with encrypted sync and one that never touches the network), Ente Photos (end-to-end encrypted photo backup, Cure53 audited) and Fossify Gallery (the community fork of Simple Mobile Tools, kept free of the ads that came with the buyout), covered by the "Second factor kit" and "Photo backup" combos.

### Changed
- The catalog now follows a stricter privacy bar, using the same rules as the mail comparison: favorable jurisdiction, encryption on by default, open source code, independent audits. Two mail providers that meet the bar joined Privacy & Security: Tuta (Germany, encrypts subject lines too, publishes a warrant canary) and Proton Mail (Switzerland, zero-access encryption, audited). Providers that fail the bar (closed source, no at-rest encryption, Five Eyes jurisdiction) will not be listed.
- Categories trimmed: "AI & Knowledge" is gone. Both of its apps (Ollama, Whisper Desktop) moved to Productivity & Office, which is what they actually are: tools you use to get work done. The remaining six categories all carry enough apps to be worth a filter.
- Accessibility basics tightened: the Apps/Combos switcher is a real tab list for screen readers (with the phone version reporting its pressed state), the menu button now carries a proper label, app icons are marked decorative so screen readers read the app name once instead of twice, and the offline banner already announced itself politely.
- The app itself got harder to misuse: the webview now runs a strict Content-Security-Policy (no inline scripts, remote content limited to the two data sources it actually talks to), external links may only open https addresses, and the theme bootstrap moved out of the page into its own file so the policy can stay strict.

### Fixed
- No em dashes anywhere in the interface or documentation. Text now reads with plain sentences instead of the punctuation pattern people associate with machine-written copy.
- The release workflow comments were rewritten in plainer language, and the author-guard workflow keeps enforcing that every commit in the repository is authored by WasewaseX, so the old ghost contributor identity can never return.
- macOS builds are now wired for signing and notarization: when the Apple Developer credentials are set as repository secrets, the dmgs ship signed and notarized and open with a plain double-click; without them the release page explains the one-time right-click -> Open step. The setup is documented in CODE_SIGNING.md.

## 1.0.1-beta (2026-09-21)

The "stop scaring people" release: calmer cards, a header that behaves on phones, honest privacy removal, and a real update path.

### Added
- In-app updates: Fress quietly checks GitHub (at most once a day) for a newer release. When one exists, an amber "Update" pill appears in the header next to the version; tapping it downloads the platform-matched file, and "Check for updates" also lives in the header menu. On Android the APK installs as a normal update over the old copy. No uninstalling, and bookmarks, added apps and settings survive.
- "What's new" popup: opens by itself the first time the app is launched after an update (once per version, never on fresh installs) with a short, human summary of the release. It stays reachable from the header menu.

### Fixed
- Batch install generator: clearing the selection (or removing the last app chip) made five arbitrary apps appear in the modal, and tapping the X on those chips could never remove them, because the chips were never in the real selection. The modal now shows the true selection, an honest empty state, and its copy/download buttons stay disabled until you pick something. The compare matrix had the same ghost-apps fallback and is fixed the same way.
- Android: the header scrolled out of view and could not be brought back, because position: sticky does not survive inside the Android webview. On phones the header is now pinned with fixed positioning (the same technique the platform bar already used) with a live-measured spacer, so it stays visible while the catalog scrolls underneath.

### Changed
- Calmer cards: the long description and the "why it's awesome" paragraph moved into the Guide popup, which already carried the install commands, links and download picker. A card is now category, badges, name, one quiet tagline line, stars, license, platforms, and three actions. The catalog reads at a glance instead of feeling like a wall of text.
- The header is leaner: the settings gear merged into the menu (download folder and language live there now), and on phones the view switch and theme toggle moved into the menu too, leaving Add app, Downloads, and the menu.
- Removed the cookie/privacy banner, the "Privacy check" panel, the storage-preferences dialog and the "No telemetry. Everything stays on this device." footer line. Fress never collected anything; it also stops begging for consent to collect nothing. The privacy and terms pages remain, opened voluntarily from the footer.
- Projects that publish on both GitHub and GitLab now show two source buttons (a GitLab button next to the GitHub one), and the star count comes from GitHub when a project has both, so everything is compared on the same scale. Tor Browser and F-Droid were the two entries rated on their GitLab numbers (18 and 2,656 stars) while their official GitHub repos carry 879 and 3,039. Both now link the GitHub repo for stars and keep the GitLab link, where development actually happens, as a second button.
- The generic "GitHub Releases" link no longer appears for apps that already have hand-verified download targets on that platform. Tor Browser's primary GitHub repo is its launcher, which ships no installers in releases, so pointing there was noise.
- Version bumped to 1.0.1-beta in package.json, tauri.conf.json and Cargo.toml.

## 1.0.0-beta (2026-09-14)

The first release that ships for every platform from one tag: Windows, macOS (Apple Silicon and Intel), Linux (AppImage, deb, rpm), and Android (universal APK).

### Fixed
- Star counts are live everywhere now, including search results. The GitHub API quota for anonymous calls (60 per hour, which a catalog this size burns fast) is handled with ETag re-validation, which is free, so counts stay fresh instead of silently freezing. Formatting matches github.com (19.6k, 950), so a 940-star repo no longer rounds down to "0k".
- Thunderbird had `stars: 0` and no repository link; LibreOffice carried a made-up round number. Both now link their official repositories (thunderbird-desktop and the LibreOffice/core mirror) with the real counts.
- Adding an app by hand no longer guesses 1,000 stars. The field fills itself from the live GitHub API once a repository URL is pasted.
- Selected and highlighted controls in light mode (Picks, Trending, Favorites toggles, compare and bookmark buttons, the batch pill, table badges) kept pale text on white. They now use muted deep shades that are easy to read. Dark mode is untouched.

### Changed
- The repository was recreated clean: the git history carries one author (WasewaseX), the "Created from template" trace is gone, and no placeholder identities remain anywhere.
- Releases restore instantly: all previous installers were re-published from byte-identical backups, and CI rebuilds each tagged version in the background.

## 0.12.1-beta (2026-09-13)

### Fixed
- Star counts were hand-entered and had drifted into nonsense: VLC showed 3k (it really has 19.6k on its official GitHub mirror), 7-Zip showed 0, Immich showed 70k instead of 114k. Every number was replaced with the live value from each project's code hosting, and the catalog now refreshes them automatically every 24 hours (cards, table view, and the detail modal all show the same live count; offline it falls back to the last known value).
- VLC, GIMP, and Inkscape now link their repo to the official GitHub mirror so the star count reflects where their community actually tracks the project.
- Selected buttons in light mode (platform and category chips, grid/table toggle, command palette rows) had near-white text on a white background, so they were invisible. They now use a muted cocoa-brown chip with white text. Dark mode looks exactly as before.
- The "Unknown Publisher" blue warning on Windows: releases now sign through Azure Trusted Signing the moment the signing account is configured in repo secrets, and Windows then shows Fress as a verified publisher with no warning. Until that one-time setup is done (see CODE_SIGNING.md), releases keep the timestamped self-signature and the release page says so plainly.

### Changed
- Git history rewritten so every commit is authored by WasewaseX; the placeholder "Fress" identity no longer appears in git history.

## 0.12.0-beta (2026-09-13)

### Added
- Update check for Fress itself: the footer button (replacing "Get Fress") compares your installed version with the latest release on GitHub and only downloads when a newer build exists. It picks the right file for your platform automatically.
- The whole catalog is translated: app descriptions, taglines, highlights, and setup notes now follow the selected language (English, Persian, Spanish, French, German) instead of staying English.

### Fixed
- Windows installer: the exe now carries a real Authenticode signature (subject "Fress", timestamped). The blue "Unknown Publisher" warning still appears because removing it needs a certificate from an authority Windows trusts; see the README for what the signature does and does not prove.
- Misplaced and crowded card buttons: the card footer is now one clean row (Guide left; Download and GitHub right). The install-command chip and site link moved into the detail modal where they belong.
- A stray "Advanced: paste these..." help line appeared inside the About section of the detail modal; it moved back to the install-commands section.
- The download platform picker no longer shows every platform as a disabled button. It only lists the platforms the app actually ships for, with your device preselected.
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
- One-click stable downloads: Fress now resolves the app's real installer straight from GitHub Releases. Pick a platform and Fress fetches the latest STABLE file for it (Windows `.exe`/`.msi`, macOS `.dmg` for your architecture, Linux `.AppImage`/`.deb`/`.rpm`, Android `.apk`). Beta, RC, and draft releases are never offered.
- F-Droid integration: Android apps with an F-Droid package download the current stable APK directly from f-droid.org; if the package is not in the main repository, Fress opens the correct F-Droid page instead.
- Google Play links for Android apps with an official Play listing.
- Download folder settings in the header menu: change the folder, or reset to the system Downloads folder (now the default, like every other app).
- Release pipeline now ships every platform: Windows NSIS + MSI, macOS DMG for Apple Silicon and Intel, Linux AppImage + deb + rpm, Android universal + arm64 APK, plus a SHA256SUMS.txt covering all assets.

### Fixed
- All external buttons (GitHub, official websites, store links) now open reliably from the desktop app; the webview previously swallowed plain `window.open` and `target="_blank"` links, so nothing happened on click.
- App icon redesigned: a blue leaf on a fully transparent background (no tile, no white ball), consistent between the taskbar, Windows Settings, and the app itself.

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
