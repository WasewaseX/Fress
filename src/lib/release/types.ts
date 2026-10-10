// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Platform } from '../../types';

/**
 * Shared release/asset types for the download resolvers.
 *
 * This module owns the data shapes that cross resolver boundaries:
 * provider modules (GitHub, F-Droid) produce them, the matching layer
 * scores against them, and the UI consumes them. Nothing here imports
 * from other release modules - types only, so dependency arrows always
 * point from the implementations toward this file.
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
  /** 'github' = release assets, 'fdroid' = the F-Droid index, 'official' =
   * the project's own manifest/CDN outside GitHub (Tor, Signal, Proton, ...). */
  source: 'github' | 'fdroid' | 'official';
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
  /** Checksums the vendor published in the same manifest that named the
   * file (GIMP's gimp_versions.json, Signal's latest*.yml / latest.json,
   * Proton's version.json). The download engine deletes any file that
   * fails them, so a corrupted or tampered download can never look
   * finished. Absent when the manifest ships no per-file checksum. */
  expectedSha256?: string;
  expectedSha512?: string;
}

export interface FdroidInfo {
  apkUrl: string;
  pageUrl: string;
  version: string;
  versionCode: number;
}

/** Below this heuristic score the pick is reported as low confidence.
 * A typical solid pick scores 6-13; 1 and below means the only candidate
 * was an odd extension or something stripped of identifying markers. */
export const WEAK_SCORE_MAX = 1;

export interface AssetPick {
  pick: ReleaseAsset;
  matchedBy: 'override' | 'heuristic';
  weak: boolean;
}

/* ------------------------------------------------------------------ */
/* Android ABI vocabulary (shared with the self-updater)               */
/* ------------------------------------------------------------------ */

export type AndroidAbi = 'arm64' | 'arm' | 'x86' | 'x86_64';

/** What the runtime actually knows about the device. "unknown" is NOT a
 * synonym for x86_64: guessing x86_64 for a browser on a reduced user agent
 * is exactly what made ARM phones get handed x86_64-only APKs they cannot
 * install. Unknown devices fall back to universal APKs instead. */
export type DeviceAbi = AndroidAbi | 'unknown';

/** The per-platform naming patterns a catalog entry may pin. Declared here
 * so both the matching layer and the resolver orchestration share one
 * shape. */
export type PlatformPatterns = Partial<Record<Platform, string>>;
