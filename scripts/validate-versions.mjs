#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Version-coherence validation - THE single authoritative implementation.
//
// Every workflow that needs a version-consistency verdict invokes this
// command (`npm run validate:versions`); none of them re-implement the
// rules in shell. The version RULES belong to Agent 2 (i18n/dictionary
// and version-validator owner); the pipeline WIRING (which jobs call it,
// and where it blocks) belongs to the CI/release owner. One rules file,
// many callers.
//
// What it proves:
//   1. package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json,
//      package-lock.json (both recorded positions) and the `fress` crate
//      entry in src-tauri/Cargo.lock all declare the SAME version.
//   2. Version shape: MAJOR.MINOR.PATCH with an optional prerelease
//      suffix (-beta/-alpha/-rc.N/...). A drifted or hand-mangled version
//      fails before anything builds.
//   3. With --expect-tag: a release tag must be exactly `v<version>` -
//      the tag the installer reports can never disagree with the tag the
//      user clicked. Ordinary development builds pass WITHOUT the flag:
//      the working-tree version (e.g. 1.0.10-beta) is NOT required to
//      equal the currently published release (e.g. v1.0.9-beta) - that
//      comparison would fail every post-release commit forever.
//
// Usage:
//   npm run validate:versions                     # manifest coherence only
//   npm run validate:versions -- --expect-tag vX.Y.Z   # + tag binding
//   node scripts/validate-versions.mjs --root <dir>    # alternate tree (tests)
//
// Exit 0 iff every check passes; failures print `error: ...` lines (and
// `::error::` annotations when GITHUB_ACTIONS is set) and exit 1.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ci = !!process.env.GITHUB_ACTIONS;
const fail = (msg) => {
  console.error(`${ci ? '::error::' : ''}error: ${msg}`);
  process.exitCode = 1;
};

// ---- argument parsing (tiny by design; no dependency on the app bundle) --
const argv = process.argv.slice(2);
let expectTag = null;
let root = process.cwd();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect-tag') expectTag = argv[++i] ?? null;
  else if (argv[i] === '--root') root = argv[++i] ?? process.cwd();
  else {
    fail(`unknown argument: ${argv[i]} (supported: --expect-tag <tag>, --root <dir>)`);
  }
}
if (process.exitCode) process.exit(process.exitCode);

const read = (p) => readFileSync(join(root, p), 'utf8');

// ---- 1. the version and its shape ---------------------------------------
const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
if (typeof version !== 'string' || !SHAPE.test(version)) {
  fail(`package.json version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH[-prerelease]`);
  process.exit(process.exitCode ?? 1);
}
console.log(`ok package.json: ${version}`);

// ---- 2. every build manifest and lockfile must agree --------------------
const cargoToml = read('src-tauri/Cargo.toml');
const cargoMatch = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
if (!cargoMatch) {
  fail('src-tauri/Cargo.toml: no `version = "..."` under [package]');
} else if (cargoMatch[1] !== version) {
  fail(`src-tauri/Cargo.toml version (${cargoMatch[1]}) != package.json version (${version})`);
} else {
  console.log(`ok src-tauri/Cargo.toml: ${cargoMatch[1]}`);
}

const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
if (tauri.version !== version) {
  fail(`src-tauri/tauri.conf.json version (${tauri.version}) != package.json version (${version})`);
} else {
  console.log(`ok src-tauri/tauri.conf.json: ${tauri.version}`);
}

let lock;
try {
  lock = JSON.parse(read('package-lock.json'));
} catch {
  fail('package-lock.json is not valid JSON');
}
if (lock) {
  if (lock.version !== version) {
    fail(`package-lock.json .version (${lock.version}) != package.json version (${version})`);
  } else {
    console.log(`ok package-lock.json .version: ${lock.version}`);
  }
  const pkgEntry = lock.packages && lock.packages[''];
  if (!pkgEntry || pkgEntry.version !== version) {
    fail(`package-lock.json packages[""].version (${pkgEntry && pkgEntry.version}) != package.json version (${version})`);
  } else {
    console.log(`ok package-lock.json packages[""].version: ${pkgEntry.version}`);
  }
}

// Cargo.lock records the crate version where the crate is named ("fress");
// a release cut from a stale lockfile would embed the old version in the
// binary metadata even though Cargo.toml was bumped.
const cargoLock = read('src-tauri/Cargo.lock');
const lines = cargoLock.split('\n');
let crateVersion = null;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'name = "fress"') {
    const m = lines[i + 1] && lines[i + 1].match(/^\s*version\s*=\s*"([^"]+)"/);
    if (m) crateVersion = m[1];
    break;
  }
}
if (crateVersion === null) {
  fail('src-tauri/Cargo.lock: could not find the "fress" crate entry');
} else if (crateVersion !== version) {
  fail(`src-tauri/Cargo.lock fress version (${crateVersion}) != package.json version (${version})`);
} else {
  console.log(`ok src-tauri/Cargo.lock (fress): ${crateVersion}`);
}

// ---- 3. tag binding is enforced ONLY for release builds ------------------
if (expectTag !== null) {
  if (expectTag !== `v${version}`) {
    fail(`release tag (${expectTag}) != package.json version (v${version}) - refusing to publish a mismatched release`);
  } else {
    console.log(`ok tag binding: ${expectTag} == v${version}`);
  }
} else {
  // Development mode: an ordinary default-branch commit is allowed (and
  // expected) to carry the NEXT version while the published release stays
  // behind. Deliberately no comparison against any published tag here.
  console.log('ok tag binding: not required for a development build (no --expect-tag)');
}

if (process.exitCode) {
  console.error(`version coherence FAILED for ${version}`);
  process.exit(process.exitCode);
}
console.log(`version coherence: OK (${version})`);
