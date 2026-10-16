// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Behavior tests for scripts/ci/check-no-chinese.mjs
 * (the zero-Chinese-content gate).
 *
 * The checker is exercised as a real subprocess against temporary git
 * fixture trees. NO literal CJK glyph appears in this test file: every
 * offending string is constructed from Unicode escapes at runtime, so the
 * checker can never detect its own fixtures (or this file) as content.
 * Every test asserts the OBSERVABLE CONTRACT: the JSON report fields and
 * the process exit code.
 *
 * Coverage map onto the 14-case adversarial matrix:
 *   1 -> test 1    2 -> test 2    3 -> test 3     4 -> tests 4, 4b, 4c
 *   5 -> test 5    6 -> test 6    7 -> test 7b    8 -> tests 10b, 8b, 8c, 8d
 *   9 -> test 9b  10 -> test 10  11 -> tests 7, 13b  12 -> tests 8, 9
 *  13 -> tests 11, 12, 12c, 12d  14 -> test 9 (12b proves kana warning routing)
 *
 * Critique-round additions (Agent 2 audit wave 2): 20a-20e prove Korean
 * script is never classified as Chinese; 15/15b/21a/21b prove byte-level
 * parser correctness incl. signature-spoof and truncated-container labs;
 * 16/16b prove locale pairing and astral columns/context; 17/17b/21a/21b
 * prove determinism, safe --out behavior and strict flag validation; 17d
 * proves honest history reporting.
 *
 * Integrity-round additions (Agent 2 post-merge audit, mapping the NEW
 * 12-case acceptance matrix): 13c proves a git-execution failure exits 2
 * (case 8); 22 proves multi-file stable code-point sort order plus escaped
 * context (case 10); 23 is the mutation/negative-control pair (case 12:
 * weakened range and raised binary bar both lose hits the real gate keeps);
 * 24 proves the --extra-dir package-extraction primitive (case 8's missing-
 * required-target rule plus the extra-scope finding path).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CHECKER = resolve(process.cwd(), 'scripts/ci/check-no-chinese.mjs');

// Offending characters, constructed from code points (never literals here).
const HANChar = String.fromCodePoint(0x62a5); // a CJK Unified Ideograph
const HANChar2 = String.fromCodePoint(0x544a); // another CJK Unified Ideograph
const FULLWIDTH_BANG = String.fromCodePoint(0xff01); // fullwidth ASCII form
const CJK_PERIOD = String.fromCodePoint(0x3002); // CJK punctuation
const KANA_A = String.fromCodePoint(0x30ec); // a Katakana letter (non-Chinese)
const GREEK_ALPHA = String.fromCodePoint(0x1f00); // polytonic Greek (3-byte UTF-8, clean)
const ZH_LOCALE = `${String.fromCodePoint(0x7a)}${String.fromCodePoint(0x68)}-CN`; // registry form of the banned root
const ZH_PLAIN = `${String.fromCodePoint(0x7a)}${String.fromCodePoint(0x68)}`; // bare banned root
const YUE_ROOT = `${String.fromCodePoint(0x79)}${String.fromCodePoint(0x75)}${String.fromCodePoint(0x65)}`; // banned Cantonese root

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return (run.stdout || '').trim();
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'no-chinese-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  return root;
}

function commitAll(root: string): void {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
}

interface Report {
  summary: { total_hits: number; warnings_count: number; result: string; exit_code: number };
  hits: Array<{ kind: string; path: string; line: number | null; col: number | null; codepoint: string | null; category: string; family: string; context_escaped: string; match_escaped?: string; scope?: string; owner_action: string; role_hint?: string; source?: string; severity?: string }>;
  warnings: Array<{ path: string; codepoint: string | null; category: string }>;
  scope: Record<string, number | null>;
  commit: string | null;
}

function runChecker(root: string, args: string[] = []): { status: number; report: () => Report; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CHECKER, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  });
  return {
    status: run.status ?? -1,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    report: () => {
      const start = run.stdout.indexOf('{');
      if (start < 0) throw new Error(`no JSON report in stdout: ${run.stdout.slice(0, 400)} / ${run.stderr.slice(0, 400)}`);
      return JSON.parse(run.stdout.slice(start)) as Report;
    },
  };
}

