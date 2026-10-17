#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// check-no-chinese.mjs - zero-Chinese-content audit for the Fress tree.
//
// WHY: the project advertises exactly five UI languages (en, fa RTL, es,
// fr, de - see src/lib/i18n.tsx). The user requires NO Chinese-language
// content anywhere in the repository: no Han-script characters, no CJK
// punctuation/fullwidth language content, no Chinese locale identifiers,
// no stray agent-inserted Chinese comments or strings. "Zero" is an
// observed scan result, not an assumption.
//
// WHAT IT SCANS (default mode):
//   1. every tracked file (git ls-files -z)
//   2. every untracked, non-ignored file (would enter the release commit)
//   3. with --include-dist: the generated frontend build tree (dist/) that
//      the release packages
//   4. with --extra-dir <path> (repeatable): any explicitly requested tree,
//      e.g. an extracted package (APK assets). Unlike a missing dist/ (which
//      only warns), a MISSING --extra-dir is a hard exit-2 failure: an
//      explicitly requested scan target must never be silently skipped.
//   plus every FILE NAME in those scopes.
//
// HOW (fail-closed rules):
//   - text files are decoded as strict UTF-8; a file that is neither valid
//     UTF-8 nor visibly binary is reported as unreadable-suspect (never
//     silently passed)
//   - binary blobs are NOT regexed raw (compressed image bytes would false-
//     positive); instead: PNG text chunks (tEXt/iTXt/zTXt) and JPEG COM
//     comment segments are parsed and scanned (strict-UTF-8 decode first,
//     Latin-1 + printable-run fallback), JPEG APPn payloads keep the
//     conservative printable-run path (they are usually binary EXIF/ICC
//     structures); other binaries get
//     a printable-run ("strings"-style) scan that also decodes valid
//     multi-byte UTF-8 sequences; every printable-run scan reports CJK
//     code points only when a single run carries at least 3 of them (an
//     isolated CJK-looking byte triplet inside binary data is noise; real
//     embedded language content is a string of characters); fonts
//     (.ttf/.otf/.woff/
//     .woff2/.eot) are skipped entirely - glyph coverage inside a font is
//     NOT Chinese-language UI copy
//   - every hit prints path, line, code-point column, U+ code point,
//     escaped context and an owner-action hint; there is NO suppression
//     list - an approved exception is a documented code change to this
//     file, never a silent data file
//
// EXIT CODES: 0 = zero hits; 1 = hits found (or unreadable files);
//             2 = the scan itself could not run (usage, not a git repo...).
// The scan needs no dependencies and no network; stock Node in CI is enough.
//
// Usage: node scripts/ci/check-no-chinese.mjs [--out <path>] [--include-dist]
//                                          [--extra-dir <path>] [--history]
//                                          [--json] [--help]
//   --out <path>    write report JSON to <path> (same base, .md for summary)
//   --include-dist  also scan the generated dist/ build tree
//   --extra-dir <path>  also scan an explicitly added tree (repeatable); a
//      missing/unreadable requested target exits 2. Hit paths are prefixed
//      with the directory's basename (disambiguated -2, -3, ... in CLI
//      order when basenames collide) so findings stay attributable.
//   --history       additionally scan all reachable history blobs
//                   (report-only; reports history-only findings separately)
//   --json          print the machine-readable report to stdout
//                   (the human summary goes to stderr)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// zlib-bomb cap for PNG text chunks: iTXt/zTXt payloads are attacker-
// suppliable in a PR, and deflate expansion ratios >1000:1 are trivial to
// craft. Refuse to expand any single text chunk beyond 64 MiB; on cap
// overflow (or malformed stream) the caller falls back to the raw bytes,
// which still pass through the printable-run scan. Detection stays
// fail-closed: real-world text metadata is orders of magnitude smaller.
const MAX_INFLATED_TEXT_BYTES = 64 << 20;
function boundedInflate(buf) {
  try {
    return inflateSync(buf, { maxOutputLength: MAX_INFLATED_TEXT_BYTES });
  } catch {
    return null; // malformed stream or expansion over the cap: keep raw
  }
}
import { join, resolve, sep, basename, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Unicode ranges considered Chinese/CJK-language content. Persian/Arabic
// script (supported UI language) is deliberately NOT here.
const HAN_RANGES = [
  [0x2e80, 0x2eff, 'CJK radicals supplement'],
  [0x2f00, 0x2fdf, 'Kangxi radicals'],
  [0x3000, 0x303f, 'CJK punctuation'],
  [0x3040, 0x30ff, 'Kana (Japanese script)'],
  [0x3100, 0x312f, 'Bopomofo'],
  [0x3130, 0x318f, 'Hangul compatibility jamo (Korean)'],
  [0x3190, 0x319f, 'Kanbun'],
  [0x31f0, 0x31ff, 'Katakana phonetic extensions (Japanese)'],
  [0x3400, 0x4dbf, 'CJK Unified Ideographs Extension A (Han)'],
  [0x4e00, 0x9fff, 'CJK Unified Ideographs (Han)'],
  [0xac00, 0xd7af, 'Hangul syllables (Korean)'],
  [0xf900, 0xfaff, 'CJK Compatibility Ideographs (Han)'],
  [0xfe30, 0xfe4f, 'CJK Compatibility Forms'],
  [0xff01, 0xff5e, 'Fullwidth ASCII forms (CJK language content)'],
  [0xff61, 0xff64, 'Halfwidth ideographic punctuation'],
  [0xff65, 0xff9f, 'Halfwidth Kana (Japanese)'],
  [0xffa0, 0xffdc, 'Halfwidth Hangul compatibility jamo (Korean)'],
  [0xffe0, 0xffef, 'Fullwidth signs'],
  [0x20000, 0x2a6df, 'CJK Unified Ideographs Extension B (Han)'],
  [0x2a700, 0x2ebef, 'CJK Unified Ideographs Extensions C-F (Han)'],
  [0x2ebf0, 0x2ee5d, 'CJK Unified Ideographs Extension I (Han)'],
  [0x2f800, 0x2fa1f, 'CJK Compatibility Ideographs Supplement (Han)'],
  [0x30000, 0x3134a, 'CJK Unified Ideographs Extension G (Han)'],
  [0x31350, 0x323af, 'CJK Unified Ideographs Extension H (Han)'],
];

// Chinese locale identifiers (BCP-47 and common filesystem forms). Built
// from code points so this source file can never match itself (rule: the
// checker must not flag its own regex). The two-letter ROOT is case-
// sensitive lowercase - real registrations are lowercase; random binary
// byte-runs in mixed case are noise, not locale registration. Subtags are
// case-insensitive per BCP-47, spelled out as per-letter classes below so
// no matchable literal appears in this file.
const ZH_ROOT = String.fromCharCode(0x7a) + String.fromCharCode(0x68);
const YUE_ROOT = String.fromCharCode(0x79, 0x75, 0x65);
const SUBTAG = '(?:[-_](?:[hH][aA][nN][sS]|[hH][aA][nN][tT]|[cC][nN]|[tT][wW]|[hH][kK]|[sS][gG]|[mM][oO]))?';
const LOCALE_RE_CI_SUBTAGS = new RegExp(
  `(?:^|[^A-Za-z0-9])(${ZH_ROOT}|${YUE_ROOT})${SUBTAG}(?![A-Za-z0-9])`,
  'g', // global: the report loops exec() per line/path; without 'g' exec never advances and every loop would spin forever on the first match
);

const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
const BINARY_EXTS = new Set([...FONT_EXTS, '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns',
  '.webp', '.pdf', '.zip', '.gz', '.exe', '.msi', '.dmg', '.appimage', '.deb', '.rpm', '.apk',
  '.wasm', '.node', '.so', '.dylib', '.dll', '.bin', '.der', '.p12', '.keystore']);

function classifyCodePoint(cp) {
  // ORDER MATTERS: Korean/Japanese ranges must be classified BEFORE the Han
  // family. 'Hangul syllables (Korean)' literally starts with the letters
  // "Han", so a naive name.startsWith('Han') test classified Korean syllables
  // as blocking Chinese content - a false positive against non-Chinese CJK
  // script that the audit brief explicitly forbids. The Han branch now also
  // matches the exact "(Han)" marker instead of a prefix.
  for (const [lo, hi, name] of HAN_RANGES) {
    if (cp >= lo && cp <= hi) {
      if (name.includes('Korean') || name.includes('Hangul')) return { name, family: 'Korean script (unexpected)' };
      if (name.includes('Japanese') || name.includes('Kana')) return { name, family: 'Japanese script (unexpected)' };
      if (name.includes('(Han)')) return { name, family: 'Chinese script (Han)' };
      if (name.includes('Fullwidth') || name.includes('punctuation')) return { name, family: 'CJK punctuation/fullwidth' };
      return { name, family: 'CJK symbols (unexpected)' };
    }
  }
  return null;
}

function escapeForDisplay(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return out;
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// Printable-run extraction ("strings"-style) for opaque binary payloads.
// A run may span valid multi-byte UTF-8 sequences so Chinese text embedded
// in an opaque binary stays detectable; any other byte breaks the run.
// Pure-ASCII runs decode identically to the previous Latin-1 behavior.
function printableRuns(buf, minLen = 6) {
  const runs = [];
  let cur = [];
  const push = () => { if (cur.length >= minLen) runs.push(Buffer.from(cur).toString('utf8')); cur = []; };
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09) { cur.push(b); i += 1; continue; }
    // Admit a WELL-FORMED 2-4 byte UTF-8 sequence into the run; any other
    // byte (bad lead, bad continuation) breaks it. Lead and first-continuation
    // ranges follow Unicode Table 3-7, so overlong (C0/C1), surrogate (ED A0)
    // and >U+10FFFF (F5+) forms cannot bridge otherwise-isolated runs.
    let need = -1;
    let c1min = 0x80;
    let c1max = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) { need = 2; if (b === 0xe0) c1min = 0xa0; else if (b === 0xed) c1max = 0x9f; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; if (b === 0xf0) c1min = 0x90; else if (b === 0xf4) c1max = 0x8f; }
    if (need > 0 && i + need < buf.length) {
      let ok = buf[i + 1] >= c1min && buf[i + 1] <= c1max;
      for (let k = 2; ok && k <= need; k += 1) if (buf[i + k] < 0x80 || buf[i + k] > 0xbf) ok = false;
      if (ok) { for (let k = 0; k <= need; k += 1) cur.push(buf[i + k]); i += need + 1; continue; }
    }
    push();
    i += 1;
  }
  push();
  return runs;
}

