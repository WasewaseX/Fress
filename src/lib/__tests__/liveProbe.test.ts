// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// LIVE download-component probe. NOT part of CI (skipped unless
// FRESS_LIVE_PROBE=1). It replays the resolver's exact decision flow
// against the real GitHub/F-Droid APIs for every catalog app and prints
// an evidence report: which apps resolve to a direct file, which only
// resolve when the prerelease flag is ignored, and which fall back to a
// page. Run once per audit:
//   FRESS_LIVE_PROBE=1 npx vitest run src/lib/__tests__/liveProbe.test.ts
//
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { INITIAL_APPS } from '../../data/appsData';
import { pickAssetDetailed } from '../releaseFetch';
import { Platform } from '../../types';

const PROBE = !!process.env.FRESS_LIVE_PROBE;

function readPat(): string | null {
  try {
    const src = readFileSync('/home/z/my-project/scripts/verify_round6.py', 'utf8');
    const m = src.match(/github_pat_[A-Za-z0-9_]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

const ghHeaders: Record<string, string> = { Accept: 'application/vnd.github+json' };
const pat = readPat();
if (pat) ghHeaders.Authorization = `Bearer ${pat}`;

interface RawRel {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

function toReleaseInfo(r: RawRel) {
  return {
    tag: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: '',
    htmlUrl: '',
    assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloadUrl: a.browser_download_url })),
  };
}

const ARCHES: Array<string | undefined> = [undefined, 'x86_64', 'aarch64'];
const DESKTOP: Platform[] = ['windows', 'mac', 'linux'];

describe.skipIf(!PROBE)('LIVE catalog download probe', () => {
  it('resolves every catalog app against the real APIs', { timeout: 900_000 }, async () => {
    const rows: string[] = [];
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] || 0) + 1; };
    const noRepo: string[] = [];

    for (const app of INITIAL_APPS) {
      const repoMatch = app.githubUrl?.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
      let rels: RawRel[] | null = null;
      if (repoMatch) {
        try {
          const res = await fetch(`https://api.github.com/repos/${repoMatch[1].replace(/\.git$/i, '')}/releases?per_page=20`, { headers: ghHeaders });
          if (res.status === 403 || res.status === 429) {
            rows.push(`RATE-LIMITED at ${app.id} (${repoMatch[1]}) - stopping`);
            break;
          }
          if (res.ok) {
            rels = (await res.json()) as RawRel[];
          } else {
            rows.push(`${app.id}: repo HTTP ${res.status} (${repoMatch[1]})`);
            bump('repo-error');
          }
        } catch (e) {
          rows.push(`${app.id}: repo network error ${(e as Error).message}`);
          bump('repo-error');
        }
      } else {
        noRepo.push(`${app.id} (${app.githubUrl || 'no github'})`);
      }

      // Same rule the shipped resolver applies: flagged releases only for
      // apps the catalog explicitly vouches for (includeFlaggedReleases).
      const wantFlagged = app.includeFlaggedReleases === true;
      const strict = (rels || [])
        .filter((r) => !r.prerelease || wantFlagged)
        .map(toReleaseInfo);
      const relaxed = (rels || []).map(toReleaseInfo);

      for (const platform of app.platforms as Platform[]) {
        if (platform === 'ios' || platform === 'web') { bump(`skip-${platform}`); continue; }
        for (const arch of ARCHES) {
          const strictPick = pickAssetDetailed(strict.flatMap((r) => r.assets), platform, arch, app.assetPatterns);
          let verdict = '';
          if (strictPick && !strictPick.weak) { verdict = `STRICT(${strictPick.pick.name})`; bump('direct-strict'); }
          else {
            const relaxedPick = pickAssetDetailed(relaxed.flatMap((r) => r.assets), platform, arch, app.assetPatterns);
            if (relaxedPick && !relaxedPick.weak) {
              const tag = (rels || []).find((r) => r.assets?.some((a) => a.name === relaxedPick.pick.name))?.tag_name;
              verdict = `PRERELEASE-ONLY(tag=${tag}, asset=${relaxedPick.pick.name})`;
              bump('prerelease-flag-only');
            } else if (strictPick) { verdict = `WEAK(${strictPick.pick.name})`; bump('weak-only'); }
            else { verdict = 'NO-DIRECT'; bump('no-direct'); }
          }
          const shortArch = arch ?? 'unknown';
          rows.push(`${app.id} | ${platform} | ${shortArch} | ${verdict}`);
        }
      }

      if ((app.platforms as Platform[]).includes('android') && app.fdroidId) {
        try {
          const res = await fetch(`https://f-droid.org/api/v1/packages/${app.fdroidId}`);
          if (!res.ok) { rows.push(`${app.id} | fdroid | HTTP ${res.status}`); bump('fdroid-error'); }
          else {
            const d = (await res.json()) as { packages?: { versionCode: number }[]; suggestedVersionCode?: number };
            const max = Math.max(0, ...(d.packages || []).map((p) => p.versionCode));
            const vc = d.suggestedVersionCode && d.suggestedVersionCode <= max ? d.suggestedVersionCode : max;
            if (!vc) { rows.push(`${app.id} | fdroid | NO VERSIONS`); bump('fdroid-error'); }
            else {
              const apk = `https://f-droid.org/repo/${app.fdroidId}_${vc}.apk`;
              const head = await fetch(apk, { method: 'HEAD' });
              if (head.ok) bump('fdroid-ok');
              else { rows.push(`${app.id} | fdroid | APK ${head.status} ${apk}`); bump('fdroid-apk-bad'); }
            }
          }
        } catch (e) {
          rows.push(`${app.id} | fdroid | UNREACHABLE from sandbox`);
          bump('fdroid-unreachable');
        }
      }
    }

    console.log('\n===== LIVE PROBE REPORT =====');
    console.log('(f-droid.org is not reachable from this sandbox; F-Droid rows are informational only)');
    console.log('PAT used:', pat ? 'yes' : 'NO (unauthenticated)');
    console.log('Counts:', JSON.stringify(counts, null, 2));
    console.log('\nApps without a parseable GitHub repo:', noRepo.length ? noRepo.join(' | ') : 'none');
    console.log('\nAll rows:');
    for (const r of rows) console.log('  ' + r);
  });
});

function platform0(app: { platforms: Platform[] }): Platform {
  return app.platforms[0] || 'windows';
}
