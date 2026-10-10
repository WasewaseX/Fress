// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';
import { FdroidInfo } from './types';

/**
 * F-Droid provider: reads the official package index and picks the
 * suggested version code (falling back to the newest known one). Knows
 * nothing about GitHub or asset scoring.
 */

export async function getFdroid(pkg: string): Promise<FdroidInfo> {
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
