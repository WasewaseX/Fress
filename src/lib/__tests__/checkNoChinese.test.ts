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
 *   5 -> test 5    6 -> test 6    7 -> test 7b    8 -> tests 10b, 8b, 8c
 *   9 -> test 9b  10 -> test 10  11 -> test 7    12 -> tests 8, 9
 *  13 -> tests 11, 12, 12c       14 -> test 9 (self-scan) + 12b (kana)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  hits: Array<{ kind: string; path: string; line: number | null; col: number | null; codepoint: string | null; category: string; family: string; context_escaped: string; owner_action: string }>;
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
    expect(r.report().hits[0].path).toBe('catalog.json');
    expect(r.report().hits[0].family).toContain('Han');
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
    expect(localeHits.length).toBeGreaterThanOrEqual(2);
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
    expect(rep.hits.some((h) => h.kind === 'filename' && h.path.includes(HANChar))).toBe(true);
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
      `lang=${YUE_ROOT}`,
      `lang=${YUE_ROOT}-Hant`,
      '',
    ].join('\n'));
    commitAll(root);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const localeHits = r.report().hits.filter((h) => h.kind === 'locale-identifier');
    expect(localeHits.length).toBe(5);
    const categories = localeHits.map((h) => h.category);
    for (const form of [`${ZH_PLAIN}-TW`, `${ZH_PLAIN}-Hans`, `${ZH_PLAIN}-Hant`, YUE_ROOT, `${YUE_ROOT}-Hant`]) {
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
    // ASCII COM carrying a banned locale id.
    writeFileSync(join(root, 'meta-locale.jpg'), jpeg(Buffer.from('generated for zh-CN users', 'latin1')));
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
  });
});