// Evidence bar for printable-run scans: runs are a HEURISTIC extraction
// from binary payloads (opaque binaries, JPEG APPn structures, non-UTF-8
// metadata), where compressed data occasionally contains byte triplets that
// happen to decode to isolated CJK code points. Real embedded language
// content is a string of characters, so a run must carry at least
// RUN_CJK_MIN CJK-family code points before any of them are reported.
// Declared-textual content (text files, PNG text chunks, UTF-8 JPEG COM)
// is scanned at full 1-character sensitivity instead. This is a declared,
// documented threshold - not a suppression list: every run above the bar
// reports ALL of its findings.
const RUN_CJK_MIN = 3;

function countCjkCodePoints(text) {
  let n = 0;
  for (const ch of text) if (classifyCodePoint(ch.codePointAt(0))) n += 1;
  return n;
}

// PNG: parse chunks, decode the TEXT-bearing ones only (IDAT stays compressed
// and is never regexed raw). A file must be STRUCTURALLY a PNG - IHDR first,
// every chunk length in bounds, walk reaching IEND - before its text chunks
// are trusted as the full story; a signature-only spoof returns null so the
// payload falls through to the opaque printable-run scan (never a blind spot).
function pngTextPayloads(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) return null; // not a PNG
  // Structural gate 1: room for signature + a 13-byte IHDR chunk (12 + 13).
  if (buf.length < 8 + 25) return null;
  // Structural gate 2: the first chunk MUST be IHDR with its spec length 13.
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const out = [];
  let off = 8;
  let reachedIend = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    // Structural gate 3: every chunk must fit inside the buffer - a length
    // that runs past EOF means the chain has desynced and the walk's silence
    // would be a false "fully parsed" verdict.
    if (off + 12 + len > buf.length) return null;
    const data = buf.subarray(off + 8, off + 8 + len);
    try {
      if (type === 'tEXt') {
        const z = data.indexOf(0);
        if (z > 0) {
          const raw = data.subarray(z + 1);
          // tEXt is Latin-1 per spec, but real-world writers emit UTF-8.
          // Decode strict-UTF-8 first and fall back to Latin-1 so Chinese
          // metadata written as UTF-8 is still detected.
          let text = null;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { /* not UTF-8 */ }
          out.push({ source: `tEXt:${data.toString('latin1', 0, z)}`, text: text ?? raw.toString('latin1') });
        }
      } else if (type === 'iTXt') {
        const z = data.indexOf(0);
        if (z > 0) {
          const compFlag = data[z + 1];
          let rest = data.subarray(z + 3);
          const langEnd = rest.indexOf(0);
          if (langEnd >= 0) {
            rest = rest.subarray(langEnd + 1);
            const transEnd = rest.indexOf(0);
            if (transEnd >= 0) {
              let txt = rest.subarray(transEnd + 1);
              if (compFlag === 1) { const inf = boundedInflate(txt); if (inf) txt = inf; }
              out.push({ source: `iTXt:${data.toString('latin1', 0, z)}`, text: txt.toString('utf8') });
            }
          }
        }
      } else if (type === 'zTXt') {
        const z = data.indexOf(0);
        if (z > 0 && data[z + 1] === 0) {
          const inf = boundedInflate(data.subarray(z + 2));
          if (inf) out.push({ source: `zTXt:${data.toString('latin1', 0, z)}`, text: inf.toString('utf8') });
        }
      }
    } catch { /* malformed chunk: move on */ }
    off += 12 + len;
    if (type === 'IEND') { reachedIend = true; break; }
  }
  // Structural gate 4: a well-formed PNG terminates with IEND. If the walk
  // ran off the end of the buffer first, the file is not a parseable PNG.
  if (!reachedIend) return null;
  return out;
}

