# Changelog

## Unreleased: a catalog that still points where the world moved

A live audit of all 75 catalog entries against the real GitHub, F-Droid, winget, Homebrew, Scoop and Flathub infrastructure found the quiet rot that time leaves behind: repositories that were renamed, package ids that moved, and package-manager commands that can no longer succeed. Every one is fixed, plus one asset-picker leak and two screen-reader gaps.

### Fixed (resolver/catalog continuation, audited live 2026-10-12)
- **Package commands now install the product the entry describes.** The Jellyfin entry is the desktop client (its repo is `jellyfin/jellyfin-desktop`), yet its winget, Homebrew and Flatpak commands all installed the headless SERVER (`Jellyfin.Server`, cask `jellyfin`, `org.jellyfin.JellyfinServer`). They now carry the verified client ids: `Jellyfin.JellyfinMediaPlayer`, cask `jellyfin-media-player` ("Jellyfin desktop client"), Flathub `com.github.iwalton3.jellyfin-media-player`.
- **Two Homebrew casks were renamed and the old tokens fail outright.** `brew install --cask handbrake` and `--cask ollama` return 404 in homebrew-cask today; the GUI apps live at `handbrake-app` (v1.11.2) and `ollama-app` (bundles the CLI). Both commands re-pointed, with audit comments in the data.
- **Retry actually retries.** The detail modal's Retry path (`retryGitHubResolve` / `retryFdroidResolve` / `retryOfficialResolve`) evicts exactly the failed lookup from the session memo and the persisted failure store, then re-runs one app|platform lookup — a live test proves a fresh network request happens and recovers once the outage ends. Successes and unrelated apps are never invalidated, and failure records are cleared at the start of each new run so a genuine "no build here" is never misreported as an error.
- **The resolver speaks a typed outcome contract.** `resolveWithOutcome()` returns `ResolveOutcome` — resolved (confident vs weak), no-match, unsupported, failed (rate-limit / network / api), or official-page — so the UI can distinguish a rate limit from an honest "no Linux build" without string-matching, and offer the right action (retry vs page link vs nothing).
- **Cache keys carry every selection input.** The resolve-cache key now includes the app's asset-naming overrides (on top of repo, platform, tag-stream pattern and prerelease vouch, with the host arch in the persistent store), so editing an override can never serve a pick cached under the old rules.
- **Trusted digests are bound to their file.** Vendor checksums (GIMP's manifest, etc.) attach only through `attachTrustedDigests()` — same manifest row, same download. Malformed digests are discarded with a recorded diagnostic (and re-validated coming out of the persisted store); absence stays unverified, never "verified".
- **Wrong-product assets are hard-refused, not merely scored down.** Server binaries are refused for desktop-client selections (with a vouch for apps resolving from a repo named `*server*`), help/language packs and debug builds never rank (with a documented exception for Termux's `+github-debug` release flavor, which IS their stable APK naming), and a low-confidence score can never resurrect a hard-incompatible file. The full catalog × platform × arch live probe matches the pre-change verdicts row for row (322 confident picks, zero deltas).
- **Catalog validation catches more of what hands get wrong.** Package-manager ids must now match their registry's canonical shape (winget `Publisher.Package`, flatpak reverse-DNS, …), F-Droid/Play ids must be unique across entries, tag-stream patterns are validated like asset patterns, patterns that would be silently disabled by the safe-regex subset are errors, and the warning policy (13 re-checked single-platform entries) is documented in the validator.

### Fixed
- **Renamed GitHub repos are referenced by their canonical names.** `jellyfin/jellyfin-media-player` → `jellyfin/jellyfin-desktop` (with the entry's star count corrected to the linked repo's real value), `ente-io/ente` → `ente/ente` (Ente Photos and Ente Auth), `Catfriend1/syncthing-android` → `researchxxl/syncthing-android` (the Syncthing-Fork), and `calcom/cal.com` → `calcom/cal.diy`. GitHub redirects kept the old names working, but a rename can be recycled — the catalog now states the truth.
- **Dead package-manager commands removed or corrected.** `RustDesk.RustDesk` was removed from winget-pkgs (removal commit 2026-03-27), `mifi.LosslessCut` never had a winget manifest, and DevToys is in no Scoop bucket — those commands would always have failed, so they are gone (the remaining managers still cover each app). balenaEtcher's winget id is now correctly cased (`Balena.Etcher`), LocalSend's Flatpak id is `org.localsend.localsend_app` and Tuta's is `com.tutanota.Tutanota`, matching their current Flathub listings.
- **Six dead or moved download pages re-pointed at live ones.** LibreOffice (`/download/download-libreoffice/`), LibreWolf (`/installation/`), SimpleX (`/downloads/`), Cake Wallet (GitHub releases — the site no longer hosts a downloads page), Immich (`docs.immich.app/install/script`), and NocoDB (GitHub releases).
- **Source archives can no longer pose as the app.** The asset picker already excluded `-source-`/`-src-` files (the HandBrake incident), but the plural slipped past: OBS Studio's `-Sources.tar.gz` was the last-resort pick for Linux hosts of any architecture when a release carried no Linux binary. The name filter now catches `-sources-` too, a regression test locks it in, and hosts with no Linux build fall back to the project's own download page instead of a source tree.
- **Two modals are real dialogs for screen readers.** Batch Install and Export rendered without `role="dialog"`, `aria-modal` or an accessible name — inconsistent with the other seven modals and invisible to assistive technology as a modal. All three attributes are in place now.

## 1.0.6-beta (2026-10-11): a catalog that uses its desktop, and a table that speaks

The main window learned what a 1920-pixel monitor is for. Header, hero, filter bar and catalog now share one wide content boundary, the grid grows a fourth column on large desktops, and the last untranslated surface — the table view — speaks five languages. A long-standing page-switch bug is fixed with a regression suite. Nothing about what Fress does with your data changed: filters, favorites, batch selection, comparison and every download behave exactly as before.

### Added
- **A desktop-width catalog.** One shared content boundary (1536px) unifies the header, spotlight, filter bar and catalog; on large desktops the grid grows to four columns while a ~365px card stays comfortably readable, keeping three columns on medium desktops, two on tablets and one on phones. Zero horizontal overflow verified at every width from 320 to 1920 pixels, dark and light.
- **Touch-sized controls.** Every icon-only control on the cards and in the table — compare, edit, delete, bookmarks, source links, checkboxes — grows to a 44px touch box on coarse pointers while desktop keeps its compact density.

### Changed
- **Cards are fully keyboard-operable and fully translated.** The application title is a real button inside the heading (a clickable heading was invisible to keyboards and screen readers), every tooltip, accessible name and toast on the card speaks five languages — including the download flow's "showing the download options" and "opening the official download page" notices, the last hardcoded strings flagged in 1.0.5.
- **The table view joined the design system.** Column headers, the copy-command control, the direct-download marker, the pick/trend badges and the versus chips are translated; platform names use the same localized words as the filter bar; taglines respect per-language overrides for custom entries; and every row's name is a keyboard-focusable button. Surfaces, borders and focus rings come from the shared tokens.
- **One focus look everywhere.** The filter bar's thinner ring was the last deviator; every focusable control in the app now shares the single 2px outline treatment, and the app root, card surfaces and filter bar ride the semantic token layer end to end.

### Fixed
- **Switching Apps ↔ Privacy Pack no longer buries the heading.** Scrolling deep into one page and switching to the other kept the old scroll offset, so the fixed header covered the new page's title; every page change now lands at the top instantly, view-mode toggles still never scroll, and a four-test regression suite (including "switch pages after a deep scroll") locks it in.

## 1.0.5-beta (2026-10-11): a coherent interface, and downloads that run quiet

The interface got a real design-token system, a header that knows what is primary, and catalog cards that keep their footing while transfers stream — while the download engine stopped writing to storage on every progress tick. Nothing changes about what Fress does with your data: favorites, filters, the download folder, the custom catalog and every download you had running behave exactly as before.

### Added
- **Semantic design tokens under the interface.** A `--fr-*` role layer (background, surface, elevated surface, text, muted text, border, primary, success, warning, danger, focus) is registered as real Tailwind utilities and themed for both the dark and the warm-paper light mode. The header, hero, empty state and shared controls now style by meaning instead of by whichever slate step looked right, and a documented size scale gives main actions, secondary controls, inputs and mobile touch targets consistent heights.
- **A universal More menu.** Every utility is reachable on every screen size through one menu with labeled groups — Section and View, Catalog & data (backup, restore, README export, batch generator), Updates (What's new, check now, channel), Download folder, Language, Theme and Help. The theme toggle moved into it, the 768–1023px band finds its section tabs there, and nothing is hidden without an equivalent route. The menu announces its state (`aria-expanded`/`aria-controls`), closes on Escape with focus returned to its button, and closes on outside click or item activation.
- **A skip-to-content link.** The first focusable element on the page jumps straight to the catalog, and the content area accepts focus so the jump actually lands.
- **Real catalog counts in the hero.** The spotlight states what Fress is in one heading and one honest sentence, then shows live numbers: how many open-source apps the catalog holds and how many of them ship Android builds. No buttons, no second navigation.
- **An empty state that answers three questions.** When a search or filter combination hides every app, the screen says so, offers Reset as the recovery action and Add a missing app as the secondary route; when the catalog itself is empty, the filters story is dropped honestly because resetting cannot help.

### Changed
- **Streaming downloads no longer hammer storage.** Terminal states (completed, failed, cancelled, page opens, removals) flush immediately; ordinary progress snapshots coalesce on a 750ms window that never starves a continuous transfer; and because the persisted payload only contains what survives a restart, identical payloads never touch storage at all — a streaming download performs zero writes. A refused write (full quota) retries once with the newest 20 entries and degrades to "panel forgets on close" without ever touching the running download. Quitting right after a terminal event cannot lose it: unmount and pagehide flush once.
- **Cards stop processing every transfer update.** Download state was split into focused subscriptions: actions (stable identities), a summary (active count + folder) and the live item list (download manager only). Each card subscribes through a selector store whose snapshot is the per-app boolean — a byte-count update re-renders zero cards, and a start or finish flips exactly the one matching card. The grid is memoized behind stable callbacks, and favorites/batch/compare membership checks are O(1) Sets now.
- **Redesigned catalog cards.** Icon (38px), clamped name and at most the two curation badges on top; a quiet uppercase category label under the name; the Custom badge moved to the metadata row; stars, license, the proprietary alternative it replaces, the offline marker and the custom marker always in the same order with platforms at the edge; one dominant Download button per card with quiet source icons beside it. Descriptions reserve a fixed two-line height so adjacent cards keep their metadata and footers aligned, and broken artwork falls back to a designed letter tile instead of an empty gap.
- **The removal confirmation speaks five languages.** "Remove {name} from your library?" and its action are real translations now, the dialog starts focus on Cancel — never on the destructive button — and Escape dismisses it.

### Fixed
- The skip-to-content link rendered its raw key string (`a11y.skipToContent`) because the key never landed in the dictionary; it is translated in all five languages now, and the key-coverage scan keeps every `t()` reference pinned to a real entry.
- The CI test gate crashed on Node 20: jsdom 30 requires Node ≥ 22 and imports undici, whose module-load path calls a function Node 20 does not have. The gate runs jsdom 26 now, and all 284 tests load cleanly on it.
- The lockfile's root version trailed the release bump (1.0.3 while package.json said 1.0.4); every version-carrying file including the lockfile is bumped together from now on.

## 1.0.4-beta (2026-10-11): the app speaks five languages — filter bar, palette, and a download context split

The last English-only corners of the interface are localized now, and the download context grew a real API boundary. Nothing about how filtering or downloading behaves has changed: the categories and platforms you select, the platform filter your device remembers, and the favorites you keep are all the same values as before — only the words around them learned five languages.

### Added
- **Complete UI localization (91 new keys × 5 languages).** The filter bar, the command palette, the header, and the detail modal's source/license metadata were hardcoded English; every label now ships in English, Persian, Spanish, French and German as real translations — never English copied into the other dictionaries. A dictionary parity test locks the five languages to identical key sets, so a missing translation fails CI instead of shipping.
- **Screen-reader announcements that translate.** The download panel's live summary accepts a translator (its default English output is pinned by tests), the filter bar announces result-count changes politely instead of interrupting, and the download progress bar carries proper progressbar ARIA plus a localized hash-copy label.

### Changed
- **The filter bar separates domain values from labels.** Category and platform chips keep their internal values — filter state, the persisted platform filter, and the keyboard shortcuts behave exactly as before — while rendering translated labels. The sort select, quick filters, reset button and the group aria-labels all read from the dictionary, and the comment declaring hardcoded English "a design choice" is gone with the assumption it described.
- **Touch ergonomics on phones, density on desktop.** Mobile filter controls get roughly 40px touch targets and visible keyboard-focus rings while desktop keeps its compact rows; the platform row keeps scrolling sideways instead of wrapping, and the selected-platform auto-centering is scoped to the mobile container and direction-aware, so it works right-to-left in Persian.
- **The download context is split into state and actions.** `useDownloadState()` (items, active count, folder) and `useDownloadActions()` (start, cancel, retry, open, ...) replace the twelve-member aggregate context. Every caller — the header badge, the download manager, app cards, the detail modal, the footer, batch selection and the app shell — migrated and verified, and the legacy `useDownloads()` hook is retired now that its migration condition is met.

### Fixed
- **Duplicate DOM ids in the filter bar.** Platform chips, quick-filter toggles, sort controls and the result counter each rendered twice (mobile row + desktop row) with shared ids, so `document.getElementById` could never be trusted. Every id is layout-suffixed now, the scroll effect queries inside the mobile container by ref, and a server-render regression test fails the build if any rendered id is ever duplicated.

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
