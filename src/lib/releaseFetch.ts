// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { AppItem, Platform } from '../types';
import { isTauri } from './downloads';

/**
 * Resolves real download files from GitHub Releases and F-Droid.
 *
 * Only STABLE releases are ever offered: GitHub's /releases/latest endpoint
 * already excludes drafts and prereleases (beta/RC), so users never get a
 * beta build by accident. For F-Droid we use the official API's suggested
 * version code.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface ResolvedDownload {
  source: 'github' | 'fdroid';
  url: string;
  filename: string;
  size: number;
  version: string;
  publishedAt?: string;
  releasePageUrl?: string;
  /** 'override' = the catalog author pinned this exact naming pattern;
   * 'heuristic' = picked by the scoring rules. */
  matchedBy?: 'override' | 'heuristic';
  /** True when the heuristic could only produce a low-confidence pick
   * (odd extension, no architecture marker, stripped flags). The UI warns
   * instead of presenting it as a sure thing. */
  weak?: boolean;
}

/* ------------------------------------------------------------------ */
/* Repo parsing                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Asset picking                                                       */
/* ------------------------------------------------------------------ */

/** Files that can never be the app itself. */
const BAD_EXT = /\.(sig|blockmap|sha256|sha512|sha256sum|md5|txt|json|yaml|yml|pub|pem|sbom|zsync|bittorrent|xml|map|dSYM|apk\.idsig|idsig)$/i;
/** Metadata / tooling artefacts shipped next to installers. */
const BAD_NAME = /sha256|checksum|^latest\.json$|(^|[^a-z0-9])symbols([^a-z0-9]|$)|(^|[^a-z0-9])pdb([^a-z0-9]|$)|dont[-_.]?use|(^|[^a-z0-9])group[-_.]?policy/i;

/* ------------------------------------------------------------------ */
/* Android ABI classification (shared with the self-updater)           */
/* ------------------------------------------------------------------ */

export type AndroidAbi = 'arm64' | 'arm' | 'x86' | 'x86_64';

/** What the runtime actually knows about the device. "unknown" is NOT a
 * synonym for x86_64: guessing x86_64 for a browser on a reduced user agent
 * is exactly what made ARM phones get handed x86_64-only APKs they cannot
 * install. Unknown devices fall back to universal APKs instead. */
export type DeviceAbi = AndroidAbi | 'unknown';

/**
 * The one place that decides what ABI an APK filename carries. Both the
 * catalog resolver and the self-updater call this, so the two pickers can
 * never drift apart again (the updater used to collapse every host to
 * arm-vs-not and mis-served ARMv7 and x86 Android devices).
 *
 * host_arch on Android reports "aarch64", "arm" (32-bit), "x86"/"i686" or
 * "x86_64"; CI publishes the per-ABI splits as `Fress_*_arm64.apk`,
 * `Fress_*_arm.apk`, `Fress_*_x64.apk` and `Fress_*_x86.apk` - "x64" IS an
 * x86_64 marker here, same as on Windows.
 */
export function androidAssetFlags(name: string): {
  universal: boolean;
  arm64: boolean;
  arm32: boolean;
  x64: boolean;
  x86: boolean;
} {
  const n = name.toLowerCase();
  const arm64 = /arm64|aarch64|v8a/.test(n);
  const x64 = /x86[_-]?64|amd64|x64/.test(n);
  // "universal" must be a TOKEN, not a prefix: the old ^app- rule classified
  // gradle's per-ABI splits (app-arm64-release.apk) as universal simply for
  // starting with "app-", which handed unknown-ABI browsers a split they
  // cannot install. app-universal-release.apk still matches via -universal-.
  return {
    universal:
      /(^|[-_.])universal([-_.]|$)/.test(n) || /all[-_.]?abis/.test(n),
    arm64,
    arm32: !arm64 && /armeabi|arm32|v7a|(^|[^a-z0-9])arm([^a-z0-9]|$)/.test(n),
    x64,
    x86: !x64 && /x86(?!_64)|i[36]86/.test(n),
  };
}

/** Single-ABI view of an APK name, in priority order (a fat APK that names
 * several ABIs classifies as its first); null when nothing marks the ABI. */
export function androidAssetAbi(name: string): AndroidAbi | null {
  const f = androidAssetFlags(name);
  if (f.arm64) return 'arm64';
  if (f.arm32) return 'arm';
  if (f.x64) return 'x86_64';
  if (f.x86) return 'x86';
  return null;
}