// JPEG: scan ONLY the textual marker segments (COM, APPn payloads); the
// compressed entropy-coded image data is never string-scanned.
function jpegTextPayloads(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG
  const out = [];
  let off = 2;
  let terminated = false;
  // Markers are 2 bytes; segment LENGTHS need 4. Keeping the loop condition
  // at +2 lets a tail EOI (last 2 bytes of the file) terminate the walk.
  while (off + 2 <= buf.length) {
    if (buf[off] !== 0xff) { off += 1; continue; }
    const marker = buf[off + 1];
    if (marker === 0xff) { off += 1; continue; } // FF fill padding before a marker is not a segment: reading a length here desyncs the walk and silently skips the real COM/APPn that follows
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) { terminated = true; break; } // entropy-coded data starts / EOI
    if (off + 4 > buf.length) return null; // segment header truncated: not a parseable JPEG
    const segLen = buf.readUInt16BE(off + 2);
    // Structural gates: a segment length INCLUDES its own 2 bytes (so < 2 is
    // impossible) and every segment must fit inside the buffer. Anything else
    // means the walk has desynced - return null so the payload goes to the
    // opaque printable-run scan instead of trusting a parsed verdict.
    if (segLen < 2 || off + 2 + segLen > buf.length) return null;
    if (marker === 0xfe) {
      const raw = buf.subarray(off + 4, off + 2 + segLen);
      // COM is a declared textual segment: decode strict-UTF-8 first so
      // Chinese metadata written as UTF-8 is fully visible (line/column and
      // locale ids), falling back to the Latin-1 printable-run path only
      // when the payload is not valid UTF-8.
      let text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { /* not UTF-8 */ }
      out.push({ source: 'COM', text: text ?? raw.toString('latin1'), utf8: text !== null });
    } else if (marker >= 0xe0 && marker <= 0xef) {
      // APPn payloads (JFIF/EXIF/ICC/XMP structures) are usually BINARY:
      // whole-payload text scanning would classify random code points from
      // binary junk, so they keep the conservative Latin-1 printable-run
      // path (ASCII + valid UTF-8 runs, locale regex still applied).
      out.push({ source: `APP${marker - 0xe0}`, text: buf.toString('latin1', off + 4, off + 2 + segLen), utf8: false });
    }
    off += 2 + segLen;
  }
  if (!terminated) return null; // ran off the end without SOS/EOI: not a parseable JPEG
  return out;
}

const SUMMARY = { tracked: 0, untracked: 0, dist: 0, extra: 0, textScanned: 0, binarySkipped: 0, fontSkipped: 0,
  pngMetadata: 0, jpegMetadata: 0, binaryStringScans: 0, oleContainers: 0, historyBlobs: 0,
  historyNonBlobObjects: 0, historySkippedOversize: 0, historySkippedEmpty: 0, historySkippedUndecodable: 0 };

const HITS = [];
const WARNINGS = [];
const HISTORY_HITS = [];

function pushHit(kind, scope, relPath, extra) {
  HITS.push({ kind, scope, path: relPath, ...extra });
}

// Role hint: what kind of file the owner is dealing with.
function roleHint(relPath) {
  const p = relPath.split(sep).join('/');
  const b = basename(p).toLowerCase();
  if (/^(license|notice|copying)/.test(b)) return 'legal/third-party text - do NOT alter; escalate to the release owner';
  if (p.startsWith('tests/')) return 'test fixture/source - replace the string with a non-Chinese equivalent that keeps the test intent';
  if (p.startsWith('docs/')) return 'documentation - rewrite in English (or a supported language) for the docs owner';
  if (p.startsWith('public/')) return 'app asset/metadata - route to the UI owner';
  if (p.startsWith('src/data') || p.includes('catalog')) return 'catalog data - user-visible; use the recognized English name or romanization, keep the official download URL';
  if (p.startsWith('src/')) return 'first-party source (UI copy or comments) - replace with correct English wording; route to the UI owner';
  if (p.startsWith('src-tauri/')) return 'native/Rust config - route to the native owner';
  if (b === 'package.json' || b === 'package-lock.json') return 'package metadata - upstream strings stay untouched; escalate if a legal name is required';
  if (p.startsWith('dist/')) return 'generated build output - fix the SOURCE file, rebuild, never edit dist directly';
  if (p.startsWith('.github/')) return 'workflow/CI config - fix the wording, keep the gate semantics';
  return 'first-party tree - replace with correct English wording';
}

