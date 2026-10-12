// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Rejection-behavior tests for scripts/validate-versions.mjs - the single
// authoritative version-coherence command (npm run validate:versions) that
// both ci.yml and release.yml invoke. The tests drive the REAL script as a
// child process against synthetic fixture trees in temporary directories,
// so the exact bytes CI executes are what is under test.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/validate-versions.mjs', import.meta.url));

const VERSION = '1.0.10-beta';

interface Tree {
  dir: string;
  cleanup: () => void;
}

function buildTree(overrides: {
  version?: string;
  cargoTomlVersion?: string;
  tauriVersion?: string;
  lockRootVersion?: string;
  lockPkgVersion?: string;
  cargoLockVersion?: string;
  omitFressCrate?: boolean;
}): Tree {
  const dir = mkdtempSync(path.join(tmpdir(), 'fress-validate-versions-'));
  const v = overrides.version ?? VERSION;
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fress', version: v, private: true }),
  );
  mkdirSync(path.join(dir, 'src-tauri'));
  writeFileSync(
    path.join(dir, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "fress"\nversion = "${overrides.cargoTomlVersion ?? v}"\n`,
  );
  writeFileSync(
    path.join(dir, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ version: overrides.tauriVersion ?? v }),
  );
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      version: overrides.lockRootVersion ?? v,
      packages: { '': { version: overrides.lockPkgVersion ?? v } },
    }),
  );
  const crateVersion = overrides.cargoLockVersion ?? v;
  const cargoLock = overrides.omitFressCrate
    ? `[[package]]\nname = "other"\nversion = "0.1.0"\n`
    : `[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "fress"\nversion = "${crateVersion}"\n`;
  writeFileSync(path.join(dir, 'src-tauri', 'Cargo.lock'), cargoLock);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args: string[], dir: string) {
  return spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
}

describe('validate-versions.mjs (the authoritative version-coherence command)', () => {
  it('a coherent development tree passes without any tag expectation', () => {
    const t = buildTree({});
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(0);
      // Development mode is explicit about NOT comparing against a release.
      expect(r.stdout).toContain('not required for a development build');
    } finally {
      t.cleanup();
    }
  });

  it('a post-release development version does NOT have to match the published release', () => {
    // The published release is v1.0.9-beta while main carries the next
    // version: ordinary integration builds must stay green. Nothing in
    // dev mode consults any published tag, so this passes by construction.
    const t = buildTree({ version: '1.0.10-beta' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('a matching release tag passes', () => {
    const t = buildTree({});
    try {
      const r = run(['--expect-tag', `v${VERSION}`], t.dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`ok tag binding: v${VERSION}`);
    } finally {
      t.cleanup();
    }
  });

  it('a release tag that disagrees with the manifests fails before publication', () => {
    const t = buildTree({});
    try {
      const r = run(['--expect-tag', 'v1.0.9-beta'], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('release tag (v1.0.9-beta) != package.json version');
    } finally {
      t.cleanup();
    }
  });

  it('catches Cargo.toml drift', () => {
    const t = buildTree({ cargoTomlVersion: '0.0.1' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src-tauri/Cargo.toml version (0.0.1)');
    } finally {
      t.cleanup();
    }
  });

  it('catches tauri.conf.json drift', () => {
    const t = buildTree({ tauriVersion: '0.0.1' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src-tauri/tauri.conf.json version (0.0.1)');
    } finally {
      t.cleanup();
    }
  });

  it('catches package-lock.json root drift', () => {
    const t = buildTree({ lockRootVersion: '0.0.1' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('package-lock.json .version (0.0.1)');
    } finally {
      t.cleanup();
    }
  });

  it('catches package-lock.json packages[""] drift', () => {
    const t = buildTree({ lockPkgVersion: '0.0.1' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('packages[""].version (0.0.1)');
    } finally {
      t.cleanup();
    }
  });

  it('catches a stale fress crate entry in Cargo.lock', () => {
    const t = buildTree({ cargoLockVersion: '0.0.1' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src-tauri/Cargo.lock fress version (0.0.1)');
    } finally {
      t.cleanup();
    }
  });

  it('catches a missing fress crate entry in Cargo.lock', () => {
    const t = buildTree({ omitFressCrate: true });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not find the "fress" crate entry');
    } finally {
      t.cleanup();
    }
  });

  it('catches a malformed version shape', () => {
    const t = buildTree({ version: '1.0' });
    try {
      const r = run([], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not MAJOR.MINOR.PATCH');
    } finally {
      t.cleanup();
    }
  });

  it('the release path enforces lockfile coherence too, even with a matching tag', () => {
    // Stricter than the old inline release shell (which skipped the
    // lockfiles): a tag whose lockfiles drifted must not publish.
    const t = buildTree({ cargoLockVersion: '0.0.1' });
    try {
      const r = run(['--expect-tag', `v${VERSION}`], t.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src-tauri/Cargo.lock fress version');
    } finally {
      t.cleanup();
    }
  });
});
