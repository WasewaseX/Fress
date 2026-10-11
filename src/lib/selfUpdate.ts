// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Self-update for Fress itself.
 *
 * Checks the WasewaseX/Fress releases on GitHub, compares the running version
 * with the newest published release (prereleases included, drafts excluded),
 * and if there is something newer, hands the platform-matched file to the
 * download manager.
 *
 * The plain /releases/latest endpoint is useless here because Fress marks its
 * pre-stable builds as prereleases; /releases?per_page=10 returns those.
 *
 * The check MUST NOT surface errors to users: the REST API shares a small
 * unauthenticated quota per IP, so it legitimately fails sometimes. When the
 * API is unavailable we fall back to the releases.atom feed, which is served
 * as a static file by github.com and is not rate limited. Only when BOTH
 * sources fail does the check report an error, and the app shows a quiet
 * note instead of a scary red toast.
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauri } from './downloads';
import { androidAssetAbi, androidAssetFlags, androidDeviceAbi, getHostArch } from './releaseFetch';

const REPO = 'WasewaseX/Fress';

/**
 * Reads a small text document from the Fress release feed (releases.atom,
 * SHA256SUMS.txt).
 *
 * Inside the Tauri app this goes through the native `fetch_self_update_text`
 * command: github.com and its release-asset CDN send no CORS headers, so a
 * WebView fetch of these documents fails in EVERY runtime - the old WebView
 * fetch made the checksum step and the atom fallback dead code while looking
 * alive. The native command enforces the same rails as the rest of the
 * native layer (HTTPS, GitHub-host allowlist, per-hop re-check, repo path
 * pin, 2 MiB cap). In a plain browser tab there is no native bridge; the
 * plain fetch stays as the best-effort fallback and its CORS failure
 * degrades to null exactly as before.
 */
async function fetchSelfUpdateText(url: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const r = await invoke<{ status: number; body: string; truncated: boolean }>(
        'fetch_self_update_text',
        { url }
      );
      if (r.status >= 400 || r.truncated) return null;
      return r.body;
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export interface OwnRelease {
  tag: string;
  version: string; // tag without the leading "v"
  publishedAt: string;
  htmlUrl: string;
  assets: Array<{ name: string; size: number; url: string }>;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null }
  | { kind: 'error' };

/** How rough a build the user wants to hear about. */
export type UpdateChannel = 'stable' | 'beta' | 'alpha';

export const UPDATE_CHANNELS: Array<{ id: UpdateChannel; label: string }> = [
  { id: 'stable', label: 'Stable' },
  { id: 'beta', label: 'Beta' },
  { id: 'alpha', label: 'Alpha' },
];

/**
 * Pre-stable Fress treats every published build as news, so the default is
 * the widest channel. When a stable 1.0 lands this flips to 'stable' and
 * normal users stop being offered prerelease builds.
 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'alpha';

const CHANNEL_KEY = 'fress.updateChannel';

export function getUpdateChannel(): UpdateChannel {
  try {
    const v = localStorage.getItem(CHANNEL_KEY);
    if (v === 'stable' || v === 'beta' || v === 'alpha') return v;
  } catch {
    // ignore
  }
  return DEFAULT_UPDATE_CHANNEL;
}

export function setUpdateChannel(channel: UpdateChannel): void {
  try {
    localStorage.setItem(CHANNEL_KEY, channel);
  } catch {
    // ignore
  }
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  prerelease: string[];
  /** Dot-separated build-metadata identifiers; empty when absent. Build
   * metadata NEVER takes part in precedence comparisons (SemVer rule 10). */
  build: string[];
}

/**
 * The exact SemVer subset Fress accepts, anchored on BOTH ends.
 *
 * This is the official semver.org grammar with one documented project
 * addition: an optional leading "v" is stripped before matching (GitHub
 * release tags use both conventions).
 *
 * Why the end anchor matters: the previous pattern was anchored at the
 * start only, so "1.0.7junk" matched the "1.0.7" prefix and entered the
 * candidate list as a 1.0.7 stable release. Trailing junk is now a
 * rejection, not a truncation.
 *
 * - Core numbers: "0" or a nonzero leading digit followed by digits, so
 *   "01.2.3" is malformed (SemVer forbids leading zeros in the core).
 * - Prerelease identifiers: numeric identifiers follow the same no-leading-
 *   zero rule ("beta.02" is malformed) while ALPHANUMERIC identifiers may
 *   start with a digit ("beta.02a" is valid, per the SemVer spec). Empty
 *   identifiers and empty segments ("1.0.7-beta..2", "1.0.7-") cannot match.
 * - Build metadata: alphanumerics and hyphens, no empty segments; leading
 *   zeros are allowed there because build metadata is informational.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Strip the optional, case-insensitive leading "v" the same way everywhere
 * (parsing, comparing, display) so "v1.0.7" and "1.0.7" are one version. */
