// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

/**
 * The strict release-tag parser, shared by everything that must decide
 * whether a tag is a stable version, a prerelease, or not a version at
 * all: the self-update channel policy and the atom fallback's unstable
 * gate both read it, so the two can never drift apart on what counts as
 * a prerelease. Leaf module - imports nothing.
 */

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
export function stripVPrefix(v: string): string {
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