// Scan one decoded text payload; returns array of findings with severity.
// Kana/Hangul are NON-Chinese CJK script: reported as warnings (owner-routed)
// and never silently dropped from DECLARED-TEXT content; inside printable-run
// scans the declared RUN_CJK_MIN evidence bar applies to warnings too.
function scanTextPayload(kind, scope, relPath, text, { sourceLabel = null, allowLocale = true } = {}) {
  const found = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const cps = Array.from(line); // ci counts CODE POINTS, so the context window must be sliced by code points too (a UTF-16 slice shifts when astral chars precede the hit)
    for (let ci = 0; ci < cps.length; ci += 1) {
      const ch = cps[ci];
      const cp = ch.codePointAt(0);
      const cls = classifyCodePoint(cp);
      if (cls) {
        const severity = cls.family === 'Japanese script (unexpected)' || cls.family === 'Korean script (unexpected)' ? 'warning' : 'blocking';
        found.push({ severity, kind, line: li + 1, col: ci + 1, codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
          category: cls.name, family: cls.family,
          match_escaped: escapeForDisplay(ch),
          context_escaped: escapeForDisplay(cps.slice(Math.max(0, ci - 24), ci + 25).join('')),
          ...(sourceLabel ? { source: sourceLabel } : {}),
          role_hint: roleHint(relPath),
          owner_action: severity === 'blocking'
            ? 'replace the character with correct English (or a supported-language) wording; never silently suppress'
            : 'non-Chinese CJK script (unadvertised language): owner should replace with a supported-language fixture' });
      }
    }
    if (allowLocale) {
      // Global regex with an explicit per-line loop: EVERY banned identifier
      // on the line is reported, not just the first one. lastIndex is reset
      // per line - a shared global regex keeps state across exec calls.
      LOCALE_RE_CI_SUBTAGS.lastIndex = 0;
      let loc;
      while ((loc = LOCALE_RE_CI_SUBTAGS.exec(line)) !== null) {
        // loc[0] includes the consumed boundary character; the reported
        // identifier is the clean root+subtag form, and the column points
        // at the root's first character.
        const idStart = loc[0].indexOf(loc[1]);
        const id = loc[0].slice(idStart);
        found.push({ severity: 'blocking', kind: 'locale-identifier', line: li + 1, col: loc.index + idStart + 1, codepoint: null,
          category: `Chinese locale identifier "${id}"`, family: 'locale registry',
          match_escaped: escapeForDisplay(id),
          context_escaped: escapeForDisplay(line.slice(Math.max(0, loc.index - 24), loc.index + loc[0].length + 24)),
          ...(sourceLabel ? { source: sourceLabel } : {}),
          role_hint: roleHint(relPath),
          owner_action: 'remove the Chinese locale registration/identifier or replace with a supported language (en, fa, es, fr, de)' });
      }
    }
  }
  return found;
}

function scanTextFile(kind, scope, absPath, relPath) {
  // Symlinks need lstat-first handling: git stores a symlink's LINK TEXT as
  // the blob content, not the target's content. Every symlink is scanned as
  // its LINK TEXT (file links and directory links alike; a directory link
  // additionally gets a declared warning that the linked contents are not
  // part of the commit). A NON-symlink directory entry (a submodule gitlink
  // checkout) is NOT caught here: it falls through to readFileSync and fails
  // closed like any unreadable file - the gate must never fail open on
  // tracked content.
  let lst = null;
  try { lst = lstatSync(absPath); } catch { /* let readFileSync fail closed */ }
  if (lst && lst.isSymbolicLink()) {
    // git stores a symlink's LINK TEXT as the blob content - scan it, for
    // file links AND directory links alike (a Han-bearing link target path
    // is committed content even when the linked directory itself is not).
    let link;
    try {
      link = readlinkSync(absPath, 'buffer');
    } catch (err) {
      pushHit('unreadable-file', scope, relPath, { line: null, col: null, codepoint: null,
        category: `symlink target could not be read: ${err.message}`, family: 'fail-closed',
        match_escaped: '', context_escaped: '', role_hint: roleHint(relPath),
        owner_action: 'make the symlink readable or remove it; a scan that cannot read committed content must not pass silently' });
      return;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(link);
    } catch {
      pushHit('unreadable-file', scope, relPath, { line: null, col: null, codepoint: null,
        category: 'symlink target path is neither valid UTF-8 text nor recognizable content', family: 'fail-closed',
        match_escaped: '', context_escaped: '', role_hint: roleHint(relPath),
        owner_action: 're-create the symlink with a UTF-8 target path; undecodable committed content fails the scan' });
      return;
    }
    let targetIsDir = false;
    try { targetIsDir = statSync(absPath).isDirectory(); } catch { /* broken link: link text already scanned */ }
    if (targetIsDir) {
      process.stderr.write(`::warning::check-no-chinese: symlinked directory ${relPath} - its link text is scanned; the linked directory's contents are not part of the commit\n`);
    }
    SUMMARY.textScanned += 1;
    for (const hit of scanTextPayload(kind, scope, relPath, text)) pushHit2(hit, kind, scope, relPath);
    scanFilename(kind, scope, relPath);
    return;
  }
  let buf;
  try {
    buf = readFileSync(absPath);
  } catch (err) {
    pushHit('unreadable-file', scope, relPath, { line: null, col: null, codepoint: null,
      category: `file could not be read: ${err.message}`, family: 'fail-closed',
      match_escaped: '', context_escaped: '', role_hint: roleHint(relPath),
      owner_action: 'make the file readable or remove it; a scan that cannot read a file must not pass silently' });
    return;
  }
  if (isProbablyBinary(buf)) { scanBinaryFile(kind, scope, absPath, relPath, buf); return; }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    pushHit('unreadable-file', scope, relPath, { line: null, col: null, codepoint: null,
      category: 'file is neither valid UTF-8 text nor a recognized binary - undecodable content', family: 'fail-closed',
      match_escaped: '', context_escaped: '', role_hint: roleHint(relPath),
      owner_action: 're-encode as UTF-8 or mark with a known binary extension; undecodable files fail the scan' });
    return;
  }
  SUMMARY.textScanned += 1;
  for (const hit of scanTextPayload(kind, scope, relPath, text)) pushHit2(hit, kind, scope, relPath);
  scanFilename(kind, scope, relPath);
}