/** Map a Tauri host_arch value (or a browser's best-effort arch signal) to
 * the ABI family it runs. Only EXACT arch values map to an ABI; anything
 * else - including the empty signal a reduced user agent gives - is
 * "unknown", and the scorers treat unknown as "universal APK only". */
export function androidDeviceAbi(arch?: string | undefined): DeviceAbi {
  return arch === 'aarch64' ? 'arm64' :
    arch === 'arm' ? 'arm' :
    arch === 'i686' || arch === 'x86' ? 'x86' :
    arch === 'x86_64' ? 'x86_64' :
    'unknown';
}

/**
 * The HARD architecture-compatibility constraint, shared by the heuristic
 * scorer and the `assetPatterns` override path so the two can never
 * disagree about what is impossible.
 *
 * Division of authority:
 *   assetPatterns        = naming authority (WHICH file family is right)
 *   this gate            = safety constraint (what can never be installed)
 *   heuristic score      = preference ranking (tie breaker among the rest)
 *
 * An override may pin the naming; it may never declare an impossible
 * architecture installable. Returns false only for PROVEN incompatibility:
 * with an unknown host arch nothing is proven, so the gate stays open
 * (except Android, where unknown means the universal-only contract).
 */
export function assetCompatibleWithDevice(
  name: string,
  platform: Platform,
  arch: string | undefined
): boolean {
  const n = name.toLowerCase();
  switch (platform) {
    case 'android': {
      const device = androidDeviceAbi(arch);
      if (device === 'unknown') return androidAssetFlags(n).universal; // universal only, never a guess
      if (androidAssetFlags(n).universal) return true;
      const abi = androidAssetAbi(n);
      if (!abi) return true; // unmarked: a gamble only a KNOWN device may take
      // Runnable cross-ABI pairs: armv7 apks run on arm64 devices, and
      // x86_64 devices keep 32-bit x86 compat. Everything else is a
      // guaranteed install failure (arm64 on arm/32-bit, x64 on 32-bit,
      // arm splits on x86 family, 64-bit splits on a 32-bit device).
      return (
        abi === device ||
        (device === 'arm64' && abi === 'arm') ||
        (device === 'x86_64' && abi === 'x86')
      );
    }
    case 'windows': {
      // x86_64 Windows cannot run arm64 binaries (WoA emulates x64/x86, not
      // the reverse) and a 32-bit host runs neither arm64 nor x64. An
      // ARM64 host runs everything through emulation.
      const armAsset = /arm64|aarch64/.test(n);
      const x64Asset = /x64|x86_64|amd64|win64/.test(n);
      const hostIs32 = arch === 'x86' || arch === 'i686';
      if (armAsset && !x64Asset) return arch !== 'x86_64' && !hostIs32;
      if (x64Asset && !armAsset) return !hostIs32;
      return true;
    }
    case 'mac': {
      // Apple Silicon runs Intel dmgs through Rosetta 2; an Intel Mac has
      // no path to arm64-only builds.
      const armAsset = /arm64|aarch64|apple[-_. ]?silicon/.test(n);
      const x64Asset = /x64|x86_64|intel/.test(n);
      if (armAsset && !x64Asset) return arch !== 'x86_64';
      return true;
    }
    case 'linux': {
      // No usable cross-ISA emulation in a desktop context either way:
      // x86_64 builds on ARM machines and arm builds on x86 machines are
      // both dead ends (the self-updater has refused these for ages). A
      // 32-bit x86 host additionally cannot run 64-bit-only builds.
      const armAsset = /arm|aarch64/.test(n);
      const x64Asset = /x86_64|x64|amd64/.test(n);
      const hostIsArm = arch === 'aarch64' || arch === 'arm';
      const hostIs32 = arch === 'x86' || arch === 'i686';
      if (armAsset && !x64Asset) return !hostIs32 && arch !== 'x86_64';
      if (x64Asset && !armAsset) return !hostIsArm && !hostIs32;
      return true;
    }
    default:
      return true;
  }
}