function stripVPrefix(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/** Strict release-tag parser. Returns null for ANYTHING that is not exactly
 * the accepted SemVer subset above - an unparsable tag must never be
 * interpreted as "some kind of 1.0.7" or treated as stable. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = stripVPrefix(v).match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

function comparePrereleaseIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const va = Number(a);
    const vb = Number(b);
    return va < vb ? -1 : va > vb ? 1 : 0;
  }
  if (na) return -1; // numeric identifiers rank below alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // SemVer: a version WITHOUT prerelease outranks every prerelease of the
  // same major.minor.patch, so 1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-alpha.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = comparePrereleaseIds(a[i], b[i]);
    if (c !== 0) return c;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * -1 older, 0 equal, 1 newer. Full SemVer prerelease ordering; build
 * metadata is ignored (SemVer rule 10: "1.0.7+build.9" == "1.0.7").
 *
 * The fallback for unparsable input is a TOTAL order, not the old one-sided
 * "-1": the previous shape returned -1 in BOTH directions when exactly one
 * side parsed, which is antisymmetry-breaking and made sort results depend
 * on input order. Now a parsable SemVer always outranks garbage, and two
 * garbage tags compare by their normalized strings - deterministic and
 * consistent whichever way the arguments are swapped. Release feeds are
 * filtered to parsable tags before sorting anyway (see fetchFromApi /
 * fetchFromAtom), so this branch is a defensive contract for direct calls.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return comparePrerelease(pa.prerelease, pb.prerelease);
  }
  if (pa && !pb) return 1;
  if (!pa && pb) return -1;
  const na = stripVPrefix(a);
  const nb = stripVPrefix(b);
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/**
 * How rough a version is: 0 stable, 1 beta/rc, 2 alpha/dev/anything else.
 * Used for channel filtering, not for ordering (ordering is SemVer).
 */
function prereleaseStage(v: ParsedVersion): number {
  if (v.prerelease.length === 0) return 0;
  const first = v.prerelease[0].toLowerCase();
  if (first.includes('rc')) return 1;
  if (first.startsWith('beta') || first.startsWith('b')) return 1;
  return 2;
}

/** Which versions the channel surfaces. Stable sees only stable releases;
 * Beta adds beta/rc; Alpha (the pre-stable default) sees everything.
 *
 * An UNPARSABLE tag matches NO channel: the previous "stay visible" shape
 * made a malformed tag ("1.0.7junk", "beta-build") eligible on every
 * channel including Stable, which is a policy-boundary hole - the channel
 * gate is exactly where malformed tags must be rejected, not waved through.
 * fetchFromApi/fetchFromAtom additionally drop unparsable tags before
 * sorting, so a malformed release can never become an update candidate. */
export function releaseMatchesChannel(version: string, channel: UpdateChannel): boolean {
  const p = parseVersion(version);
  if (!p) return false; // malformed tags are never eligible, on any channel
  const stage = prereleaseStage(p);
  switch (channel) {
    case 'stable':
      return stage === 0;
    case 'beta':
      return stage <= 1;
    case 'alpha':
      return true;
  }
}

interface RawRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

function mapRelease(r: RawRelease): OwnRelease {
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/i, ''),
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
  };
}

function isJunkAsset(name: string): boolean {
  return /\.sig$|blockmap|checksum|sha256|latest\.json|symbols|\.zip$/i.test(name);
}

/* ------------------------------------------------------------------ */
/* Architecture marker regexes (Windows / macOS / Linux assets)        */
/* ------------------------------------------------------------------ */
/* Kept classification-compatible with the catalog resolver's hard gate
 * (release/assetMatching.ts): hyphenated markers ("arm-64", "x86-64")
 * classify the same as their underscore siblings. Android deliberately
 * does NOT use these - it shares androidAssetFlags/androidDeviceAbi with
 * the catalog instead, so the two pickers cannot drift apart. */

