#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * validate:versions — the version-coherence guard.
 *
 * One authoritative build version lives in package.json:version (the release
 * pipeline derives VERSION from it, npm metadata carries it, and both CI
 * checks anchored on it before this script existed). Every other manifest
 * and lockfile that records the application version must agree with it:
 *
 *   package.json                 .version                (canonical)
 *   package-lock.json            .version                (npm root metadata)
 *   package-lock.json            .packages[""].version   (npm workspace root)
 *   src-tauri/Cargo.toml         [package] version       (crate metadata)
 *   src-tauri/Cargo.lock         [[package]] name="fress" -> version (binary metadata)
 *   src-tauri/tauri.conf.json    .version                (Tauri/bundle metadata)
 *
 * ANDROID METADATA (conditional-authoritative). The Android version that
 * ships is normally DERIVED from tauri.conf.json:version by the Tauri CLI
 * at `tauri android build` time, so a plain checkout has no Android version
 * field to check. Two places carry an explicit Android version anyway, and
 * when they exist they are authoritative build inputs:
 *
 *   src-tauri/tauri.conf.json    .bundle.android.versionName  (optional CLI
 *                                override: if set, Android bundles ship THIS
 *                                version — it must agree with the canonical
 *                                one or desktop and Android drift apart)
 *   src-tauri/gen/android/app/build.gradle.kts  versionName    (the generated
 *                                Gradle project's app version; present only
 *                                after `tauri android init`, never gitignored,
 *                                so it can be checked in or sit in a working
 *                                tree — if the file EXISTS, its versionName
 *                                must agree and must be parseable)
 *
 * These are OPTIONAL files/fields: absent means "nothing to check" (not a
 * failure — they are generated, not hand-maintained), but PRESENT means
 * authoritative: a stale, ambiguous or unparsable Android version fails
 * closed exactly like a required field. A file that exists but cannot be
 * read also fails — an unreadable manifest must never silently disable its
 * check.
 *
 * Why lockfiles are checked, not just manifests: a release cut from a stale
 * lockfile ships an old `npm view` version and embeds the old crate version
 * in the binary metadata even though every manifest was bumped.
 *
 * RELEASE MODE (--release-tag vX.Y.Z[-suffix]): when a release is built
 * from a tag, the tag and every authoritative field must be one version.
 * Outside release mode the tag is NOT consulted.
 *
 * DELIBERATE NON-CHECK: the default-branch development version does NOT
 * have to equal the latest published release tag. "1.0.11-beta in the
 * manifests while v1.0.10-beta is the newest published release" is the
 * normal next-version development state, not drift. Comparing against the
 * latest release would reject every legitimate post-release commit, and it
 * would require either network access or fragile git history walking, both
 * of which this validator avoids (it is offline and deterministic on an
 * ordinary checkout). Only an explicitly passed --release-tag is enforced.
 *
 * NOT AUTHORITATIVE (never fail on these, never read them as sources):
 *   - CHANGELOG.md and src/lib/releaseNotes.ts: historical release records.
 *     They document PAST versions by design and are allowed to trail the
 *     build version (a changelog entry is written when a version ships).
 *   - README.md examples, screenshots, test fixtures: prose and test data.
 * Do not mass-replace version strings in those files; only the six fields
 * above are build inputs.
 *
 * Workflow wiring (complete): `ci.yml` → `version-guard` and the `frontend`
 * job run `npm run validate:versions` (development mode); `release.yml` →
 * `version` runs it with `--release-tag "${GITHUB_REF_NAME}"` on tag pushes.
 * The old inline shell copies (ci.yml version-guard bash, the release job's
 * three-manifest check) are retired; scripts/ci/test_workflow_contract.py
 * pins that wiring so it cannot silently regress. validate-security-config.mjs
 * retains a coarser three-manifest agreement check as part of its security
 * report; it is a subset of this validator and not a competing rule source.
 *
 * Failure policy: fail closed. A required file that is missing, unreadable,
 * unparsable, or whose required field is absent or not a valid project
 * version is a FAILURE naming the file, the field and the observed value —
 * never a silent skip.
 *
 * Exit codes: 0 all invariants pass; 1 validation failures; 2 usage error.
 *
 * Usage:
 *   npm run validate:versions
 *   npm run validate:versions -- --release-tag v1.0.10-beta
 *   npm run validate:versions -- --expect-tag v1.0.10-beta
 *   npm run validate:versions -- --root /path/to/checkout
 *
 *   --expect-tag is accepted as an exact alias of --release-tag so release
 *   wiring can use either spelling; prefer --release-tag.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Version grammar
