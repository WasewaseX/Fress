// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../../types';
import { resolveOfficialDownload } from '../officialResolvers';
import { compileSafePattern } from '../patternSafety';
import { cleanVersion, effectiveRepo } from './repo';
import {
  ghCache,
  fdCache,
  cacheSet,
  ghCacheKey,
  loadPersisted,
  persist,
  recordResolveError,
} from './resolveCache';
import { getFdroid } from './fdroidProvider';
import { getLatestRelease, getRecentReleases, RECENT_RELEASES_COUNT } from './githubProvider';
import { getHostArch } from './hostArch';
import { AssetPick, ReleaseInfo, ResolvedDownload } from './types';
import { pickAssetDetailed } from './assetMatching';

/**
 * Release resolution orchestration.
 *
 * Owns the RESOLUTION POLICY - which release stream, which confidence
 * order, which caches - while the providers fetch and assetMatching picks.
 * The order of trust for resolveDownloadFor:
 *   1. A confident GitHub pick (properly named for this platform and arch).
 *   2. The app's F-Droid package on Android (never preempted by a weak
 *      GitHub pick - signing flavors must stay consistent).
 *   3. The project's own manifest outside GitHub (official beats a guess).
 *   4. A weak GitHub pick as a last resort, flagged for the UI.
 *   5. null, so the caller can fall back to curated targets and pages.
 */

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

export function resolveGitHubDownload(app: AppItem, platform: Platform): Promise<ResolvedDownload | null> {
  const repo = effectiveRepo(app, platform);
  if (!repo || platform === 'web' || platform === 'ios') return Promise.resolve(null);
  // The cache key must carry everything that changes WHAT is fetched, not
  // just what is picked: two apps can share one repo while using different
  // tag-stream filters (Ente Photos and Ente Auth both live on ente/
  // ente), and a flagged-releases entry fetches a different release list.
  // (The persistent store additionally partitions by host arch, resolved
  // inside the async closure below: the same repo+platform resolves
  // DIFFERENT files on x64 vs ARM64 hosts.)
  const key = ghCacheKey(app, platform, repo);
  if (!ghCache.has(key)) {
    const p = (async () => {
        try {
          const arch = await getHostArch();
          const persistKey = `${key}|${arch ?? 'u'}`;
          // Persistent hit first: no network, no quota.
          const cached = loadPersisted(persistKey);
          if (cached !== undefined) return cached;
          // Tag-stream filter: repos that ship several products from one
          // repo under different tag prefixes (Ente: photos/auth/locker/
          // Ensu; Tuta: desktop/android/calendar). Without it the picker
          // can serve a DIFFERENT product's installer that merely carries
          // the right file extension. An invalid or unsafe pattern must
          // not kill (or hang) the download path, so a failed compile just
          // disables the filter (compileSafePattern: null = no filter).
          let tagRe: RegExp | null = null;
          const tagSrc = app.tagPatterns?.[platform];
          if (tagSrc) {
            tagRe = compileSafePattern(tagSrc);
          }
          const tagOk = (tag: string): boolean => (tagRe ? tagRe.test(tag) : true);
          // 1) The cheapest correct answer: the repo's single latest stable
          //    release. This is where every well-behaved project resolves.
          //    A 404 here (repos with only prereleases, or release-less
          //    mirrors) must not kill the attempt - the recent scan below
          //    still runs.
          let latest: ReleaseInfo | null = null;
          try {
            latest = await getLatestRelease(repo);
          } catch (e) {
            latest = null;
            const msg = (e as Error).message || '';
            if (/rate limit/i.test(msg)) recordResolveError(repo, platform, msg);
          }
          // A latest release from the wrong product stream is worse than
          // none: drop it and let the scan find the right stream.
          if (latest && !tagOk(latest.tag)) latest = null;
          // Confidence is decided the same way on both paths now: a
          // confident pick wins wherever it appears (latest first, then the
          // recent scan); a weak pick from the latest release is only ever
          // the last resort, returned flagged so the UI can caution.
          let weakLatest: { detailed: AssetPick; rel: ReleaseInfo } | null = null;
          if (latest) {
            const detailed = pickAssetDetailed(latest.assets, platform, arch, app.assetPatterns);
            if (detailed) {
              if (!detailed.weak) {
                const hit = toResolved(detailed, latest);
                persist(persistKey, hit);
                return hit;
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
          const recent = await getRecentReleases(
            repo,
            RECENT_RELEASES_COUNT,
            app.includeFlaggedReleases === true
          );
          // Unmarked or odd-extension files never win the scan while a
          // confident pick exists, but they beat a dead end: remember the
          // newest weak pick (Tuta's unmarked android apk, SimpleX's stable
          // apks) and fall back to it, flagged, when nothing confident
          // surfaced anywhere.
          let weakScan: { detailed: AssetPick; rel: ReleaseInfo } | null = null;
          for (const candidate of recent) {
            if (!tagOk(candidate.tag)) continue;
            const cPick = pickAssetDetailed(candidate.assets, platform, arch, app.assetPatterns);
            if (cPick && !cPick.weak) {
              const hit = toResolved(cPick, candidate);
              persist(persistKey, hit);
              return hit;
            }
            if (cPick && !weakScan) {
              weakScan = { detailed: cPick, rel: candidate };
            }
          }
          // 3) Nothing confident anywhere. A low-confidence pick is still
          //    better than no download at all, and the weak flag makes the
          //    UI say so.
          if (weakLatest) {
            const hit = toResolved(weakLatest.detailed, weakLatest.rel);
            persist(persistKey, hit);
            return hit;
          }
          if (weakScan) {
            const hit = toResolved(weakScan.detailed, weakScan.rel);
            persist(persistKey, hit);
            return hit;
          }
          persist(persistKey, null);
          return null;
        } catch (e) {
          const msg = (e as Error).message || '';
          if (/rate limit/i.test(msg)) recordResolveError(repo, platform, msg);
          return null;
        }
      })();
    cacheSet(ghCache, key, p);
  }
  return ghCache.get(key)!;
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

export async function resolveDownloadFor(
  app: AppItem,
  platform: Platform
): Promise<ResolvedDownload | null> {
  const gh = await resolveGitHubDownload(app, platform);
  const fdAllowed = platform === 'android' && !!app.fdroidId;
  if (gh && (!gh.weak || !fdAllowed)) return gh;
  if (fdAllowed && app.fdroidId) {
    const fd = await resolveFdroidDownload(app.fdroidId);
    if (fd) return fd;
  }
  // 3) The project's own download infrastructure outside GitHub (Tor's
  //    manifests, Signal's updater feeds, Proton's version.json, KDE's
  //    mirror router, ...). An official manifest outranks a weak GitHub
  //    guess: the vendor states exactly which file is current.
  if (!gh || gh.weak) {
    const official = await resolveOfficialDownload(app, platform);
    if (official) return official;
  }
  return gh ?? null;
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