const WIN_ARM_ASSET_RE = /arm64|aarch64|arm[_-]?64/;
const WIN_X64_ASSET_RE = /x64|x86[_-]?64|amd64|win64/;
const MAC_ARM_ASSET_RE = /arm64|aarch64|arm[_-]?64|apple[-_. ]?silicon/;
const MAC_X64_ASSET_RE = /x64|x86_64|intel/;
const MAC_UNIVERSAL_RE = /universal/;
const LINUX_ARM_ASSET_RE = /arm64|aarch64|(^|[^a-z0-9])arm([^a-z0-9]|$)/;
const LINUX_X64_ASSET_RE = /x86[_-]?64|x64|amd64/;

/** Command-line companions never name the GUI app. Same token rule as the
 * catalog's CLI gate: a "-cli-" / "_cli." / trailing "cli" token excludes
 * the asset ("client"/"click" do not match - the token must end at a
 * separator or the string end). LocalSend-style repos ship
 * "<App>-CLI-<v>-windows-arm-64.exe" next to the GUI installer; a CLI
 * binary must never become the app installer candidate, no matter how
 * well its name scores otherwise. */
const CLI_NAME_RE = /(^|[^a-z0-9])cli([-_.0-9]|$)/i;

/**
 * Pick the file a user on this platform actually needs - in TWO explicit
 * phases:
 *
 *   Phase 1 - ELIGIBILITY. Hard platform/architecture/role gates decide
 *   what MAY be delivered at all. An asset that fails its gate is excluded,
 *   not down-ranked: "the only candidate" must never rescue an incompatible
 *   installer. The old single-pass scoring kept ineligible assets alive at
 *   low or negative scores, and because the scan started at -Infinity a
 *   lone ARM64-only dmg could win on an Intel Mac.
 *
 *   Phase 2 - RANKING among eligible candidates only. Rank is
 *   architecture-certainty first (exact match > universal > unmarked >
 *   emulated), packaging preference second (setup > portable, dmg > pkg,
 *   AppImage > deb > rpm), with a final lexicographic name tie-break so
 *   asset ORDER in the release can never change the selection.
 *
 * `archHint` semantics - what the reported architecture IS:
 *   - Windows: the native MACHINE architecture (GetNativeSystemInfo), even
 *     when the Fress process itself is an emulated x64 build.
 *   - macOS/Linux/Android: the Fress PROCESS architecture
 *     (std::env::consts::ARCH). Under Rosetta an x64 Fress build reports
 *     "x86_64" - the policy below therefore hands that process the x64 dmg
 *     (it keeps updating as an x64 app under Rosetta; switching to the
 *     arm64-native build needs one manual install from the releases page).
 *     This is a deliberate, tested policy - never the WebView user agent,
 *     which macOS WebKit reports as "Intel" even on Apple Silicon.
 *   - undefined: unknown (browser mode; modern user agents hide the CPU
 *     arch). Unknown never selects a marked artifact on a GUESS - each
 *     platform's unknown policy below is explicit.
 *
 * Returns null when nothing eligible exists; the UI then routes the user
 * to the official Releases page instead of offering a wrong installer.
 */
