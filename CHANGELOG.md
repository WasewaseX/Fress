# Changelog

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
