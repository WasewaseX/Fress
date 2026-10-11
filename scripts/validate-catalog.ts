// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Catalog validator, the quality gate for the heart of Fress.
 *
 * The catalog is curated by hand and grows by pull requests. This script
 * catches the mistakes hands make before users ever see them: duplicate
 * ids, dead or non-HTTPS links, commands that belong to a different
 * platform than the app claims, apps without icons or without
 * translations, and the same app listed twice.
 *
 * WARNING POLICY (deliberate, documented - warnings never fail CI):
 *   - "single-platform app": a GitHub-hosted entry claiming exactly one
 *     desktop platform is suspicious but sometimes correct (ShareX and
 *     PowerToys are Windows-only by design; the Android-only entries ship
 *     through F-Droid). Each of the current 13 warnings was individually
 *     re-checked during the live audit (see PR #20 / the audit notes in
 *     the data files); a NEW single-platform entry should expect review.
 *   - "possible duplicate application": two entries with the same normal-
 *     ized name. Legitimate when the apps genuinely differ (a client and
 *     its companion); a human decides.
 *
 * Run: npm run validate:catalog   (CI runs it on every PR)
 * Exit code 1 = errors that must be fixed; warnings do not fail CI.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INITIAL_APPS } from '../src/data/appsData';
import { APP_DESCRIPTIONS } from '../src/data/appDescriptions';
import { APP_ICONS } from '../src/data/appIcons';
import { sanitizeInstallCommand, PkgManager } from '../src/lib/installCommands';
import { compileSafePattern } from '../src/lib/patternSafety';
import type { AppItem, Category, Platform } from '../src/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const VALID_CATEGORIES: Category[] = [
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video',
];

const VALID_PLATFORMS: Platform[] = ['windows', 'mac', 'linux', 'web', 'android', 'ios'];

/** Which platforms a package-manager command makes sense for. */
const COMMAND_PLATFORMS: Record<PkgManager, Platform[]> = {
  winget: ['windows'],
  scoop: ['windows'],
  brew: ['mac', 'linux'],
  flatpak: ['linux'],
  apt: ['linux'],
};

const ANDROID_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
// `githubUrl` is the primary-repo field on any forge (see sourceLinks.ts):
// GitHub owner/repo, or a GitLab project (which may nest owner/group/repo
// - LibreWolf builds at gitlab.com/librewolf-community/browser/bsys6).
const GITHUB_URL_RE = /^https:\/\/(github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|gitlab\.com\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,2})\/?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRANSLATED_LANGS = ['fa', 'es', 'fr', 'de'] as const;

interface Issue {
  app: string;
  level: 'error' | 'warning';
  message: string;
}

const issues: Issue[] = [];
const err = (app: string, message: string) => issues.push({ app, level: 'error', message });
const warn = (app: string, message: string) => issues.push({ app, level: 'warning', message });

function checkUrl(app: string, field: string, raw: string | undefined, required: boolean): void {
  if (!raw || raw.trim() === '') {
    if (required) err(app, `${field} is missing`);
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    err(app, `${field} is not a valid URL: ${raw}`);
    return;
  }
  if (url.protocol !== 'https:') {
    err(app, `${field} must be HTTPS, got: ${raw}`);
  }
}

