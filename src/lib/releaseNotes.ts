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
