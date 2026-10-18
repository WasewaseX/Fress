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
 *   - the per-tag asset fragment carries one `/releases/download/...`
 *     anchor per uploadable asset, plus a `sha256:<hex>` span and a human
 *     size label ("37.5 MB") next to each anchor - so the quota-free path
 *     answers what the REST API answered, sizes and digests included.
 *
 * TWO FRAGMENT URL SHAPES (both quota-free, both parsed identically):
 *   - NEW (verified live 2026-10-19):
 *     `https://github.com/<repo>/releases/expanded_assets/<tag>`;
 *   - OLD: `https://github.com/<repo>/releases/tag/<tag>/expanded_assets`.
 *     During GitHub's 2026-10 rollout the old URL began answering a page
 *     shell that lazy-loads the new document - the shell carries ZERO
 *     asset anchors, so a parser pinned to the old shape silently saw an
 *     asset-less release list, the resolver answered "no match", and the
 *     card fell through to opening the official page in the browser. The
 *     fetch tries the NEW shape first and falls back to the OLD shape
 *     only when the new answer parses to zero anchors (rollback safety).
 *
 * The desktop app reads these documents through the size-capped,
 * host-allowlisted, per-hop-checked `fetch_github_release_doc` command
 * (the native shape validator admits exactly releases.atom and both
 * fragment paths); in the browser plain fetch is attempted and simply
 * degrades (github.com does not answer CORS, so the browser keeps the
 * API-first behavior).
 *
 * TRUST MODEL: github.com is the naming authority here exactly as
 * api.github.com was - the tag comes from GitHub's own feed and the asset
 * names from GitHub's own release page. Parsing is deliberately bounded
 * (the fragment walk is bounded by the requested scan depth, tags pass a
 * conservative charset, documents are size-capped) and fails closed:
 * anything this module cannot parse confidently is skipped, and the
 * caller falls back to the ORIGINAL API error, never to a silent wrong
 * answer.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';
import { parseVersion } from './semver';
import { ReleaseInfo } from './types';

/** Browser-path cap for the two github.com document shapes. The documents
 * are CDN-served static files (verified: <1s live); 15s is generous while
 * keeping a hung connection from stalling a user click. */
const BROWSER_TEXT_TIMEOUT_MS = 15_000;

/** How far past an asset anchor the size/digest enrichment may look. The
 * fragment renders sha256 + size spans directly after each anchor; the
 * window always ends at the NEXT asset anchor, so one asset's metadata
 * can never bleed into the next. */
const ASSET_META_WINDOW = 4000;

/** How deep the fragment walk may reach, mirroring the API path's
 * recent-releases scan (multi-stream repos - desktop + mobile + server
 * tags from one repo: Obsidian, Tuta, Ente - need roughly a dozen entries
 * before the right stream appears; 20 covers every catalog repo there
 * with one API call, so the fallback must not stop shorter or a
 * compatible installer silently stops existing). Bounded, not unbounded:
 * the walk costs at most one small quota-free fragment per scanned
 * entry, exactly the bound the caller chose for the API path. */
export const ATOM_SCAN_DEPTH = 20;

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
    // Dedicated command, NOT fetch_text: github.com stays OFF the generic
    // resolver-manifest allowlist by pinned audit invariant; this class
    // admits exactly the two release-document shapes (releases.atom and
    // expanded_assets fragments) and refuses everything else on github.com.
    const r = await invoke<{ status: number; body: string; truncated: boolean }>(
      'fetch_github_release_doc',
      { url }
    );
    // A native build without this command (or an environment that resolves
    // the call to null) is an honest "document reader unavailable", not a
    // document: fail fast with a named error so the caller's API fallback
    // decides, instead of dying on a TypeError deep in the parser.
    if (!r || typeof (r as { status?: unknown }).status !== 'number') {
      throw new Error('Release-document reader unavailable');
    }
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
    signal: AbortSignal.timeout(BROWSER_TEXT_TIMEOUT_MS),
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