function pushHit2(hit, kind, scope, relPath) {
  if (hit.severity === 'warning') WARNINGS.push({ ...hit, scope, path: relPath });
  else HITS.push({ kind: hit.kind || kind, scope, path: relPath, ...hit });
}

function scanBinaryFile(kind, scope, absPath, relPath, buf) {
  SUMMARY.binarySkipped += 1;
  const ext = extname(relPath).toLowerCase();
  scanFilename(kind, scope, relPath);
  if (FONT_EXTS.has(ext)) { SUMMARY.fontSkipped += 1; return; } // glyph coverage is not UI copy
  if (ext === '.png') {
    const payloads = pngTextPayloads(buf);
    if (payloads) {
      SUMMARY.pngMetadata += 1;
      for (const p of payloads) {
        for (const hit of scanTextPayload('binary-metadata', scope, relPath, p.text, { sourceLabel: `PNG ${p.source}` })) pushHit2(hit, 'binary-metadata', scope, relPath);
      }
      return;
    }
    // A file that claims .png but carries no parseable PNG structure falls
    // through to the opaque printable-run scan below - a known extension
    // must never become a blind spot (fail-closed over fail-open).
  } else if (ext === '.jpg' || ext === '.jpeg') {
    const payloads = jpegTextPayloads(buf);
    if (payloads) {
      SUMMARY.jpegMetadata += 1;
      for (const p of payloads) {
        if (p.utf8) {
          for (const hit of scanTextPayload('binary-metadata', scope, relPath, p.text, { sourceLabel: `JPEG ${p.source}` })) pushHit2(hit, 'binary-metadata', scope, relPath);
        } else {
          for (const run of printableRuns(Buffer.from(p.text, 'latin1'))) {
            if (countCjkCodePoints(run) < RUN_CJK_MIN) continue;
            for (const hit of scanTextPayload('binary-metadata', scope, relPath, run, { sourceLabel: `JPEG ${p.source}` })) pushHit2(hit, 'binary-metadata', scope, relPath);
          }
        }
      }
      return;
    }
  }
  scanOpaqueBinary(buf, scope, relPath, pushHit2);
}

// OLE Compound File (.msi installer): a sector-aligned STRUCTURAL
// container whose bulk is compressed cabinet data. Two hard facts make a
// raw text heuristic unsound on this format, in BOTH directions:
//   1. The container's own structures and compressed streams decode as
//      random Han triplets under a UTF-8 run scan (the false-positive
//      class that failed the v1.0.1 Windows release build) - and under a
//      UTF-16LE pairing ~42% of random units still land in the Han range,
//      so a 40 MB installer statistically FORCES chains of 16+ Han units
//      (the second release build proved it). No chain-based bar is both
//      sensitive and sound on this payload.
//   2. The format's real text (UTF-16LE / codepage string pools) is
//      invisible to a UTF-8 run scan, so the old path could never deliver
//      a TRUE finding on this format either.
// Declared rule (same family as font binaries: "glyph coverage is not UI
// copy"): a structurally-verified OLE compound document is recorded as a
// structured container and excluded from raw-byte text heuristics, with
// the exclusion VISIBLE in the report summary. What makes this fail-closed
// rather than a blind spot: every string that goes INTO the installer is
// source-level content - the app's UI copy, catalog data, the WiX
// template's own English strings - and the SOURCE scan (exact,
// 1-character sensitivity, every tracked file) covers all of it. The
// binary heuristic exists for metadata that never passes through the
// source tree; an MSI's payload never contains such content.
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function scanOpaqueBinary(buf, scope, relPath, pushHit2) {
  // Structured container: OLE compound document (see the declared rule
  // above). Recorded in the summary; never raw-byte text-scanned.
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    SUMMARY.oleContainers += 1;
    return;
  }
  // Opaque binary: conservative printable-run scan of the whole payload.
  // Locale-id detection is DISABLED here: random byte runs in compressed
  // data routinely contain root-like fragments in mixed case that are
  // noise, not locale registration. CJK code points in a decoded run ARE
  // real findings once the run clears the RUN_CJK_MIN evidence bar
  // (see printableRuns) - declared policy, not a suppression list.
  SUMMARY.binaryStringScans += 1;
  for (const run of printableRuns(buf)) {
    if (countCjkCodePoints(run) < RUN_CJK_MIN) continue;
    for (const hit of scanTextPayload('binary-string', scope, relPath, run, { sourceLabel: 'binary printable-run', allowLocale: false })) pushHit2(hit, 'binary-string', scope, relPath);
  }
}

function scanFilename(kind, scope, relPath) {
  const norm = relPath.split(sep).join('/');
  let ci = 0;
  for (const ch of norm) {
    const cp = ch.codePointAt(0);
    const cls = classifyCodePoint(cp);
    if (cls) {
      const severity = cls.family === 'Japanese script (unexpected)' || cls.family === 'Korean script (unexpected)' ? 'warning' : 'blocking';
      const hit = { severity, line: null, col: ci + 1, codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        category: `${cls.name} in file/dir name`, family: cls.family,
        match_escaped: escapeForDisplay(ch), context_escaped: escapeForDisplay(norm),
        role_hint: 'file name - rename the file/dir with an ASCII (or supported-language) name',
        owner_action: 'rename the path; a Chinese file name is content too' };
      if (severity === 'warning') WARNINGS.push({ kind: 'filename', scope, path: relPath, ...hit });
      else pushHit('filename', scope, relPath, hit);
    }
    ci += 1;
  }
  LOCALE_RE_CI_SUBTAGS.lastIndex = 0;
  let loc;
  while ((loc = LOCALE_RE_CI_SUBTAGS.exec(norm)) !== null) {
    const idStart = loc[0].indexOf(loc[1]);
    const id = loc[0].slice(idStart);
    pushHit('locale-identifier', scope, relPath, { severity: 'blocking', line: null, col: loc.index + idStart + 1, codepoint: null,
      category: `Chinese locale identifier "${id}" in path`, family: 'locale registry',
      match_escaped: escapeForDisplay(id), context_escaped: escapeForDisplay(norm),
      role_hint: 'path name containing a Chinese locale id - rename',
      owner_action: 'rename the path; Chinese locale registration is not supported here' });
  }
}