//
// The exact SemVer subset Fress accepts, mirroring src/lib/selfUpdate.ts
// (SEMVER_RE + optional leading "v"). One grammar everywhere: a tag the
// updater would reject as junk must not pass release validation either.
// Anchored on BOTH ends, no leading zeros in the core, prerelease and build
// metadata per semver.org.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Strip the optional, case-insensitive leading "v" the same way the app
 * does (src/lib/selfUpdate.ts), so "v1.0.10-beta" and "1.0.10-beta" are one
 * version. */
export function stripVPrefix(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/** True for anything the app itself would accept as a version string. */
export function isProjectVersion(v: string): boolean {
  return SEMVER_RE.test(stripVPrefix(v));
}

// ---------------------------------------------------------------------------
// Structural parsers
//
// Manifests are parsed as data (JSON.parse / table-aware TOML scan), never
// by substring search over the whole file: "version" appearing in a comment,
// a dependency constraint or another table must not be read as THE version.

/** Parser outcome. The discriminant is a STRING literal ('ok' | 'err'), not
 * a boolean: this repo's tsconfig does not enable strictNullChecks, and
 * under that setting TypeScript does not narrow boolean-literal
 * discriminated unions (verified with tsc 5.8) — string literals narrow
 * fine. Do not "simplify" this back to a boolean discriminant. */
export type ParseResult = { kind: 'ok'; value: string } | { kind: 'err'; error: string };

/** Extract a required string field from parsed JSON. `field` is a display
 * path like `.version` or `.packages[""].version`; `segments` carries the
 * real lookup keys ("" is a real key inside packages, so paths are spelled
 * out instead of being re-parsed from the display string). */
function jsonField(data: unknown, file: string, field: string, segments: string[]): ParseResult {
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') {
      return { kind: 'err', error: `${file} ${field} is missing (parent is not an object)` };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur !== 'string') {
    return { kind: 'err', error: `${file} ${field} is missing or is not a string` };
  }
  if (cur.trim() === '') {
    return { kind: 'err', error: `${file} ${field} is an empty string` };
  }
  return { kind: 'ok', value: cur };
}