/** Unstable-stage gate over tag + title, mirroring the repo's own stage
 * vocabulary (v1.0.N-beta, rc, alpha, nightly, canary, ...). The atom
 * feed carries no prerelease flag, so the catalog's existing
 * includeFlaggedReleases opt-in gates these the same way the API path
 * does.
 *
 * A tag that parses as strict SemVer WITH a prerelease part is unstable
 * whatever the identifier says: `-next`, `-experimental` and every other
 * custom identifier is a prerelease by the spec's own grammar, and no
 * word list can enumerate that space - a miss here would serve a
 * prerelease to a stable channel. The word scan below then covers what
 * the strict grammar cannot see: non-SemVer tags ("nightly-2026.10") and
 * the release TITLE. Boundary-guarded so "prebuilt" is not read as a
 * prerelease; build metadata ("1.2.3+build.5") is not a prerelease. */
export function stageLooksUnstable(tag: string, title: string): boolean {
  const parsed = parseVersion(tag);
  if (parsed && parsed.prerelease.length > 0) return true;
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
  /** The digest GitHub's own release page renders for the uploaded asset
   * (`sha256:<hex>` span next to the anchor). Same trust class as the
   * download URL itself - the forge that hosts the file states its digest
   * - but BEST-EFFORT: an older/absent span leaves this undefined and the
   * artifact simply stays unverified, never falsely verified. */
  sha256?: string;
}

/** Parses a human size label ("37.5 MB", "950 kB", "1.2 GB") into bytes.
 * GitHub renders binary-ish decimal labels; the parser accepts the exact
 * unit vocabulary the fragment uses and nothing else. */
