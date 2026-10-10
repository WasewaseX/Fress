// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../../types';

/**
 * Release identity strings: which repository carries a platform's
 * downloads, and which human version a release tag represents.
 *
 * Deliberately tiny and dependency-free - every other release module and
 * several UI components lean on these helpers, so they must stay cheap to
 * import and impossible to cycle.
 */

export function parseGithubRepo(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

export function cleanVersion(tag: string): string {
  // "ver" must be stripped before "v", or "v4.5" ordering turns "ver4.5"
  // into "er4.5" (caught by unit tests).
  return tag.replace(/^ver/i, '').replace(/^v/i, '') || tag;
}

/** The GitHub repo that actually carries this platform's downloads: the
 * repoOverrides entry when one exists, else the primary githubUrl. */
export function effectiveRepo(app: AppItem, platform: Platform): string | null {
  const override = app.repoOverrides?.[platform]?.trim();
  if (override) {
    // Owner/repo shorthand (what the catalog field stores) or a full URL.
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(override)) {
      return override.replace(/\.git$/i, '');
    }
    return parseGithubRepo(override);
  }
  return parseGithubRepo(app.githubUrl);
}
