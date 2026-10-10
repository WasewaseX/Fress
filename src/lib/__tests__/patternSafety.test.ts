// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import {
  MAX_PATTERN_LENGTH,
  analyzePatternSafety,
  compileSafePattern,
} from '../patternSafety';
import { sanitizeAppItem } from '../appValidation';
import { INITIAL_APPS } from '../../data/appsData';
import type { AppItem } from '../../types';

/* ------------------------------------------------------------------ */
/* The safe subset: patterns that MUST keep working                    */
/* ------------------------------------------------------------------ */

describe('analyzePatternSafety, accepted shapes', () => {
  const accepts = (p: string) =>
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(analyzePatternSafety(p).safe).toBe(true);
    });

  // The exact shapes the shipped catalog uses (audited wholesale below).
  accepts('app-full-release\\.apk$');
  accepts('AppFlowy-.+\\.apk$');
  accepts('^WhisperDesktop\\.zip$');
  accepts('^tutanota-desktop-');
  accepts('^photos-');
  accepts('Cake_Wallet_v[\\d.]+_Linux\\.tar\\.xz$');
  accepts('^ollama-linux-[^-]+\\.tar\\.zst$');
  accepts('com\\.x8bit\\.bitwarden\\.apk$');

  // General safe constructs.
  accepts('.*');
  accepts('.+');
  accepts('[a-z]+');
  accepts('[^-]+');
  accepts('v\\d+');
  accepts('(exe|msi|zip)$');
  accepts('(?:\\d{1,3}\\.){3}\\d{1,3}');
  accepts('(v\\d+)?-x64');
  accepts('(Fress|fress)[-_.]?[\\d.]+');
  accepts('^Fress_.*_arm64\\.apk$');
  accepts('a{0,2}b');
  accepts('^abc$');
});

/* ------------------------------------------------------------------ */
/* The exponential class: patterns that MUST be refused                */
/* ------------------------------------------------------------------ */

describe('analyzePatternSafety, rejected shapes (exponential backtracking class)', () => {
  const rejects = (p: string, reason?: string) =>
    it(`rejects ${JSON.stringify(p)}`, () => {
      const v = analyzePatternSafety(p);
      expect(v.safe).toBe(false);
      if (reason) expect(v.reason).toBe(reason);
    });

  // Classic nested-quantifier killers.
  rejects('(a+)+$', 'unbounded-group-with-inner-quantifier');
  rejects('(a*)*', 'unbounded-group-with-inner-quantifier');
  rejects('(.*)*', 'unbounded-group-with-inner-quantifier');
  rejects('^(a|aa)+$', 'unbounded-group-with-alternation');
  rejects('(a+b)+$', 'unbounded-group-with-inner-quantifier');
  // Bounded inner quantifiers still blow up exponentially under an
  // unbounded outer group: (a{0,2})* is Fibonacci, not linear.
  rejects('(a{0,2})*$', 'unbounded-group-with-inner-quantifier');
  rejects('(a?)*$', 'unbounded-group-with-inner-quantifier');
  // Bounded OUTER repetition of an unbounded inner quantifier is the same
  // multiplicative shape with a smaller base.
  rejects('(a+){1,20}$', 'over-bounded-group-with-inner-unbounded');
  rejects('(.*){2,10}x', 'over-bounded-group-with-inner-unbounded');
  // Absurd repetition counts on a group (the m>20 cap fires first here).
  rejects('(.+){1,500}', 'group-repetition-too-large');
  rejects('(a){500}', 'group-repetition-too-large');
  // Alternation ambiguity without any inner quantifier: the classic
  // (a|aa)+$ shape must be caught even though it contains no quantifier.
  rejects('(a|aa)+$', 'unbounded-group-with-alternation');
  rejects('((a|b))+x', 'unbounded-group-with-alternation');
  // Empty branches inside an unbounded quantified group (also caught by the
  // alternation rule, which is checked first - either rejection is sound).
  rejects('(a||b)+$', 'unbounded-group-with-alternation');

  it('rejects patterns longer than the length cap', () => {
    const p = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(analyzePatternSafety(p).reason).toBe('too-long');
    expect(analyzePatternSafety('a'.repeat(MAX_PATTERN_LENGTH)).safe).toBe(true);
  });

  it('rejects syntactically invalid patterns (same as before, now in one place)', () => {
    expect(analyzePatternSafety('(').reason).toBe('invalid-syntax');
    expect(analyzePatternSafety('a**').reason).toBe('invalid-syntax');
    expect(compileSafePattern('(')).toBeNull();
  });
});