export function parseHumanSizeToBytes(label: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s?(B|[kKMGTP]i?B)$/.exec(label.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2];
  const mult =
    unit === 'B' ? 1 :
    /^[kK]i?B$/.test(unit) ? 1024 :
    /^[M]i?B$/.test(unit) ? 1024 ** 2 :
    /^[G]i?B$/.test(unit) ? 1024 ** 3 :
    1024 ** 4;
  const bytes = Math.round(value * mult);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/** Extract the release assets from an expanded_assets HTML fragment: the
 * anchors GitHub renders for every uploaded file, of the exact shape
 * /<repo>/releases/download/<tag>/<asset>. Anything else (badge images,
 * source-tree links, arbitrary hrefs) is ignored; a malformed percent
 * escape or a path-looking asset name is skipped, never decoded into a
 * surprise.
 *
 * Enrichment (best-effort, fail-open to size 0 / no digest): the fragment
 * renders `sha256:<hex>` and a human size label shortly after each asset
 * anchor. Each anchor's metadata window is bounded by the NEXT anchor, so
 * digests and sizes can never cross-attach between assets, and a span
 * that fails to parse is silently skipped. */
export function parseExpandedAssets(body: string, repo: string): AtomAsset[] {
  const assets: AtomAsset[] = [];
  const hrefRe = new RegExp(`href="(/${repo}/releases/download/[^"]+)"`, 'g');
  const prefix = `/${repo}/releases/download/`;
  const matches = [...body.matchAll(hrefRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
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
    // Metadata window: from the end of THIS anchor to the start of the
    // NEXT asset anchor (the windows tile the fragment; nothing bleeds).
    const windowEnd = i + 1 < matches.length ? matches[i + 1].index! : Math.min(body.length, (m.index ?? 0) + m[0].length + ASSET_META_WINDOW);
    const window = body.slice((m.index ?? 0) + m[0].length, windowEnd);
    const sha = /sha256:\s*([0-9a-fA-F]{64})/.exec(window)?.[1]?.toLowerCase();
    const sizeText = /([0-9]+(?:\.[0-9]+)?)\s?(B|[kKMGTP]i?B)\b/.exec(window);
    const size = sizeText ? parseHumanSizeToBytes(sizeText[0]) : null;
    assets.push({
      name,
      size: size ?? 0,
      downloadUrl: `https://github.com${href}`,
      ...(sha ? { sha256: sha } : {}),
    });
  }
  return assets;
}

/** Reads the asset fragment for one tag, trying BOTH URL shapes. The NEW
 * shape (`/releases/expanded_assets/<tag>`) is what GitHub's release page
 * lazy-loads since the 2026-10 rollout; the OLD shape
 * (`/releases/tag/<tag>/expanded_assets`) is kept as the rollback path.
 * A shape whose answer parses to zero anchors is treated as "not the real
 * fragment" (the old URL answered a page shell with no anchors during the
 * rollout) rather than as an asset-less release - the other shape gets
 * its chance before the entry is recorded asset-less. */
async function fetchAssetsForTag(repo: string, tag: string): Promise<AtomAsset[]> {
  const safeTag = encodeURIComponent(tag);
  const urls = [
    `https://github.com/${repo}/releases/expanded_assets/${safeTag}`,
    `https://github.com/${repo}/releases/tag/${safeTag}/expanded_assets`,
  ];
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const { body } = await fetchGithubText(url);
      const assets = parseExpandedAssets(body, repo);
      if (assets.length > 0) return assets;
      // Zero anchors: not a usable fragment. Try the next shape; if none
      // yields anchors the release genuinely has no uploadable assets.
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

/** Options for the fragment walk. */
export interface AtomScanOptions {
  /** Stop the walk as soon as this many entries carry real assets - the
   * latest-release lookup reads only the first one, so it has no reason
   * to fetch the fragments behind it. Absent: walk every entry in the
   * requested slice (the recent scan needs each entry's real assets to
   * pick from). */
  stopAfterAssetBearing?: number;
}

/** The atom-feed mirror of getRecentReleases: newest-first stable entries
 * (unstable stages filtered out unless the catalog entry vouches for
 * flagged releases), each carrying its real asset list - one fragment
 * per entry across the whole requested slice, so a compatible installer
 * is found wherever the API path would have found it. The walk stays
 * bounded by the caller's count, exactly as the API path is bounded by
 * its per_page. Throws when the feed itself is unreachable or
 * unparseable - the caller keeps the ORIGINAL API error in that case, so
 * the UI's failure classification never changes. */
export async function getReleasesViaAtom(
  repo: string,
  count: number,
  includeFlagged: boolean,
  opts: AtomScanOptions = {}
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
  const out: ReleaseInfo[] = [];
  let assetBearing = 0;
  for (const entry of usable) {
    // One fragment per tag; a missing/empty fragment (or a hiccup) is
    // not fatal - the entry simply has no fallback assets to pick from.
    let assets: AtomAsset[] = [];
    try {
      assets = await fetchAssetsForTag(slug, entry.tag);
    } catch {
      assets = [];
    }
    out.push({
      tag: entry.tag,
      name: entry.title || entry.tag,
      publishedAt: entry.updated,
      htmlUrl: entry.htmlUrl,
      assets,
    });
    if (assets.length > 0) {
      assetBearing += 1;
      if (opts.stopAfterAssetBearing !== undefined && assetBearing >= opts.stopAfterAssetBearing) {
        break;
      }
    }
  }
  return out;
}

/** The atom-feed mirror of getLatestRelease: the newest stable entry that
 * actually carries assets, or null when none of the examined entries
 * does. The search reaches as deep as the recent scan - a repo whose
 * newest handful of entries are other-stream or asset-less releases must
 * not dead-end the lookup - while stopping at the first entry that has
 * assets, the only one this lookup reads. Never throws for "no stable
 * release with assets" - null is the honest answer and the caller falls
 * back to its original API error. */
export async function getLatestViaAtom(
  repo: string,
  includeFlagged: boolean
): Promise<ReleaseInfo | null> {
  const list = await getReleasesViaAtom(repo, ATOM_SCAN_DEPTH, includeFlagged, {
    stopAfterAssetBearing: 1,
  });
  for (const rel of list) {
    if (rel.assets.length > 0) return rel;
  }
  return null;
}
