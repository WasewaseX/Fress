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
  return tag.replace(/^v/i, '').replace(/^ver/i, '') || tag;
}

/* ------------------------------------------------------------------ */
/* Asset picking                                                       */
/* ------------------------------------------------------------------ */

/** Files that can never be the app itself. */
const BAD_EXT = /\.(sig|blockmap|sha256|sha512|sha256sum|md5|txt|json|yaml|yml|pub|pem|sbom|zsync|bittorrent|xml|map|dSYM|apk\.idsig|idsig)$/i;
/** Metadata / tooling artefacts shipped next to installers. */
const BAD_NAME = /sha256|checksum|^latest\.json$|(^|[^a-z0-9])symbols([^a-z0-9]|$)|(^|[^a-z0-9])pdb([^a-z0-9]|$)|dont[-_.]?use|(^|[^a-z0-9])group[-_.]?policy/i;

function scoreAsset(name: string, platform: Platform, arch: string): number {
  const n = name.toLowerCase();
  let s = 0;

  switch (platform) {
    case 'android': {
      if (!n.endsWith('.apk')) return -1;
      if (/google[-_.]?play|playstore|play[-_.]?store/.test(n)) s -= 6; // Play flavor sideloads poorly
      if (/universal|^app-|all[-_.]?abis/.test(n)) s += 6;
      if (/arm64|aarch64|v8a/.test(n)) s += 5;
      if (/armeabi|arm32|v7a/.test(n)) s += 1;
      if (/x86_64/.test(n)) s += 0;
      if (/fdroid/.test(n)) s += 1;
      break;
    }
    case 'windows': {
      if (n.endsWith('.exe')) s += 6;
      else if (n.endsWith('.msi')) s += 4;
      else return -1;
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

export function pickAsset(assets: ReleaseAsset[], platform: Platform, arch: string): ReleaseAsset | null {
  let best: ReleaseAsset | null = null;
  let bestScore = -Infinity;
  for (const a of assets) {
    if (BAD_EXT.test(a.name) || BAD_NAME.test(a.name)) continue;
    const s = scoreAsset(a.name, platform, arch);
    if (s === -1) continue;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
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

let archPromise: Promise<string> | null = null;

export function getHostArch(): Promise<string> {
  if (!archPromise) {
    archPromise = (async () => {
      if (!isTauri()) {
        const ua = navigator.userAgent || '';
        return /arm|aarch/i.test(ua) ? 'aarch64' : 'x86_64';
      }
      try {
        return (await invoke<string>('host_arch')) || 'x86_64';
      } catch {
        return 'x86_64';
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

export function resolveGitHubDownload(app: AppItem, platform: Platform): Promise<ResolvedDownload | null> {
  const repo = parseGithubRepo(app.githubUrl);
  if (!repo || platform === 'web' || platform === 'ios') return Promise.resolve(null);
  const key = `${repo}|${platform}`;
  if (!ghCache.has(key)) {
    ghCache.set(
      key,
      (async () => {
        try {
          const [rel, arch] = await Promise.all([getLatestRelease(repo), getHostArch()]);
          const pick = pickAsset(rel.assets, platform, arch);
          if (!pick) return null;
          return {
            source: 'github',
            url: pick.downloadUrl,
            filename: pick.name,
            size: pick.size,
            version: cleanVersion(rel.tag),
            publishedAt: rel.publishedAt,
            releasePageUrl: rel.htmlUrl,
          } as ResolvedDownload;
        } catch {
          return null;
        }
      })()
    );
  }
  return ghCache.get(key)!;
}

export function resolveFdroidDownload(pkgId: string): Promise<ResolvedDownload | null> {
  const pkg = pkgId.trim();
  if (!pkg) return Promise.resolve(null);
  const key = pkg;
  if (!fdCache.has(key)) {
    fdCache.set(
      key,
      (async () => {
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
      })()
    );
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
