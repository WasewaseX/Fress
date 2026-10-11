// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Trusted-digest integrity: a vendor checksum may only ride with EXACTLY
// the asset/version it describes, malformed digests are discarded with a
// diagnostic (never silently "verified"), absence means UNVERIFIED, and
// the digest survives the persist/load/retry round trip unchanged.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  attachTrustedDigests,
  normalizeTrustedDigest,
  peekDigestDiagnostics,
  revalidatePersistedDigests,
} from '../release/digests';
import { loadPersisted, persist } from '../release/resolveCache';
import { ResolvedDownload } from '../release/types';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA512_A = 'c'.repeat(128);

const baseDownload: ResolvedDownload = {
  source: 'official',
  url: 'https://vendor.example/gimp-3.1.0-setup.exe',
  filename: 'gimp-3.1.0-setup.exe',
  size: 300_000_000,
  version: '3.1.0',
};

beforeEach(() => {
  localStorage.clear();
});

describe('normalizeTrustedDigest', () => {
  it('accepts exact-length lowercase hex and normalizes uppercase input', () => {
    expect(normalizeTrustedDigest('sha256', SHA_A)).toEqual({ state: 'valid', value: SHA_A });
    expect(normalizeTrustedDigest('sha256', SHA_A.toUpperCase())).toEqual({
      state: 'valid',
      value: SHA_A,
    });
    expect(normalizeTrustedDigest('sha512', SHA512_A)).toEqual({ state: 'valid', value: SHA512_A });
  });

  it('rejects wrong length, non-hex and empty values as invalid (not absent)', () => {
    expect(normalizeTrustedDigest('sha256', 'abcd').state).toBe('invalid');
    expect(normalizeTrustedDigest('sha256', 'g'.repeat(64)).state).toBe('invalid');
    expect(normalizeTrustedDigest('sha256', SHA_A.slice(1)).state).toBe('invalid'); // 63 chars
    expect(normalizeTrustedDigest('sha512', SHA_A).state).toBe('invalid'); // 64 chars is sha256, not sha512
    expect(normalizeTrustedDigest('sha256', '').state).toBe('invalid');
    expect(normalizeTrustedDigest('sha256', '   ').state).toBe('invalid');
    expect(normalizeTrustedDigest('sha256', undefined).state).toBe('absent');
    expect(normalizeTrustedDigest('sha256', null).state).toBe('absent');
  });
});

describe('attachTrustedDigests (the only way a digest enters a resolution)', () => {
  it('attaches the digest of the SAME manifest entry that produced the download', () => {
    const out = attachTrustedDigests(baseDownload, { sha256: SHA_A, sha512: SHA512_A }, 'gimp-3.1.0-setup.exe');
    expect(out.expectedSha256).toBe(SHA_A);
    expect(out.expectedSha512).toBe(SHA512_A);
    expect(out.url).toBe(baseDownload.url);
    expect(out.filename).toBe(baseDownload.filename);
    expect(out.version).toBe(baseDownload.version);
  });

  it('a digest from a DIFFERENT asset or version cannot be attached to this download', () => {
    // The API takes download + entry as ONE pair: there is no code path
    // that hands it a digest separately. This test pins the call-site
    // shape: attaching entry B's checksums to entry A's download is a
    // different call producing a different download - entry A's result
    // carries only A.
    const entryA = { sha256: SHA_A };
    const entryB = { sha256: SHA_B };
    const downloadA = attachTrustedDigests(baseDownload, entryA, 'gimp-3.1.0-setup.exe');
    const downloadB = attachTrustedDigests(
      { ...baseDownload, url: 'https://vendor.example/gimp-3.0.4-setup.exe', filename: 'gimp-3.0.4-setup.exe', version: '3.0.4' },
      entryB,
      'gimp-3.0.4-setup.exe'
    );
    expect(downloadA.expectedSha256).toBe(SHA_A);
    expect(downloadA.expectedSha256).not.toBe(downloadB.expectedSha256);
    expect(downloadB.expectedSha256).toBe(SHA_B);
  });

  it('no digest in the manifest means unverified, never a fabricated verified state', () => {
    const out = attachTrustedDigests(baseDownload, {}, 'gimp-3.1.0-setup.exe');
    expect(out.expectedSha256).toBeUndefined();
    expect(out.expectedSha512).toBeUndefined();
  });

  it('a weak/picked-anyway download gains no digest it did not bring itself', () => {
    // The GitHub path builds ResolvedDownload without any digest fields
    // (GitHub exposes no per-asset checksums); nothing in the attachment
    // layer may change that.
    const ghDownload: ResolvedDownload = {
      source: 'github',
      url: 'https://github.com/example/tool/releases/download/v1.2.3/Tool-1.2.3-setup-x64.exe',
      filename: 'Tool-1.2.3-setup-x64.exe',
      size: 8_000_000,
      version: '1.2.3',
      weak: true,
    };
    const out = attachTrustedDigests(ghDownload, {}, 'Tool-1.2.3-setup-x64.exe');
    expect(out.expectedSha256).toBeUndefined();
    expect(out.weak).toBe(true);
  });
});

