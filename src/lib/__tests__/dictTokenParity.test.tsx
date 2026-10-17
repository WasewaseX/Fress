// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Dict-level token parity: every interpolation token a translation declares
// must match what the en template declares for the same key, and a token a
// call site supplies must be declared by the template it lands in.
//
// The seed defect: 'bs.selected' (the batch-install toolbar's aria-label)
// is rendered through formatMessage(t('bs.selected'), { n: ... }) in
// BatchInstallModal, but NO locale template declared {n} - the selected-apps
// count was silently dropped from a screen-reader label. formatMessage can
// only replace tokens the template declares; an undeclared supplied token is
// a no-op by design (literal insertion, no magic), so the mismatch surfaced
// as an aria-label stuck at "Selected" with no count.
//
// Token parity across locales is the other half of the same class: a
// translation that loses a token (or invents one) renders literal "{x}" or
// drops data for that language only - invisible to a single-locale reader
// and to every en-only test.

import { describe, expect, it } from 'vitest';

import { DICTS, formatMessage, LANGUAGES } from '../i18n';

const EN = DICTS.en;

function tokensOf(template: string): Set<string> {
  return new Set([...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
}

describe("dict token parity (every locale's tokens match en's for the same key)", () => {
  it('en is complete: every non-en locale key exists in en (fallback source)', () => {
    for (const { code } of LANGUAGES) {
      if (code === 'en') continue;
      for (const key of Object.keys(DICTS[code])) {
        expect(EN[key] !== undefined, `${code} key '${key}' has no en fallback`).toBe(true);
      }
    }
  });

  it('no translation declares a token en lacks, and none drops one en declares', () => {
    for (const { code, label } of LANGUAGES) {
      if (code === 'en') continue;
      for (const [key, enTemplate] of Object.entries(EN)) {
        const enTokens = tokensOf(enTemplate);
        const template = DICTS[code][key];
        if (template === undefined) continue; // absent -> falls back to en by design
        const tokens = tokensOf(template);
        for (const t of enTokens) {
          expect(tokens.has(t), `${label} '${key}' drops {${t}} (en declares it)`).toBe(true);
        }
        for (const t of tokens) {
          expect(enTokens.has(t), `${label} '${key}' invents {${t}} (en lacks it)`).toBe(true);
        }
      }
    }
  });
});

describe("'bs.selected' declares the {n} its call site supplies", () => {
  it("every locale renders the selected-apps count in the batch-install aria-label", () => {
    for (const { code, label } of LANGUAGES) {
      const template = DICTS[code]['bs.selected'];
      expect(template, `${label} is missing 'bs.selected'`).toBeDefined();
      expect(tokensOf(template!).has('n'), `${label} 'bs.selected' must declare {n}`).toBe(true);
      const rendered = formatMessage(template!, { n: 3 });
      expect(rendered, `${label} aria-label must contain the count`).toContain('3');
    }
  });
});
