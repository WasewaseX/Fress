// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Rate-limit-proof GitHub release lookup: the releases.atom feed + the
 * per-tag expanded_assets fragments, read from plain github.com.
 *
 * WHY THIS EXISTS: api.github.com hands out 60 unauthenticated requests per
 * hour per IP, shared with the live-star refresh. When that quota is
 * exhausted, every catalog download used to die with "No download was
 * started: the download sources could not be reached" - the resolver's
 * failure record classified the lookup as unreachable even though the
 * project's actual release documents were perfectly available. GitHub's
 * own web documents do not carry that quota:
 *
 *   - `https://github.com/<repo>/releases.atom` lists the recent releases
 *     (tag, title, updated timestamp) as a small XML document;
 *   - `https://github.com/<repo>/releases/tag/<tag>/expanded_assets` is the
 *     HTML fragment the releases page lazy-loads, and it contains one
 *     `/releases/download/...` anchor per uploadable asset.
 *
 * Together they answer exactly what the REST API answered, without the
 * quota. The desktop app reads them through the existing size-capped,
 * host-allowlisted, per-hop-checked `fetch_text` command (github.com was
 * added to the resolver allowlist for exactly these two document shapes);
 * in the browser plain fetch is attempted and simply degrades (github.com
 * does not answer CORS, so the browser keeps today's behavior).
 *
 * TRUST MODEL: github.com is the naming authority here exactly as
 * api.github.com was - the tag comes from GitHub's own feed and the asset
 * names from GitHub's own release page. Parsing is deliberately bounded
 * (fixed budget of asset-fragment fetches, conservative tag charset,
 * size-capped documents) and fails closed: anything this module cannot
 * parse confidently is skipped, and the caller falls back to the ORIGINAL
 * API error, never to a silent wrong answer.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';
import { ReleaseInfo } from './types';

/** Cap mirroring the official resolvers' transport budget. */
const TEXT_TIMEOUT_MS = 25_000;

/** Asset-fragment fetches per fallback run. The right stream for a
 * multi-product repo is virtually always inside the newest handful of
 * releases; bounding this keeps a rate-limited session from trading the
 * API quota for an unbounded fragment walk. */
export const ATOM_ASSET_FETCH_BUDGET = 5;

interface TextFetchResult {
  body: string;
}

/** Same transport contract as officialResolvers.fetchTextOnce: native
 * size-capped read in the desktop app (github.com does not answer CORS,
 * so the WebView cannot read these documents directly), plain fetch in
 * the browser (where a CORS refusal is an honest failure the caller
 * already knows how to handle). */
async function fetchGithubText(url: string): Promise<TextFetchResult> {
  if (isTauri()) {
    const r = await invoke<{ status: number; body: string; truncated: boolean }>('fetch_text', { url });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    // A body cut at the native cap is NOT a feed or a fragment: the newest
    // entries could be missing, silently resolving an OLD release. Refuse
    // with a named error instead of parsing a partial document.
    if (r.truncated) throw new Error('Response truncated');
    return { body: r.body };
  }
  const resp = await fetch(url, {
    headers: { Accept: 'application/atom+xml, text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { body: await resp.text() };
}

/** Repo slugs this module will build URLs from. Same charset GitHub
 * itself uses for owner/repository paths; anything else is refused
 * before a request is made. */
export function isSafeRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo.trim());
}

/** Tags accepted as release identifiers. Conservative allowlist (letters,
 * digits, dot, underscore, plus, tilde, space, hyphen): a feed entry whose
 * tag carries anything else is skipped rather than turned into a URL. */
function isSafeTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 120 && /^[A-Za-z0-9._+~ -]+$/.test(tag);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Unstable-stage heuristic over tag + title, mirroring the repo's own
 * stage vocabulary (v1.0.N-beta, rc, alpha, nightly, canary, ...). The
 * atom feed carries no prerelease flag, so the catalog's existing
 * includeFlaggedReleases opt-in gates these the same way the API path
 * does. Boundary-guarded so "prebuilt" is not read as a prerelease. */
export function stageLooksUnstable(tag: string, title: string): boolean {
  const hay = `${tag} ${title}`;
  return /(?:^|[^a-z0-9])(?:alpha|beta|rc|nightly|canary|snapshot|unstable|dev|preview|prerelease|pre-release|beta-release)(?:[^a-z0-9]|$)/i.test(
    hay
  );
}

interface AtomEntry {
  tag: string;
  title: string;
  updated: string;
  htmlUrl: string;
}

/** Parse the GitHub releases atom feed into release entries. The tag is
 * taken from the entry's alternate LINK (the canonical release URL) and
 * must belong to THIS exact repo; entries without such a link (or with an
 * unsafe tag) are skipped, never guessed. */
export function parseAtomFeed(body: string, repo: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const blocks = body.split(/<entry[\s>]/i).slice(1);
  for (const block of blocks) {
    let tag = '';
    for (const linkTag of block.match(/<link\b[^>]*>/gi) ?? []) {
      if (!/rel="alternate"/i.test(linkTag)) continue;
      const href = /href="([^"]+)"/i.exec(linkTag)?.[1] ?? '';
      const prefix = `https://github.com/${repo}/releases/tag/`;
      if (href.startsWith(prefix)) {
        try {
          tag = decodeURIComponent(href.slice(prefix.length).replace(/\/$/, ''));
        } catch {
          tag = '';
        }
        break;
      }
    }
    if (!tag) {
      // No alternate link for this repo: the entry cannot be attributed
      // safely (GitHub's tag: URN carries a numeric repository id, not
      // the slug, so it proves nothing about WHICH repo the release
      // belongs to). Skip rather than guess - the feed link is the only
      // trustworthy tag source here.
      continue;
    }
    if (!isSafeTag(tag)) continue;
    const title = decodeEntities(/<title[^>]*>\s*([\s\S]*?)\s*<\/title>/i.exec(block)?.[1] ?? '');
    const updated = /<updated>\s*([^<]+?)\s*<\/updated>/i.exec(block)?.[1] ?? '';
    entries.push({
      tag,
      title: title || tag,
      updated,
      htmlUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    });
  }
  return entries;
}