describe('malformed digests are discarded with explicit diagnostics', () => {
  it('drops a malformed vendor checksum and records why', () => {
    const before = peekDigestDiagnostics().length;
    const out = attachTrustedDigests(
      baseDownload,
      { sha256: 'not-a-digest-at-all', sha512: 'zz'.repeat(64) },
      'gimp-3.1.0-setup.exe'
    );
    expect(out.expectedSha256).toBeUndefined();
    expect(out.expectedSha512).toBeUndefined();
    const diags = peekDigestDiagnostics();
    expect(diags.length).toBeGreaterThan(before);
    const last = diags[diags.length - 1];
    expect(last.source).toBe('gimp-3.1.0-setup.exe');
    expect(last.reason).toContain('sha512');
  });

  it('revalidation drops malformed digests that arrive out of the persisted store', () => {
    const before = peekDigestDiagnostics().length;
    const poisoned: ResolvedDownload = { ...baseDownload, expectedSha256: 'deadbeef' };
    const out = revalidatePersistedDigests(poisoned, 'test-key');
    expect(out.expectedSha256).toBeUndefined();
    const diags = peekDigestDiagnostics();
    expect(diags.length).toBeGreaterThan(before);
    expect(diags[diags.length - 1].source).toBe('persisted:test-key');
    // A valid digest survives revalidation untouched.
    const fine = revalidatePersistedDigests({ ...baseDownload, expectedSha256: SHA_A }, 'k2');
    expect(fine.expectedSha256).toBe(SHA_A);
  });
});

describe('digests survive the persist -> load round trip bound to their file', () => {
  it('loadPersisted keeps the digest with the same url/filename/version', () => {
    const hit: ResolvedDownload = {
      ...baseDownload,
      expectedSha256: SHA_A,
      expectedSha512: SHA512_A,
    };
    persist('test|key|arch-u', hit);
    const back = loadPersisted('test|key|arch-u');
    expect(back).toBeDefined();
    expect(back!.expectedSha256).toBe(SHA_A);
    expect(back!.expectedSha512).toBe(SHA512_A);
    expect(back!.url).toBe(baseDownload.url);
    expect(back!.filename).toBe(baseDownload.filename);
    expect(back!.version).toBe(baseDownload.version);
  });

  it('a retry/resume of the same lookup returns the SAME digest, not a mixed one', () => {
    // Resolve A with digest A, persist, then "re-resolve" from the cache
    // (what a resume does): the digest must still describe A.
    const hitA: ResolvedDownload = {
      ...baseDownload,
      url: 'https://vendor.example/app-1.0.exe',
      filename: 'app-1.0.exe',
      version: '1.0',
      expectedSha256: SHA_A,
    };
    persist('repo|windows|||u', hitA);
    // A different version is persisted under its own key; it must never
    // be handed back for A's key.
    persist('repo|windows|||v2|u', {
      ...baseDownload,
      url: 'https://vendor.example/app-2.0.exe',
      filename: 'app-2.0.exe',
      version: '2.0',
      expectedSha256: SHA_B,
    });
    const resumedA = loadPersisted('repo|windows|||u');
    expect(resumedA!.version).toBe('1.0');
    expect(resumedA!.expectedSha256).toBe(SHA_A);
  });

  it('persisting a null keeps the failure a failure (no digest magic)', () => {
    persist('repo|windows|||u', null);
    expect(loadPersisted('repo|windows|||u')).toBeNull();
  });
});
