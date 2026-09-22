// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Source-code links for display, shared by the detail modal, cards and the
// table view.
//
// One repo per project is not how the real world works: Tor Browser develops
// on its own GitLab and mirrors on GitHub, F-Droid develops on gitlab.com and
// mirrors on GitHub. GitLab star counts run far lower than GitHub's for the
// same project (fewer people star there), so rating a project by its GitLab
// count while its GitHub mirror exists is unfair.
//
// The rule the catalog follows:
//   - `githubUrl` holds the primary repo and drives the live star count. When
//     a project has both, that is the GitHub one, so every app competes on
//     the same scale.
//   - `gitlabUrl` adds the second official link so nobody hides where
//     development actually happens.
//   - A project with only one home shows exactly one button.

import { AppItem } from '../types';

export interface SourceLink {
  label: string;
  url: string;
  kind: 'github' | 'gitlab' | 'forge';
}

function isGithubUrl(url: string): boolean {
  return /github\.com/.test(url);
}

function isGitlabUrl(url: string): boolean {
  return /gitlab/.test(url);
}

/**
 * Official source links for an app, primary first.
 * `githubUrl` is a legacy name: it holds the primary repo on any forge
 * (GitHub, gitlab.com or a self-hosted one), because stored user data and
 * the live-star pipeline both key off it.
 */
export function sourceLinksFor(app: Pick<AppItem, 'githubUrl' | 'gitlabUrl'>): SourceLink[] {
  const links: SourceLink[] = [];
  const primary = (app.githubUrl || '').trim();
  const secondary = (app.gitlabUrl || '').trim();

  if (primary) {
    if (isGithubUrl(primary)) {
      links.push({ label: 'GitHub', url: primary, kind: 'github' });
    } else if (isGitlabUrl(primary)) {
      links.push({ label: 'GitLab', url: primary, kind: 'gitlab' });
    } else {
      // Self-hosted non-GitLab forge (e.g. a project running Gitea itself)
      links.push({ label: 'Source', url: primary, kind: 'forge' });
    }
  }

  if (secondary && secondary !== primary) {
    links.push({ label: 'GitLab', url: secondary, kind: 'gitlab' });
  }

  return links;
}