export function pickOwnAsset(
  release: OwnRelease,
  archHint?: string
): { name: string; size: number; url: string } | null {
  const assets = (release.assets || []).filter((a) => !isJunkAsset(a.name));
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const platform =
    ua.includes('android') ? 'android' :
    ua.includes('mac os') || ua.includes('macintosh') ? 'mac' :
    ua.includes('linux') ? 'linux' : 'windows';
  // A positive ARM signal from the user agent is usable in browser mode;
  // the ABSENCE of one is not an Intel signal (UA reduction hides arch),
  // so no-Arm-UA means "unknown", never "x64".
  const isArmHost = archHint ? archHint === 'aarch64' || archHint === 'arm' : /arm|aarch/i.test(ua);

  /* Phase 1 + 2 helper: null = ineligible, otherwise the candidate's rank.
   * Rank layout: tier * 100 + packaging bonus. Tiers encode architecture
   * certainty (higher = more certain the artifact runs natively), the
   * packaging bonus only breaks ties WITHIN a tier. */
  const rankOf = (n: string): number | null => {
    const s = n.toLowerCase();
    switch (platform) {
      case 'windows': {
        // Setup installers AND portable exes go through the same gates -
        // "setup" is a packaging bonus (below), never an eligibility bypass.
        if (!s.endsWith('.exe')) return null;
        const armAsset = WIN_ARM_ASSET_RE.test(s);
        const x64Asset = WIN_X64_ASSET_RE.test(s);
        const hostIs32 = archHint === 'x86' || archHint === 'i686';
        let tier: number;
        if (archHint === 'aarch64') {
          // Windows-on-ARM. Project policy (documented in the test suite):
          // x64 installers/ executables RUN on ARM64 Windows through the
          // OS emulation layer, so they stay eligible - but a native ARM64
          // build always outranks an emulated x64 one, and emulation is a
          // tier-2 fallback, never the first choice.
          tier = armAsset ? 3 : x64Asset ? 2 : 1;
        } else if (archHint === 'x86_64') {
          // Native x64 Windows cannot run ARM64 binaries (WoA emulates
          // x64/x86, not the reverse): an ARM64-marked exe is INELIGIBLE
          // here, even when it is the only asset in the release. A name
          // ending in .exe alone proves nothing - only a positive x64
          // marker makes an artifact certain, and an unmarked exe stays a
          // documented last resort (Fress CI always marks the arch).
          if (armAsset) return null;
          tier = x64Asset ? 3 : 1;
        } else if (hostIs32) {
          // A 32-bit host runs neither arm64 nor x64 builds; only an
          // unmarked exe remains as the last resort.
          if (armAsset || x64Asset) return null;
          tier = 1;
        } else {
          // Unknown host (browser mode, reduced UA). x64 is the safe
          // superset on Windows - it runs natively on x64 machines and via
          // emulation on ARM64 - so a marked x64 exe is deliverable.
          // An ARM64-marked exe needs a POSITIVE aarch64 signal: on the
          // far more common x64 host it cannot run at all.
          if (armAsset) return null;
          tier = x64Asset ? 3 : 1;
        }
        return tier * 100 + (s.includes('setup') ? 5 : 0);
      }
      case 'android': {
        if (!s.endsWith('.apk')) return null;
        const flags = androidAssetFlags(s);
        const device = androidDeviceAbi(archHint);
        // Universal is release-required (CI fails without it) and runs on
        // every device, so it is eligible even when the device ABI is
        // unknown - the safe floor for reduced-UA browser sessions.
        if (flags.universal) return 300;
        // Browser mode usually cannot know the device ABI (reduced user
        // agents carry no architecture). An unknown device gets universal
        // ONLY - never an ABI-specific split it cannot install, and never
        // an unmarked apk either: "no ABI marker" is exactly the unknown
        // we are trying to resolve. With no universal on the release,
        // pickOwnAsset returns null and the UI links to the releases page
        // instead of downloading a guess.
        if (device === 'unknown') return null;
        const abi = androidAssetAbi(s);
        if (!abi) return 100; // unmarked apk: a documented gamble BELOW universal
        if (abi === device) return 400; // exact ABI match: smaller than universal
        // Documented cross-ABI compatibility: armv7 apks run on arm64
        // devices and 32-bit x86 apks run on x86_64 devices. Everything
        // else is a guaranteed install failure and is REJECTED - a
        // known-incompatible ABI must never survive as a low-ranked
        // candidate that wins by being alone.
        const compatible = (device === 'arm64' && abi === 'arm') || (device === 'x86_64' && abi === 'x86');
        return compatible ? 200 : null;
      }
      case 'mac': {
        // .pkg and .dmg are both legitimate installer formats; dmg stays
        // the friendlier default (packaging bonus 4 vs 1) so a pkg-only
        // release still offers a direct download instead of nothing.
        const isDmg = s.endsWith('.dmg');
        if (!isDmg && !s.endsWith('.pkg')) return null;
        const armAsset = MAC_ARM_ASSET_RE.test(s);
        const x64Asset = MAC_X64_ASSET_RE.test(s);
        const universal = MAC_UNIVERSAL_RE.test(s);
        // archHint is the Fress PROCESS architecture here (see the
        // function doc): an arm64-native build gets arm64/universal
        // artifacts, an x64 build (Intel Mac, or Fress running under
        // Rosetta on Apple Silicon) gets x64/universal artifacts. The
        // opposite arch's marked artifact is INELIGIBLE in both
        // directions - notably an x64-only dmg is never handed to an
        // arm64 process "because Rosetta exists": self-update never moves
        // a native install onto the emulated side of the fence.
        // Universal binaries run natively on both architectures.
        // With NO arch signal (browser mode) nothing marked is eligible:
        // the WebView user agent is exactly the unreliable "Intel" claim
        // this picker exists to avoid, so unknown gets universal and
        // unmarked artifacts only.
        let tier: number | null;
        if (isArmHost) {
          tier = armAsset ? 3 : universal ? 2 : x64Asset ? null : 1;
        } else if (archHint === 'x86_64') {
          tier = x64Asset ? 3 : universal ? 2 : armAsset ? null : 1;
        } else {
          // Unknown process arch (browser mode).
          tier = universal ? 2 : armAsset || x64Asset ? null : 1;
        }
        if (tier === null) return null;
        return tier * 100 + (isDmg ? 4 : 1);
      }
      case 'linux': {
        const fmt = s.endsWith('.appimage') ? 10 : s.endsWith('.deb') ? 7 : s.endsWith('.rpm') ? 5 : 0;
        if (fmt === 0) return null; // not an installer format this updater delivers
        const armAsset = LINUX_ARM_ASSET_RE.test(s);
        const x64Asset = LINUX_X64_ASSET_RE.test(s);
        const archLc = (archHint || '').toLowerCase();
        const hostIsArm = archLc === 'aarch64' || archLc === 'arm';
        const hostIs32 = archLc === 'x86' || archLc === 'i686';
        // Linux has no emulation safety net (unlike Windows-on-ARM): the
        // strict ARM/x64 incompatibility gates are preserved exactly. An
        // unmarked asset is treated as compatible ONLY where the
        // documented fallback policy supports the assumption (an
        // assumed-x86_64 desktop host); on ARM or 32-bit hosts the
        // assumption collapses and unmarked is rejected too.
        if (hostIsArm) return armAsset ? 200 + fmt : null;
        if (hostIs32) return !armAsset && !x64Asset ? 100 + fmt : null;
        if (x64Asset) return 200 + fmt;
        if (armAsset) return null;
        return 100 + fmt; // untagged: the documented assumed-x86_64 fallback, below a marked match
      }
      default:
        return null;
    }
  };

  // Phase 1: eligibility - drop every asset that failed its hard gate.
  const candidates = assets
    .filter((a) => !CLI_NAME_RE.test(a.name))
    .map((a) => ({ asset: a, rank: rankOf(a.name) }))
    .filter((c): c is { asset: { name: string; size: number; url: string }; rank: number } => c.rank !== null);

  // No eligible candidate: the caller (and the UI) must fall back to the
  // official Releases page instead of offering a wrong installer.
  if (candidates.length === 0) return null;

  // Phase 2: deterministic ranking. Descending rank, then ascending asset
  // name as the final tie-break - permuting the assets array can never
  // change which artifact is selected, even between candidates that rank
  // identically.
  candidates.sort(
    (a, b) =>
      b.rank - a.rank ||
      (a.asset.name < b.asset.name ? -1 : a.asset.name > b.asset.name ? 1 : 0)
  );
  return candidates[0].asset;
}