export interface AtomAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

/** Extract the release assets from an expanded_assets HTML fragment: the
 * anchors GitHub renders for every uploaded file, of the exact shape
 * /<repo>/releases/download/<tag>/<asset>. Anything else (badge images,
 * source-tree links, arbitrary hrefs) is ignored; a malformed percent
 * escape or a path-looking asset name is skipped, never decoded into a
 * surprise. */
export function parseExpandedAssets(body: string, repo: string): AtomAsset[] {
  const assets: AtomAsset[] = [];
  const hrefRe = new RegExp(`href="(/${repo}/releases/download/[^"]+)"`, 'g');
  const prefix = `/${repo}/releases/download/`;
  for (const m of body.matchAll(hrefRe)) {
    const href = m[1];
    // Exactly TWO segments after the prefix - the tag and the flat asset
    // file name. A nested path is not an asset name; refuse it rather
    // than decoding a surprise.
    const rest = href.slice(prefix.length);
    const parts = rest.split('/');
    if (parts.length !== 2) continue;
    let name = '';
    try {
      name = decodeURIComponent(parts[1]);
    } catch {
      continue;
    }
    if (!name || name === '.' || name === '..') continue;
    assets.push({ name, size: 0, downloadUrl: `https://github.com${href}` });
  }
  return assets;
}

async function fetchAssetsForTag(repo: string, tag: string): Promise<AtomAsset[]> {
  const url = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}/expanded_assets`;
  const { body } = await fetchGithubText(url);
  return parseExpandedAssets(body, repo);
}

/** The atom-feed mirror of getRecentReleases: newest-first stable entries
 * (unstable stages filtered out unless the catalog entry vouches for
 * flagged releases), each of the first ATOM_ASSET_FETCH_BUDGET entries
 * carrying its real asset list. Throws when the feed itself is
 * unreachable or unparseable - the caller keeps the ORIGINAL API error in
 * that case, so the UI's failure classification never changes. */
export async function getReleasesViaAtom(
  repo: string,
  count: number,
  includeFlagged: boolean
): Promise<ReleaseInfo[]> {
  const slug = repo.trim();
  if (!isSafeRepoSlug(slug)) throw new Error('Unsafe repository slug for the atom fallback');
  const { body } = await fetchGithubText(`https://github.com/${slug}/releases.atom`);
  const entries = parseAtomFeed(body, slug);
  if (entries.length === 0) throw new Error('Atom feed carried no usable release entries');
  const usable = (includeFlagged ? entries : entries.filter((e) => !stageLooksUnstable(e.tag, e.title))).slice(
    0,
    Math.max(1, count)
  );
  let budget = ATOM_ASSET_FETCH_BUDGET;
  const out: ReleaseInfo[] = [];
  for (const entry of usable) {
    let assets: AtomAsset[] = [];
    if (budget > 0) {
      budget -= 1;
      // One fragment per tag; a missing/empty fragment (or a hiccup) is
      // not fatal - the entry simply has no fallback assets to pick from.
      try {
        assets = await fetchAssetsForTag(slug, entry.tag);
      } catch {
        assets = [];
      }
    }
    out.push({
      tag: entry.tag,
      name: entry.title || entry.tag,
      publishedAt: entry.updated,
      htmlUrl: entry.htmlUrl,
      assets,
    });
  }
  return out;
}

/** The atom-feed mirror of getLatestRelease: the newest stable entry that
 * actually carries assets, or null when none of the examined entries
 * does. Never throws for "no stable release with assets" - null is the
 * honest answer and the caller falls back to its original API error. */
export async function getLatestViaAtom(repo: string, includeFlagged: boolean): Promise<ReleaseInfo | null> {
  const list = await getReleasesViaAtom(repo, ATOM_ASSET_FETCH_BUDGET, includeFlagged);
  for (const rel of list) {
    if (rel.assets.length > 0) return rel;
  }
  return null;
}
