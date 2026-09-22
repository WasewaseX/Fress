// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Catalog validator — the quality gate for the heart of Fress.
 *
 * The catalog is curated by hand and grows by pull requests. This script
 * catches the mistakes hands make before users ever see them: duplicate
 * ids, dead or non-HTTPS links, commands that belong to a different
 * platform than the app claims, apps without icons or without
 * translations, and the same app listed twice.
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
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
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
    err(label, `githubUrl is not a repository root (expected https://github.com/owner/repo): ${app.githubUrl}`);
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
    // suspicious but not always wrong — flag it for a human look.
    warn(label, `single-platform app (${app.platforms[0]}) — double-check the other platforms really are unsupported`);
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
      }
    }
  }

  if (app.lastVerifiedAt !== undefined && !ISO_DATE_RE.test(app.lastVerifiedAt)) {
    err(label, `lastVerifiedAt must be YYYY-MM-DD, got: ${app.lastVerifiedAt}`);
  }

  // 3. Icon: every catalog entry ships its official artwork.
  const iconPath = APP_ICONS[app.id];
  if (!iconPath) {
    err(label, `no icon registered in appIcons.ts for id "${app.id}"`);
  } else if (!existsSync(resolve(ROOT, 'public', iconPath.replace(/^\//, '')))) {
    err(label, `icon file does not exist on disk: public${iconPath}`);
  }
}

// 4. Translation coverage: a catalog entry is not "done" until its
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