/** Newest published release (drafts dropped, channel-filtered, SemVer order).
 * per_page=20 mirrors the catalog's recent-scan depth: per_page=10 used to
 * be enough, but the release history grows and the newest matching release
 * must never scroll out of the window. */
async function fetchFromApi(channel: UpdateChannel): Promise<OwnRelease> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const raw = (await res.json()) as RawRelease[];
  const published = (raw || []).filter((r) => {
    if (r.draft) return false;
    // Malformed release tags NEVER enter the candidate list: a tag that
    // does not parse as the accepted SemVer subset ("1.0.7junk", a
    // date-stamped tag, "beta-build") is excluded before sorting, so it
    // can neither win the sort nor be displayed as an eligible update.
    if (!parseVersion(r.tag_name)) return false;
    // The tag is not the only stability signal - GitHub's own prerelease
    // flag is. A manually published release with a stable-looking tag
    // ("v1.0.7") but prerelease=true must never surface on the Stable
    // channel from the tag alone. (The atom fallback carries no flag at
    // all, so for Stable it is not trusted either - see fetchFromAtom.)
    if (channel === 'stable' && r.prerelease) return false;
    return releaseMatchesChannel(r.tag_name.replace(/^v/i, ''), channel);
  });
  if (published.length === 0) throw new Error('No published releases');
  // Every surviving tag is parsable, so the SemVer comparator below is
  // total and deterministic over the whole input (no fallback branches).
  published.sort((a, b) => compareVersions(a.tag_name, b.tag_name));
  return mapRelease(published[published.length - 1]);
}

