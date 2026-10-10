// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import { DICTS } from '../i18n';

const LANGS = ['en', 'fa', 'es', 'fr', 'de'] as const;
const enKeys = Object.keys(DICTS.en).sort();

describe('i18n dictionary parity', () => {
  it('exposes DICTS with exactly the five supported languages', () => {
    expect(Object.keys(DICTS).sort()).toEqual([...LANGS].sort());
  });

  for (const lang of LANGS.filter((l) => l !== 'en')) {
    it(`${lang} has exactly the same key set as en (no missing, no extra)`, () => {
      const keys = Object.keys(DICTS[lang]).sort();
      const missing = enKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !enKeys.includes(k));
      expect(missing, `${lang} is missing keys`).toEqual([]);
      expect(extra, `${lang} has extra keys`).toEqual([]);
    });
  }

  it('every entry in every dict is a string', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(DICTS[lang])) {
        expect(typeof value, `${lang}.${key}`).toBe('string');
      }
    }
  });

  // Replacement contract: whatever {placeholder} the English source carries
  // must survive in every translation, or .replace('{x}', v) silently no-ops.
  const tokenRe = /\{[a-z]+\}/g;
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    it(`${lang} keeps every {placeholder} token from the en source`, () => {
      for (const [key, enValue] of Object.entries(DICTS.en)) {
        for (const token of enValue.match(tokenRe) ?? []) {
          expect(DICTS[lang][key], `${lang}.${key} dropped ${token}`).toContain(token);
        }
      }
    });
  }
});