function scoreAsset(name: string, platform: Platform, arch: string | undefined): number {
  const n = name.toLowerCase();
  let s = 0;

  switch (platform) {
    case 'android': {
      if (!n.endsWith('.apk')) return -1;
      if (/google[-_.]?play|playstore|play[-_.]?store/.test(n)) s -= 6; // Play flavor sideloads poorly
      // HARD SAFETY GATE first (shared with the assetPatterns override
      // path): a file the device provably cannot run is refused outright,
      // whatever its score would have been. This includes unknown devices
      // (universal only - "no ABI marker" is exactly the unknown, so an
      // unmarked apk is a gamble we cannot resolve) and wrong-ABI splits,
      // which used to stay pickable at negative scores when they were the
      // only candidate. Ranking below applies only to compatible files.
      if (!assetCompatibleWithDevice(name, 'android', arch)) return -1;
      const f = androidAssetFlags(n);
      const deviceAbi = androidDeviceAbi(arch);
      if (f.universal) s += 6; // runs everywhere
      // A matching ABI-specific APK slightly outranks universal (smaller
      // download); armv7 apks are runnable on arm64 devices, hence the
      // graded 2 instead of a refusal the gate already enforces elsewhere.
      if (f.arm64) s += deviceAbi === 'arm64' ? 7 : -8;
      if (f.arm32) s += deviceAbi === 'arm' ? 7 : deviceAbi === 'arm64' ? 2 : -8; // arm64 devices run armv7 apks
      if (f.x64) s += deviceAbi === 'x86_64' ? 7 : deviceAbi === 'x86' ? -2 : -8;
      if (f.x86) s += deviceAbi === 'x86' ? 7 : deviceAbi === 'x86_64' ? 2 : -8;
      if (/fdroid/.test(n)) s += 1;
      break;
    }
    case 'windows': {
      if (n.endsWith('.exe')) s += 6;
      else if (n.endsWith('.msi')) s += 4;
      else return -1;
      // Gate: an x86_64 machine can never run an arm64-only installer (WoA
      // emulates x64/x86, not the reverse) - previously it stayed pickable
      // at a weak positive score when it was the only exe.
      if (!assetCompatibleWithDevice(name, 'windows', arch)) return -1;
      if (/setup|installer|install/.test(n)) s += 2;
      if (/unsigned/.test(n)) s -= 4;
      if (/portable/.test(n)) s -= 2;
      if (/arm64|arm/.test(n)) s += arch === 'aarch64' ? 4 : -5;
      if (/win32|ia32|i686|32[-_.]?bit|x86(?!_64)/.test(n) && !/x64|x86_64|win64/.test(n)) s -= 3;
      if (/x64|x86_64|amd64|win64/.test(n)) s += arch === 'aarch64' ? 0 : 3;
      break;
    }
    case 'mac': {
      if (!n.endsWith('.dmg')) {
        // .pkg is an acceptable macOS fallback but dmg is friendlier
        if (n.endsWith('.pkg')) s += 0;
        else return -1;
      } else {
        s += 4;
      }
      // Gate: an Intel Mac cannot run an arm64-only dmg (Rosetta only
      // translates the other direction); Apple Silicon runs Intel builds.
      if (!assetCompatibleWithDevice(name, 'mac', arch)) return -1;
      if (/arm64|aarch64|apple[-_. ]?silicon/.test(n)) s += arch === 'aarch64' ? 6 : -7;
      if (/x64|x86_64|intel/.test(n)) s += arch === 'aarch64' ? -7 : 6;
      if (/universal/.test(n)) s += 3;
      break;
    }
    case 'linux': {
      if (n.endsWith('.appimage')) s += 7;
      else if (n.endsWith('.deb')) s += 5;
      else if (n.endsWith('.rpm')) s += 3;
      else if (/\.t(ar\.gz|gz|zst)$/.test(n)) s += 1;
      else return -1;
      // Gate: no usable cross-ISA emulation in a desktop context, so an
      // ARM machine gets nothing from x86_64-only releases and vice versa
      // (the self-updater has refused these for ages; the catalog used to
      // hand them over with a confident, non-weak score of 5).
      if (!assetCompatibleWithDevice(name, 'linux', arch)) return -1;
      if (/x86_64|x64|amd64/.test(n)) s += arch === 'aarch64' ? -2 : 4;
      if (/arm|aarch64/.test(n)) s += arch === 'aarch64' ? 4 : -5;
      if (/flatpak|snap/.test(n)) s -= 6;
      break;
    }
    default:
      return -1;
  }
  return s;
}

export function pickAsset(assets: ReleaseAsset[], platform: Platform, arch: string | undefined): ReleaseAsset | null {
  return pickAssetDetailed(assets, platform, arch)?.pick ?? null;
}

/** Below this heuristic score the pick is reported as low confidence.
 * A typical solid pick scores 6-13; 1 and below means the only candidate
 * was an odd extension or something stripped of identifying markers. */
const WEAK_SCORE_MAX = 1;