/**
 * Fallback: the releases.atom feed. Static file, no rate limit, no API.
 * Only carries the tag name, so assets stay empty; the header then links to
 * the releases page instead of starting a direct download.
 */
async function fetchFromAtom(channel: UpdateChannel): Promise<OwnRelease> {
  // The atom feed carries tags only - no draft flag, no prerelease flag.
  // For Beta/Alpha the tag pattern is the channel contract, but Stable
  // must not treat a stable-looking tag as proof of stability: a manual
  // prerelease tagged "v1.0.7" would slip past releaseMatchesChannel and
  // be served as a stable update. So Stable requires API metadata - no
  // Atom-based stable candidates. The updater reports no update and the
  // UI still links to the releases page; the cost is one session without
  // an update notice while the API is down, not a wrong-channel install.
  if (channel === 'stable') throw new Error('Atom feed cannot verify stable-channel releases');
  const xml = await fetchSelfUpdateText(`https://github.com/${REPO}/releases.atom`);
  if (!xml) throw new Error('Atom feed unreachable');
  // The feed carries the newest ~10 releases, newest first. Scanning ONLY
  // the first entry broke channel selection: with 1.0.5-alpha newest and
  // the user on the Beta channel, the alpha entry was rejected and the
  // fallback gave up - even though 1.0.4-beta sat right below it. Scan
  // every entry, filter by channel, keep the newest by SemVer.
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  const releases: OwnRelease[] = [];
  for (const entry of entries) {
    // The id looks like "tag:github.com,2008:Repository/123456/v1.0.1-alpha".
    const idMatch = entry.match(/<id>[^<]*\/([^<]+)<\/id>/i);
    const tag = idMatch?.[1]?.trim();
    if (!tag) continue;
    const updated = entry.match(/<updated>([^<]+)<\/updated>/i)?.[1] || '';
    releases.push({
      tag,
      version: tag.replace(/^v/i, ''),
      publishedAt: updated,
      htmlUrl: `https://github.com/${REPO}/releases`,
      assets: [],
    });
  }
  const matching = releases.filter((r) => {
    // Same policy as the API path: a malformed atom tag (they are free-form
    // tag names here) is never an eligible candidate, so the sort below
    // only ever sees parsable SemVer tags.
    if (!parseVersion(r.tag)) return false;
    return releaseMatchesChannel(r.version, channel);
  });
  if (matching.length === 0) throw new Error('Atom feed has no matching release');
  matching.sort((a, b) => compareVersions(a.tag, b.tag));
  return matching[matching.length - 1];
}

/** Newest published release on the channel, API first, atom feed fallback. */
export async function fetchOwnLatestRelease(channel: UpdateChannel = getUpdateChannel()): Promise<OwnRelease | null> {
  try {
    return await fetchFromApi(channel);
  } catch {
    try {
      // The channel filter now lives inside fetchFromAtom, so the fallback
      // searches the whole feed for the newest matching release instead of
      // giving up when only the newest entry misses the channel.
      return await fetchFromAtom(channel);
    } catch {
      return null;
    }
  }
}

