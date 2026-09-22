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