describe('check-no-chinese.mjs (spawned against git fixture trees)', () => {
  it('1. a clean multilingual file (en, fa, es, fr, de) passes with exit 0', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'strings.ts'), [
      "export const greetings = {",
      "  en: 'Hello',",
      `  fa: '\u0641\u0627\u0631\u0633\u06cc', // Persian (RTL) is a supported language`,
      "  es: '\u00a1Hola!',",
      "  fr: 'Bonjour',",
      `  de: 'Gr\u00fc\u00df Gott',`,
      '};',
      '',
    ].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.summary.result).toContain('PASS');
    expect(rep.scope.text_files_scanned).toBe(1); // the scan must cover the fixture, not scan nothing
  });

  it('2. a Han character in a source comment fails with codepoint and context', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'widget.ts'), [
      '// A helpful comment.',
      `// TODO: ${HANChar}${HANChar2} verify this path (agent note)`,
      'export const x = 1;',
      '',
    ].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(2);
    expect(rep.hits[0].line).toBe(2);
    expect(rep.hits[0].col).toBe(10); // after "// TODO: " (code-point column)
    expect(rep.hits[0].codepoint).toBe(`U+${0x62a5.toString(16).toUpperCase()}`);
    expect(rep.hits[0].family).toContain('Chinese');
    expect(rep.hits[0].context_escaped).toContain('\\u62a5');
  });

  it('3. a Han character in a catalog description (user-visible data) fails', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'catalog.json'), JSON.stringify({
      apps: [{ id: 'sample', description: { en: 'A tool', de: `Ein Werkzeug (${HANChar})` } }],
    }, null, 1));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.hits[0].path).toBe('catalog.json');
    expect(rep.hits[0].family).toContain('Han');
    expect(rep.hits[0].role_hint).toContain('catalog'); // owner routing must name the data class
  });

  it('4. a Chinese locale identifier fails (registry form and bare form)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'locales.json'), JSON.stringify({ supported: ['en', 'fa', ZH_LOCALE, 'de'] }));
    writeFileSync(join(root, 'other.md'), `Configuration uses ${ZH_PLAIN} as a fallback.\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    const localeHits = rep.hits.filter((h) => h.kind === 'locale-identifier');
    expect(localeHits.length).toBe(2); // exactly the two fixture lines
    expect(localeHits[0].category).toContain('locale identifier');
    // Hex strings and words containing the root as a substring must NOT match.
    writeFileSync(join(root, 'clean-ids.ts'), 'const a = 0xzh_no;\n// "zhSize" and "hz" and "zhx" are not locale ids\nconst zhSize = 1;\n');
    commitAll(root);
    const r2 = runChecker(root);
    const localeHits2 = r2.report().hits.filter((h) => h.kind === 'locale-identifier' && h.path === 'clean-ids.ts');
    expect(localeHits2).toHaveLength(0);
  });

  it('5. CJK punctuation and fullwidth forms are reported with exact line and column', () => {
    const root = makeRepo();
    const line2 = `note = 'done${FULLWIDTH_BANG}next${CJK_PERIOD}'`;
    writeFileSync(join(root, 'punct.ts'), [`const a = 1;`, line2, ''].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(2);
    expect(rep.hits[0].line).toBe(2);
    expect(rep.hits[0].col).toBe(13); // code-point column of the fullwidth bang
    expect(rep.hits[1].col).toBe(18); // CJK period
    expect(rep.hits[0].family).toContain('fullwidth');
    expect(rep.hits[1].family).toContain('punctuation');
  });

  it('6. an offending character in a FILE NAME is detected', () => {
    const root = makeRepo();
    const dir = join(root, `docs-${HANChar}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'readme.md'), 'plain English content\n');
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    const nameHit = rep.hits.find((h) => h.kind === 'filename' && h.path.includes(HANChar));
    expect(nameHit).toBeTruthy();
    expect(nameHit?.line).toBeNull(); // a name finding has no line
  });

  it('7. a malformed (invalid UTF-8, non-binary) file does not silently pass', () => {
    const root = makeRepo();
    // 0xC3 0x28 is an invalid UTF-8 sequence; no NUL byte, so it is not a
    // recognized binary - the checker must fail closed on it.
    writeFileSync(join(root, 'broken.txt'), Buffer.from([0x70, 0x6c, 0x61, 0x69, 0x6e, 0xc3, 0x28, 0x0a]));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.hits.some((h) => h.kind === 'unreadable-file' && h.path === 'broken.txt')).toBe(true);
    expect(rep.hits[0].owner_action).toContain('fail');
  });

  it('8. real UTF-8 content and \\u escape sequences are handled consistently', () => {
    const root = makeRepo();
    // Escape-only source: the BYTES are ASCII - must pass.
    writeFileSync(join(root, 'escaped.ts'), `const s = '\\u62a5\\u544a'; // escape sequence, ASCII bytes\n`);
    // Real UTF-8 bytes: must fail.
    writeFileSync(join(root, 'real.ts'), `const s = '${HANChar}${HANChar2}';\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.hits.some((h) => h.path === 'real.ts')).toBe(true);
    expect(rep.hits.some((h) => h.path === 'escaped.ts')).toBe(false);
  });

  it('9. the checker does not flag its own source or escape-only fixtures', () => {
    const root = makeRepo();
    copyFileSync(CHECKER, join(root, 'check-copy.mjs'));
    writeFileSync(join(root, 'escapes.mjs'), [
      `const RE = new RegExp('\\\\u4e00-\\\\u9fff'); // escape text, ASCII bytes`,
      `const root = String.fromCharCode(0x7a, 0x68); // constructed, no literal`,
      '',
    ].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    expect(r.report().hits).toHaveLength(0);
  });

  it('10. a font binary with glyph-like bytes is skipped, not diagnosed as visible text', () => {
    const root = makeRepo();
    // Font-shaped binary: NUL bytes, high bytes including UTF-8 encodings of
    // Han code points, under a .ttf name. Glyph coverage is NOT UI copy.
    const glyphNoise = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x80]),
      Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]), // UTF-8 of two Han chars
      Buffer.from([0x00, 0x00, 0x00, 0xc2, 0xa9, 0x00]),
    ]);
    writeFileSync(join(root, 'fixture-font.ttf'), glyphNoise);
    writeFileSync(join(root, 'app.ttf'), glyphNoise);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.scope.font_binaries_skipped_glyph_coverage_not_text).toBe(2);
  });

  it('10b. a PNG text chunk carrying Han script IS reported (binary metadata is inspected)', () => {
    const root = makeRepo();
    // Minimal PNG structure: signature + IHDR + tEXt (with a Han char) + IEND.
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); // parser does not validate CRCs
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
    };
    const ihdr = chunk('IHDR', Buffer.alloc(13));
    const textChunk = chunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.from(`made by ${HANChar}`, 'utf8')]));
    const iend = chunk('IEND', Buffer.alloc(0));
    writeFileSync(join(root, 'icon.png'), Buffer.concat([sig, ihdr, textChunk, iend]));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    const hit = rep.hits.find((h) => h.path === 'icon.png');
    expect(hit).toBeTruthy();
    expect(hit?.kind).toBe('binary-metadata');
    expect(hit?.codepoint).toBe(`U+${0x62a5.toString(16).toUpperCase()}`);
  });

  it('11. the generated build tree is scanned only with --include-dist', () => {
    const root = makeRepo();
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    writeFileSync(join(root, 'src.ts'), 'export const ok = 1;\n');
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'assets', 'bundle.js'), `const msg = "${HANChar}text";\n`);
    writeFileSync(join(root, 'dist', 'index.html'), '<html>ok</html>\n');
    commitAll(root);
    // Without the flag: dist is not scanned (not tracked, would be ignored).
    const r1 = runChecker(root);
    expect(r1.status).toBe(0);
    expect(r1.report().scope.dist_files).toBeNull();
    // With the flag: the generated bundle is a real finding.
    const r2 = runChecker(root, ['--include-dist']);
    expect(r2.status).toBe(1);
    const rep = r2.report();
    expect(rep.scope.dist_files).toBe(2);
    expect(rep.hits.some((h) => h.path === 'dist/assets/bundle.js')).toBe(true);
  });

  it('12. a clean run exits zero and explicitly reports the file classes inspected', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.json'), '{"k": "v"}\n');
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.exit_code).toBe(0);
    expect(rep.scope.tracked_files).toBe(2);
    expect(rep.scope.text_files_scanned).toBe(2);
    expect(rep.commit).toBeTruthy();
    // The stderr summary names every inspected class.
    expect(r.stderr).toContain('tracked files');
    expect(r.stderr).toContain('text files decoded + scanned');
    expect(r.stderr).toContain('binary files');
    expect(r.stderr).toContain('PNG metadata payloads inspected');
    expect(r.stderr).toContain('JPEG metadata payloads inspected');
  });

  it('12b. kana (non-Chinese CJK) is a warning with owner routing, not a gate failure', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'fixture.rs'), `assert_eq!(sanitize("${KANA_A}${GREEK_ALPHA}.pdf"), "${KANA_A}${GREEK_ALPHA}.pdf");\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0); // zero CHINESE content: kana alone cannot fail the gate
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.summary.warnings_count).toBeGreaterThan(0);
    expect(rep.warnings[0].category).toContain('Kana');
  });

  // ---------------------------------------------------------------------
  // Critique-round regressions (Agent 2 audit, wave 2): Korean script must
  // NEVER be classified as blocking Chinese content - "Hangul" literally
  // starts with the letters "Han", which the first classifier implementation
  // exploited as a false positive. Every fixture below is code-point-built.
  // ---------------------------------------------------------------------

  it('20a. Hangul syllables (Korean) are exit-neutral warnings, never blocking Chinese hits', () => {
    const root = makeRepo();
    // U+C5EC U+BCF4 U+C138 U+C694 - a Korean word, built from code points.
    const HANGUL_WORD = String.fromCodePoint(0xc5ec, 0xbcf4, 0xc138, 0xc694);
    writeFileSync(join(root, 'korean.txt'), `greeting: ${HANGUL_WORD}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0); // Korean script alone must not fail the gate
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.summary.warnings_count).toBe(4);
    for (const w of rep.warnings) {
      expect(w.category).toContain('Hangul');
      expect(w.category).toContain('Korean');
    }
  });

  it('20b. Hangul compatibility jamo (U+3130-318F) are warnings, not Chinese hits', () => {
    const root = makeRepo();
    const JAMO = String.fromCodePoint(0x3131, 0x3134, 0x3137);
    writeFileSync(join(root, 'jamo.txt'), `jamo: ${JAMO}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.summary.warnings_count).toBe(3);
    expect(rep.warnings[0].category).toContain('Hangul compatibility jamo');
  });

  it('20c. halfwidth Hangul (U+FFA0-FFDC) is a declared warning, not invisible', () => {
    const root = makeRepo();
    const HALF_HANGUL = String.fromCodePoint(0xffa1, 0xffa2, 0xffa3);
    writeFileSync(join(root, 'halfwidth.txt'), `half: ${HALF_HANGUL}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.summary.warnings_count).toBe(3);
    expect(rep.warnings[0].category).toContain('Halfwidth Hangul');
  });

  it('20d. halfwidth kana (U+FF65-FF9F) is a warning; halfwidth ideographic punctuation blocks', () => {
    const HALF_KANA = String.fromCodePoint(0xff71, 0xff72); // halfwidth katakana
    const HALF_PUNCT = String.fromCodePoint(0xff61); // halfwidth ideographic full stop
    const rootA = makeRepo();
    writeFileSync(join(rootA, 'half-kana.txt'), `x: ${HALF_KANA}\n`);
    commitAll(rootA);
    const rA = runChecker(rootA);
    expect(rA.status).toBe(0);
    expect(rA.report().summary.warnings_count).toBe(2);
    const rootB = makeRepo();
    writeFileSync(join(rootB, 'half-punct.txt'), `y: ${HALF_PUNCT}\n`);
    commitAll(rootB);
    const rB = runChecker(rootB);
    expect(rB.status).toBe(1); // CJK-language punctuation remains blocking
    const repB = rB.report();
    expect(repB.hits).toHaveLength(1);
    expect(repB.hits[0].codepoint).toBe(`U+${0xff61.toString(16).toUpperCase()}`);
  });

  it('20e. mixed Han + Hangul + kana: only the Han code points block', () => {
    const root = makeRepo();
    const HANGUL_WORD = String.fromCodePoint(0xc5ec, 0xbcf4);
    writeFileSync(join(root, 'mixed.txt'), `note: ${HANChar}${HANChar2} ${HANGUL_WORD} ${KANA_A}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1); // the two Han code points block
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(2);
    expect(rep.hits.every((h) => h.family === 'Chinese script (Han)')).toBe(true);
    expect(rep.summary.warnings_count).toBe(3); // 2 Hangul + 1 kana, exit-neutral
  });

  // ---------------------------------------------------------------------
  // Adversarial matrix round 2 (brief cases 4/7/8/9/13 deep coverage).
  // Same rule as above: every fixture below is built from code points at
  // runtime - the committed test source stays 100% ASCII.
  // ---------------------------------------------------------------------

  it('4b. every banned locale root/subtag form fails, while case-imitations pass', () => {
    // Five banned forms, one per line (the locale regex reports the first
    // match per line, so each form needs its own line).
    const root = makeRepo();
    writeFileSync(join(root, 'locales.txt'), [
      `lang=${ZH_PLAIN}-TW`,
      `lang=${ZH_PLAIN}-Hans`,
      `lang=${ZH_PLAIN}-Hant`,
      `lang=${ZH_PLAIN}-HK`,
      `lang=${ZH_PLAIN}-SG`,
      `lang=${ZH_PLAIN}_Hans`, // underscore filesystem form
      `lang=${YUE_ROOT}`,
      `lang=${YUE_ROOT}-Hant`,
      '',
    ].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const localeHits = r.report().hits.filter((h) => h.kind === 'locale-identifier');
    expect(localeHits.length).toBe(8);
    const categories = localeHits.map((h) => h.category);
    for (const form of [`${ZH_PLAIN}-TW`, `${ZH_PLAIN}-Hans`, `${ZH_PLAIN}-Hant`, `${ZH_PLAIN}-HK`, `${ZH_PLAIN}-SG`, `${ZH_PLAIN}_Hans`, YUE_ROOT, `${YUE_ROOT}-Hant`]) {
      expect(categories).toContain(`Chinese locale identifier "${form}"`);
    }
    // Negatives: uppercase roots, near-miss roots and substring noise are
    // NOT locale registrations (the root itself is case-sensitive lowercase;
    // boundaries reject alnum-adjacent fragments).
    const root2 = makeRepo();
    writeFileSync(join(root2, 'clean-ids.txt'), [
      `lang=${ZH_PLAIN.toUpperCase()}-CN`,
      `lang=${ZH_PLAIN.toUpperCase()}-Hans`,
      `lang=${YUE_ROOT}e`,
      `lang=a${ZH_PLAIN}`,
      '',
    ].join('\n'));
    commitAll(root2);
    const r2 = runChecker(root2);
    const localeHits2 = r2.report().hits.filter((h) => h.kind === 'locale-identifier');
    expect(localeHits2).toHaveLength(0);
    expect(r2.status).toBe(0);
  });

  it('4c. a banned locale id inside a FILE PATH is a blocking finding without a line', () => {
    const root = makeRepo();
    const dir = join(root, `docs-${ZH_PLAIN}-CN`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'readme.md'), 'plain English content\n');
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const hit = r.report().hits.find((h) => h.kind === 'locale-identifier');
    expect(hit).toBeTruthy();
    expect(hit?.line).toBeNull();
    expect(hit?.path).toContain(`${ZH_PLAIN}-CN`);
  });

  it('7b. compressed PNG pixel data (IDAT) never triggers content false positives', () => {
    const root = makeRepo();
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); // parser does not validate CRCs
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
    };
    // IDAT payload mimicking compressed entropy data: high bytes, the UTF-8
    // bytes of a Han character and an ASCII locale-id decoy. IDAT is NOT a
    // textual chunk - none of it may ever be classified as language content.
    const idatData = Buffer.concat([
      Buffer.from([0x78, 0x9c, 0xed, 0xdd, 0x0b]),
      Buffer.from(`${HANChar}`, 'utf8'), // e6 8a a5 inside compressed data
      Buffer.from('xzh-CNx', 'latin1'), // ASCII locale-id decoy
      Buffer.from([0xff, 0xfe, 0x9c, 0x78]),
    ]);
    const ihdr = chunk('IHDR', Buffer.alloc(13));
    const idat = chunk('IDAT', idatData);
    const cleanText = chunk('tEXt', Buffer.concat([Buffer.from('Software\0', 'latin1'), Buffer.from('Fress builder', 'latin1')]));
    const iend = chunk('IEND', Buffer.alloc(0));
    writeFileSync(join(root, 'icon.png'), Buffer.concat([sig, ihdr, idat, cleanText, iend]));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.scope.png_metadata_payloads_inspected).toBe(1);
    expect(rep.scope.binary_files_skipped_from_text_scan).toBe(1);
  });

  it('8b. JPEG COM segments are scanned: a locale id and UTF-8 Han in COM are reported', () => {
    const root = makeRepo();
    const jpeg = (comPayload: Buffer): Buffer => Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe]),
      (() => { const l = Buffer.alloc(2); l.writeUInt16BE(comPayload.length + 2); return l; })(),
      comPayload,
      Buffer.from([0xff, 0xd9]),
    ]);
    // ASCII COM carrying a banned locale id (built from code points - even
    // ASCII locale ids must not appear as committed literals, or the checker
    // would detect its own fixture in this file).
    writeFileSync(join(root, 'meta-locale.jpg'), jpeg(Buffer.from(`generated for ${ZH_LOCALE} users`, 'latin1')));
    // UTF-8 COM carrying a Han character (strict-UTF-8-first decode path).
    writeFileSync(join(root, 'meta-han.jpg'), jpeg(Buffer.from(`photo ${HANChar} proof`, 'utf8')));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    // Content hits keep the caller's kind (binary-metadata); locale-id hits
    // carry the dedicated 'locale-identifier' kind from scanTextPayload.
    const metaHits = rep.hits.filter((h) => h.path === 'meta-locale.jpg' || h.path === 'meta-han.jpg');
    expect(metaHits.length).toBe(2);
    expect(metaHits.some((h) => h.path === 'meta-locale.jpg' && h.kind === 'locale-identifier' && (h.category || '').includes('locale identifier'))).toBe(true);
    expect(metaHits.some((h) => h.path === 'meta-han.jpg' && h.kind === 'binary-metadata' && h.codepoint === `U+${0x62a5.toString(16).toUpperCase()}`)).toBe(true);
  });

  it('8c. PNG iTXt and zTXt chunks are inspected like tEXt', () => {
    const root = makeRepo();
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
    };
    // iTXt: keyword\0 compFlag(0) compMethod(0) lang\0 translated\0 text
    const itxtData = Buffer.concat([
      Buffer.from('Comment\0', 'latin1'),
      Buffer.from([0x00, 0x00]),
      Buffer.from('\0\0', 'latin1'),
      Buffer.from(`made by ${HANChar}`, 'utf8'),
    ]);
    // zTXt: keyword\0 compMethod(0) deflate(text)
    const ztxtData = Buffer.concat([
      Buffer.from('Author\0', 'latin1'),
      Buffer.from([0x00]),
      deflateSync(Buffer.from(`made by ${HANChar2}`, 'utf8'), { level: 6 }),
    ]);
    const png = Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('iTXt', itxtData), chunk('zTXt', ztxtData), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(join(root, 'banner.png'), png);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const hits = r.report().hits.filter((h) => h.path === 'banner.png' && h.kind === 'binary-metadata');
    expect(hits.length).toBe(2);
    expect(hits.some((h) => h.codepoint === `U+${0x62a5.toString(16).toUpperCase()}`)).toBe(true);
    expect(hits.some((h) => h.codepoint === `U+${0x544a.toString(16).toUpperCase()}`)).toBe(true);
  });

  it('9b. opaque binaries: printable runs use the declared CJK evidence bar', () => {
    const root = makeRepo();
    const HAN3 = Buffer.from(`${HANChar}${HANChar}${HANChar}`, 'utf8'); // 9 bytes, 3 code points
    const HAN1 = Buffer.from(HANChar, 'utf8'); // isolated CJK-looking triplet
    // Blob: NUL marks it binary; part 1 is a run with ONE CJK code point
    // (compressed-data noise: below the declared RUN_CJK_MIN bar, never a
    // finding); part 2 is a run carrying a real 3-character string (a real
    // finding, reported in full).
    const blob = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('abc', 'latin1'), HAN1, Buffer.from('def\x00', 'latin1'),
      Buffer.from('cfg:', 'latin1'), HAN3, Buffer.from('!x\x00', 'latin1'),
    ]);
    writeFileSync(join(root, 'payload.bin'), blob);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    const stringHits = rep.hits.filter((h) => h.kind === 'binary-string');
    expect(stringHits.length).toBe(3); // exactly the 3 code points of the real string
    expect(stringHits.every((h) => h.codepoint === `U+${0x62a5.toString(16).toUpperCase()}`)).toBe(true);
    expect(rep.scope.opaque_binaries_string_scanned).toBe(1);
    expect(rep.scope.binary_files_skipped_from_text_scan).toBe(1);
  });

  it('12c. a fully clean candidate with generated dist resources exits zero under --include-dist', () => {
    const root = makeRepo();
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    writeFileSync(join(root, 'src.ts'), [
      'export const strings = {',
      "  en: 'Hello',",
      `  fa: '\u0641\u0627\u0631\u0633\u06cc',`,
      "  es: '\u00a1Hola!',",
      "  fr: 'Bonjour',",
      "  de: 'Hallo',",
      '};',
      '',
    ].join('\n'));
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<html lang="en">Fress</html>\n');
    writeFileSync(join(root, 'dist', 'assets', 'app.js'), `export const greeting = '\u00a1Hola!';\n`);
    commitAll(root);
    const r = runChecker(root, ['--include-dist']);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.scope.dist_files).toBe(2);
    expect(rep.summary.exit_code).toBe(0);
    expect(r.stderr).toContain('generated dist/ files');
    expect(rep.scope.text_files_scanned).toBe(4); // .gitignore + src.ts + both dist files actually scanned
  });

  it('12d. untracked release-intended files are scanned (both directions)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'committed.ts'), 'export const ok = 1;\n');
    commitAll(root);
    // Untracked clean candidate file: scanned, counted, passes.
    writeFileSync(join(root, 'candidate.ts'), 'export const alsoOk = 2;\n');
    const r1 = runChecker(root);
    expect(r1.status).toBe(0);
    expect(r1.report().scope.untracked_files_included).toBe(1);
    // Untracked dirty candidate file: a real finding without any commit.
    writeFileSync(join(root, 'candidate.ts'), `export const s = '${HANChar}';\n`);
    const r2 = runChecker(root);
    expect(r2.status).toBe(1);
    const rep = r2.report();
    expect(rep.scope.untracked_files_included).toBe(1);
    expect(rep.hits.some((h) => h.path === 'candidate.ts' && h.codepoint === `U+${0x62a5.toString(16).toUpperCase()}`)).toBe(true);
  });

  it('13b. a scan outside a git repository fails closed with exit 2', () => {
    const bare = mkdtempSync(join(tmpdir(), 'no-chinese-bare-'));
    roots.push(bare);
    const r = runChecker(bare);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('::error::');
    expect(r.stdout).toBe('');
  });

  it('8d. JPEG APPn payloads use the printable-run path with the declared evidence bar', () => {
    const root = makeRepo();
    const jpegWith = (marker: number, payload: Buffer): Buffer => Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, marker]),
      (() => { const l = Buffer.alloc(2); l.writeUInt16BE(payload.length + 2); return l; })(),
      payload,
      Buffer.from([0xff, 0xd9]),
    ]);
    // APP1 (EXIF-shaped) with a 3-CJK printable run: a real finding.
    const app1 = Buffer.concat([
      Buffer.from('EXIF\0', 'latin1'),
      Buffer.from('x', 'latin1'),
      Buffer.from(`${HANChar}${HANChar}${HANChar}`, 'utf8'),
      Buffer.from('y', 'latin1'),
    ]);
    writeFileSync(join(root, 'app-han.jpg'), jpegWith(0xe1, app1));
    // APP1 with one isolated CJK triplet: below the declared bar, silent.
    const app1b = Buffer.concat([
      Buffer.from('EXIF\0', 'latin1'),
      Buffer.from('x', 'latin1'),
      Buffer.from(HANChar, 'utf8'),
      Buffer.from('y', 'latin1'),
    ]);
    writeFileSync(join(root, 'app-noise.jpg'), jpegWith(0xe1, app1b));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.hits.filter((h) => h.path === 'app-han.jpg').length).toBe(3);
    expect(rep.hits.some((h) => h.path === 'app-noise.jpg')).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Critique-round tooling regressions (Agent 2 audit, wave 2): byte-level
  // parser correctness, report determinism and honest CLI validation.
  // ---------------------------------------------------------------------

  it('15. JPEG FF fill padding before COM no longer desyncs the segment walk', () => {
    const root = makeRepo();
    const filler = Buffer.alloc(8, 0xff); // legal padding bytes before the marker
    const com = Buffer.concat([Buffer.from(`note ${HANChar}${HANChar}${HANChar}`, 'utf8')]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      filler,
      Buffer.from([0xff, 0xfe]),
      (() => { const l = Buffer.alloc(2); l.writeUInt16BE(com.length + 2); return l; })(),
      com,
      Buffer.from([0xff, 0xd9]),
    ]);
    writeFileSync(join(root, 'padded.jpg'), jpeg);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1); // the COM payload must be found, not skipped
    const hits = r.report().hits.filter((h) => h.path === 'padded.jpg');
    expect(hits.length).toBe(3);
    expect(hits[0].codepoint).toBe(`U+${0x62a5.toString(16).toUpperCase()}`);
  });

  it('15b. a .png file with no parseable PNG structure still gets the opaque run scan', () => {
    const root = makeRepo();
    const fake = Buffer.concat([
      Buffer.alloc(64, 0x00), // NULs make it binary; signature is wrong
      Buffer.from(`zzz ${HANChar}${HANChar}${HANChar} yyy`, 'utf8'), // 3-CJK run clears the evidence bar
    ]);
    writeFileSync(join(root, 'broken.png'), fake);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1); // a known extension must never become a blind spot
    const hits = r.report().hits.filter((h) => h.path === 'broken.png');
    expect(hits.length).toBe(3);
    expect(hits[0].source).toBe('binary printable-run');
  });

  it('16. two banned locale ids on ONE line are both reported', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'two-ids.txt'), `langs: ${ZH_PLAIN}-CN and ${YUE_ROOT}-Hant\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const localeHits = r.report().hits.filter((h) => h.kind === 'locale-identifier');
    expect(localeHits.length).toBe(2);
    expect(localeHits.map((h) => h.category)).toContain(`Chinese locale identifier "${ZH_PLAIN}-CN"`);
    expect(localeHits.map((h) => h.category)).toContain(`Chinese locale identifier "${YUE_ROOT}-Hant"`);
  });

  it('16b. astral Han after a >24-code-point astral prefix: true columns AND an intact context window', () => {
    const root = makeRepo();
    // 30 astral Han code points precede the BMP hit: the context window is
    // code-point-sliced, so it must STILL end at the hit. A UTF-16 slice
    // (the pre-hardening bug) shifts the window into the middle of a
    // surrogate pair and LOSES the hit character entirely - so the
    // endsWith assertion below is discriminating between old and new.
    const PREFIX = Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x20000 + i)).join('');
    writeFileSync(join(root, 'astral.txt'), `${PREFIX}${HANChar}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    expect(rep.hits).toHaveLength(31); // 30 astral Han + 1 BMP Han, all blocking
    const bmp = rep.hits[rep.hits.length - 1];
    expect(bmp.codepoint).toBe(`U+${0x62a5.toString(16).toUpperCase()}`);
    expect(bmp.col).toBe(31); // true CODE-POINT column
    // The context window still ends WITH the hit after 30 astral chars.
    expect(bmp.context_escaped.endsWith('\\u62a5')).toBe(true);
    // And it begins with a whole astral escape, not a lone surrogate: the
    // window starts 24 code points before the hit, i.e. at U+20006.
    expect(bmp.context_escaped.startsWith('\\U00020006\\U00020007')).toBe(true);
  });

  it('17. the JSON report is byte-deterministic across runs', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'det.txt'), `note: ${HANChar}\n`);
    commitAll(root);
    const r1 = runChecker(root);
    const r2 = runChecker(root);
    expect(r1.stdout).toBe(r2.stdout);
    expect(r1.stderr).toBe(r2.stderr);
  });

  it('17b. an extensionless --out path is never clobbered by the .md companion', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'out.txt'), 'clean content\n');
    commitAll(root);
    const outPath = join(root, 'report'); // deliberately no extension
    const r = runChecker(root, ['--out', outPath]);
    expect(r.status).toBe(0);
    const jsonText = readFileSync(outPath, 'utf8');
    const parsed = JSON.parse(jsonText) as Report; // the JSON survived the .md write
    expect(parsed.summary.total_hits).toBe(0);
    expect(readFileSync(`${outPath}.md`, 'utf8')).toContain('# Zero-Chinese-content scan');
  });

  it('17c. unknown flags and a valueless --out exit 2 with an error annotation', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'ok.txt'), 'clean\n');
    commitAll(root);
    const r = runChecker(root, ['--root', '/etc']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('::error::');
    expect(r.stderr).toContain('unknown argument');
    const r2 = runChecker(root, ['--out']);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('--out requires a path');
  });

  it('21a. a signature-spoofed PNG (magic bytes, no real chunks) still gets the opaque run scan', () => {
    const root = makeRepo();
    const evil = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // valid PNG signature
      Buffer.alloc(32, 0x00), // then NULs: no IHDR, no chunk chain
      Buffer.from(`secret ${HANChar}${HANChar}${HANChar} tail`, 'utf8'), // 3-CJK run
    ]);
    writeFileSync(join(root, 'evil.png'), evil);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1); // the magic bytes alone must not buy trust
    const hits = r.report().hits.filter((h) => h.path === 'evil.png');
    expect(hits.length).toBe(3);
    expect(hits[0].source).toBe('binary printable-run');
  });

  it('21b. a truncated-but-signed JPEG (no SOS/EOI) still gets the opaque run scan', () => {
    const root = makeRepo();
    const evil = Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from(`stashed ${HANChar}${HANChar}${HANChar} payload`, 'utf8'), // no valid segment chain, no EOI
      Buffer.alloc(16, 0x00), // NULs make it binary so the container path applies
    ]);
    writeFileSync(join(root, 'evil.jpg'), evil);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const hits = r.report().hits.filter((h) => h.path === 'evil.jpg');
    expect(hits.length).toBe(3);
    expect(hits[0].source).toBe('binary printable-run');
  });

  it('21c. --out followed by another flag is a usage error (exit 2)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'ok.txt'), 'clean\n');
    commitAll(root);
    const r = runChecker(root, ['--out', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--out requires a path');
  });

  it('13c. an unavailable git binary fails closed with exit 2 (never a green gate)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'ok.txt'), 'clean\n');
    commitAll(root);
    // Strip PATH so spawnSync('git') cannot resolve; the checker must treat
    // an execution failure as exit 2, not as an empty (clean) tree.
    const run = spawnSync(process.execPath, [CHECKER, '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 << 20,
      env: { ...process.env, PATH: '', Path: '' },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('::error::');
    expect(run.stderr).toContain('git');
  });

  it('22. hits from multiple files are reported in stable code-point order with escaped context', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'sub'), { recursive: true });
    // Committed in deliberately NON-alphabetical order; the report order
    // must not depend on creation, inode or locale order.
    writeFileSync(join(root, 'zeta.txt'), `line1: ${HANChar}\nline2 ok\nline3: ${HANChar2}\n`);
    writeFileSync(join(root, 'sub', 'nested.txt'), `deep ${HANChar}\n`);
    writeFileSync(join(root, 'alpha.md'), `early ${HANChar}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const hits = r.report().hits;
    expect(hits).toHaveLength(4);
    // The report's order IS the documented (path, line, col) code-point order.
    const sorted = [...hits].sort(
      (a, b) =>
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.line || 0) - (b.line || 0) ||
        (a.col || 0) - (b.col || 0),
    );
    expect(hits).toEqual(sorted);
    // Byte-wise code-point order ('a' < 's' < 'z'), independent of ICU locale.
    expect(hits.map((h) => h.path)).toEqual(['alpha.md', 'sub/nested.txt', 'zeta.txt', 'zeta.txt']);
    // Same file: ordered by line (line 1 hit before line 3 hit).
    expect(hits[2].line as number).toBeLessThan(hits[3].line as number);
    // Every hit carries a non-empty escaped context and an escaped match.
    for (const h of hits) {
      expect(h.context_escaped.length).toBeGreaterThan(0);
      expect(h.match_escaped).toMatch(/^\\u[0-9a-f]{4}$/);
      expect(h.context_escaped).toContain(h.match_escaped);
    }
  });

  it('23. mutation/negative control: weakened detection loses hits the real gate keeps', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'guard.ts'), `export const note = "${HANChar}";\n`);
    writeFileSync(
      join(root, 'noise.bin'),
      Buffer.concat([Buffer.alloc(32, 0x00), Buffer.from(`zzz ${HANChar}${HANChar}${HANChar} yyy`, 'utf8')]),
    );
    commitAll(root);
    // Real gate: BOTH detection families fire (declared text + binary run).
    const real = runChecker(root);
    expect(real.status).toBe(1);
    expect(real.report().hits.filter((h) => h.path === 'guard.ts')).toHaveLength(1);
    expect(real.report().hits.filter((h) => h.path === 'noise.bin')).toHaveLength(3);

    const src = readFileSync(CHECKER, 'utf8');
    const mutantDir = mkdtempSync(join(tmpdir(), 'no-chinese-mutant-'));
    roots.push(mutantDir);
    const runFrom = (checkerPath: string) =>
      spawnSync(process.execPath, [checkerPath, '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 });
    const hitsOf = (out: string) => JSON.parse(out.slice(out.indexOf('{'))).hits as Array<{ path: string }>;

    // Mutant 1: narrow the Han range so the BMP ideograph escapes content scan.
    const originalRange = "[0x4e00, 0x9fff, 'CJK Unified Ideographs (Han)']";
    expect(src.indexOf(originalRange)).toBe(src.lastIndexOf(originalRange)); // single, exact mutation target
    const mutant1 = join(mutantDir, 'mutant-range.mjs');
    writeFileSync(mutant1, src.replace(originalRange, "[0x4e00, 0x6200, 'CJK Unified Ideographs (Han)']"));
    const m1 = runFrom(mutant1);
    expect(m1.status).toBe(0); // the weakened gate MISSES what the real gate blocks
    expect(hitsOf(m1.stdout)).toHaveLength(0);

    // Mutant 2: raise the binary evidence bar so printable-run findings vanish
    // while declared-text detection still fires (independent failure modes).
    const originalBar = 'const RUN_CJK_MIN = 3;';
    expect(src.indexOf(originalBar)).toBe(src.lastIndexOf(originalBar));
    const mutant2 = join(mutantDir, 'mutant-bar.mjs');
    writeFileSync(mutant2, src.replace(originalBar, 'const RUN_CJK_MIN = 99;'));
    const m2 = runFrom(mutant2);
    expect(m2.status).toBe(1); // text hit survives...
    const m2hits = hitsOf(m2.stdout);
    expect(m2hits.filter((h) => h.path === 'noise.bin')).toHaveLength(0); // ...but the binary run is lost
    expect(m2hits.some((h) => h.path === 'guard.ts')).toBe(true);
    // Conclusion: both suite fixtures are discriminating - a scanner regression
    // in either family would flip a real-gate assertion above from pass to fail.
  });

  it('24. --extra-dir scans an explicitly added tree; a missing one fails closed', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'src.ts'), 'export const ok = 1;\n');
    commitAll(root);
    const extra = mkdtempSync(join(tmpdir(), 'no-chinese-extra-'));
    roots.push(extra);
    writeFileSync(join(extra, 'extracted.txt'), `packaged ${HANChar}\n`);
    writeFileSync(join(extra, 'clean.txt'), 'fine\n');
    // Without the flag: the extra tree is invisible to the repo scan.
    const r0 = runChecker(root);
    expect(r0.status).toBe(0);
    expect(r0.report().scope.extra_dir_files).toBeNull();
    // With the flag: the packaged text is a real finding, path-attributed.
    const r1 = runChecker(root, ['--extra-dir', extra]);
    expect(r1.status).toBe(1);
    const rep1 = r1.report();
    expect(rep1.scope.extra_dir_files).toBe(2);
    const hit = rep1.hits.find((h) => h.scope === 'extra-dir' && h.path.endsWith('/extracted.txt'));
    expect(hit).toBeTruthy();
    expect(hit?.path.startsWith(`${basename(extra)}/`)).toBe(true); // deterministic prefix
    expect(hit?.line).toBe(1);
    // A missing explicitly requested target can never pass silently.
    const r2 = runChecker(root, ['--extra-dir', join(extra, 'does-not-exist')]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('::error::');
    expect(r2.stderr).toContain('--extra-dir');
    // A valueless --extra-dir is a usage error like --out.
    const r3 = runChecker(root, ['--extra-dir']);
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain('--extra-dir requires a path');
  });

  it('17d. the history report declares every skip class and labels the touching commit', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'hist.txt'), `note: ${HANChar}${HANChar2}\n`);
    commitAll(root);
    // Fix the file: the history finding must be reported as still detectable
    // in history but gone from the current tree, with a commit label.
    writeFileSync(join(root, 'hist.txt'), 'clean now\n');
    commitAll(root);
    const r = runChecker(root, ['--history']);
    expect(r.status).toBe(0); // history mode stays report-only
    const rep = r.report();
    expect(rep.scope.history_blobs_scanned).toBeGreaterThan(0);
    expect(rep.scope.history_blobs_skipped_empty_or_unreadable).toBe(0);
    const historyHits = (rep as unknown as { history_hits: Array<{ path: string; still_present: boolean; last_touching_commit: string }> }).history_hits;
    expect(historyHits.length).toBe(2);
    expect(historyHits[0].still_present).toBe(false);
    expect(historyHits[0].last_touching_commit).toBeTruthy();
    expect(historyHits[0].last_touching_commit).not.toBe('unattributed');
  });

  // ------------------------------------------------------------------
  // OLE compound documents (the .msi installer): the release build's
  // UTF-8 printable-run scan produced alignment false positives on the
  // container's own structures while being structurally unable to see
  // the format's real UTF-16LE text. The structural rule: a CFB gets a
  // UTF-16LE run scan at the same evidence bar; everything else keeps
  // the opaque path.
  // ------------------------------------------------------------------

  const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const utf16le = (s: string): Buffer => Buffer.from(s, 'utf16le');

  it('25a. an OLE compound document is recorded as a structured container and not raw-text scanned', () => {
    const root = makeRepo();
    const msi = Buffer.concat([
      OLE_MAGIC,
      Buffer.alloc(0x1c0, 0x00),
      utf16le(`Product ${HANChar.repeat(18)} setup name`),
      Buffer.alloc(0x40, 0x00),
    ]);
    writeFileSync(join(root, 'fixture.msi'), msi);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    const rep = r.report();
    expect(rep.summary.total_hits).toBe(0);
    expect(rep.scope.ole_compound_containers_structural).toBe(1);
  });

  it('25b. an OLE compound document carrying the MSI alignment artifact shape is clean', () => {
    const root = makeRepo();
    // The exact byte shape the v1.0.1 Windows build tripped on: UTF-8 Han
    // triplets interleaved with '~;' separators (OLE string-pool alignment
    // noise). Under even-offset UTF-16LE pairing these isolated pairs stay
    // below the evidence bar.
    const artifact = Buffer.concat([
      OLE_MAGIC,
      Buffer.from([0xe9, 0x97, 0x91]), Buffer.from('~;', 'latin1'),
      Buffer.from([0xe9, 0xb7, 0x93]), Buffer.from('~;', 'latin1'),
      Buffer.from([0xe9, 0xb7, 0x93]),
      Buffer.alloc(7, 0x00),
    ]);
    writeFileSync(join(root, 'installer.msi'), artifact);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    expect(r.report().summary.total_hits).toBe(0);
  });

  it('25d. compressed-cabinet noise inside an OLE container stays clean (the 16-unit bar is above the noise floor)', () => {
    const root = makeRepo();
    // Simulated cabinet bytes: dense pseudo-random pairs where ~42% of
    // even-offset units land in the Han range (the exact statistical shape
    // that defeated the 3-unit bar in the second release build).
    let seed = 0x1234567;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const noise = Buffer.alloc(0x4000);
    for (let i = 0; i + 1 < noise.length; i += 2) noise.writeUInt16LE(0x2000 + (rnd() % 0xafff), i);
    const msi = Buffer.concat([OLE_MAGIC, noise]);
    writeFileSync(join(root, 'packed.msi'), msi);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(0);
    expect(r.report().summary.total_hits).toBe(0);
  });

  it('25c. the same artifact bytes WITHOUT the OLE magic still fail (opaque path unchanged)', () => {
    const root = makeRepo();
    const bytes = Buffer.concat([
      Buffer.from([0xe9, 0x97, 0x91]), Buffer.from('~;', 'latin1'),
      Buffer.from([0xe9, 0xb7, 0x93]), Buffer.from('~;', 'latin1'),
      Buffer.from([0xe9, 0xb7, 0x93]),
      Buffer.alloc(7, 0x00),
    ]);
    writeFileSync(join(root, 'blob.bin'), bytes);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const rep = r.report();
    const hit = rep.hits.find((h) => h.path === 'blob.bin');
    expect(hit).toBeTruthy();
    expect(hit?.kind).toBe('binary-string');
  });

  it('25e. Han extensions I/G/H (newer supplementary-plane blocks) are blocking hits', () => {
    const root = makeRepo();
    // Round-4 audit finding: HAN_RANGES ended at Extension F (0x2EBEF) and had
    // nothing at or above 0x30000; a planted Ext I/G/H ideograph passed silently.
    // All fixtures constructed from numeric code points.
    const EXT_I = String.fromCodePoint(0x2ebf0); // Extension I (Unicode 15.1)
    const EXT_G = String.fromCodePoint(0x30000); // Extension G (Unicode 13.0)
    const EXT_H = String.fromCodePoint(0x31350); // Extension H (Unicode 15.0)
    writeFileSync(join(root, 'ext-ghi.txt'), `supplementary ${EXT_I}${EXT_G}${EXT_H}\n`);
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const cps = r.report().hits.map((h) => h.codepoint);
    expect(cps).toContain('U+2EBF0');
    expect(cps).toContain('U+30000');
    expect(cps).toContain('U+31350');
    // Negative control: adjacent NON-Han astral scripts stay clean (exit 0) -
    // proves the new blocks are discriminating, not an over-broad astral sweep.
    const root2 = makeRepo();
    const MUSICAL = String.fromCodePoint(0x1d10c); // Musical symbol (U+1D10C)
    const LINEAR_B = String.fromCodePoint(0x10000); // Linear B syllable (U+10000)
    const EGYPTIAN = String.fromCodePoint(0x13000); // Egyptian hieroglyph (U+13000)
    writeFileSync(join(root2, 'astral-clean.txt'), `${MUSICAL}${LINEAR_B}${EGYPTIAN} ok\n`);
    commitAll(root2);
    const r2 = runChecker(root2);
    expect(r2.status).toBe(0);
  });

  it('25f. an Extension G ideograph in a FILE NAME is a blocking finding', () => {
    const root = makeRepo();
    writeFileSync(join(root, `x${String.fromCodePoint(0x30001)}.txt`), 'clean\n');
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const fn = r.report().hits.find((h) => h.kind === 'filename');
    expect(fn).toBeTruthy();
    expect(fn?.codepoint).toBe('U+30001');
  });
});