function checkCommand(app: string, field: string, manager: PkgManager, raw: string | undefined, platforms: Platform[]): void {
  if (!raw) return;
  // The command must survive the sanitizer (it ends up in generated scripts)
  if (!sanitizeInstallCommand(manager, raw)) {
    err(app, `${field} is not a plain install command for ${manager}: "${raw}"`);
    return;
  }
  // And it must belong to a platform the app actually supports.
  const relevant = COMMAND_PLATFORMS[manager].some((p) => platforms.includes(p));
  if (!relevant) {
    err(app, `${field} is a ${manager} command but the app lists none of: ${COMMAND_PLATFORMS[manager].join(', ')}`);
    return;
  }
  // And the package id must have the CANONICAL shape that manager's
  // registry uses. A plausible-looking string that no registry could ever
  // resolve is a silent lie in the UI; each manager has its own grammar.
  // The canonical package id is the command's LAST token: flatpak carries
  // a remote name ("flatpak install flathub org.videolan.VLC"), brew an
  // optional --cask flag, winget/scoop/apt are bare. The sanitizer has
  // already guaranteed "<manager> install [flags] <id>".
  const id = raw.trim().split(/\s+/).pop() ?? '';
  const shapes: Record<PkgManager, { re: RegExp; hint: string }> = {
    winget: { re: /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+$/, hint: 'Publisher.Package (e.g. VideoLAN.VLC)' },
    brew: { re: /^(--cask\s+)?[a-z0-9@._+-]+$/, hint: 'formula or --cask name (e.g. --cask vlc)' },
    // Flatpak ids allow hyphens inside segments (io.gitlab.librewolf-community);
    // Android package names do not, which is why fdroidId uses the stricter regex.
    flatpak: { re: /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/, hint: 'reverse-DNS app id (e.g. org.videolan.VLC)' },
    scoop: { re: /^[a-z0-9][a-z0-9._-]*$/, hint: 'lowercase manifest name (e.g. sharex)' },
    apt: { re: /^[a-z0-9][a-z0-9+._-]*$/, hint: 'lowercase package name (e.g. gimp)' },
  };
  if (!shapes[manager].re.test(id)) {
    err(app, `${field} package id does not look like a canonical ${manager} id (expected ${shapes[manager].hint}): "${id}"`);
  }
}

// ---------------------------------------------------------------- checks

const apps = INITIAL_APPS;

// 1. Duplicate ids and duplicate apps under different ids.
const ids = new Set<string>();
const names = new Map<string, string>(); // normalized name -> first id
for (const app of apps) {
  const label = app.id || '(missing id)';
  if (!app.id) err(label, 'every app needs an id');
  else if (ids.has(app.id)) err(label, `duplicate id: ${app.id}`);
  ids.add(app.id);

  const norm = (app.name || '').trim().toLowerCase();
  if (norm) {
    if (names.has(norm)) {
      warn(app.id, `possible duplicate application: "${app.name}" already listed as ${names.get(norm)}`);
    } else {
      names.set(norm, app.id);
    }
  }
}