export interface AssetPick {
  pick: ReleaseAsset;
  matchedBy: 'override' | 'heuristic';
  weak: boolean;
}

/**
 * Picks the asset a user on this platform/architecture needs.
 *
 * Order of trust:
 *  1. The app's own `assetPatterns[platform]` regex, when provided - the
 *     catalog author vouched for that naming. Bad-extension files are still
 *     excluded, and a pattern that matches nothing falls through to (2)
 *     rather than failing the download.
 *  2. The scoring heuristic below, which never claims certainty it does not
 *     have: weak picks are flagged so the UI can show a caution instead of
 *     silently handing over a questionable file.
 */
export function pickAssetDetailed(
  assets: ReleaseAsset[],
  platform: Platform,
  arch: string | undefined,
  patterns?: Partial<Record<Platform, string>>
): AssetPick | null {
  const usable = assets.filter((a) => !BAD_EXT.test(a.name) && !BAD_NAME.test(a.name));

  const pattern = patterns?.[platform];
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      // Architecture compatibility is a HARD constraint an override cannot
      // bypass: the pattern is the naming authority - it says which file
      // FAMILY is right - but it must never declare an impossible
      // architecture installable (an Android pattern pinning a split name
      // used to hand that file to an unknown-ABI browser even though the
      // heuristic correctly refuses it). Incompatible matches are dropped;
      // if none survive, fall through to the heuristic, which applies the
      // very same gate (assetCompatibleWithDevice).
      const matches = usable
        .filter((a) => re.test(a.name))
        .filter((a) => assetCompatibleWithDevice(a.name, platform, arch));
      if (matches.length > 0) {
        // Among surviving pattern matches the heuristic still breaks ties
        // (x64 vs arm64 variants of the same pinned naming).
        let best = matches[0];
        let bestScore = -Infinity;
        for (const a of matches) {
          const s = scoreAsset(a.name, platform, arch);
          if (s > bestScore) {
            bestScore = s;
            best = a;
          }
        }
        return { pick: best, matchedBy: 'override', weak: false };
      }
    } catch {
      // An invalid pattern must never kill the download path; the catalog
      // validator flags it separately.
    }
  }

  let best: ReleaseAsset | null = null;
  let bestScore = -Infinity;
  for (const a of usable) {
    const s = scoreAsset(a.name, platform, arch);
    if (s === -1) continue;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  if (!best) return null;
  return { pick: best, matchedBy: 'heuristic', weak: bestScore <= WEAK_SCORE_MAX };
}

/* ------------------------------------------------------------------ */
/* API access (Tauri command in the desktop app, fetch in the browser) */
/* ------------------------------------------------------------------ */

interface GhReleaseRaw {
  tag: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; download_url: string }[];
}

async function getLatestRelease(repo: string): Promise<ReleaseInfo> {
  if (isTauri()) {
    const r = await invoke<GhReleaseRaw>('fetch_latest_release', { repo });
    return {
      tag: r.tag,
      name: r.name,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloadUrl: a.download_url })),
    };
  }
  const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (resp.status === 404) throw new Error('No stable release found');
  if (resp.status === 403 || resp.status === 429) throw new Error('GitHub rate limit reached');
  if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
  const d = await resp.json();
  return {
    tag: d.tag_name || '',
    name: d.name || d.tag_name || '',
    publishedAt: d.published_at || '',
    htmlUrl: d.html_url || `https://github.com/${repo}/releases`,
    assets: (d.assets || []).map((a: { name: string; size: number; browser_download_url: string }) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  };
}

/** How far the recent-releases scan reaches. Multi-stream repos (desktop +
 * mobile + server tags from one repo: Obsidian, Tuta, Ente) need roughly a
 * dozen entries before the right stream shows up; 20 covers every repo in
 * the catalog with one API call. */
const RECENT_RELEASES_COUNT = 20;

interface GhReleaseListRaw {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

async function getRecentReleases(repo: string, count: number): Promise<ReleaseInfo[]> {
  if (isTauri()) {
    const r = await invoke<GhReleaseRaw[]>('fetch_recent_releases', { repo, count });
    return (r || []).map((rel) => ({
      tag: rel.tag,
      name: rel.name,
      publishedAt: rel.published_at,
      htmlUrl: rel.html_url,
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, downloadUrl: a.download_url })),
    }));
  }
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=${count}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  if (resp.status === 404) throw new Error('No stable release found');
  if (resp.status === 403 || resp.status === 429) throw new Error('GitHub rate limit reached');
  if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
  const d: GhReleaseListRaw[] = await resp.json();
  return (Array.isArray(d) ? d : [])
    .filter((r) => r.prerelease !== true)
    .map((r) => ({
      tag: r.tag_name || '',
      name: r.name || r.tag_name || '',
      publishedAt: r.published_at || '',
      htmlUrl: r.html_url || `https://github.com/${repo}/releases`,
      assets: (r.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
      })),
    }));
}

