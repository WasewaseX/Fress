/**
 * Release notes shown in the "What's new" popup.
 *
 * The popup opens by itself once per version (see App.tsx), and can be
 * reopened from the header menu. Newest entry first — the modal shows the
 * entry that matches the running version and falls back to the newest one.
 */
export interface WhatsNewEntry {
  version: string;
  title: string;
  items: string[];
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.0.1-beta',
    title: 'Calmer, cleaner, easier to update',
    items: [
      'Cards got shorter: the long descriptions now live in the guide popup — tap "Guide" on any card to read the full story, install commands and links in one place.',
      'The header stays out of the way on phones: one compact row plus the search bar, and it keeps still while you scroll.',
      'Fixed the batch installer: clearing the selection no longer makes mystery apps appear that refuse to leave.',
      'Fress now checks for new releases by itself and offers a one-tap download that installs over the old copy — no uninstalling, no losing your bookmarks.',
      'Removed the cookie and privacy banner. Nothing was ever collected; now the app also stops talking about it.'
    ]
  }
];

/** Notes for the running version, or the newest entry when none matches. */
export function whatsNewFor(version: string): WhatsNewEntry {
  return (
    WHATS_NEW.find((entry) => entry.version === version) ??
    WHATS_NEW[0]
  );
}
