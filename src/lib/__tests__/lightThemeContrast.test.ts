// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Automated WCAG 2.x contrast audit of the theme token blocks in
// src/index.css. This is the enforced version of the audit that used to be
// a manual checklist: the light-theme text scale and every accent step that
// can appear as TEXT must hold 4.5:1 (AA, normal text) against the surfaces
// it actually renders on, and the two hardcoded ink pairs that burned us
// (white-on-download-green, amber-950-on-amber-400) are pinned for BOTH
// themes. Decorative-only roles are held at the 3:1 non-text floor instead
// - deliberately NOT darkened further, so hierarchy survives.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8');

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const chan = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

export function contrastRatio(fg: string, bg: string): number {
  const [l1, l2] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function block(anchor: string): string {
  // Anchored with the opening brace so comments that MENTION the selector
  // (e.g. "set in the :root:not(.dark) block further down") cannot match.
  const start = CSS.indexOf('\n' + anchor);
  expect(start, `block ${anchor} exists`).toBeGreaterThanOrEqual(0);
  const end = CSS.indexOf('\n}', start);
  return CSS.slice(start, end);
}

function hexValues(blockCss: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of blockCss.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    map.set(name, value);
  }
  return map;
}

// Tinted chip backgrounds: fg at alpha over a solid surface, computed the
// way the browser composites bg-*/10 chips over cards.
function mix(fg: string, alpha: number, bg: string): string {
  const f = [1, 3, 5].map((i) => parseInt(fg.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return (
    '#' +
    f
      .map((fc, i) => Math.round(alpha * fc + (1 - alpha) * b[i]).toString(16).padStart(2, '0'))
      .join('')
  );
}

const light = hexValues(block(':root:not(.dark)'));

// Surfaces text actually sits on in light mode (page, raised band, card,
// and the two tinted chips). slate-700 (#e9e4d8) carries no accent text;
// icons on it are covered by the 3:1 decorative floor below.
const LIGHT_SURFACES = [
  light.get('slate-950')!, // page (warm paper)
  light.get('slate-900')!, // header/footer band
  light.get('slate-800')!, // cards
  light.get('sky-950')!,   // sky-tinted chips
  light.get('emerald-950')!, // emerald-tinted chips
];

// Active-state chips put white/ink over alpha-tinted accents too. The
// Android platform chip uses the file's light/dark split (emerald-900 ink
// over a 7-12% emerald-800 tint in light, emerald-300 over 10-20% in dark);
// sky chips tint at 10-20% under text-sky-400.
const LIGHT_CHIP_MIXES = [
  mix(light.get('sky-500')!, 0.2, light.get('slate-800')!),
  mix(light.get('sky-500')!, 0.1, light.get('slate-800')!),
];

describe('light theme token contrast (WCAG AA)', () => {
  it('secondary and body text steps meet 4.5:1 on every surface they render on', () => {
    for (const step of ['slate-400', 'slate-300', 'slate-200', 'slate-100']) {
      for (const surface of LIGHT_SURFACES) {
        const r = contrastRatio(light.get(step)!, surface);
        expect(r, `${step} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('slate-500 stays decorative-only: >= 3:1 everywhere, never darkened to hide the role', () => {
    // The brief keeps a distinct low-emphasis token. It must NOT be used
    // for text (components were swept to slate-400) and must NOT be made
    // identical to slate-400 ("do not make every element equally dark").
    expect(light.get('slate-500')).not.toBe(light.get('slate-400'));
    for (const surface of [...LIGHT_SURFACES, light.get('slate-700')!]) {
      const r = contrastRatio(light.get('slate-500')!, surface);
      expect(r, `slate-500 (icons/separators) on ${surface}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('accent steps used as text meet 4.5:1 on surfaces and matching tints', () => {
    const textAccents: Array<[string, string[]]> = [
      ['sky-400', [...LIGHT_SURFACES, ...LIGHT_CHIP_MIXES.slice(0, 2)]],
      ['sky-500', LIGHT_SURFACES],
      ['sky-600', LIGHT_SURFACES],
      ['sky-300', LIGHT_SURFACES],
      ['emerald-400', LIGHT_SURFACES],
      ['emerald-500', LIGHT_SURFACES],
      ['emerald-300', [...LIGHT_SURFACES, mix(light.get('emerald-500')!, 0.15, light.get('slate-800')!)]],
      // emerald-900 is the Android chip's light ink; it is a Tailwind
      // default (#064e3b) - the light block deliberately does not remap it.
      ['emerald-900|#064e3b', [...LIGHT_SURFACES, mix(light.get('emerald-500')!, 0.12, light.get('slate-800')!)]],
      ['rose-400', LIGHT_SURFACES],
      ['rose-500', LIGHT_SURFACES],
      ['rose-300', LIGHT_SURFACES],
      ['amber-300', LIGHT_SURFACES],
      ['indigo-400', LIGHT_SURFACES],
    ];
    for (const [step, surfaces] of textAccents) {
      const value = step.includes('|') ? step.split('|')[1] : light.get(step)!;
      for (const surface of surfaces) {
        const r = contrastRatio(value, surface);
        expect(r, `${step} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the green Download button keeps white text at AA in BOTH themes', () => {
    // bg-fr-success-strong resolves to emerald-700 (never overridden in
    // either scope) and hover to emerald-800; white on each must pass.
    const dark = hexValues(block(':root {'));
    expect(contrastRatio('#ffffff', '#047857')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', '#065f46')).toBeGreaterThanOrEqual(4.5);
    // Guard the assumption the buttons rely on: the steps are NOT remapped.
    expect(dark.has('emerald-700')).toBe(false);
    expect(light.has('emerald-700')).toBe(false);
    expect(dark.has('emerald-800')).toBe(false);
    expect(light.has('emerald-800')).toBe(false);
  });

  it('bright badge ink stays readable on amber in BOTH themes', () => {
    // The trending badge: bg-amber-400 with text-amber-950 (#451a03). The
    // old text-slate-950 resolved to warm PAPER in light mode (1.95:1).
    expect(contrastRatio('#451a03', light.get('amber-400')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#451a03', '#fbbf24')).toBeGreaterThanOrEqual(4.5);
  });

  it('the selected filter chip is readable in BOTH themes', () => {
    // bg-emerald-500 with white (light) / slate-950 (dark) ink. Dark values
    // are the effective defaults: emerald-500 is Tailwind's #10b981 (the
    // dark :root block does not remap it) and slate-950 is @theme's #090d16.
    expect(contrastRatio('#ffffff', light.get('emerald-500')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#090d16', '#10b981')).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus indicator holds the 3:1 non-text floor on paper in both themes', () => {
    // Dark focus = Tailwind sky-500 default #38bdf8 (not remapped in the
    // dark block); light focus = the overridden #0c73a6.
    expect(contrastRatio('#38bdf8', '#090d16')).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(light.get('sky-500')!, light.get('slate-950')!)).toBeGreaterThanOrEqual(3.0);
  });

  it('danger and success note inks hold 4.5:1 on their own tinted wells (light)', () => {
    // The detail modal renders resolver errors on bg-rose-500/10 and the
    // F-Droid call-to-action on bg-emerald-500/10, both over the light
    // card. Their light ink is a dark accent step (Tailwind defaults, NOT
    // remapped by the light block); the previous pale inks (rose-200,
    // emerald-200 - Tailwind defaults around 1.1:1 here) were unreadable.
    const roseWell = mix(light.get('rose-500')!, 0.1, light.get('slate-800')!);
    const emeraldWell = mix(light.get('emerald-500')!, 0.1, light.get('slate-800')!);
    expect(contrastRatio('#881337', roseWell)).toBeGreaterThanOrEqual(4.5); // rose-900
    expect(contrastRatio('#881337', light.get('slate-800')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#064e3b', emeraldWell)).toBeGreaterThanOrEqual(4.5); // emerald-900
    expect(contrastRatio('#064e3b', light.get('slate-800')!)).toBeGreaterThanOrEqual(4.5);
    // And the pale steps that burned here are pinned as the failures they
    // are, so nobody "restores" them believing they were readable.
    expect(contrastRatio('#fecdd3', roseWell)).toBeLessThan(2.0); // rose-200
    expect(contrastRatio('#d1fae5', emeraldWell)).toBeLessThan(2.0); // emerald-200
  });

  it('decorative-only steps never reappear as real text in the swept components', () => {
    // slate-600's light value (#d8d1c1) measures ~1.2:1 on the paper card;
    // it is a border/scrollbar step. TableView used to render the
    // "Direct download" label and the zero-star placeholder with it -
    // invisible text in light mode. Same failure family as rose-200 /
    // emerald-200 above (dark-first leftovers that only the rendered
    // screenshots exposed). Pin the sweep so the classes cannot return.
    const tableView = readFileSync(join(__dirname, '..', '..', 'components', 'TableView.tsx'), 'utf8');
    expect(tableView).not.toContain('text-slate-600');
    const detailModal = readFileSync(join(__dirname, '..', '..', 'components', 'AppDetailModal.tsx'), 'utf8');
    expect(detailModal).not.toContain('text-rose-200');
    expect(detailModal).not.toContain('text-emerald-200');
  });

  it('warning-text ambers resolve to the deepened light step, never the badge fill step (round 26)', () => {
    // The light block deepens amber-400 to #dda50e (a BADGE FILL step: it
    // needs ~2:1 against paper to carry dark ink, not to BE the ink). Real
    // warning TEXT that renders amber in light mode must therefore use
    // amber-300 (#8a6206, >= 4.5:1 on every paper surface) with the bright
    // default reserved for dark mode. The three regressed usages: the
    // detail modal's weak-pick hint, the export modal's copy-failed
    // feedback, and the batch modal's skip note.
    expect(contrastRatio(light.get('amber-300')!, light.get('slate-800')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.get('amber-300')!, light.get('slate-950')!)).toBeGreaterThanOrEqual(4.5);
    // The overridden 400/500 steps stay pinned AS FAILURES as text on the
    // card, so they cannot quietly become text inks again.
    expect(contrastRatio(light.get('amber-400')!, light.get('slate-800')!)).toBeLessThan(4.5);
    expect(contrastRatio(light.get('amber-500')!, light.get('slate-800')!)).toBeLessThan(4.5);
    const detailModal = readFileSync(join(__dirname, '..', '..', 'components', 'AppDetailModal.tsx'), 'utf8');
    const exportModal = readFileSync(join(__dirname, '..', '..', 'components', 'ExportModal.tsx'), 'utf8');
    const batchModal = readFileSync(join(__dirname, '..', '..', 'components', 'BatchInstallModal.tsx'), 'utf8');
    for (const [name, src] of [
      ['AppDetailModal', detailModal],
      ['ExportModal', exportModal],
      ['BatchInstallModal', batchModal],
    ] as const) {
      expect(src, name).not.toMatch(/(?<!dark:)text-amber-(400|500)(?![\w-])/);
    }
  });

  it('the header update pill holds AA in BOTH themes (round 26)', () => {
    // Light: bg-amber-400 (#dda50e) with amber-950 ink - the same verified
    // recipe as the card pick badge. The old light pair (amber-900 #78350f
    // on the OVERRIDDEN amber-300 #8a6206) measured 1.65:1. Dark keeps
    // amber-300 (#fcd34d) with amber-900.
    expect(contrastRatio('#451a03', light.get('amber-400')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#78350f', '#fcd34d')).toBeGreaterThanOrEqual(4.5);
    // Dark hover (amber-200 #fef08a) keeps amber-900 readable.
    expect(contrastRatio('#78350f', '#fef08a')).toBeGreaterThanOrEqual(4.5);
    const header = readFileSync(join(__dirname, '..', '..', 'components', 'Header.tsx'), 'utf8');
    // The broken light pair must not return: amber-900 text directly on
    // the overridden amber-300 fill without a dark: split.
    expect(header).not.toMatch(/text-amber-900 bg-amber-300/);
  });
});