/** package.json — the canonical application version. */
export function parsePackageJsonVersion(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { kind: 'err', error: `package.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  return jsonField(data, 'package.json', '.version', ['version']);
}

/** package-lock.json — BOTH root version fields. */
export function parsePackageLockVersions(text: string): { root: ParseResult; pkg: ParseResult } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const error = `package-lock.json is not valid JSON (${e instanceof Error ? e.message : String(e)})`;
    return { root: { kind: 'err', error }, pkg: { kind: 'err', error } };
  }
  return {
    root: jsonField(data, 'package-lock.json', '.version', ['version']),
    pkg: jsonField(data, 'package-lock.json', '.packages[""].version', ['packages', '', 'version']),
  };
}

/** src-tauri/tauri.conf.json — the Tauri/bundle version. */
export function parseTauriConfVersion(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { kind: 'err', error: `src-tauri/tauri.conf.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  return jsonField(data, 'src-tauri/tauri.conf.json', '.version', ['version']);
}

/** Outcome of reading an OPTIONAL field: 'absent' is legitimate (the field
 * is simply not set — never a failure), 'err' means present-but-malformed,
 * which fails closed like any authoritative field. String discriminant:
 * this repo's tsconfig does not narrow boolean-literal unions. */
export type OptionalParseResult =
  | { kind: 'ok'; value: string }
  | { kind: 'absent' }
  | { kind: 'err'; error: string };

/** src-tauri/tauri.conf.json — the optional .bundle.android.versionName
 * override. Absent key (or absent bundle.android object) => 'absent'; a
 * present-but-non-string / empty value => 'err'. */
export function parseTauriAndroidVersionName(text: string): OptionalParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { kind: 'err', error: `src-tauri/tauri.conf.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (data === null || typeof data !== 'object') {
    return { kind: 'absent' };
  }
  const bundle = (data as Record<string, unknown>)['bundle'];
  if (bundle === undefined || bundle === null || typeof bundle !== 'object') {
    return { kind: 'absent' };
  }
  const android = (bundle as Record<string, unknown>)['android'];
  if (android === undefined || android === null || typeof android !== 'object') {
    return { kind: 'absent' };
  }
  const versionName = (android as Record<string, unknown>)['versionName'];
  if (versionName === undefined) return { kind: 'absent' };
  if (typeof versionName !== 'string' || versionName.trim() === '') {
    return { kind: 'err', error: 'src-tauri/tauri.conf.json .bundle.android.versionName is set but is not a non-empty string' };
  }
  return { kind: 'ok', value: versionName };
}

/** src-tauri/gen/android/app/build.gradle.kts — the generated Android
 * project's versionName. Kotlin DSL assignments come in two shapes Tauri
 * emits/accepts: `versionName = "1.0.0"` and Groovy-style
 * `versionName "1.0.0"`. Comments are ignored; exactly ONE uncommented
 * assignment must exist — zero means the authoritative field is missing,
 * several means it is ambiguous, and both fail closed. */
export function parseGradleKtsVersionName(text: string): ParseResult {
  const FILE = 'src-tauri/gen/android/app/build.gradle.kts';
  const found: string[] = [];

  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (line === '') continue;
    // Strip full-line and trailing // comments (no string-aware lexing is
    // needed: a URL inside a versionName cannot contain '//'-started text
    // before the quoted value this parser reads, and a comment can only be
    // *stripped*, never mistaken for an assignment).
    const commentIdx = line.indexOf('//');
    if (commentIdx === 0) continue;
    if (commentIdx > 0) line = line.slice(0, commentIdx).trim();

    const assign = /^(?:[a-zA-Z_][\w.]*\.)?versionName\s*(?:=\s*)?"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (assign) {
      found.push(assign[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
  }

  if (found.length === 0) {
    return { kind: 'err', error: `${FILE} exists but has no parseable versionName assignment (the authoritative Android version field is missing or mangled)` };
  }
  if (found.length > 1) {
    return { kind: 'err', error: `${FILE} has ${found.length} versionName assignments (${found.join(', ')}) — ambiguous, cannot tell which one the build uses` };
  }
  return { kind: 'ok', value: found[0] };
}

// --- Cargo (TOML) -----------------------------------------------------------
//
// Focused table-aware scan for the two machine-generated Cargo files. Not a
// full TOML parser: it tracks table headers and reads only the exact keys
// this validation needs, which is enough structure to be immune to
// comments, dependency version constraints and unrelated tables.

const TOML_TABLE_HEADER = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;
const TOML_ARRAY_HEADER = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/;
const TOML_BASIC_STRING = /^"((?:[^"\\]|\\.)*)"(.*)$/;
const TOML_LITERAL_STRING = /^'([^']*)'(.*)$/;

function readTomlStringLine(line: string): { key: string; value: string; rest: string } | null {
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  const valuePart = line.slice(eq + 1).trim();
  if (key !== 'version' && key !== 'name') return null;
  const basic = TOML_BASIC_STRING.exec(valuePart);
  if (basic) {
    return { key, value: basic[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'), rest: basic[2] };
  }
  const literal = TOML_LITERAL_STRING.exec(valuePart);
  if (literal) {
    return { key, value: literal[1], rest: literal[2] };
  }
  return null;
}

/** src-tauri/Cargo.toml — the [package] table's version key. Sub-tables
 * like [package.metadata] do not count; comments are ignored; a duplicated
 * version key inside [package] is malformed (TOML forbids redefining a
 * key). */
export function parseCargoTomlVersion(text: string): ParseResult {
  let current: string | null = null;
  let seenPackage = false;
  let version: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const arrayHeader = TOML_ARRAY_HEADER.exec(line);
    const tableHeader = arrayHeader ? null : TOML_TABLE_HEADER.exec(line);
    if (arrayHeader || tableHeader) {
      current = (arrayHeader ? arrayHeader[1] : tableHeader![1]).trim();
      if (current === 'package') seenPackage = true;
      continue;
    }

    if (current === 'package') {
      const parsed = readTomlStringLine(line);
      if (!parsed || parsed.key !== 'version' || !parsed.value) continue;
      if (version !== null) {
        return { kind: 'err', error: 'src-tauri/Cargo.toml [package] redefines the "version" key (malformed TOML)' };
      }
      version = parsed.value;
    }
  }

  if (!seenPackage) {
    return { kind: 'err', error: 'src-tauri/Cargo.toml has no [package] table' };
  }
  if (version === null) {
    return { kind: 'err', error: 'src-tauri/Cargo.toml [package] has no "version" key' };
  }
  return { kind: 'ok', value: version };
}

interface LockPackage {
  name: string | null;
  version: string | null;
}

/** src-tauri/Cargo.lock — the version of the fress crate entry.
 *
 * The lockfile's top-level `version = <format>` (e.g. 4) is the lockfile
 * FORMAT version, not an application version; it sits outside any
 * [[package]] record and is never read. Only the [[package]] record whose
 * name is exactly "fress" counts. Zero or several such records is a
 * failure, not a guess. */
export function parseCargoLockFressVersion(text: string): ParseResult {
  const records: LockPackage[] = [];
  let current: LockPackage | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (/^\[\[\s*package\s*\]\]$/.test(line)) {
      current = { name: null, version: null };
      records.push(current);
      continue;
    }
    const tableHeader = TOML_TABLE_HEADER.exec(line);
    if (tableHeader && !tableHeader[1].includes('"')) {
      // A single-bracket table ([metadata], [patch], ...) ends package
      // context. Quoted captures (a continuation of an inline dependency
      // array like ["a 1.0", "b 2.0"]) are data, not headers.
      current = null;
      continue;
    }

    if (current) {
      const parsed = readTomlStringLine(line);
      if (!parsed || parsed.value === '') continue;
      if (parsed.key === 'name') {
        if (current.name !== null) {
          return { kind: 'err', error: 'src-tauri/Cargo.lock has a [[package]] record with a duplicated "name" key (corrupted lockfile)' };
        }
        current.name = parsed.value;
      } else {
        if (current.version !== null) {
          return { kind: 'err', error: 'src-tauri/Cargo.lock has a [[package]] record with a duplicated "version" key (corrupted lockfile)' };
        }
        current.version = parsed.value;
      }
    }
  }

  const fress = records.filter((r) => r.name === 'fress');
  if (fress.length === 0) {
    return { kind: 'err', error: 'src-tauri/Cargo.lock has no [[package]] entry with name = "fress" (stale or foreign lockfile?)' };
  }
  if (fress.length > 1) {
    return { kind: 'err', error: `src-tauri/Cargo.lock has ${fress.length} [[package]] entries named "fress" (ambiguous, corrupted lockfile)` };
  }
  const entry = fress[0];
  if (entry.version === null) {
    return { kind: 'err', error: 'src-tauri/Cargo.lock: the [[package]] entry named "fress" has no "version" key' };
  }
  return { kind: 'ok', value: entry.version };
}

// ---------------------------------------------------------------------------
// Validation core
//
// Pure and I/O-free: `files` maps the five required paths to file CONTENT,
// so tests exercise every rule against in-memory fixtures without touching
// production files. The CLI is a thin loader around this function.

export const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
] as const;

export type RequiredFile = (typeof REQUIRED_FILES)[number];

/** Optional-authoritative files: checked ONLY when present on disk. Absent
 * means the build input does not exist in this checkout (the Android Gradle
 * project is generated by `tauri android init`), which is legitimate — not
 * a skip of a required check. Present means authoritative: it must parse
 * and must agree with the canonical version. */
export const OPTIONAL_FILES = ['src-tauri/gen/android/app/build.gradle.kts'] as const;

export type OptionalFile = (typeof OPTIONAL_FILES)[number];

export interface VersionCheck {
  file: string;
  field: string;
  /** Observed value, or the empty marker when nothing could be read. */
  value: string;
  status: 'canonical' | 'ok' | 'fail' | 'tag';
  detail?: string;
  hint?: string;
}

export interface ValidationReport {
  ok: boolean;
  /** The canonical build version (package.json:version), when readable. */
  canonical: string | null;
  checks: VersionCheck[];
  failures: string[];
  releaseTag: { input: string; normalized: string | null } | null;
}

export interface ValidateInput {
  /** Content by required path. Files absent from the map are MISSING. */
  files?: Partial<Record<RequiredFile, string>>;
  /** Required paths that do not exist on disk (from loadVersionFiles). */
  missing?: string[];
  /** Required paths that exist but could not be read, with the reason. */
  readErrors?: Record<string, string>;
  /** Content of optional-authoritative files by path. A path absent from
   * this map means the file does not exist (nothing to check); a path
   * PRESENT here is validated like a required field. */
  optionalFiles?: Partial<Record<OptionalFile, string>>;
  /** Optional paths that exist but could not be read — fails closed. */
  optionalReadErrors?: Record<string, string>;
  /** Release-context tag (e.g. "v1.0.10-beta" from GITHUB_REF_NAME). */
  releaseTag?: string;
}

interface FieldSpec {
  file: RequiredFile;
  field: string;
  /** Unique map key (field names collide: package.json and package-lock
   * both display ".version"). */
  id: string;
  /** package-lock.json is parsed once for BOTH fields, so it has no
   * single-field extractor; the loop handles it explicitly. */
  extract?: (text: string) => ParseResult;
  hint: string;
}

const FIELD_SPECS: FieldSpec[] = [
  {
    file: 'package.json',
    field: '.version',
    id: 'package.json:.version',
    extract: (t) => parsePackageJsonVersion(t),
    hint: 'package.json is the canonical build version; fix it first, then re-sync the rest',
  },
  {
    file: 'package-lock.json',
    field: '.version',
    id: 'package-lock.json:.version',
    hint: 'run "npm install" so the lockfile records the bumped version',
  },
  {
    file: 'package-lock.json',
    field: '.packages[""].version',
    id: 'package-lock.json:packages-root',
    hint: 'run "npm install" so the lockfile records the bumped version',
  },
  {
    file: 'src-tauri/Cargo.toml',
    field: '[package] version',
    id: 'Cargo.toml:package.version',
    extract: (t) => parseCargoTomlVersion(t),
    hint: 'bump [package] version in src-tauri/Cargo.toml to match',
  },
  {
    file: 'src-tauri/Cargo.lock',
    field: '[[package] name="fress"] version',
    id: 'Cargo.lock:fress.version',
    extract: (t) => parseCargoLockFressVersion(t),
    hint: 'run any cargo command in src-tauri/ (e.g. "cargo check") so Cargo.lock records the crate\'s own version',
  },
  {
    file: 'src-tauri/tauri.conf.json',
    field: '.version',
    id: 'tauri.conf.json:version',
    extract: (t) => parseTauriConfVersion(t),
    hint: 'bump "version" in src-tauri/tauri.conf.json to match',
  },
];

function expectedLine(file: string, field: string, observed: string, canonical: string, hint: string): string {
  return `${file} ${field} is ${observed}, expected ${canonical} (package.json:version). Fix: ${hint}`;
}

export function validateVersions(input: ValidateInput): ValidationReport {
  const { files = {}, missing = [], readErrors = {}, releaseTag } = input;
  const checks: VersionCheck[] = [];
  const failures: string[] = [];

  // Fail closed on absent files: a required path with no content provided
  // (not on disk per `missing`, or absent from the in-memory map for direct
  // callers) is a failure, never a silent skip.
  const absent = REQUIRED_FILES.filter(
    (p) => typeof files[p] !== 'string' && !missing.includes(p) && !(p in readErrors)
  );
  const allMissing = [...missing, ...absent];

  // Read-level failures first: missing/unreadable required files fail closed.
  const unreadable = new Set<string>([...allMissing, ...Object.keys(readErrors)]);
  for (const path of REQUIRED_FILES) {
    if (allMissing.includes(path)) {
      checks.push({ file: path, field: '(file)', value: '(missing)', status: 'fail', detail: 'required file is missing' });
      failures.push(`${path} is missing — version coherence cannot be checked without it.`);
    } else if (readErrors[path]) {
      checks.push({ file: path, field: '(file)', value: '(unreadable)', status: 'fail', detail: readErrors[path] });
      failures.push(`${path} could not be read (${readErrors[path]}).`);
    }
  }

  // Extract every authoritative field. Even when the canonical version is
  // unreadable, every other field is still parsed and reported (fail closed
  // on malformed data; never skip silently).
  const observed = new Map<string, { file: string; field: string; value: string | null; error: string | null; hint: string }>();

  for (const spec of FIELD_SPECS) {
    const set = (value: string | null, error: string | null) =>
      observed.set(spec.id, { file: spec.file, field: spec.field, value, error, hint: spec.hint });

    if (unreadable.has(spec.file)) {
      set(null, '(file missing/unreadable)');
      continue;
    }
    const text = files[spec.file];
    if (typeof text !== 'string') {
      set(null, '(file missing)');
      continue;
    }
    if (spec.file === 'package-lock.json') {
      const { root, pkg } = parsePackageLockVersions(text);
      const target = spec.field === '.version' ? root : pkg;
      set(target.kind === 'ok' ? target.value : null, target.kind === 'ok' ? null : target.error);
      continue;
    }
    const result = spec.extract!(text);
    set(result.kind === 'ok' ? result.value : null, result.kind === 'ok' ? null : result.error);
  }

  // Canonical version: package.json:version.
  const canonicalEntry = observed.get('package.json:.version')!;
  const fileField = (e: { file: string; field: string }) => `${e.file}${e.field.startsWith('.') ? e.field : ' ' + e.field}`;
  // Synthetic errors mean the FILE was absent/unreadable: the file-level
  // failure above already explains that, so field rows stay informational
  // and must not double-report.
  const isSynthetic = (error: string | null) => error === '(file missing)' || error === '(file missing/unreadable)';
  let canonical: string | null = null;

  if (canonicalEntry.value !== null) {
    if (!isProjectVersion(canonicalEntry.value)) {
      const msg = `package.json.version is "${canonicalEntry.value}" — not a valid project version (expected a SemVer string like 1.0.10-beta; see src/lib/selfUpdate.ts for the accepted grammar).`;
      checks.push({ file: 'package.json', field: '.version', value: canonicalEntry.value, status: 'fail', detail: msg });
      failures.push(msg);
    } else {
      canonical = stripVPrefix(canonicalEntry.value);
      checks.push({ file: 'package.json', field: '.version', value: canonicalEntry.value, status: 'canonical' });
    }
  } else {
    const synthetic = isSynthetic(canonicalEntry.error);
    const msg = synthetic ? 'package.json.version: file missing/unreadable' : canonicalEntry.error ?? 'package.json.version is missing';
    checks.push({ file: 'package.json', field: '.version', value: '(unreadable)', status: 'fail', detail: msg });
    if (!synthetic) failures.push(msg);
  }

  // Every other field must exist, be a valid project version, and agree.
  for (const spec of FIELD_SPECS) {
    if (spec.file === 'package.json') continue; // canonical, already reported
    const entry = observed.get(spec.id)!;

    if (entry.value === null) {
      const synthetic = isSynthetic(entry.error);
      const msg = synthetic ? `${fileField(entry)}: file missing/unreadable` : entry.error ?? `${fileField(entry)} is missing`;
      checks.push({
        file: entry.file,
        field: entry.field,
        value: '(unreadable)',
        status: 'fail',
        detail: msg,
        hint: entry.hint,
      });
      // Complete sentences from the parsers go out verbatim; synthetic
      // file-level rows are already covered by the file-level failure.
      if (!synthetic) failures.push(msg);
      continue;
    }

    if (!isProjectVersion(entry.value)) {
      const msg = `${fileField(entry)} is "${entry.value}" — not a valid project version (expected a SemVer string like 1.0.10-beta).`;
      checks.push({ file: entry.file, field: entry.field, value: entry.value, status: 'fail', detail: msg, hint: entry.hint });
      failures.push(msg);
      continue;
    }

    if (canonical === null) {
      const msg = `${fileField(entry)} is "${entry.value}" but the canonical package.json version is unavailable — cannot verify agreement (fail closed).`;
      checks.push({ file: entry.file, field: entry.field, value: entry.value, status: 'fail', detail: msg });
      failures.push(msg);
      continue;
    }

    const normalized = stripVPrefix(entry.value);
    if (normalized !== canonical) {
      const msg = expectedLine(entry.file, entry.field, `"${entry.value}"`, `"${canonical}"`, entry.hint);
      checks.push({ file: entry.file, field: entry.field, value: entry.value, status: 'fail', detail: msg, hint: entry.hint });
      failures.push(msg);
      continue;
    }

    checks.push({ file: entry.file, field: entry.field, value: entry.value, status: 'ok' });
  }

  // Release-tag mode: the tag and the build versions must be one version.
  let releaseTagReport: ValidationReport['releaseTag'] = null;
  if (releaseTag !== undefined && releaseTag !== null && releaseTag !== '') {
    const normalizedTag = stripVPrefix(releaseTag);
    if (!isProjectVersion(releaseTag)) {
      releaseTagReport = { input: releaseTag, normalized: null };
      const msg = `--release-tag "${releaseTag}" is not a valid project version tag (expected vX.Y.Z or vX.Y.Z-suffix, e.g. v1.0.10-beta). An unparsable tag must never be interpreted as "some version".`;
      checks.push({ file: '(release tag)', field: '--release-tag', value: releaseTag, status: 'fail', detail: msg });
      failures.push(msg);
    } else {
      releaseTagReport = { input: releaseTag, normalized: normalizedTag };
      if (canonical !== null && normalizedTag !== canonical) {
        const msg = `release tag "${releaseTag}" (${normalizedTag}) disagrees with the build version "${canonical}" in package.json — a release is built from a tag, so the tagged source must carry that version. Re-tag from the right commit or align the manifests; NEVER move or retarget an already-published tag.`;
        checks.push({ file: '(release tag)', field: '--release-tag', value: releaseTag, status: 'fail', detail: msg });
        failures.push(msg);
      } else if (canonical !== null) {
        checks.push({ file: '(release tag)', field: '--release-tag', value: releaseTag, status: 'tag' });
      }
    }
  }

  // ---------------------------------------------------------------------
  // ANDROID metadata (conditional-authoritative).
  //
  // 1) .bundle.android.versionName in tauri.conf.json — an explicit CLI
  //    override. If the key is set, Android bundles ship THAT version, so
  //    it must agree with the canonical one. Absent = the top-level version
  //    applies (legitimate, no row).
  // 2) versionName in the generated Gradle project — checked only when the
  //    file exists (after `tauri android init`). Present-but-unparsable,
  //    ambiguous, or unreadable fails closed; stale fails as drift.
  // A failure in a required file means its content is untrustworthy; the
  // Android override shares that file, so the file-level failure already
  // covers it (no double reporting).
  const tauriConfText = files['src-tauri/tauri.conf.json'];
  const tauriConfTrusted = typeof tauriConfText === 'string';

  if (tauriConfTrusted) {
    const override = parseTauriAndroidVersionName(tauriConfText!);
    if (override.kind === 'err') {
      checks.push({ file: 'src-tauri/tauri.conf.json', field: '.bundle.android.versionName', value: '(malformed)', status: 'fail', detail: override.error });
      failures.push(override.error);
    } else if (override.kind === 'ok') {
      if (canonical === null) {
        const msg = `src-tauri/tauri.conf.json .bundle.android.versionName is "${override.value}" but the canonical package.json version is unavailable — cannot verify agreement (fail closed).`;
        checks.push({ file: 'src-tauri/tauri.conf.json', field: '.bundle.android.versionName', value: override.value, status: 'fail', detail: msg });
        failures.push(msg);
      } else if (stripVPrefix(override.value) !== canonical) {
        const msg = expectedLine('src-tauri/tauri.conf.json', '.bundle.android.versionName', `"${override.value}"`, `"${canonical}"`, 'remove the Android override or set it to the canonical version (Android bundles would otherwise ship a different version than desktop)');
        checks.push({ file: 'src-tauri/tauri.conf.json', field: '.bundle.android.versionName', value: override.value, status: 'fail', detail: msg, hint: 'remove the Android override or set it to the canonical version' });
        failures.push(msg);
      } else {
        checks.push({ file: 'src-tauri/tauri.conf.json', field: '.bundle.android.versionName', value: override.value, status: 'ok' });
      }
    }
  }

  for (const optPath of OPTIONAL_FILES) {
    if (optPath in (input.optionalReadErrors ?? {})) {
      const reason = input.optionalReadErrors![optPath];
      const msg = `${optPath} exists but could not be read (${reason}) — an unreadable build input must not silently disable its check.`;
      checks.push({ file: optPath, field: '(file)', value: '(unreadable)', status: 'fail', detail: msg });
      failures.push(msg);
      continue;
    }
    const text = input.optionalFiles?.[optPath];
    if (typeof text !== 'string') continue; // absent = generated, nothing to check

    if (optPath === 'src-tauri/gen/android/app/build.gradle.kts') {
      const parsed = parseGradleKtsVersionName(text);
      if (parsed.kind === 'err') {
        checks.push({ file: optPath, field: 'versionName', value: '(unparsable)', status: 'fail', detail: parsed.error });
        failures.push(parsed.error);
        continue;
      }
      if (canonical === null) {
        const msg = `${optPath} versionName is "${parsed.value}" but the canonical package.json version is unavailable — cannot verify agreement (fail closed).`;
        checks.push({ file: optPath, field: 'versionName', value: parsed.value, status: 'fail', detail: msg });
        failures.push(msg);
        continue;
      }
      if (stripVPrefix(parsed.value) !== canonical) {
        const msg = expectedLine(optPath, 'versionName', `"${parsed.value}"`, `"${canonical}"`, 're-run "tauri android build" so the generated project records the current version');
        checks.push({ file: optPath, field: 'versionName', value: parsed.value, status: 'fail', detail: msg, hint: 're-run "tauri android build" so the generated project records the current version' });
        failures.push(msg);
        continue;
      }
      checks.push({ file: optPath, field: 'versionName', value: parsed.value, status: 'ok' });
    }
  }

  return { ok: failures.length === 0, canonical, checks, failures, releaseTag: releaseTagReport };
}

// ---------------------------------------------------------------------------
// Disk loading (CLI only)

export interface LoadedFiles {
  files: Partial<Record<RequiredFile, string>>;
  missing: string[];
  readErrors: Record<string, string>;
  /** Optional-authoritative files that exist on disk, by path. */
  optionalFiles: Partial<Record<OptionalFile, string>>;
  /** Optional paths that exist but could not be read (fail closed). */
  optionalReadErrors: Record<string, string>;
}

/** Read the required files from a checkout. Missing files are reported (and
 * fail closed in validateVersions) rather than skipped. Optional files
 * (the generated Android project) are read only when present; a read error
 * on an EXISTING optional file is recorded and fails closed. */
export function loadVersionFiles(root: string): LoadedFiles {
  const out: LoadedFiles = { files: {}, missing: [], readErrors: {}, optionalFiles: {}, optionalReadErrors: {} };
  for (const rel of REQUIRED_FILES) {
    try {
      out.files[rel] = readFileSync(join(root, rel), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') out.missing.push(rel);
      else out.readErrors[rel] = e instanceof Error ? e.message : String(e);
    }
  }
  for (const rel of OPTIONAL_FILES) {
    try {
      out.optionalFiles[rel] = readFileSync(join(root, rel), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Exists but unreadable: authoritative metadata must not silently
        // disable its own check.
        out.optionalReadErrors[rel] = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering + CLI

const VALUE_COL = 38;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Compact, aligned summary: one line per checked file/field, plus the
 * canonical value and the mode. */
export function renderReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push('validate:versions — Fress version coherence');
  lines.push('');
  lines.push(`  canonical build version: ${report.canonical ?? '(unreadable)'}  (package.json:version)`);
  lines.push('');
  for (const check of report.checks) {
    const mark = check.status === 'fail' ? 'FAIL' : check.status === 'canonical' ? 'source' : check.status === 'tag' ? 'ok' : 'ok';
    lines.push(`  ${pad(check.file, 26)} ${pad(check.field, VALUE_COL)} ${pad(check.value, 14)} ${mark}`);
  }
  lines.push('');
  if (report.releaseTag) {
    lines.push(
      `  release-tag mode: ${report.releaseTag.input}` +
        (report.releaseTag.normalized ? ` (normalized: ${report.releaseTag.normalized})` : ' (unparsable)')
    );
  } else {
    lines.push('  release-tag mode: off — the development version may differ from the latest published release (by design).');
  }
  lines.push('');
  if (report.ok) {
    const agreed = report.checks.filter((c) => c.status !== 'fail').length;
    lines.push(`validate:versions PASSED — ${agreed} authoritative field(s) agree${report.canonical ? ` on ${report.canonical}` : ''}${report.releaseTag?.normalized ? ` with release tag ${report.releaseTag.input}` : ''}.`);
  } else {
    lines.push(`validate:versions FAILED — ${report.failures.length} problem(s):`);
    for (const failure of report.failures) {
      lines.push(`  - ${failure}`);
    }
  }
  return lines.join('\n');
}

export const USAGE = `validate:versions — check Fress version coherence

Usage:
  npm run validate:versions [-- --release-tag <tag>] [--root <dir>]

Options:
  --release-tag <tag>   Release context: the tag (e.g. v1.0.10-beta) must equal
                        the build version in every authoritative field.
  --expect-tag <tag>    Exact alias of --release-tag (wiring compatibility).
  --root <dir>          Checkout root (default: the repo root this file lives in).
  -h, --help            Show this help.

Android metadata (src-tauri/gen/android/app/build.gradle.kts versionName and
the tauri.conf.json .bundle.android.versionName override) is checked whenever
it exists; its absence is legitimate because it is generated at build time.

Exit codes: 0 pass, 1 validation failure, 2 usage error.`;

/** Parse argv, load files, validate, render, and return the process exit
 * code. Exported for tests; the direct-run guard below is the real entry. */
export function runCli(argv: string[]): number {
  let root: string | undefined;
  let releaseTag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = (name: string): string | null => {
      if (arg === name) {
        if (i + 1 >= argv.length) {
          console.error(`validate:versions: ${name} requires a value\n\n${USAGE}`);
          return null;
        }
        return argv[++i];
      }
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      return null;
    };

    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      return 0;
    }
    const tag = inline('--release-tag') ?? inline('--expect-tag');
    if (tag !== null) {
      releaseTag = tag;
      continue;
    }
    const r = inline('--root');
    if (r !== null) {
      root = r;
      continue;
    }
    console.error(`validate:versions: unknown argument "${arg}"\n\n${USAGE}`);
    return 2;
  }

  const checkoutRoot = root ?? resolve(join(dirnameFileUrl(), '..', '..'));
  const loaded = loadVersionFiles(checkoutRoot);
  const report = validateVersions({
    files: loaded.files,
    missing: loaded.missing,
    readErrors: loaded.readErrors,
    optionalFiles: loaded.optionalFiles,
    optionalReadErrors: loaded.optionalReadErrors,
    releaseTag,
  });
  const rendered = renderReport(report);
  console.log(rendered);
  // GitHub Actions annotations: when running inside a workflow, surface each
  // failure as a ::error:: so the PR diff shows WHERE version coherence
  // broke. Local runs keep the plain report.
  if (process.env.GITHUB_ACTIONS && !report.ok) {
    for (const failure of report.failures) {
      console.error(`::error::validate:versions: ${failure}`);
    }
  }
  return report.ok ? 0 : 1;
}

/** Repo root inferred from this file's location (scripts/ci/<file> -> root). */
function dirnameFileUrl(): string {
  // import.meta.url is unavailable in the CJS test shim; fall back to cwd.
  try {
    return decodeURIComponent(new URL('.', import.meta.url).pathname);
  } catch {
    return process.cwd();
  }
}

// Direct-run guard: run the CLI only when executed as a script, so tests can
// import the pure core without triggering file I/O.
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  process.exit(runCli(process.argv.slice(2)));
}
