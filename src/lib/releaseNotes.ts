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
