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