/**
 * Fetch the release's SHA256SUMS.txt and return the trusted hash published
 * for `assetName`. This is what turns the download manager's "calculated a
 * hash" into an actual verification: the hash is compared against the value
 * CI published next to the file, not merely computed and shown.
 *
 * Trust properties (all fail closed):
 *   - The lookup is tied to THIS release and the SELECTED filename: the
 *     manifest is found among this release's own assets, and only an entry
 *     whose name matches `assetName` exactly (byte-for-byte, the same string
 *     the download will carry) yields a digest.
 *   - A missing manifest, an unreachable document, an entry for a different
 *     name, or a malformed document all return null - and null means the
 *     delivery layer refuses the in-app download (planUpdateDelivery).
 *   - Malformed lines (wrong hash length, non-hex, free text) can never
 *     yield a digest: they are skipped by the strict line grammar.
 *   - Duplicate entries for the same filename with CONFLICTING digests
 *     return null: two different "expected" hashes for one file means the
 *     manifest itself cannot be trusted, so nothing is verified. A byte-
 *     identical duplicate is harmless and accepted.
 *
 * Routed through the native text fetch inside the app (see
 * fetchSelfUpdateText): a WebView fetch of this release asset fails on
 * CORS, which silently degraded every self-update to "unverified". Both
 * the manifest URL and the asset URL stay inside the native layer's
 * self-update host allowlist and repo path pin.
 */
async function fetchExpectedSha256(release: OwnRelease, assetName: string): Promise<string | null> {
  const sums = release.assets.find((a) => /^sha256sums\.txt$/i.test(a.name));
  if (!sums) return null;
  const text = await fetchSelfUpdateText(sums.url);
  if (!text) {
    // A missing/unreachable checksum file degrades to "unverified", never to
    // a fake "verified". The update delivery layer treats null as "cannot
    // verify" and refuses the in-app download instead of shipping an
    // unverified installer (fail closed).
    return null;
  }
  const matches: string[] = [];
  for (const line of text.split('\n')) {
    // Strict sha256sum grammar: "<64 hex chars>  <name>" (two spaces, an
    // optional binary-mode marker before the name). Anything else - a
    // 63-char hash, non-hex text, an empty line - is malformed and can
    // never produce an expected digest for ANY file.
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (m[2].trim() === assetName) matches.push(m[1].toLowerCase());
  }
  if (matches.length === 0) return null;
  const first = matches[0];
  // Conflicting duplicates = untrustworthy manifest = fail closed.
  return matches.every((h) => h === first) ? first : null;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateState> {
  try {
    const channel = getUpdateChannel();
    const release = await fetchOwnLatestRelease(channel);
    if (!release) return { kind: 'error' };
    const cmp = compareVersions(release.version, currentVersion);
    if (cmp <= 0) {
      return { kind: 'latest', version: release.version };
    }
    // The Tauri host arch, not the WebView user agent: macOS WebKit claims
    // "Intel" even on Apple Silicon, which handed Intel dmgs to M-series
    // Macs. Same source of truth as the catalog resolver.
    let arch: string | undefined;
    try {
      arch = await getHostArch();
    } catch {
      arch = undefined;
    }
    const asset = pickOwnAsset(release, arch);
    let expectedSha256: string | null = null;
    if (asset) {
      expectedSha256 = await fetchExpectedSha256(release, asset.name);
    }
    return { kind: 'available', release, asset, expectedSha256 };
  } catch {
    return { kind: 'error' };
  }
}

/** What tapping the update button may do with a detected update.
 *
 * - `download` : a platform-matched asset exists AND its published SHA-256
 *   entry was read from SHA256SUMS.txt - the download manager verifies the
 *   file against it before it counts as finished.
 * - `releases-page`: no usable asset (unknown ABI), or the asset's
 *   checksum could NOT be established (no SHA256SUMS.txt on the release,
 *   no entry for the asset, or the checksum document was unreachable).
 *   The update is NOT delivered through the app in that state - handing an
 *   unverifiable installer to the user while calling it an update would be
 *   the one thing this flow must never do. The releases page keeps the
 *   manual `sha256sum -c SHA256SUMS.txt` instructions one click away.
 */
export type UpdateDelivery =
  | { kind: 'download'; asset: { name: string; size: number; url: string }; sha256: string }
  | { kind: 'releases-page'; release: OwnRelease; reason: 'no-asset' | 'unverifiable' };

/** Pure decision behind BOTH update buttons (header pill, footer button),
 * so the two call sites cannot drift apart on the fail-closed rule. */
export function planUpdateDelivery(
  release: OwnRelease,
  asset: { name: string; size: number; url: string } | null,
  expectedSha256: string | null
): UpdateDelivery {
  if (!asset) return { kind: 'releases-page', release, reason: 'no-asset' };
  if (!expectedSha256) return { kind: 'releases-page', release, reason: 'unverifiable' };
  return { kind: 'download', asset, sha256: expectedSha256 };
}