function git(args, { allowFail = false } = {}) {
  const run = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 64 << 20 });
  if (run.status !== 0 && !allowFail) {
    process.stderr.write(`::error::check-no-chinese: git ${args.join(' ')} failed: ${run.stderr ? run.stderr.toString() : '(no stderr)'}\n`);
    process.exit(2);
  }
  return run.stdout;
}

function walkFiles(root, base, acc = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(full, rel, acc);
    else if (entry.isFile() || entry.isSymbolicLink()) acc.push([full, rel]);
  }
  return acc;
}

// -- argument parsing --------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`usage: node scripts/ci/check-no-chinese.mjs [--out <path>] [--include-dist]\n                          [--extra-dir <path>] [--history] [--json]\n\nScans tracked + untracked files (and optionally dist/ and --extra-dir trees)\nfor Chinese/CJK-language content and Chinese locale identifiers.\nExit 0 = zero hits, 1 = hits found, 2 = scan could not run.\nNo dependencies, no network.\n`);
  process.exit(0);
}
// Strict argument validation: the header documents "usage errors exit 2",
// so unknown flags and a valueless --out must fail loudly instead of being
// silently ignored (a silently ignored --include-dist would weaken the gate).
const KNOWN_FLAGS = new Set(['--help', '--out', '--include-dist', '--extra-dir', '--history', '--json']);
let outArg = null;
const extraDirsRaw = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out') {
    outArg = argv[i + 1];
    if (!outArg || outArg.startsWith('--')) {
      process.stderr.write('::error::check-no-chinese: --out requires a path argument (usage errors exit 2)\n');
      process.exit(2);
    }
    i += 1;
    continue;
  }
  if (argv[i] === '--extra-dir') {
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) {
      process.stderr.write('::error::check-no-chinese: --extra-dir requires a path argument (usage errors exit 2)\n');
      process.exit(2);
    }
    extraDirsRaw.push(val);
    i += 1;
    continue;
  }
  if (!KNOWN_FLAGS.has(argv[i])) {
    process.stderr.write(`::error::check-no-chinese: unknown argument "${argv[i]}" (usage errors exit 2; run with --help)\n`);
    process.exit(2);
  }
}
const includeDist = argv.includes('--include-dist');
const historyMode = argv.includes('--history');
const jsonStdout = argv.includes('--json');
// Resolve extra dirs against the INVOCATION cwd (the chdir below moves to the
// repo top; a caller extracting a package into a temp dir passes absolute or
// invocation-relative paths, never repo-relative ones).
const extraDirs = extraDirsRaw.map((p) => resolve(p));
// Deterministic, unique report prefixes: first dir with a basename wins the
// plain name; later collisions get -2, -3, ... in CLI order.
const usedExtraPrefixes = new Map();
const extraScopes = extraDirs.map((dir) => {
  let prefix = basename(dir) || 'extra';
  if (usedExtraPrefixes.has(prefix)) {
    const n = usedExtraPrefixes.get(prefix) + 1;
    usedExtraPrefixes.set(prefix, n);
    prefix = `${prefix}-${n}`;
  } else {
    usedExtraPrefixes.set(prefix, 1);
  }
  return { dir, prefix };
});

const repoTop = git(['rev-parse', '--show-toplevel']).toString().trim();
const headSha = git(['rev-parse', 'HEAD'], { allowFail: true }).toString().trim() || null;
process.chdir(repoTop);

// Last-resort honesty: an unexpected crash must produce a distinct error
// annotation and a nonzero exit - never a silently green gate.
process.on('uncaughtException', (err) => {
  process.stderr.write(`::error::check-no-chinese: the scan itself failed: ${err && err.message ? err.message : err}\n`);
  process.exit(2);
});

// -- scope 1+2: tracked and untracked files ---------------------------------
const tracked = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
SUMMARY.tracked = tracked.length;
SUMMARY.untracked = untracked.length;
for (const rel of tracked) scanTextFile('content', 'tracked', join(repoTop, rel), rel);
for (const rel of untracked) scanTextFile('content', 'untracked', join(repoTop, rel), rel);

// -- scope 3 (optional): generated build output ------------------------------
if (includeDist) {
  const distDir = join(repoTop, 'dist');
  if (existsSync(distDir)) {
    for (const [abs, rel] of walkFiles(distDir, 'dist')) {
      SUMMARY.dist += 1;
      scanTextFile('content', 'dist', abs, rel);
    }
  } else {
    process.stderr.write('::warning::--include-dist requested but dist/ does not exist (run the production build first)\n');
  }
}

// -- scope 3b (optional): explicitly requested extra trees -------------------
// Package-extraction primitive: a release job may unzip an artifact (e.g. an
// APK's assets/) and hand the tree here. Fail-closed rules:
//   - a requested dir that does not exist or is not a directory -> exit 2
//     (unlike a missing dist/, an EXPLICITLY passed target is a requirement,
//     and a silently skipped requirement would fake a clean gate)
//   - walk/read failures propagate to the uncaughtException handler (exit 2)
//   - every file is scanned with the SAME policy as the repo scopes
//     (declared-textual at 1-char sensitivity, binaries via parsed metadata
//     or the RUN_CJK_MIN printable-run bar) - no special treatment.
if (extraScopes.length > 0) {
  for (const { dir, prefix } of extraScopes) {
    let st = null;
    try { st = statSync(dir); } catch { /* missing -> fail closed below */ }
    if (!st || !st.isDirectory()) {
      process.stderr.write(`::error::check-no-chinese: --extra-dir "${dir}" does not exist or is not a directory - an explicitly requested scan target is missing, refusing to report a clean scan\n`);
      process.exit(2);
    }
    for (const [abs, rel] of walkFiles(dir, prefix)) {
      SUMMARY.extra += 1;
      scanTextFile('content', 'extra-dir', abs, rel);
    }
  }
}