export interface FdroidInfo {
  apkUrl: string;
  pageUrl: string;
  version: string;
  versionCode: number;
}

async function getFdroid(pkg: string): Promise<FdroidInfo> {
  if (isTauri()) {
    const r = await invoke<{ apk_url: string; page_url: string; version: string; version_code: number }>(
      'fetch_fdroid_package',
      { pkg }
    );
    return { apkUrl: r.apk_url, pageUrl: r.page_url, version: r.version, versionCode: r.version_code };
  }
  const resp = await fetch(`https://f-droid.org/api/v1/packages/${pkg}`);
  if (!resp.ok) throw new Error(`F-Droid HTTP ${resp.status}`);
  const d = await resp.json();
  let max = 0;
  for (const p of d.packages || []) {
    if (typeof p.versionCode === 'number' && p.versionCode > max) max = p.versionCode;
  }
  const suggested = typeof d.suggestedVersionCode === 'number' ? d.suggestedVersionCode : 0;
  const vc = suggested > 0 && (max === 0 || suggested <= max) ? suggested : max;
  if (!vc) throw new Error('No F-Droid version');
  const found = (d.packages || []).find((p: { versionCode: number }) => p.versionCode === vc);
  return {
    apkUrl: `https://f-droid.org/repo/${pkg}_${vc}.apk`,
    pageUrl: `https://f-droid.org/packages/${pkg}/`,
    version: found?.versionName || '',
    versionCode: vc,
  };
}

/* ------------------------------------------------------------------ */
/* Host architecture (cached)                                          */
/* ------------------------------------------------------------------ */

let archPromise: Promise<string | undefined> | null = null;

/** The host architecture when the runtime actually knows it:
 * - Tauri: the real host_arch from Rust (never a WebView guess).
 * - Browser: 'aarch64' only on a UA that positively names ARM; otherwise
 *   undefined. Modern UA reduction hides the CPU arch (MDN's own Android
 *   example is "Linux; Android 16; Pixel 9"), and the old x86_64 guess
 *   here made ARM-phone browsers pick x86_64-only APKs that cannot
 *   install. Callers treat undefined as "unknown, be conservative". */