// 2. Per-app field, URL, platform and command checks.
for (const app of apps) {
  const label = app.id || '(missing id)';

  if (!app.name?.trim()) err(label, 'name is missing');
  if (!app.tagline?.trim()) err(label, 'tagline is missing');
  if (!app.description?.trim() || app.description.length < 40) {
    err(label, 'description is missing or too short to be useful (< 40 chars)');
  }
  if (!app.whyItsAwesome?.trim()) warn(label, 'whyItsAwesome is missing');
  if (!app.beginnerGuide?.trim()) warn(label, 'beginnerGuide is missing');

  checkUrl(label, 'websiteUrl', app.websiteUrl, true);
  checkUrl(label, 'githubUrl', app.githubUrl, true);
  checkUrl(label, 'gitlabUrl', app.gitlabUrl, false);
  checkUrl(label, 'downloadUrl', app.downloadUrl, false);

  if (app.githubUrl && !GITHUB_URL_RE.test(app.githubUrl.replace(/\/$/, ''))) {
    err(label, `githubUrl is not a repository root (expected https://github.com/owner/repo or a gitlab.com project): ${app.githubUrl}`);
  }

  if (!app.license?.trim()) err(label, 'license is missing');

  if (!Array.isArray(app.platforms) || app.platforms.length === 0) {
    err(label, 'platforms must list at least one platform');
  } else {
    for (const p of app.platforms) {
      if (!VALID_PLATFORMS.includes(p)) err(label, `unknown platform: ${p}`);
    }
  }
  if (app.githubUrl && app.platforms?.length === 1 && app.platforms[0] !== 'web') {
    // A GitHub-hosted project that claims exactly one desktop platform is
    // suspicious but not always wrong; flag it for a human look.
    warn(label, `single-platform app (${app.platforms[0]}): double-check the other platforms really are unsupported`);
  }

  if (!VALID_CATEGORIES.includes(app.category)) err(label, `unknown category: ${app.category}`);

  if (typeof app.stars !== 'number' || app.stars < 0 || !Number.isFinite(app.stars)) {
    err(label, `stars must be a non-negative number, got: ${app.stars}`);
  }

  if (!app.addedAt || !ISO_DATE_RE.test(app.addedAt)) {
    err(label, `addedAt must be YYYY-MM-DD, got: ${app.addedAt}`);
  }

  if (!Array.isArray(app.tags) || app.tags.length === 0) warn(label, 'tags are empty');

  checkCommand(label, 'wingetCommand', 'winget', app.wingetCommand, app.platforms || []);
  checkCommand(label, 'scoopCommand', 'scoop', app.scoopCommand, app.platforms || []);
  checkCommand(label, 'brewCommand', 'brew', app.brewCommand, app.platforms || []);
  checkCommand(label, 'flatpakCommand', 'flatpak', app.flatpakCommand, app.platforms || []);
  checkCommand(label, 'aptCommand', 'apt', app.aptCommand, app.platforms || []);

  if (app.fdroidId && !ANDROID_ID_RE.test(app.fdroidId)) {
    err(label, `fdroidId does not look like an Android package name: ${app.fdroidId}`);
  }
  if (app.playStoreId && !ANDROID_ID_RE.test(app.playStoreId)) {
    err(label, `playStoreId does not look like a Play package name: ${app.playStoreId}`);
  }
  if ((app.fdroidId || app.playStoreId) && !app.platforms?.includes('android')) {
    warn(label, 'has an Android store id but does not list the android platform');
  }

  // Download overrides must at least be valid regexes, and only for
  // platforms the app supports - otherwise the override can never fire.
  if (app.assetPatterns) {
    for (const [plat, pattern] of Object.entries(app.assetPatterns)) {
      if (!VALID_PLATFORMS.includes(plat as Platform)) {
        err(label, `assetPatterns has an unknown platform: ${plat}`);
        continue;
      }
      if (!app.platforms?.includes(plat as Platform)) {
        err(label, `assetPatterns.${plat} is set but the app does not list that platform`);
      }
      try {
        new RegExp(pattern as string, 'i');
      } catch {
        err(label, `assetPatterns.${plat} is not a valid regex: ${pattern}`);
        continue;
      }
      // A pattern that compiles but fails the SAFE subset would be silently
      // disabled at resolve time (compileSafePattern returns null there) -
      // the entry would quietly lose its override. Flag it as the defect
      // it is instead of letting the resolver shrug.
      if (!compileSafePattern(pattern as string)) {
        err(label, `assetPatterns.${plat} is not in the safe regex subset (it would be ignored at resolve time): ${pattern}`);
      }
    }
  }

  // Tag-stream patterns follow the exact same rules as asset patterns.
  if (app.tagPatterns) {
    for (const [plat, pattern] of Object.entries(app.tagPatterns)) {
      if (!VALID_PLATFORMS.includes(plat as Platform)) {
        err(label, `tagPatterns has an unknown platform: ${plat}`);
        continue;
      }
      if (!app.platforms?.includes(plat as Platform)) {
        err(label, `tagPatterns.${plat} is set but the app does not list that platform`);
      }
      try {
        new RegExp(pattern as string, 'i');
      } catch {
        err(label, `tagPatterns.${plat} is not a valid regex: ${pattern}`);
        continue;
      }
      if (!compileSafePattern(pattern as string)) {
        err(label, `tagPatterns.${plat} is not in the safe regex subset (it would be ignored at resolve time): ${pattern}`);
      }
    }
  }

  // The architectures claim must use the vocabulary the UI and resolver
  // understand - a stray "x64" or "ARM" here silently filters nothing.
  if (app.architectures !== undefined) {
    if (!Array.isArray(app.architectures)) {
      err(label, 'architectures must be an array when present');
    } else {
      for (const a of app.architectures) {
        if (!['x86_64', 'arm64', 'universal'].includes(a)) {
          err(label, `architectures contains an unknown value: ${a} (expected x86_64, arm64 or universal)`);
        }
      }
    }
  }

  if (app.lastVerifiedAt !== undefined && !ISO_DATE_RE.test(app.lastVerifiedAt)) {
    err(label, `lastVerifiedAt must be YYYY-MM-DD, got: ${app.lastVerifiedAt}`);
  }

  // TIMEZONE POLICY for lastVerifiedAt (and addedAt): the stamp is the
  // Asia/Tehran (project) local calendar date on which the live
  // verification actually ran. The audit scripts log the UTC instant
  // alongside, so an audit at 2026-10-11T19:15Z is stamped 2026-10-12 -
  // that is the same event, not a future date. To keep the policy
  // enforceable everywhere (CI included) this validator computes "today"
  // in that exact zone and rejects any stamp that would be in the future
  // there. A stamp must NEVER be moved forward just to satisfy a test:
  // it may only change when a live verification actually re-runs.
  const tehranToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  for (const [field, value] of [
    ['lastVerifiedAt', app.lastVerifiedAt],
    ['addedAt', app.addedAt],
  ] as const) {
    if (value !== undefined && ISO_DATE_RE.test(value) && value > tehranToday) {
      err(
        label,
        `${field} ${value} is in the future (today in Asia/Tehran, the catalog's verification timezone: ${tehranToday}) - stamps must reflect real verification dates`
      );
    }
  }

  // Per-platform release repos: must be an "owner/repo" GitHub path and
  // only for platforms the app supports, exactly like the pattern checks.
  if (app.repoOverrides) {
    for (const [plat, repo] of Object.entries(app.repoOverrides)) {
      if (!VALID_PLATFORMS.includes(plat as Platform)) {
        err(label, `repoOverrides has an unknown platform: ${plat}`);
        continue;
      }
      if (!app.platforms?.includes(plat as Platform)) {
        err(label, `repoOverrides.${plat} is set but the app does not list that platform`);
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo))) {
        err(label, `repoOverrides.${plat} must be "owner/repo", got: ${repo}`);
      }
    }
  }

  // 3. Icon: every catalog entry ships its official artwork.
  const iconPath = APP_ICONS[app.id];
  if (!iconPath) {
    err(label, `no icon registered in appIcons.ts for id "${app.id}"`);
  } else if (!existsSync(resolve(ROOT, 'public', iconPath.replace(/^\//, '')))) {
    err(label, `icon file does not exist on disk: public${iconPath}`);
  }
}

// 4. Store identities must be unique ACROSS apps: two entries claiming the
// same F-Droid package or Play id would both stream the same APK under two
// different names, and a repoOverride pointing at another app's repo makes
// both entries fight over one release stream.
const seenFdroid = new Map<string, string>();
const seenPlay = new Map<string, string>();
for (const app of apps) {
  if (app.fdroidId) {
    const prev = seenFdroid.get(app.fdroidId);
    if (prev) err(app.id, `fdroidId ${app.fdroidId} is already used by "${prev}"`);
    else seenFdroid.set(app.fdroidId, app.id);
  }
  if (app.playStoreId) {
    const prev = seenPlay.get(app.playStoreId);
    if (prev) err(app.id, `playStoreId ${app.playStoreId} is already used by "${prev}"`);
    else seenPlay.set(app.playStoreId, app.id);
  }
}

// 5. Translation coverage: a catalog entry is not "done" until its
// description exists in every supported language.
for (const lang of TRANSLATED_LANGS) {
  for (const app of apps) {
    const entry = APP_DESCRIPTIONS[app.id]?.[lang];
    if (!entry || !entry.description?.trim()) {
      err(app.id, `missing ${lang} description translation in appDescriptions.ts`);
    } else if (!entry.tagline?.trim()) {
      warn(app.id, `missing ${lang} tagline translation`);
    }
  }
}

// ---------------------------------------------------------------- report

const errors = issues.filter((i) => i.level === 'error');
const warnings = issues.filter((i) => i.level === 'warning');

console.log(`\nCatalog: ${apps.length} apps, ${Object.keys(APP_ICONS).length} icons, ` +
  `${Object.keys(APP_DESCRIPTIONS).length} translated entries\n`);

for (const issue of issues) {
  const mark = issue.level === 'error' ? '✗' : '⚠';
  console.log(`${mark} [${issue.app}] ${issue.message}`);
}

console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)\n`);

if (errors.length > 0) {
  console.error('Catalog validation FAILED: fix the errors above.');
  process.exit(1);
}
console.log('Catalog validation passed.');
