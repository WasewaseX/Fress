// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Human release notes for the "What's new" popup.
 *
 * The popup appears once, the first time the app is opened after an update
 * (App.tsx compares the stored "seen" version with the running one). Only
 * versions with real user-facing changes need an entry here; if a version is
 * missing, the modal falls back to a short generic message with a link to the
 * full changelog on GitHub.
 */

export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  items: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.0.6-beta',
    date: '2026-09-24',
    title: 'The first beta: Fress now ships from its permanent signing key, and downloads prove every byte they received',
    items: [
      'Android, coming from v1.0.6-alpha: this release is signed with the project\'s permanent key, and Android refuses a differently-signed update over an installed app. Uninstall the old build once, install this one, and every future update goes back to updating in place. Export a backup first — your picks and favorites do not survive an uninstall.',
      'Fixed: a download can no longer be finalized short. The byte count received is checked against the length the server promised (Content-Length on a fresh download, Content-Range on a resume) before the file is declared complete — a connection that dies in the final stretch now ends in an error and a retry, not a silently truncated file.',
      'Fixed: resuming validates the server\'s answer strictly (RFC 9110). A 206 response must carry a valid Content-Range that starts exactly where the staged file ends — a proxy that ignores the Range header can no longer splice two different copies of the file into one corrupted download.',
      'Fixed: resume now requires a validator. If the server published no ETag/Last-Modified, the partial file is discarded and the download restarts from byte 0 — without a validator a Range request can legally return bytes of a different file version, which used to allow quiet corruption.',
      'Fixed: a resume the server rejects at the protocol level (invalid 206, HTTP 416) offers Retry instead of Resume — retrying Resume could never succeed.',
      'Fixed: architecture is a hard gate for every asset pick now, catalog overrides included. A per-app naming pattern decides what a file is called, never whether your device can run it — and a browser that cannot establish the device ABI is treated as universal-only on Android instead of guessing x86_64.',
      'Fixed: an Android device whose ABI cannot be recognized is offered the universal APK only — never a split APK picked by name similarity.',
      'Fixed: the offline Atom fallback no longer answers Stable-channel update checks (the feed cannot mark prereleases), and broken percent-encoding in a catalog link no longer breaks the download click.',
      '11 new regression tests behind all of this (115 total).',
    ],
  },
  {
    version: '1.0.6-alpha',
    date: '2026-09-23',
    title: 'Bug hunt round three: the self-updater learns every architecture, and two downloads can no longer trip over each other',
    items: [
      'Fixed: the Windows self-updater architecture-matches every exe now, portables included — an ARM64 machine can no longer be handed an x64 portable just because it sorted first.',
      'Fixed: the Linux self-updater refuses binaries that cannot run. An ARM64 Linux machine used to be offered the amd64 AppImage; now a matching build wins and, when nothing compatible exists, you get the releases page instead of a download that can never start.',
      'Fixed: a failed update check no longer suppresses automatic checks for 24 hours — offline launches used to burn the whole throttle window.',
      'Fixed: the Android self-updater understands every ABI (ARMv7 and x86 devices included) using the exact same classification as the catalog downloader, and recognizes the x86_64 APK from its Fress_*_x64.apk name.',
      'Fixed: two simultaneous downloads of the same filename can no longer write into the same .part staging file — each download now reserves its own, and the final name is claimed only when the file is complete.',
      'Changed: the platform filter ignores corrupted saved values and falls back to your device default.',
      '17 new regression tests behind all of this (85 total).',
    ],
  },
  {
    version: '1.0.5-alpha',
    date: '2026-09-23',
    title: 'The bug-hunt release: every confirmed finding from the second audit, fixed and regression-tested',
    items: [
      'Fixed: Android downloads now match your device. The old APK picker ignored the device architecture and could hand an x86_64 or ARMv7 phone an arm64 file that cannot install; matching split APKs also win over the bigger universal one now.',
      'Fixed: the Privacy Pack no longer drops picks from other categories. Unpicking Proton Mail for Mail keeps it selected while Contacts still has it picked.',
      'Fixed: Resume works after changing the download folder — it looks for the partial file in the folder the download started in, not wherever is selected now.',
      'Fixed: imported backups are fully validated at runtime. A malformed backup (platforms: null, tags as a string…) can no longer crash the app, and unsafe package commands or non-http links in a shared backup are dropped.',
      'Fixed: a macOS release that only ships a .pkg offers a direct download again, and the updater asks the operating system for the CPU architecture instead of trusting the user agent (which claims Intel on Apple Silicon).',
      'Fixed: the offline update-check fallback now scans the whole release feed per channel instead of giving up when only the newest entry misses your channel.',
      'Fixed: very fast downloads can no longer vanish from the download panel, and low-confidence asset picks follow one consistent rule with a visible caution instead of two contradictory ones.',
      '34 new regression tests behind all of this (70 total).',
    ],
  },
  {
    version: '1.0.4-alpha',
    date: '2026-09-23',
    title: 'Everything just works: picks download themselves, downloads heal themselves',
    items: [
      'Privacy tab: selecting a private replacement adds it to the batch download right away — no separate "add picks to selection" step anymore, and deselecting removes it again.',
      "Fixed: downloading could just pop the guide window. Every download click now ends in a download or in the official download page opening in your browser — never a silent help window.",
      'Fixed: newer apps like Obsidian, Tuta, Mullvad, DevToys or Cake Wallet resolved to nothing because their repos publish several release streams. The resolver scans recent releases now and finds the installer for your platform.',
      'Downloads survive flaky connections on their own: a stall or drop resumes automatically from where it stopped, with a quiet "Reconnecting" note instead of an error.',
      'The speed and ETA readouts are now a live rolling window instead of an average stuck at the early peak.',
      'Smaller fixes everywhere: keyboard shortcuts no longer hijack Ctrl+A/Ctrl+F/Ctrl+D, the Brewfile generator handles formula packages, live-search results no longer race, and several strings are translated in all five languages.',
      'License hardening with the MIT license untouched: SPDX headers on every source file and a NOTICE covering copyright, trademarks and the icon audit (all catalog icons are the projects\' official artwork).',
    ],
  },
  {
    version: '1.0.3-alpha',
    date: '2026-09-22',
    title: 'Hardening: lint-clean Rust, small per-ABI Android APKs, updater-ready releases',
    items: [
      'Android finally ships the small APKs it always promised: one per architecture (arm64, armv7, x86_64, x86) at roughly half the universal APK size, alongside the universal one. The arm64 APK is now a required, gate-checked release artifact instead of a best effort.',
      'The Rust side passes clippy at its strictest setting (-D warnings) and is fully formatted; both checks are now hard CI gates, so a warning fails a build like an error.',
      'Release pipeline groundwork for signed in-app updates: when the update signing key is configured, every release now also carries a signed latest.json manifest and per-artifact signatures. Without the key, nothing changes.',
    ],
  },
  {
    version: '1.0.2-alpha',
    date: '2026-09-22',
    title: 'Releases that prove themselves, resumable downloads, real verification',
    items: [
      'Fixed: v1.0.1-alpha went out without any Windows x64 installer (the new MSI target choked on the -alpha version). Releases now stay private drafts until every required file for every platform exists and every file hashes against SHA256SUMS.txt — only then do they publish.',
      'Fixed: the updater treated 1.0.1-alpha, 1.0.1-beta and the stable 1.0.1 as the same version. It now understands prerelease ordering, so the stable release correctly lands as an update.',
      'New: update channels. Pick Stable, Beta or Alpha in the header menu; until Fress reaches stable, Alpha (everything) stays the default.',
      'Fixed: a dropped connection no longer leaves a corrupt installer behind. Downloads write to a temporary file and only get their real name when complete — and Cancel is now a pause: Resume continues from where it stopped instead of restarting.',
      'Changed: the download manager now verifies Fress updates against the checksum the release publishes. Verified shows in green; a mismatch deletes the file instead of pretending nothing happened.',
      'New: Scoop and APT are first-class in the Add App form and the script generator gained an APT (sudo apt install) tab, so Linux users get real batch installs too.',
      'Changed: backups now export as Fress (fress-backup-date.json) instead of the old project name, imports validate the file before touching anything, and bookmark restore is summarized in one clear toast.',
      'Under the hood: 23 unit tests, a catalog validator that checks all 75 apps (links, platforms, commands, icons, translations), and a PR CI pipeline — this release also fixed an ARM64 installer that could be offered to x64 machines.',
    ],
  },
  {
    version: '1.0.1-alpha',
    date: '2026-09-22',
    title: 'Calmer looks, real batch downloads, MSI installer',
    items: [
      'Fixed: the "You use now" dropdown no longer shows a white options list in the dark theme. Native dropdowns follow the app theme everywhere now.',
      'Fixed: "Download" could do nothing visible after one GitHub rate limit. Nothing is cached into silence anymore: every click ends in a download, a note, or the guide.',
      'New: the selection bar\'s main button is now "Download" and really downloads every selected app for your device. The install script generator is one click away.',
      'Fixed: the update check stays quiet. It falls back to the always-available releases feed when the API is throttled instead of showing an error.',
      'New: Privacy Pack, not Replace. One calm line at the top, the details in "About this list", the Maximum Privacy kit in calm green, and the Combos tab folded away.',
      'New: all interface text and all 75 app descriptions are now fully translated in Persian, Spanish, French and German.',
      'New: a Windows MSI installer ships next to the classic one. Antivirus engines flag it far less often; verify both against SHA256SUMS.txt.',
      'New: a fresh app icon, free software out of the box.',
    ],
  },
  {
    version: '1.0.5-beta',
    date: '2026-09-22',
    title: 'Replace your apps for better privacy',
    items: [
      'New: the Replace tab, a port of ente\'s PrivacyPack. Pick what you use today in 28 categories, from Mail to VPN to Phone OS, and pick up to three private replacements per category.',
      'New: every replacement carries a security grade, Fortress, Strong or Basic, sorted best-first with a Start here badge, so the long option lists finally say which options are actually the safe ones.',
      'New: a real downloader, the thing PrivacyPack never had. Catalog apps get a Get button with the device-aware download picker, and any set of picks can go straight to the batch install bar.',
      'New: the Maximum privacy combo. The single strongest app for every replaceable type, one kit, no spy access under default settings. Reachable from the Combos tab and from the top of the Replace tab.',
    ],
  },
  {
    version: '1.0.4-beta',
    date: '2026-09-22',
    title: 'Faster starts and friendlier keyboard support',
    items: [
      'New: popups now look after keyboard focus. Tab stays inside the popup you opened, and closing it puts you back on the button you came from.',
      'The app now loads as several smaller files instead of one big bundle, so the first start is a bit lighter, especially on Android.',
      'Fixed: the version badge on GitHub showed an old release. It now always reads the newest one.',
    ],
  },
  {
    version: '1.0.3-beta',
    date: '2026-09-21',
    title: 'Real icons, a Combos tab, and a stricter privacy bar',
    items: [
      'New: every app now shows its official icon. All icons ship inside the app, nothing is fetched from outside.',
      'New: the Combos tab in the header. Kits of apps that solve one problem together, each with a one-click install script.',
      'New: twelve more vetted apps cover the gaps from mail to browser: LibreWolf, Mullvad VPN, Proton VPN, SimpleX, Element, Mastodon, Jellyfin, Cryptomator, LibreTranslate, Fossify Calendar and Contacts, and Cake Wallet.',
      'New: the Complete privacy pack combo. The whole stack, from mail to browser, in one kit.',
      'Tuta and Proton Mail joined too. Both meet the strict bar: good jurisdiction, encryption on by default, open source, audited.',
      'The app itself got safer: a strict content security policy now runs inside the app, and macOS builds are ready for signing and notarization.',
      'Categories got trimmed so every filter is worth using.',
      'Removed the em dash habit from all text, so nothing reads machine-written.',
    ],
  },
  {
    version: '1.0.1-beta',
    date: '2026-09-21',
    title: 'Cleaner, calmer, and it updates itself',
    items: [
      'A calmer look: cards are shorter and the long descriptions moved into the Guide popup, so the catalog is easy to scan at a glance.',
      'On Android the header now stays visible while you scroll instead of disappearing.',
      'Fixed the install script generator: clearing the selection no longer makes mystery apps appear that you could not remove.',
      'Removed the privacy banners. Fress simply stays private. It does not need to keep asking.',
      'New: a window like this one appears once after every update, so you always know what changed.',
      'New: Fress can update itself. When a new version is out, an Update button appears at the top. Tap it, open the downloaded file, done. Your apps and data are kept.',
    ],
  },
];

export function notesForVersion(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((r) => r.version === version) || null;
}