export function getHostArch(): Promise<string | undefined> {
  if (!archPromise) {
    archPromise = (async () => {
      if (!isTauri()) {
        // typeof guard: Node 20 (CI) has no global navigator.
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
        return /arm|aarch/i.test(ua) ? 'aarch64' : undefined;
      }
      try {
        return (await invoke<string>('host_arch')) || undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return archPromise;
}

/* ------------------------------------------------------------------ */
/* Cached resolvers                                                    */
/* ------------------------------------------------------------------ */

const ghCache = new Map<string, Promise<ResolvedDownload | null>>();
const fdCache = new Map<string, Promise<ResolvedDownload | null>>();
/**
 * Failed lookups are remembered only briefly. A GitHub rate limit or a Wi-Fi
 * blip used to be cached for the whole session: the first click resolved to
 * nothing and every later click on the same app kept silently doing nothing
 * until a restart. Successes stay cached for the session, failures expire so
 * the next click really tries again.
 */
const FAIL_TTL_MS = 30_000;

function cacheSet(
  cache: Map<string, Promise<ResolvedDownload | null>>,
  key: string,
  value: Promise<ResolvedDownload | null>
): void {
  cache.set(key, value);
  value.then((r) => {
    if (r === null) {
      // Expire failures after a short TTL so the next click really retries.
      // globalThis: window does not exist in Node (tests) or workers.
      globalThis.setTimeout(() => {
        if (cache.get(key) === value) cache.delete(key);
      }, FAIL_TTL_MS);
    }
  });
}

export function resolveGitHubDownload(app: AppItem, platform: Platform): Promise<ResolvedDownload | null> {
  const repo = parseGithubRepo(app.githubUrl);
  if (!repo || platform === 'web' || platform === 'ios') return Promise.resolve(null);
  const key = `${repo}|${platform}`;
  if (!ghCache.has(key)) {
    const p = (async () => {
        try {
          const arch = await getHostArch();
          // 1) The cheapest correct answer: the repo's single latest stable
          //    release. This is where every well-behaved project resolves.
          //    A 404 here (repos with only prereleases, or release-less
          //    mirrors) must not kill the attempt - the recent scan below
          //    still runs.
          let latest: ReleaseInfo | null = null;
          try {
            latest = await getLatestRelease(repo);
          } catch {
            latest = null;
          }
          // Confidence is decided the same way on both paths now: a
          // confident pick wins wherever it appears (latest first, then the
          // recent scan); a weak pick from the latest release is only ever
          // the last resort, returned flagged so the UI can caution.
          let weakLatest: { detailed: AssetPick; rel: ReleaseInfo } | null = null;
          if (latest) {
            const detailed = pickAssetDetailed(latest.assets, platform, arch, app.assetPatterns);
            if (detailed) {
              if (!detailed.weak) {
                return toResolved(detailed, latest);
              }
              weakLatest = { detailed, rel: latest };
            }
          }
          // 2) Multi-stream repos (Obsidian publishes desktop and mobile
          //    under different tags, Tuta splits desktop/web, Ente splits
          //    photos/auth/server): the latest release is often the WRONG
          //    stream, so the platform's installer seems not to exist. Scan
          //    the recent stable releases in order instead - the first one
          //    carrying a confident match for this platform wins.
          const recent = await getRecentReleases(repo, RECENT_RELEASES_COUNT);
          for (const candidate of recent) {
            const cPick = pickAssetDetailed(candidate.assets, platform, arch, app.assetPatterns);
            if (cPick && !cPick.weak) {
              return toResolved(cPick, candidate);
            }
          }
          // 3) Nothing confident anywhere. The latest release's low-
          //    confidence pick is still better than no download at all,
          //    and the weak flag makes the UI say so.
          if (weakLatest) {
            return toResolved(weakLatest.detailed, weakLatest.rel);
          }
          return null;
        } catch {
          return null;
        }
      })();
    cacheSet(ghCache, key, p);
  }
  return ghCache.get(key)!;
}

function toResolved(detailed: AssetPick, rel: ReleaseInfo): ResolvedDownload {
  return {
    source: 'github',
    url: detailed.pick.downloadUrl,
    filename: detailed.pick.name,
    size: detailed.pick.size,
    version: cleanVersion(rel.tag),
    publishedAt: rel.publishedAt,
    releasePageUrl: rel.htmlUrl,
    matchedBy: detailed.matchedBy,
    weak: detailed.weak || undefined,
  };
}

export function resolveFdroidDownload(pkgId: string): Promise<ResolvedDownload | null> {
  const pkg = pkgId.trim();
  if (!pkg) return Promise.resolve(null);
  const key = pkg;
  if (!fdCache.has(key)) {
    const p = (async () => {
        try {
          const r = await getFdroid(pkg);
          return {
            source: 'fdroid',
            url: r.apkUrl,
            filename: `${pkg}_${r.versionCode}.apk`,
            size: 0,
            version: r.version || String(r.versionCode),
            releasePageUrl: r.pageUrl,
          } as ResolvedDownload;
        } catch {
          return null;
        }
      })();
    cacheSet(fdCache, key, p);
  }
  return fdCache.get(key)!;
}

export function fdroidPageUrl(pkgId: string): string {
  return `https://f-droid.org/packages/${pkgId.trim()}/`;
}

export function playStoreUrl(pkgId: string): string {
  return `https://play.google.com/store/apps/details?id=${pkgId.trim()}`;
}

/** The platforms for which a GitHub auto-fetch even makes sense. */
export function githubFetchSupported(platform: Platform): boolean {
  return platform === 'windows' || platform === 'mac' || platform === 'linux' || platform === 'android';
}

/** Best guess of the current device platform, used for one-click downloads. */
export function guessUserPlatform(app: AppItem): Platform {
  if (typeof navigator === 'undefined') return app.platforms[0] || 'windows';
  const ua = navigator.userAgent.toLowerCase();
  let guess: Platform = 'windows';
  if (ua.includes('android')) guess = 'android';
  else if (ua.includes('iphone') || ua.includes('ipad')) guess = 'ios';
  else if (ua.includes('mac os') || ua.includes('macintosh')) guess = 'mac';
  else if (ua.includes('linux')) guess = 'linux';
  return app.platforms.includes(guess) ? guess : app.platforms[0] || 'windows';
}
