# Changelog

## 1.0.3-beta (2026-10-11): the hardened engine — nine audits merged, vendor checksums verified

Nine independent hardening and refactor rounds landed in one release, and the download engine learned to check the publisher's math. Every byte of every download now flows through a policy-validated network stack, files are assembled transactionally, and where a vendor publishes a checksum in the same manifest that named the file, a download that fails it is deleted before it can look finished.

### Added
- **Vendor checksum verification, end to end.** Signal's electron-updater feeds, Proton's `version.json` and GIMP's `gimp_versions.json` publish a per-file hash right next to the download URL; the resolver now carries that hash (SHA-256 and SHA-512, including electron-updater's base64 encoding) into the download engine, which verifies the finished file and deletes any that fails. The same contract covers single downloads, batch downloads and the app's own self-update (verified against the release's published `SHA256SUMS.txt`). A corrupted or tampered download can never present itself as done.
- **An authoritative native network policy.** Before a download starts, the URL is admitted under an executable-download policy inside Rust: malformed URLs, cleartext http, embedded credentials, private and loopback address literals and localhost names are refused at the gate, redirects are re-validated per hop, and connections stay public-address-only. The engine's HTTP client is the policy's client — SSRF- and rebinding-resistant by construction, not by convention.
- **A transaction-safe download engine.** Downloads stage into `.part` files with validator sidecars, resume only against a proven byte-identical origin (strict `Content-Range` checks), and finalize through an atomic no-clobber commit — two downloads finishing the same name can no longer destroy each other, and a finished file never appears half-written. The engine is a self-contained, unit-tested module with an explicit state machine.
- **Rust is tested in CI now.** Every pull request and every main push runs the Rust test suite on every desktop platform Fress ships for, plus formatting and lint gates; release workflows are SHA-pinned and least-privilege.

### Changed
- **The frontend and the engine were decomposed.** `App.tsx` went from 1,245 lines to a composition shell, `releaseFetch` became a facade over focused `release/` modules (providers, matching, caching, types), and the download engine moved out of the Tauri monolith into `download_finalize.rs`. No behavior drift: characterization tests landed before the extraction.
- **Imported regex overrides are boundary-checked.** Patterns coming from backup imports and custom entries pass a safe-subset analyzer that targets the catastrophic-backtracking class; the shipped catalog's patterns are compile-audited by test.
- **Tauri capabilities are least-privilege now.** Every plugin permission in the capability file was re-verified against the actual frontend call sites and narrowed to exactly those, the CSP was hardened to the audited dist output with `freezePrototype`, and the previously-dead "Open file / Open folder" buttons work again.
- **Accessibility pass.** Icon-only controls carry real names, the filter bar is a labelled group, and download progress is announced to screen readers.

### Fixed
- The download engine's extraction initially dropped the `serde::Serialize` derives that compile the event payloads (caught by CI, fixed before merge); the integration of the policy layer and the engine moved download-path validation into the plan itself so no download can bypass it.
- The compare button in the app card now tells screen readers whether it adds to or removes from the comparison matrix, instead of reading the same either way.



## 1.0.2-beta (2026-09-26): every entry downloads, no "go look it up" left

The catalog-wide download audit finished the job the earlier rounds started: every app, on every platform it claims, now hands you a real file (or, where a project genuinely ships no binary, its official package channel). Fifty-two desktop rows and seven Android rows used to dead-end in a download page; they resolve to exact installers now, read live from each project's own manifest infrastructure.

