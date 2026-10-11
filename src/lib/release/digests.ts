// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { ResolvedDownload } from './types';

/**
 * Trusted-digest integrity for resolved downloads.
 *
 * Vendors that publish per-file checksums (GIMP's gimp_versions.json,
 * Signal's latest*.yml, Proton's version.json) hand the download engine
 * the ability to DELETE a corrupted or tampered file instead of presenting
 * it as finished. That only protects anyone when the digest is bound to
 * EXACTLY the file it describes. This module owns that binding:
 *
 *   - a digest is accepted only when it is syntactically valid for its
 *     algorithm (lowercase hex, exact digest length);
 *   - a digest can only be attached through attachTrustedDigests(), which
 *     copies the digest fields from the SAME manifest entry that produced
 *     the download - there is no API that takes a digest and a download
 *     separately, so a digest from a different asset or version cannot be
 *     glued on, not even by accident;
 *   - malformed input is DISCARDED (the download stays unverified) and
 *     recorded in the diagnostics ring, never silently normalized into
 *     something that looks verified;
 *   - absent digests stay absent: `expectedSha256 === undefined` means
 *     UNVERIFIED. Nothing in this module ever manufactures a placeholder
 *     that the engine could mistake for a verified download.
 */

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

export type DigestAlgorithm = 'sha256' | 'sha512';

/** Three-state verdict for a digest a manifest carried. String-literal
 * discriminant on purpose: the project does not compile with strict mode,
 * and boolean-literal discriminants do not narrow without strictNullChecks
 * (this bit is load-bearing - do not "simplify" it back to ok: true/false).
 */
export type DigestCheck =
  | { state: 'valid'; value: string }
  | { state: 'absent' }
  | { state: 'invalid'; reason: string };

/** A digest as a vendor manifest carries it: possibly uppercase, possibly
 * whitespace-padded, possibly garbage. */
export function normalizeTrustedDigest(algo: DigestAlgorithm, raw: string | undefined | null): DigestCheck {
  if (raw === undefined || raw === null) return { state: 'absent' };
  if (typeof raw !== 'string') return { state: 'invalid', reason: 'not a string' };
  const v = raw.trim().toLowerCase();
  if (v === '') return { state: 'invalid', reason: 'empty string' };
  // A digest that is not pure lowercase hex after normalization is not a
  // digest this engine can verify (base64 manifests must be converted by
  // the resolver that reads the manifest, BEFORE it reaches this gate).
  const valid = algo === 'sha256' ? HEX_64.test(v) : HEX_128.test(v);
  if (!valid) {
    return {
      state: 'invalid',
      reason: `not a valid lowercase hex ${algo} digest (got ${v.length} chars)`,
    };
  }
  return { state: 'valid', value: v };
}

/* ------------------------------------------------------------------ */
/* Diagnostics: malformed digests are dropped, never silent            */
/* ------------------------------------------------------------------ */

export interface DigestDiagnostic {
  at: number;
  /** Which manifest entry the malformed digest came from. */
  source: string;
  algo: DigestAlgorithm;
  reason: string;
}

const DIAGNOSTICS_MAX = 20;
const digestDiagnostics: DigestDiagnostic[] = [];

/** Record and expose (for tests/support) every discarded digest. Kept as a
 * bounded ring so a chatty manifest cannot grow memory without bound. */
function recordDiagnostic(source: string, algo: DigestAlgorithm, reason: string): void {
  digestDiagnostics.push({ at: Date.now(), source, algo, reason });
  if (digestDiagnostics.length > DIAGNOSTICS_MAX) digestDiagnostics.shift();
}

export function peekDigestDiagnostics(): readonly DigestDiagnostic[] {
  return digestDiagnostics;
}

/* ------------------------------------------------------------------ */
/* The attachment API (the only way a digest enters a resolution)      */
/* ------------------------------------------------------------------ */

/** The per-file checksum fields a vendor manifest may carry for ONE entry.
 * Structurally a subset of what pickOfficial reads, so a manifest row can
 * be passed through unchanged. */
export interface DigestBearing {
  sha256?: string;
  sha512?: string;
}

