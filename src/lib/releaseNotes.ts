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
    version: '1.0.1',
    date: '2026-10-17',
    title: 'The verified-boundary release',
    items: [
      'Open and "Show in folder" work again on every desktop. The first stable release narrowed the webview\'s file-opening powers to a validated native boundary, but the desktop buttons still asked for a permission the app had deliberately removed; they now cross the same registry-validated native command the Android installer handoff uses - the exact completed file, admitted by the session registry, OS asked only from the Rust side.',
      'Queued downloads can no longer evict a sibling that queued the same file for a different folder (queue entries match the panel row\'s identity now), and one failed start can no longer strand the rest of the line: the promotion pump survives errors instead of dying with an unhandled rejection.',
      'The update pill is pinned to the release it actually delivers, failed official lookups stay honest and retryable without ever opening a browser, and TypeScript strict mode (unused code, implicit returns) is now enforced on every future change.',
    ],
  },{
    version: '1.0.12-beta',
    date: '2026-10-13',
    title: 'The frontend-quality release',
    items: [
      'Every interactive surface now names itself properly: real labels and ARIA relationships across the modals, the catalog table, the palette and the batch bar, with polite live regions announcing result counts. Feedback that used to be color-only is text-backed now, and a dedicated quality test suite plus an accessibility scan pin the invariants so a regression cannot merge quietly.',
      '320 pixels is a supported floor: the batch bar, catalog grid, export dialog and command palette reflow below 360px instead of clipping, with new visual snapshots at 320px in both themes. Right-to-left layouts hardened across the detail modal, palette and header, so the Farsi experience no longer inherits left-to-right assumptions.',
      'Favorites and catalog edits no longer double-fire: the side effects (toasts, storage writes) moved out of React state updaters into once-per-action paths, so StrictMode cannot duplicate them. Adding an app that already exists now says so plainly instead of silently creating a near-duplicate, and the update-channel picker speaks five languages.',
    ],
  },
  {
    version: '1.0.11-beta',
    date: '2026-10-13',
    title: 'The open-contract release',
    items: [
      'Downloaded apps open now. Every completed download hands its exact file to your operating system, and when the OS refuses you get a real reason (the file moved, no app handles it, the system said no) with the action left retryable — no more re-downloading to try again. Linux AppImages launch for real: a validated launcher re-proves the file against the download engine\'s own completion record before marking it executable and starting it, so a launch can never be faked or double-fired.',
      'The whole download-to-open journey is now pinned by 22 new browser tests — exact per-row paths, keyboard-only activation, filenames with spaces and Unicode and shell characters, and the AppImage fallback included. The release pipeline validates its versions through one executable command across all six authoritative surfaces and audits its own published artifacts with loud, named refusals (duplicate manifest keys and platform mismatches are hard errors now).',
      'The README and the signing guide were rewritten against the actual published release bytes: which artifacts carry an updater signature, which platforms get verified in-app updates, what macOS Gatekeeper and Android expect on first launch, and why Windows shows "Unknown publisher" today.',
    ],
  },
  {
    version: '1.0.10-beta',
    date: '2026-10-12',
    title: 'The contrast-acceptance release',
    items: [
      'Every interface state is readable now, verified by a fresh acceptance round that rendered the real app in both themes at every supported width. The command palette\'s highlighted row is legible in light mode (the selection band used to swallow its own text at 1.06:1), app names can no longer be pushed out of a palette row by a long "vs proprietary" chip on narrow windows, dark-theme primary buttons and their hover states hold WCAG AA by measurement, and the export preview is keyboard-scrollable.',
      'The update pill is truthful in every state: a refused in-app delivery says "see the releases page" in both the label and the tooltip, and a cancelled update transfer returns quietly to the available state instead of hanging. The download registry records what the engine proved about each file\'s checksum, so the signature verifier\'s diagnostics can tell you whether your download completed verified or merely completed — and new tests pin that concurrent downloads can never read each other\'s records.',
      'Privacy Pack controls are named by what they actually show (speech-input "click Gmail" works now), the catalog audit reports a rate-limited answer as "inconclusive" instead of confusing it with a dead package, and CI now guards the Rust lockfile version so a stale build can never ship.',
    ],
  },
  {
    version: '1.0.9-beta',
    date: '2026-10-12',
    title: 'The verified-delivery release',
    items: [
      'An in-app update is now called "verified" only after every check has passed on the file that is actually being delivered: the release offers a file your machine can run with a published checksum and a signature for that exact filename, the download is checksum-checked by the engine, and the completed file\'s bytes are verified with the release signature before anything says "verified and ready" — nothing is ever launched automatically. A corrupted transfer stays in the download manager with a working Retry, unsigned platforms (macOS, Android) get the Releases page with the reason spelled out, and the signature verifier itself now only accepts files the app actually finished downloading — never an arbitrary path on disk.',
      'The release pipeline audits its own bytes before publishing: checksums both ways, the update manifest cross-checked against the real assets, and every signature sidecar cryptographically verified. The manifest\'s timestamp is derived from the release now, so re-running the pipeline can no longer invalidate the published checksums.',
      'The interface passed its final acceptance round: the header works at 200% browser zoom, amber warning text (the weak-pick hint, copy-failed feedback, the update pill in light mode) now holds WCAG AA contrast by measurement with new automated gates, the command palette\'s copy control and empty state are honest ARIA, the footer speaks five languages, and the Android device behavior is pinned by tests.',
    ],
  },
  {
    version: '1.0.8-beta',
    date: '2026-10-12',
    title: 'The integration release',
    items: [
      'The self-update picker got strict in both directions: version tags must be real versions now (trailing junk like "1.0.7junk" used to ride in as 1.0.7), and an update is only offered when the release carries a file your machine can actually run. The old picker could hand an Intel Mac an ARM64-only build as a fully "verified" download when that was the only file in the release — now Fress links to the Releases page instead. Release artifacts for Windows and Linux also gained a native minisign verification path against the key embedded in the app.',
      'The last English-only strings speak five languages now: Privacy Pack category names, download-option labels in the detail dialog ("Thunderbird für Windows", not "Thunderbird for Windows"), the export dialog and the detail category badge all follow your language. Cards and the table show translated category labels, ghost text like the zero-star placeholder is readable in light mode, and long app names can no longer stretch a card to four lines.',
      'CI now runs the full browser suite on every change: all ten user workflows against the production build with a sealed fixture network, plus performance invariants (a progress burst may not repaint unrelated cards, persistence stays coalesced) and the security-config validator as required gates.',
    ],
  },
  {
    version: '1.0.7-beta',
    date: '2026-10-12',
    title: 'The machine-truth release, and a polished surface',
    items: [
      'Fress asks the machine for its architecture now, not the process: a Windows-on-ARM machine running the x64 build under emulation was treated as x64 by both the updater and the catalog. ARM64 hosts get ARM64 builds offered, hyphenated names like LocalSend\'s "x86-64" are understood, a "-CLI-" companion can no longer impersonate the app, and a skipped batch download now offers an Open-official-pages action instead of a dead end.',
      'The self-update chain is pinned: the published checksum file was CORS-dead code in every earlier release, so updates shipped "unverified" silently. It is fetched natively now, and an update that cannot be verified is not delivered through the app — the Releases page opens instead. The network policy gained registry-complete IPv6 classification, and a full disk during a download is now an honest, resumable dead stop rather than a confusing retry loop.',
      'The interface finished its polish pass: light-theme text holds WCAG AA contrast by measurement (with automated tests keeping it there), the green Download button is readable in both themes, and the comparison tab\'s install command no longer sits in a black stripe. Every dialog speaks five languages, closes one layer per Escape press, and hands focus back where it belongs.',
    ],
  },
  {
    version: '1.0.6-beta',
    date: '2026-10-11',
    title: 'A catalog that uses its desktop, and a table that speaks',
    items: [
      'On a wide monitor Fress finally spreads out: header, hero, filters and the catalog share one wide content boundary, and the grid grows a fourth column on large desktops. Narrow screens keep the exact layout they had — three columns on medium desktops, two on tablets, one on phones — and nothing overflows sideways at any width.',
      'The table view was the last untranslated corner of the app; its headers, copy-command button, badges and platform names speak all five languages now, and every row\'s name is a real keyboard-focusable button. Card titles became proper buttons too, so the whole catalog is keyboard-operable, and every small icon control is sized for real fingers on touch screens.',
      'Switching between Apps and Privacy Pack no longer leaves you stranded mid-page after a deep scroll — the new page always starts at the top with its heading fully visible, while switching grid/table never scrolls at all. Filters, favorites, batch selection and downloads behave exactly as before.',
    ],
  },
  {
    version: '1.0.5-beta',
    date: '2026-10-11',
    title: 'A coherent interface, and downloads that run quiet',
    items: [
      'The header learned a hierarchy: Add App and Downloads are the primary actions, tabs and view toggles are secondary, and one More menu routes every utility on every screen size — theme, language, updates, backup and restore included. A skip-to-content link is the first thing on the page for keyboard users, and the menu hands focus back to its button when you press Escape.',
      'The catalog cards were rebuilt: icon, name and at most two curation badges on top, a quiet category label, an aligned metadata row, and one dominant Download button. Broken artwork now falls back to a designed letter tile, and the removal confirmation is translated into all five languages and keyboard-safe (focus starts on Cancel, Escape dismisses).',
      'Downloads got quieter under the hood: while a file streams, Fress no longer writes to storage on every progress tick — terminal events still save instantly, everything else coalesces and dedupes. And a byte-count update no longer re-renders catalog cards; only the card whose download actually started or finished repaints. Your download panel behaves exactly the same.',
      'The hero now shows real catalog numbers — how many open-source apps are in it and how many ship Android builds — and an empty view tells you honestly whether your filters hid everything or the catalog is truly empty, with the way back one click away.',
    ],
  },
  {
    version: '1.0.4-beta',
    date: '2026-10-11',
    title: 'The app speaks five languages now',
    items: [
      'The filter bar, the command palette (Ctrl+K), the header and the detail pages were the last English-only corners of Fress — they are translated into Persian, Spanish, French and German now, as real translations, not copied English. Persian gets proper right-to-left layout in the filter bar, including the platform scroller.',
      'Filters work exactly the same underneath: the category and platform values never changed, only the words around them. Your saved platform filter and your favorites are untouched.',
      'On phones the filter controls are easier to hit now (proper touch targets), keyboard focus is visible, the platform row still scrolls sideways instead of wrapping, and two copies of the same control no longer share one element id.',
      'The download manager got quieter polish: progress bars are named for screen readers, result-count changes are announced politely, and the download state was split into focused hooks under the hood — same features, cleaner engine.',
    ],
  },
  {
    version: '1.0.3-beta',
    date: '2026-10-11',
    title: 'The hardened engine: verified downloads, validated network',
    items: [
      'Downloads check the publisher\'s math now: Signal, Proton and GIMP publish a checksum next to every file, and any download that fails it is deleted before it can look finished. Your own self-update is verified the same way.',
      'Every download URL is validated inside the native engine first: no cleartext http, no embedded credentials, no private-address redirects — the connection policy is enforced in Rust, not by convention.',
      'Files are assembled transactionally: resumable staging, proven byte-identity on resume, and a no-clobber commit so two downloads finishing the same name can never destroy each other.',
      'The whole app was decomposed and hardened under the hood: the download engine, the resolver and the app shell are focused, fully tested modules, with the Rust test suite now running in CI on every platform.',
    ],
  },
  {
    version: '1.0.2-beta',
    date: '2026-09-26',
    title: 'Every entry downloads now, straight from the source',
    items: [
      'The catalog-wide audit is done: no more "open their download page" dead ends. Apps that distribute outside GitHub (VLC, Blender, GIMP, Signal, Tor, Proton, Zotero, Nextcloud, Element, LibreWolf, Krita, Kdenlive, LibreOffice, SumatraPDF, Inkscape and more) resolve to their exact current installer from each project\'s own manifests.',
      'Ente Photos desktop comes from its real repo now (the wrong-app pick is gone for good), and Bitwarden, Home Assistant, Proton VPN and Element resolve their Android builds from their dedicated repos.',
      'Android is fully covered: Tor Browser, Signal and every other catalog app hands you the exact APK for your device, zero skips.',
      'Where a project ships no Linux binary at all, the download button offers its official Flatpak build instead of a hunt. Server-only apps (LibreTranslate) no longer claim desktop platforms they never had.',
      'Vendor lookups are allowlisted, size-capped and retry once on hiccups, and a source-code tarball can never again be served as "the app".',
    ],
  },
  {
    version: '1.0.1-beta',
    date: '2026-09-25',
    title: 'Downloads queue politely, and the resolver remembers',
    items: [
      'Batch downloads no longer stampede your bandwidth: three transfers run at a time and the rest wait in a visible queue with cancel buttons, draining automatically.',
      'Resolved download links are remembered for a few hours, so the shared GitHub rate limit stops punishing repeat visits and batches. The detail modal now says honestly when a lookup failed because of that limit.',
      'The download panel survives an app restart now: a download interrupted by a reboot comes back resumable with one click, and finished entries stay listed.',
      'Ten Android apps (Obsidian, Mastodon, Mullvad, Aegis, the Fossify apps and friends) resolve to their real APK with confidence instead of a flagged guess, and Jellyfin and LibreWolf resolve again after their catalog entries pointed at dead repositories.',
    ],
  },
  {
    version: '1.0.0-beta',
    date: '2026-09-24',
    title: 'The first real release: direct downloads for (almost) everything',
    items: [
      'This is the real v1.0.0. Every older test build has been deleted from the Releases page. If you still run one of them, install this build by hand once: the version number went back to 1.0.0, so the updater will not offer it on its own.',
      'Direct downloads were the whole point of this app, and most of the gaps are gone. The catalog now resolves the right installer for your device from each project\'s own releases, architecture aware: x64 and ARM64 on Windows, Apple Silicon on macOS, per-ABI APKs on Android.',
      'Fixed: Ente Photos and Ente Auth could resolve to a different Ente product\'s installers because all Ente apps publish from one repo. Each app is pinned to its own release stream now, so the button downloads the app it says.',
      'Fixed: Linux builds that ship as .tar.zst or .tar.xz (Ollama, 7-Zip, Calibre) used to be invisible and a macOS archive could get picked instead. Linux now gets its own tarball.',
      'Fixed: Bitwarden, DevToys, Syncthing, Whisper Desktop and LosslessCut resolve to their real files now instead of falling back to a web page.',
      'Batch downloads skip fewer apps, and when an app genuinely has no direct file (VLC, Tor Browser, GIMP and friends publish on their own sites only) the toast says so and can open the official pages for you in one click.',
      'Also inside: downloads that resume after a drop, checksum-verified updates, the Replace tab for private alternatives, and an interface translated into Persian, Spanish, French and German.',
    ],
  },
];

export function notesForVersion(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((r) => r.version === version) || null;
}