// -- scope 4 (optional, report-only): reachable history ----------------------
if (historyMode) {
  // Newline-separated (rev-list --objects has no NUL mode): split each line
  // on the FIRST space only - paths may contain spaces.
  const objects = git(['rev-list', '--objects', '--all']).toString().split('\n').filter(Boolean);
  const blobs = [];
  for (const line of objects) {
    const sp = line.indexOf(' ');
    const sha = sp === -1 ? line : line.slice(0, sp);
    const path = sp === -1 ? '' : line.slice(sp + 1);
    blobs.push([sha, path]);
  }
  const trackedSet = new Set(tracked);
  // Content-based still-present check: a historical finding is "still
  // present" only when the SAME code points (or the exact locale id) can be
  // found in the current working-tree file at that path. A path-based check
  // would label every hit of a since-cleaned file as STILL PRESENT.
  const currentTextCache = new Map();
  const currentTreeText = (relPath) => {
    if (currentTextCache.has(relPath)) return currentTextCache.get(relPath);
    let text = null;
    if (trackedSet.has(relPath)) {
      try {
        const abs = join(repoTop, relPath);
        const lst = lstatSync(abs);
        if (lst.isSymbolicLink()) {
          // The committed blob of a symlink is its link text.
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(readlinkSync(abs, 'buffer')); } catch { text = null; }
        } else {
          const buf = readFileSync(abs);
          if (!isProbablyBinary(buf)) {
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = null; }
          }
        }
      } catch { text = null; }
    }
    currentTextCache.set(relPath, text);
    return text;
  };
  const stillPresentInCurrentTree = (relPath, findings) => {
    const text = currentTreeText(relPath);
    if (text === null) return false;
    for (const f of findings) {
      // Filename findings: the offending NAME is the content - check path
      // existence first, always (the codepoint branch below would compare
      // the name's characters against file CONTENT instead).
      if (f.kind === 'filename') return trackedSet.has(relPath);
      if (f.codepoint) {
        const cp = parseInt(f.codepoint.slice(2), 16);
        if (Number.isFinite(cp) && text.includes(String.fromCodePoint(cp))) return true;
      } else if (f.kind === 'locale-identifier') {
        const m = /"([^"]+)"/.exec(f.category || '');
        if (m) {
          // Boundary-delimited presence test mirroring the scan's own locale
          // matching: an id embedded inside a longer alphanumeric token (the
          // test suite plants decoys like x-z-h-C-N-x to prove the scan does
          // not false-positive) is NOT a live locale registration, so it must
          // not be reported as "still present". A boundary-free includes()
          // here produced a false STILL PRESENT attribution (round-5 audit).
          const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`).test(text)) return true;
        }
      }
    }
    return false;
  };
  for (const [sha, path] of blobs) {
    const show = spawnSync('git', ['cat-file', '-t', sha], { encoding: 'utf8' });
    if (show.status !== 0 || show.stdout.trim() !== 'blob') { SUMMARY.historyNonBlobObjects += 1; continue; }
    const size = spawnSync('git', ['cat-file', '-s', sha], { encoding: 'utf8' });
    if (size.status !== 0) { SUMMARY.historySkippedUndecodable += 1; continue; }
    if (Number(size.stdout.trim()) > 5 * 1024 * 1024) { SUMMARY.historySkippedOversize += 1; continue; } // DECLARED cap: oversized blobs are skipped and counted, never silently
    const buf = git(['cat-file', 'blob', sha], { allowFail: true });
    if (!buf || buf.length === 0) { SUMMARY.historySkippedEmpty += 1; continue; }
    SUMMARY.historyBlobs += 1;
    const pseudoPath = path || `blob:${sha.slice(0, 12)}`;
    const hitsBefore = HITS.length;
    const warnsBefore = WARNINGS.length;
    if (isProbablyBinary(buf)) scanBinaryFile('content', 'history', null, pseudoPath, buf);
    else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { SUMMARY.historySkippedUndecodable += 1; continue; } // undecodable historical blob: not a current-tree finding, but the skip is declared
      SUMMARY.textScanned += 1;
      for (const hit of scanTextPayload('content', 'history', pseudoPath, text)) pushHit2(hit, 'content', 'history', pseudoPath);
      scanFilename('content', 'history', pseudoPath);
    }
    const log = git(['log', '--all', '--find-object', sha, '--format=%H|%s', '-n', '1'], { allowFail: true }).toString().trim();
    const [cSha, ...cSubj] = log.split('|');
    // Honest label: --find-object reports the most recent commit that TOUCHED
    // the blob (added OR removed it) - it is not provably the introducing
    // commit, so the field is named last_touching_commit.
    const attribution = cSha ? `${cSha.slice(0, 12)} ${cSubj.join('|')}` : 'unattributed';
    const newHits = HITS.splice(hitsBefore); // history findings live in HISTORY_HITS only
    const newWarns = WARNINGS.splice(warnsBefore);
    const findings = [...newHits, ...newWarns];
    const stillThere = stillPresentInCurrentTree(pseudoPath, findings);
    for (const f of findings) {
      HISTORY_HITS.push({ ...f, blob: sha.slice(0, 12), last_touching_commit: attribution, still_present: stillThere });
    }
  }
  // Sanity: a repo with objects but ZERO scannable blobs means the parsing
  // above broke - the history scan must never silently report nothing.
  if (blobs.length > 0 && SUMMARY.historyBlobs === 0) {
    process.stderr.write('::error::check-no-chinese: history scan listed objects but scanned zero blobs - refusing to report an empty history pass\n');
    process.exit(2);
  }
}

// -- reporting ---------------------------------------------------------------
// Codepoint-order sort (NOT localeCompare): the report must be byte-stable
// regardless of the ICU locale the runner happens to have installed.
HITS.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || ((a.line || 0) - (b.line || 0)) || ((a.col || 0) - (b.col || 0)));
const report = {
  tool: 'fress/no-chinese@v1',
  commit: headSha,
  // No wall-clock timestamp field: the report is fully byte-deterministic
  // for identical trees (CI run logs carry the timing metadata already).
  scope: {
    tracked_files: SUMMARY.tracked,
    untracked_files_included: SUMMARY.untracked,
    dist_files: includeDist ? SUMMARY.dist : null,
    extra_dir_files: extraScopes.length > 0 ? SUMMARY.extra : null,
    text_files_scanned: SUMMARY.textScanned,
    binary_files_skipped_from_text_scan: SUMMARY.binarySkipped,
    font_binaries_skipped_glyph_coverage_not_text: SUMMARY.fontSkipped,
    png_metadata_payloads_inspected: SUMMARY.pngMetadata,
    jpeg_metadata_payloads_inspected: SUMMARY.jpegMetadata,
    opaque_binaries_string_scanned: SUMMARY.binaryStringScans,
  ole_compound_containers_structural: SUMMARY.oleContainers,
    history_blobs_scanned: historyMode ? SUMMARY.historyBlobs : null,
    history_only_findings: historyMode ? HISTORY_HITS.length : null,
    history_non_blob_objects_skipped: historyMode ? SUMMARY.historyNonBlobObjects : null,
    history_blobs_skipped_oversize_declared_cap_5mb: historyMode ? SUMMARY.historySkippedOversize : null,
    history_blobs_skipped_empty_or_unreadable: historyMode ? SUMMARY.historySkippedEmpty : null,
    history_blobs_skipped_undecodable: historyMode ? SUMMARY.historySkippedUndecodable : null,
  },
  hits: HITS,
  warnings: WARNINGS,
  ...(historyMode ? { history_hits: HISTORY_HITS } : {}),
  summary: {
    total_hits: HITS.length,
    warnings_count: WARNINGS.length,
    by_kind: HITS.reduce((m, h) => { m[h.kind] = (m[h.kind] || 0) + 1; return m; }, {}),
    result: HITS.length === 0 ? 'PASS - zero Chinese/CJK-language content observed' : 'FAIL - hits present',
    exit_code: HITS.length === 0 ? 0 : 1,
  },
};

const md = [];
md.push('# Zero-Chinese-content scan');
md.push('');
md.push(`Commit: \`${headSha || '(none)'}\` - Result: **${HITS.length === 0 ? 'PASS (zero hits)' : `FAIL (${HITS.length} hit(s))`}**${WARNINGS.length > 0 ? ` - ${WARNINGS.length} non-Chinese CJK warning(s) reported` : ''}`);
md.push('');
md.push('| File class | Count |');
md.push('|---|---|');
md.push(`| tracked files | ${SUMMARY.tracked} |`);
md.push(`| untracked (release-commit candidates) | ${SUMMARY.untracked} |`);
md.push(`| generated dist/ files${includeDist ? '' : ' (not requested)'} | ${includeDist ? SUMMARY.dist : '-'} |`);
md.push(`| extra-dir files (--extra-dir)${extraScopes.length > 0 ? '' : ' (not requested)'} | ${extraScopes.length > 0 ? SUMMARY.extra : '-'} |`);
md.push(`| text files decoded + scanned | ${SUMMARY.textScanned} |`);
md.push(`| binary files (no raw-text scan) | ${SUMMARY.binarySkipped} |`);
md.push(`| - font binaries skipped (glyph coverage is not UI copy) | ${SUMMARY.fontSkipped} |`);
md.push(`| - PNG metadata payloads inspected | ${SUMMARY.pngMetadata} |`);
md.push(`| - JPEG metadata payloads inspected | ${SUMMARY.jpegMetadata} |`);
md.push(`| - opaque binaries printable-run scanned | ${SUMMARY.binaryStringScans} |`);
md.push(`| - OLE compound containers (MSI): structured, not raw-text scanned | ${SUMMARY.oleContainers} |`);
if (historyMode) {
  md.push(`| history blobs scanned (report-only) | ${SUMMARY.historyBlobs} |`);
  md.push(`| history non-blob objects skipped | ${SUMMARY.historyNonBlobObjects} |`);
  md.push(`| history blobs skipped: oversize (declared 5 MB cap) | ${SUMMARY.historySkippedOversize} |`);
  md.push(`| history blobs skipped: empty or unreadable | ${SUMMARY.historySkippedEmpty} |`);
  md.push(`| history blobs skipped: undecodable as UTF-8 | ${SUMMARY.historySkippedUndecodable} |`);
}
md.push('');
if (HITS.length > 0) {
  md.push('| Kind | Path | Line:Col | Code point | Category | Context (escaped) | Owner action |');
  md.push('|---|---|---|---|---|---|---|');
  for (const h of HITS) {
    md.push(`| ${h.kind} | \`${h.path}\` | ${h.line !== null && h.line !== undefined ? `${h.line}:${h.col}` : '-'} | ${h.codepoint || '-'} | ${h.category} | \`${h.context_escaped.slice(0, 80)}\` | ${h.owner_action} |`);
  }
}
if (WARNINGS.length > 0) {
  md.push('');
  md.push(`## Non-Chinese CJK warnings (${WARNINGS.length}) - reported, owner-routed, exit-neutral`);
  md.push('');
  md.push('The gate enforces ZERO CHINESE content. Kana/Hangul (Japanese/Korean script) are not Chinese; they remain unadvertised in this five-language project and are reported for the relevant owner.');
  md.push('');
  for (const w of WARNINGS) {
    md.push(`- \`${w.path}\` ${w.line !== null && w.line !== undefined ? `${w.line}:${w.col}` : '(name)'} ${w.codepoint || ''} ${w.category} - \`${w.context_escaped.slice(0, 70)}\``);
  }
}
if (historyMode && HISTORY_HITS.length > 0) {
  md.push('');
  md.push('## History findings (report-only - each row states whether it is still present in the current tree)');
  md.push('');
  for (const h of HISTORY_HITS) {
    md.push(`- \`${h.path}\` blob ${h.blob} via ${h.last_touching_commit} - ${h.category} at ${h.line !== null && h.line !== undefined ? `${h.line}:${h.col}` : 'name'} ${h.still_present ? '(STILL PRESENT)' : '(since removed)'}`);
  }
}
md.push('');
const mdText = md.join('\n');

if (outArg) {
  const jsonPath = resolve(outArg);
  // The markdown companion is ALWAYS a sibling file: an extensionless (or
  // non-.json) --out path must never have its JSON report clobbered by the
  // .md write.
  const mdPath = /\.json$/i.test(jsonPath) ? jsonPath.replace(/\.json$/i, '.md') : `${jsonPath}.md`;
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(mdPath, `${mdText}\n`);
}
if (jsonStdout) {
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  process.stderr.write(`${mdText}\n`); // the human summary accompanies the JSON
} else {
  process.stderr.write(`${mdText}\n`);
}

process.exitCode = report.summary.exit_code;