/**
 * Fail closed on CONFLICTING duplicate manifest rows.
 *
 * A well-formed vendor manifest lists one row per file. When the same
 * filename appears twice with DIFFERENT digest values (a broken mirror
 * merge, a hand-edited manifest, a parsing bug), at most one of the two
 * digests can be true - and picking one would be order-dependent, i.e.
 * the same release could verify differently depending on the order the
 * API returned rows in. Trust that flips with input order is not trust:
 * every row of a conflicting name has its digests STRIPPED here (the
 * download stays unverified) and a diagnostic is recorded. Rows whose
 * digests agree byte-for-byte are duplicates, not conflicts - kept as-is.
 *
 * Rows with NO digest at all are untouched (absent stays absent).
 */
export function failClosedConflictingDigests<T extends { name: string } & DigestBearing>(
  items: readonly T[],
  source: string
): T[] {
  // One pass to collect the digest sets per name.
  const seen = new Map<string, { sha256?: string; sha512?: string }>();
  const conflicts = new Set<string>();
  for (const it of items) {
    if (it.sha256 === undefined && it.sha512 === undefined) continue;
    const prev = seen.get(it.name);
    if (!prev) {
      seen.set(it.name, { sha256: it.sha256, sha512: it.sha512 });
      continue;
    }
    if (prev.sha256 !== it.sha256 || prev.sha512 !== it.sha512) {
      conflicts.add(it.name);
    }
  }
  if (conflicts.size === 0) return items.slice();
  for (const name of conflicts) {
    recordDiagnostic(
      source,
      // An algo is required by the diagnostic shape; the conflict is about
      // the row pair, so record it under the first algorithm that differs.
      'sha256',
      `conflicting duplicate digest entries for "${name}" - digest stripped (fail closed, unverified)`
    );
  }
  return items.map((it) =>
    conflicts.has(it.name) ? { ...it, sha256: undefined, sha512: undefined } : it
  );
}

/**
 * Attach the digests of ONE manifest entry onto the download that entry
 * produced. `source` names the entry (filename is enough) for diagnostics.
 *
 * The download object is returned unchanged (new object) when nothing
 * valid remains to attach; `expectedSha256`/`expectedSha512` then stay
 * undefined, which the engine reports as unverified - never as verified.
 */
export function attachTrustedDigests<T extends ResolvedDownload>(
  download: T,
  entry: DigestBearing,
  source: string
): T {
  const out = { ...download } as unknown as Record<string, unknown>;
  for (const algo of ['sha256', 'sha512'] as const) {
    const field = algo === 'sha256' ? 'expectedSha256' : 'expectedSha512';
    // Guard against a caller that pre-populated the field with something
    // the resolver did not vouch for in the same breath.
    delete out[field];
    const norm = normalizeTrustedDigest(algo, entry[algo]);
    if (norm.state === 'valid') {
      out[field] = norm.value;
    } else if (norm.state === 'invalid') {
      // A PRESENT but malformed digest is a data bug worth surfacing: the
      // vendor shipped a checksum nobody can verify against.
      recordDiagnostic(source, algo, norm.reason);
    }
    // 'absent' is the normal case for most vendors: stay quiet, stay
    // unverified.
  }
  return out as unknown as T;
}

/**
 * Re-validate digests that come OUT of the persisted cache. Data written
 * by an older build (or hand-edited storage) must not re-enter the engine
 * looking trusted; anything malformed is dropped here with a diagnostic.
 * Returns the entry unchanged when everything is fine.
 */
export function revalidatePersistedDigests(hit: ResolvedDownload, persistedKey: string): ResolvedDownload {
  if (!hit || (hit.expectedSha256 === undefined && hit.expectedSha512 === undefined)) return hit;
  const cleaned = { ...hit } as unknown as Record<string, unknown>;
  for (const algo of ['sha256', 'sha512'] as const) {
    const field = algo === 'sha256' ? 'expectedSha256' : 'expectedSha512';
    const norm = normalizeTrustedDigest(algo, cleaned[field] as string | undefined);
    if (norm.state !== 'valid') {
      delete cleaned[field];
      if (norm.state === 'invalid') recordDiagnostic(`persisted:${persistedKey}`, algo, norm.reason);
    }
  }
  return cleaned as unknown as ResolvedDownload;
}