### Added
- **A third resolver source: the vendor's own download infrastructure.** Projects that distribute outside GitHub resolve through their own manifests now, not through a marketing page: Tor's per-platform update manifests (Windows, macOS, Linux and every Android ABI), Signal's electron-updater feeds with exact sizes plus its Android `latest.json`, Proton Mail's `version.json` (the Stable channel, never Early Access), Zotero's stable download endpoint, GIMP's official `gimp_versions.json`, Blender's, Krita's and Kdenlive's mirror directory indexes, LibreOffice's stable tree, Nextcloud's desktop CDN, Element's installer directory, LibreWolf's GitLab releases, SumatraPDF's download page and Inkscape's Windows installer via its winget manifest. Every pick was verified live against the real endpoints, and the picks re-resolve on every release, so nothing rots.
- **Per-platform repository overrides.** Projects whose downloads live in a different repo than their front page now say so in the catalog: Ente Photos' desktop app comes from `ente/photos-desktop` (which also kills the wrong-app Ensu pick for good), Bitwarden's Android APK from `bitwarden/android`, Home Assistant's companion app from `home-assistant/android`, Proton VPN's macOS and Android builds from their own repos, and Element's Android app from `element-hq/element-x-android`.
- **Honest platform claims.** LibreTranslate is server software (pip and Docker) and claims no desktop platforms; Cake Wallet publishes no macOS build and Proton VPN has no downloadable Linux installer, so neither claims those platforms. Where a project ships no binary at all for Linux (VLC, GIMP, Krita, HandBrake, Inkscape, Element), the download button offers the project's official Flatpak build on Flathub instead of pretending a tarball exists.
- **A hard, allowlisted text-fetch command.** The desktop app reads vendor manifests through a new Rust command that speaks https only, talks to exactly the allowlisted project hosts, and never pulls more than 2 MB, so a manifest fetch can never become a proxy or a memory hazard.

### Fixed
- **Linux users were handed source code.** HandBrake publishes no Linux binary in its GitHub releases, and the resolver's only candidate was the source tarball; a `-src-`/`-source-` name is now excluded everywhere as a matter of rule.
- **The Tor Android manifest was keyed by the wrong name** (`arm64` where the host reports `aarch64`), so the per-ABI lookup missed; Android devices get their exact APK now.
- **The Syncthing Android entry still pointed at the retired official app.** The Syncthing team retired their Android app in December 2024; Android now resolves to the maintained Syncthing-Fork they recommend, on GitHub and on F-Droid.
- **Cake Wallet's Windows row** resolved from a stale old release and its Linux tarball carried a weak-guess flag; both are pinned to their real naming now, and the catalog no longer claims a macOS build that was never published.
- **The batch-download skip toast** reads like help instead of a dead end: the few apps without a device file say so plainly and open their official page with the right pick one tap away.
- **Vendor lookups survive hiccups.** Manifest reads retry once on transient failures, and GitLab's occasional HTML challenge pages no longer turn into a failed download.



## 1.0.1-beta (2026-09-25): the download queue and the rate-limit truce

The first release on top of 1.0.0: a second, independent download-component audit was reconciled with the 1.0.0 work, keeping the best of both. The download manager now queues instead of stampeding, the resolver remembers what it already found so GitHub's rate limit stops biting, and the UI says honestly when a lookup failed because of the network instead of implying the app has no download.

### Added
- **The download queue.** A batch of thirty apps used to start thirty parallel transfers that fought each other for bandwidth. Three downloads run at a time now and the rest wait in a visible FIFO queue with their own cancel buttons, draining automatically as slots free up. The queue logic is a separate, unit-tested module.
- **Resolved downloads persist across sessions.** GitHub's unauthenticated API quota is 60 requests per hour per IP, which a batch download spends in minutes and every app launch used to re-spend. Results are now cached in local storage for six hours (failures for five minutes), partitioned by platform, host architecture and release-stream filter so a stale hit can never serve the wrong file.
- **The download panel survives an app restart.** Finished, failed and cancelled entries used to vanish when the window closed while their files (and resumable .part files) sat on disk; a download interrupted by a reboot now comes back as exactly what it is, resumable with one click.
- **Rate limits are said out loud.** When an automatic lookup fails because GitHub rate-limited the network, the detail modal says exactly that instead of implying the app has no downloadable build; and while the primary pick is only a weak guess, the "All releases" alternative stays visible instead of being hidden.

