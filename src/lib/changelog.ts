// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * In-app detailed changelog.
 *
 * Parses CHANGELOG.md (imported raw, so the popup can never drift out of sync
 * with the real changelog) into typed entries for the "What's new" popup's
 * "All details" view. The markdown structure it understands is the one the
 * repo already uses:
 *
 *   ## 1.0.1-beta (2026-09-21)
 *   Optional intro paragraph.
 *   ### Added|Fixed|Changed|Removed
 *   - one bullet per line
 */

import raw from '../../CHANGELOG.md?raw';

export interface ChangelogSection {
  heading: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  intro: string | null;
  sections: ChangelogSection[];
}

export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;

  const pushIntro = (text: string) => {
    if (!current) return;
    current.intro = current.intro ? `${current.intro} ${text}` : text;
  };

  for (const lineRaw of md.split('\n')) {
    const line = lineRaw.trim();

    if (line.startsWith('## ')) {
      // "## 1.0.1-beta (2026-09-21)" -> version + optional date
      const head = line.slice(3).trim();
      const m = head.match(/^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)$/);
      current = {
        version: m ? m[1].trim() : head,
        date: m ? m[2] : null,
        intro: null,
        sections: [],
      };
      section = null;
      entries.push(current);
      continue;
    }

    if (!current) continue; // "# Changelog" title and preamble

    if (line.startsWith('### ')) {
      section = { heading: line.slice(4).trim(), items: [] };
      current.sections.push(section);
      continue;
    }

    if (line.startsWith('- ')) {
      if (section) section.items.push(line.slice(2).trim());
      continue;
    }

    if (line.length === 0) continue;

    // Non-empty, non-heading text: part of the intro paragraph.
    if (!section) pushIntro(line);
    // (Wrapped bullet lines don't exist in this file; if one ever appears
    // below a section it is deliberately ignored rather than mis-parsed.)
  }

  return entries;
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = parseChangelog(raw);

export function changelogForVersion(version: string): ChangelogEntry | null {
  return CHANGELOG_ENTRIES.find((e) => e.version === version) || null;
}

/** Everything older than the given version, newest first. */
export function earlierChangelog(version: string): ChangelogEntry[] {
  const idx = CHANGELOG_ENTRIES.findIndex((e) => e.version === version);
  if (idx === -1) return CHANGELOG_ENTRIES;
  return CHANGELOG_ENTRIES.slice(idx + 1);
}