describe('compileSafePattern', () => {
  it('returns a working RegExp for safe patterns', () => {
    const re = compileSafePattern('AppFlowy-.+\\.apk$');
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test('AppFlowy-1.2.3.apk')).toBe(true);
    expect(re!.test('AppFlowy-1.2.3.exe')).toBe(false);
  });

  it('returns null (never throws) for invalid or unsafe patterns', () => {
    expect(compileSafePattern('(a+)+')).toBeNull();
    expect(compileSafePattern('x'.repeat(MAX_PATTERN_LENGTH + 1))).toBeNull();
    expect(compileSafePattern('')).toBeNull();
  });

  it('a compiled safe pattern stays fast on a large input (large-input regression)', () => {
    // A safe but quantifier-heavy pattern against a 100k-char near-miss
    // input: the accepted subset is linear-ish, so this is instant. The
    // point of the test is that no ACCEPTED shape degrades catastrophically
    // with input size.
    const re = compileSafePattern('^[\\w.-]+_[\\d.]+_(x64|arm64)\\.(exe|zip)$');
    expect(re).not.toBeNull();
    const big = `${'a'.repeat(99_990)}_1.0.0_x64.exe!`;
    const start = Date.now();
    re!.test(big);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

/* ------------------------------------------------------------------ */
/* sanitizeAppItem integration                                         */
/* ------------------------------------------------------------------ */

describe('sanitizeAppItem, imported pattern hardening', () => {
  const base = {
    id: 'x',
    name: 'X',
    githubUrl: 'https://github.com/x/x',
  };

  it('keeps valid, safe patterns exactly as before', () => {
    const out = sanitizeAppItem({
      ...base,
      assetPatterns: { windows: 'app-.+\\.exe$', android: 'app-.*\\.apk$' },
      tagPatterns: { windows: '^desktop-' },
    }).app;
    expect(out?.assetPatterns).toEqual({ windows: 'app-.+\\.exe$', android: 'app-.*\\.apk$' });
    expect(out?.tagPatterns).toEqual({ windows: '^desktop-' });
  });

  it('drops malformed patterns (regression)', () => {
    const out = sanitizeAppItem({ ...base, assetPatterns: { windows: '(' }, tagPatterns: { mac: '[a-' } }).app;
    expect(out?.assetPatterns).toBeUndefined();
    expect(out?.tagPatterns).toBeUndefined();
  });

  it('drops excessive-complexity patterns that compile but backtrack exponentially', () => {
    // NEW behavior (documented): unsafe == dropped, same code path as
    // invalid. A backup that smuggles "(a+)+" into assetPatterns must not
    // be able to freeze the resolve path later.
    const out = sanitizeAppItem({
      ...base,
      assetPatterns: { windows: '(a+)+$', linux: '(.*)*x' },
      tagPatterns: { windows: '(a|aa)+$' },
    }).app;
    expect(out?.assetPatterns).toBeUndefined();
    expect(out?.tagPatterns).toBeUndefined();
  });

  it('keeps the safe entries of a mixed pattern map', () => {
    const out = sanitizeAppItem({
      ...base,
      assetPatterns: { windows: 'safe-.+\\.exe$', linux: '(a+)+$' },
    }).app;
    expect(out?.assetPatterns).toEqual({ windows: 'safe-.+\\.exe$' });
  });
});

/* ------------------------------------------------------------------ */
/* Catalog audit: no shipped entry may be silently rejected            */
/* ------------------------------------------------------------------ */

describe('catalog audit against the safe subset', () => {
  it('every assetPatterns/tagPatterns entry in the shipped catalog compiles safely', () => {
    const offenders: string[] = [];
    for (const app of INITIAL_APPS as AppItem[]) {
      for (const [platform, pattern] of Object.entries(app.assetPatterns ?? {})) {
        if (!compileSafePattern(pattern)) offenders.push(`${app.id} assetPatterns.${platform}: ${pattern}`);
      }
      for (const [platform, pattern] of Object.entries(app.tagPatterns ?? {})) {
        if (!compileSafePattern(pattern)) offenders.push(`${app.id} tagPatterns.${platform}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
