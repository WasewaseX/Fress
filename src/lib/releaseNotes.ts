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
    version: '1.0.1-beta',
    date: '2026-09-21',
    title: 'Cleaner, calmer, and it updates itself',
    items: [
      'A calmer look: cards are shorter and the long descriptions moved into the Guide popup, so the catalog is easy to scan at a glance.',
      'On Android the header now stays visible while you scroll instead of disappearing.',
      'Fixed the install script generator: clearing the selection no longer makes mystery apps appear that you could not remove.',
      'Removed the privacy banners. Fress simply stays private — it does not need to keep asking.',
      'New: a window like this one appears once after every update, so you always know what changed.',
      'New: Fress can update itself. When a new version is out, an Update button appears at the top. Tap it, open the downloaded file, done — your apps and data are kept.',
    ],
  },
];

export function notesForVersion(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((r) => r.version === version) || null;
}
