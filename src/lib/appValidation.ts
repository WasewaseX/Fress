// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, BeginnerRating, Category, Platform } from '../types';
import { sanitizeInstallCommand } from './installCommands';

/**
 * Runtime validation for AppItem-shaped data that crosses a trust boundary:
 * imported backup files and anything already sitting in localStorage.
 *
 * The old import path checked only `name` and then spread EVERY other field
 * into the app object, so a hand-edited (or corrupted) backup could store
 * `platforms: null` or `tags: "not-an-array"` and later crash the rendering
 * and filtering paths (`app.platforms.includes`, `app.tags.some`).
 *
 * The sanitizer never trusts, never merges unknown fields, and always
 * returns a fully-typed AppItem or null. Storage/format rounding: strings
 * are capped, arrays are length-capped, invalid regexes in assetPatterns
 * are dropped (they would throw at resolve time otherwise).
 */

const PLATFORMS: Platform[] = ['windows', 'mac', 'linux', 'web', 'android', 'ios'];
const CATEGORIES: Category[] = [
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video',
];
const BEGINNER_RATINGS: BeginnerRating[] = [
  'Super Beginner Friendly',
  'Quick Learning Curve',
  'Advanced / Power User',
];
const ARCHITECTURES = ['x86_64', 'arm64', 'universal'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_TEXT = 4000;
const MAX_URL = 2000;
const MAX_TAGS = 24;
const MAX_TAG_LEN = 40;
const MAX_PATTERN_LEN = 200;

export interface SanitizedApp {
  app: AppItem | null;
  /** Package-manager commands that were present in the input but dropped
   * by the installer-command sanitizer (reported to the user on import). */
  strippedCommands: number;
}

/** A generated id for entries that arrive without one; uniqueness comes
 * from the timestamp plus a random suffix, not from trusting the file. */
function makeFallbackId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeAppItem(raw: unknown): SanitizedApp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { app: null, strippedCommands: 0 };
  }
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
  if (!name) return { app: null, strippedCommands: 0 };

  const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
  const urlOpt = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s || s.length > MAX_URL) return undefined;
    // Only http(s) links may come in from outside: javascript: or data: URLs
    // in a shared backup must not survive into clickable fields.
    return /^https?:\/\//i.test(s) ? s : undefined;
  };
  const bool = (v: unknown): boolean => v === true;

  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter(
        (p): p is Platform => typeof p === 'string' && (PLATFORMS as string[]).includes(p)
      ) as Platform[])
    : [];
  const tags = Array.isArray(r.tags)
    ? r.tags
        .filter((tg): tg is string => typeof tg === 'string' && tg.trim().length > 0)
        .map((tg) => tg.trim().slice(0, MAX_TAG_LEN))
        .slice(0, MAX_TAGS)
    : [];
  const category: Category = (CATEGORIES as string[]).includes(r.category as string)
    ? (r.category as Category)
    : 'Utilities & System';
  const stars =
    typeof r.stars === 'number' && Number.isFinite(r.stars) ? Math.max(0, Math.floor(r.stars)) : 0;
  const beginnerRating = (BEGINNER_RATINGS as string[]).includes(r.beginnerRating as string)
    ? (r.beginnerRating as BeginnerRating)
    : undefined;
  const architectures = Array.isArray(r.architectures)
    ? r.architectures.filter(
        (a): a is (typeof ARCHITECTURES)[number] =>
          typeof a === 'string' && (ARCHITECTURES as readonly string[]).includes(a)
      )
    : undefined;
  const addedAt =
    typeof r.addedAt === 'string' && DATE_RE.test(r.addedAt)
      ? r.addedAt
      : new Date().toISOString().slice(0, 10);
  const lastVerifiedAt =
    typeof r.lastVerifiedAt === 'string' && DATE_RE.test(r.lastVerifiedAt)
      ? r.lastVerifiedAt
      : undefined;

  // assetPatterns: per-platform regex strings. Anything that is not a
  // compilable, size-capped pattern is dropped - a broken regex must never
  // throw inside the resolve path later.
  let assetPatterns: Partial<Record<Platform, string>> | undefined;
  if (r.assetPatterns && typeof r.assetPatterns === 'object' && !Array.isArray(r.assetPatterns)) {
    const out: Partial<Record<Platform, string>> = {};
    for (const [k, v] of Object.entries(r.assetPatterns as Record<string, unknown>)) {
      if (!(PLATFORMS as string[]).includes(k)) continue;
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATTERN_LEN) continue;
      try {
        // eslint-disable-next-line no-new
        new RegExp(v, 'i');
        out[k as Platform] = v;
      } catch {
        // invalid pattern dropped; the validator flags authoring mistakes
      }
    }
    if (Object.keys(out).length > 0) assetPatterns = out;
  }

  // tagPatterns: per-platform release-tag regexes, validated exactly like
  // assetPatterns. A broken regex must never throw inside the resolve path.
  let tagPatterns: Partial<Record<Platform, string>> | undefined;
  if (r.tagPatterns && typeof r.tagPatterns === 'object' && !Array.isArray(r.tagPatterns)) {
    const out: Partial<Record<Platform, string>> = {};
    for (const [k, v] of Object.entries(r.tagPatterns as Record<string, unknown>)) {
      if (!(PLATFORMS as string[]).includes(k)) continue;
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATTERN_LEN) continue;
      try {
        // eslint-disable-next-line no-new
        new RegExp(v, 'i');
        out[k as Platform] = v;
      } catch {
        // invalid pattern dropped; the validator flags authoring mistakes
      }
    }
    if (Object.keys(out).length > 0) tagPatterns = out;
  }

  // Install commands get the same treatment as always: only plain
  // "<manager> install <package>" invocations survive.
  const cmdRaw = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const winget = sanitizeInstallCommand('winget', cmdRaw(r.wingetCommand));
  const brew = sanitizeInstallCommand('brew', cmdRaw(r.brewCommand));
  const flatpak = sanitizeInstallCommand('flatpak', cmdRaw(r.flatpakCommand));
  const scoop = sanitizeInstallCommand('scoop', cmdRaw(r.scoopCommand));
  const apt = sanitizeInstallCommand('apt', cmdRaw(r.aptCommand));
  const strippedCommands = [
    cmdRaw(r.wingetCommand),
    cmdRaw(r.brewCommand),
    cmdRaw(r.flatpakCommand),
    cmdRaw(r.scoopCommand),
    cmdRaw(r.aptCommand),
  ].filter((rawCmd, i) => rawCmd && [winget, brew, flatpak, scoop, apt][i] === null).length;

  const id =
    typeof r.id === 'string' && r.id.trim() && r.id.length <= 80 ? r.id.trim() : makeFallbackId();

  const app: AppItem = {
    id,
    name,
    tagline: text(r.tagline),
    description: text(r.description),
    whyItsAwesome: text(r.whyItsAwesome),
    beginnerGuide: text(r.beginnerGuide),
    githubUrl: urlOpt(r.githubUrl) ?? '',
    gitlabUrl: urlOpt(r.gitlabUrl),
    websiteUrl: urlOpt(r.websiteUrl) ?? '',
    downloadUrl: urlOpt(r.downloadUrl),
    category,
    platforms,
    license: text(r.license).slice(0, 80),
    stars,
    beginnerRating,
    isOwnerPick: bool(r.isOwnerPick),
    isTrendingToday: bool(r.isTrendingToday),
    tags,
    wingetCommand: winget ?? undefined,
    brewCommand: brew ?? undefined,
    flatpakCommand: flatpak ?? undefined,
    scoopCommand: scoop ?? undefined,
    aptCommand: apt ?? undefined,
    fdroidId:
      typeof r.fdroidId === 'string' && /^[A-Za-z0-9_.]+$/.test(r.fdroidId) && r.fdroidId.length <= 120
        ? r.fdroidId
        : undefined,
    playStoreId:
      typeof r.playStoreId === 'string' && /^[A-Za-z0-9_.]+$/.test(r.playStoreId) && r.playStoreId.length <= 120
        ? r.playStoreId
        : undefined,
    proprietaryAlternative: text(r.proprietaryAlternative).slice(0, 160) || undefined,
    isPortable: typeof r.isPortable === 'boolean' ? r.isPortable : undefined,
    architectures: architectures && architectures.length > 0 ? architectures : undefined,
    offlineReady: typeof r.offlineReady === 'boolean' ? r.offlineReady : undefined,
    lastVerifiedAt,
    assetPatterns,
    tagPatterns,
    includeFlaggedReleases: typeof r.includeFlaggedReleases === 'boolean' ? r.includeFlaggedReleases : undefined,
    addedAt,
    isCustom: r.isCustom === true ? true : undefined,
  };

  return { app, strippedCommands };
}