### Fixed
- **A server-supplied filename can no longer be a Windows device name.** `CON`, `NUL`, `COM1`... are reserved on Windows up to the first dot (`NUL.tar.gz` too), and a hostile Content-Disposition could make the final rename fail on a clean folder. Reserved names collapse to a safe default; compile-checked against 14 cases including multi-extension and unicode names.
- **Ten Android apps resolved to weak, unmarked picks.** Obsidian, KeePassDX, Organic Maps, Tuta, Proton Mail, Aegis, the three Fossify apps, Mastodon and Mullvad publish universal APKs whose names carry no architecture marker; each entry now pins its real APK naming, turning a flagged guess into a confident pick. The wrong-ABI protections are untouched: an unknown device still gets nothing rather than an unmarked APK.
- **Jellyfin** pointed at the server repository, whose releases carry no installers; the desktop app now resolves from `jellyfin/jellyfin-media-player`.
- **LibreWolf** pointed at a deleted GitHub repository, so every lookup ended in a 404; the entry now links to the project's real home, `librewolf-community/browser/bsys6` on GitLab.
- The "Added <date>" line in the detail modal is localized now (it was hardcoded English).


## 1.0.0-beta (2026-09-24): the first real release

This is the real v1.0.0 of Fress. Every older test build (the whole alpha line and the first beta run) has been deleted from the Releases page, and the version number starts over at 1.0.0. If you still run one of those builds, install this one by hand once: the updater compares version numbers and never offers a lower one, so it will not suggest this release on its own. Android installs coming from the last test builds use the same signing key and can install straight over the old app; export a backup from the old build first if you want to be safe. Everyone else: welcome, this is the beginning.

### Downloads, the whole point of the app
- The catalog resolves the right installer for your device from each project's own release feed. Architecture aware everywhere: x64 and ARM64 on Windows (the app asks the machine for its real architecture, not the emulated one), Apple Silicon and Intel on macOS, per-ABI APKs on Android, and Linux builds that actually run on your CPU.
- Multi-product repos are pinned to the right release stream, so the Ente Photos button downloads Ente Photos and not another Ente app, and Tuta's desktop, Android and calendar builds never cross over.
- Linux tarballs in every common format resolve now (.tar.gz, .tar.zst, .tar.xz and friends), so Ollama, 7-Zip and Calibre download directly again.
- Archive-only distributions are supported (Syncthing, Whisper Desktop, LosslessCut ship zip or 7z files instead of installers), and builds kept around for old Windows ("Legacy") can no longer outrank the current installer.
- Bitwarden resolves from its clients repository plus a stable official download link; DevToys resolves even though its repo flags every release as a prerelease.
- Android apps that also live on F-Droid prefer the F-Droid build when the GitHub release carries no architecture marker, so updates keep installing cleanly.
- When an app genuinely has no direct file (VLC, Tor Browser, GIMP and friends publish on their own sites only), the batch toast says so and opens the official pages in one click. No fake fallbacks.

### Fixed
- A wrong product could be offered: repos that publish several apps from one repo (Ente, Tuta, Obsidian, Bitwarden) are filtered by release stream before any file is picked.
- A wrong operating system could be offered: archive files whose names name another OS (a macos zip on Windows, a linux zip on macOS) are refused outright.
- A wrong architecture can never be offered: the compatibility gate runs on every pick, catalog overrides included, and an Android device whose ABI cannot be read gets the universal APK only.
- Downloads verify every byte: the received size is checked against what the server promised, resumes validate the server's answer strictly, and a resume without a validator restarts cleanly instead of risking corruption.
- Windows on ARM gets native ARM builds of Fress and of catalog apps; hyphenated names like x86-64 and arm-64 are classified correctly, and a -CLI companion can never impersonate the app.

### The app
- Batch downloads with a download manager: progress, speed, pause and resume, retries, all locally.
- The Replace tab: pick what you use today in 28 categories and get vetted private alternatives, graded and sorted.
- Update channels (alpha, beta, stable) with checksum-verified self-updates.
- Fully translated into Persian, Spanish, French and German.
- 75 curated apps, each with its official icon shipped inside the app.
- 138 regression tests behind all of the above.
