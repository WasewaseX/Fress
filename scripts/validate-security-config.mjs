#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Validates the Tauri security configuration without a Rust toolchain:
//   1. the capability file grants EXACTLY the permission matrix that maps to
//      traced frontend call sites (no silent broadening, no orphan grants),
//   2. the production CSP stays restrictive (script-src locked, style-src
//      split, connect-src limited to the verified WebView hosts),
//   3. version fields stay consistent across the three manifests,
//   4. the embedded updater public key still matches the published key file.
//
// Usage: npm run validate:security

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const notes = [];
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function grepSource(pattern, glob) {
  // Tiny recursive scan of src/ (no external ripgrep dependency).
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx|mjs|css)$/.test(entry.name)) {
        const text = readFileSync(p, 'utf8');
        if (new RegExp(pattern).test(text)) results.push(p.replace(`${root}/`, ''));
      }
    }
  };
  walk(join(root, glob));
  return results;
}

console.log('\n[1/5] Capability permission matrix (capabilities/default.json)');

const tauri = readJson('src-tauri/tauri.conf.json');
const capsDir = join(root, 'src-tauri/capabilities');
const capFiles = readdirSync(capsDir).filter((f) => f.endsWith('.json'));
check(capFiles.length === 1 && capFiles[0] === 'default.json', 'exactly one capability file (default.json)', `found: ${capFiles.join(', ')}`);

const cap = readJson('src-tauri/capabilities/default.json');

// The full, expected grant list. Each entry carries the frontend evidence that
// justifies it; the matrix in docs/security/tauri-security.md mirrors this.
const expected = [
  { id: 'core:event:allow-listen', evidence: { file: 'src/lib/downloads.tsx', pattern: "from '@tauri-apps/api/event'" }, why: 'listen() receives download progress/completion/error events emitted by the Rust side' },
  { id: 'core:event:allow-unlisten', evidence: { file: 'src/lib/downloads.tsx', pattern: "from '@tauri-apps/api/event'" }, why: 'the unlisten callback returned by listen() calls plugin:event|unlisten' },
  { id: 'core:path:allow-dirname', evidence: { file: 'src/lib/downloads.tsx', pattern: "dirname" }, why: 'dirname() is an IPC call (plugin:path|dirname) used to fall back to opening the parent folder' },
  { id: 'dialog:allow-open', evidence: { file: 'src/lib/downloads.tsx', pattern: "from '@tauri-apps/plugin-dialog'" }, why: 'the "Choose download folder" picker (openDialog, directory mode)' },
  { id: 'opener:allow-open-url', evidence: { file: 'src/lib/external.ts', pattern: 'openUrl' }, why: 'opens official vendor websites, scoped to https:// only' },
];

// The opener plugin's unrestricted open-path / reveal-item-in-dir grants are
// deliberately ABSENT: opening/revealing downloaded files runs through the
// native `open_downloaded_file` / `reveal_download_file` commands, which
// validate against the session's completed-artifact registry (canonical
// stability, regular file, committed size) before the OS is asked from the
// Rust side; `open_download_dir` admits only download folders (the platform
// default, a folder holding a completed artifact, or one picked this
// session via `record_download_directory`). The inverse check below fails
// if either grant ever reappears in the capability file.
const forbidden = ['opener:allow-open-path', 'opener:allow-reveal-item-in-dir'];

const granted = new Map();
for (const p of cap.permissions) {
  if (typeof p === 'string') granted.set(p, null);
  else granted.set(p.identifier, p);
}

const expectedIds = new Set(expected.map((e) => e.id));
for (const e of expected) {
  check(granted.has(e.id), `grants ${e.id}`, e.why);
  const hits = grepSource(e.evidence.pattern, 'src');
  check(hits.length > 0, `evidence still exists for ${e.id} (${e.evidence.file})`, `pattern ${e.evidence.pattern} not found under src/ — consider dropping the permission`);
}

const unexplained = [...granted.keys()].filter((id) => !expectedIds.has(id));
check(unexplained.length === 0, 'no unexplained/extra permissions in the capability', `unexpected grants: ${unexplained.join(', ')}`);

for (const id of forbidden) {
  check(!granted.has(id), `capability must NOT grant ${id}`, 'open/reveal runs through the validated native open_downloaded_file / reveal_download_file commands instead');
}
for (const cmd of ['open_downloaded_file', 'reveal_download_file', 'open_download_dir', 'record_download_directory']) {
  const hits = grepSource(cmd, 'src');
  check(hits.length > 0, `frontend evidence for native command ${cmd}`, `no src/ call site invokes ${cmd} — the native boundary has no consumer`);
}

check(Array.isArray(cap.windows) && cap.windows.length === 1 && cap.windows[0] === 'main', 'capability targets only the main window');
const configuredWindows = (tauri.app.windows || []).map((w) => w.label || 'main');
check(cap.windows.every((w) => configuredWindows.includes(w)), 'capability windows exist in tauri.conf.json', `windows in config: ${configuredWindows.join(', ')}`);

console.log('\n[2/5] Production CSP (app.security.csp)');

const csp = tauri.app.security.csp;
check(typeof csp === 'string' && csp.length > 0, 'csp is set');

const directives = new Map();
for (const part of String(csp).split(';').map((s) => s.trim()).filter(Boolean)) {
  const [name, ...sources] = part.split(/\s+/);
  directives.set(name, sources);
}

const expectSources = (name, list) => {
  const actual = directives.get(name);
  const ok = actual && list.every((s) => actual.includes(s)) && actual.length === list.length;
  check(ok, `${name} is exactly: ${list.join(' ')}`, actual ? `actual: ${actual.join(' ')}` : 'directive missing');
};
const expectAbsent = (name) => check(!directives.has(name), `${name} is absent`);

expectSources("default-src", ["'self'"]);
expectSources("script-src", ["'self'"]);
check(!directives.has('style-src'), "monolithic style-src is replaced by the elem/attr split (sonner needs inline <style> elements; React styles via CSSOM only)");
expectSources("style-src-elem", ["'self'", "'unsafe-inline'"]);
expectSources("style-src-attr", ["'self'"]);
expectSources("img-src", ["'self'", "data:"]);
expectSources("font-src", ["'self'", "data:"]);
expectSources("object-src", ["'none'"]);
expectSources("base-uri", ["'self'"]);
expectSources("form-action", ["'self'"]);
expectSources("frame-src", ["'none'"]);
expectAbsent('style-src');
expectAbsent('script-src-elem'); // never needed: no inline scripts in dist/

// connect-src: allow only the verified WebView fetch hosts.
const allowedConnectHosts = new Set([
  "'self'",
  'https://api.github.com', // selfUpdate API check, star counts, live search, add-app validation (the only WebView host that actually answers CORS)
  // NOTE: https://github.com was REMOVED - the releases.atom fallback and the
  // SHA256SUMS.txt fetch now go through the native `fetch_self_update_text`
  // command (github.com sends no CORS headers, so the WebView fetch never
  // worked; see docs/security/tauri-security.md). Do not re-add the host
  // without evidence of a WebView-fetched document.
]);
const connect = directives.get('connect-src') || [];
check(connect.length > 0, 'connect-src is present');
for (const src of connect) {
  check(allowedConnectHosts.has(src), `connect-src entry verified: ${src}`, 'not in the allowlist — document it in docs/security/tauri-security.md first');
}
check(!connect.includes('https://f-droid.org'), 'connect-src does not re-add f-droid.org (desktop path uses the native fetch_fdroid_package command)');

// Global sanity: no wildcards or insecure schemes anywhere.
for (const [name, sources] of directives) {
  for (const s of sources) {
    check(s !== '*', `no wildcard source in ${name}`, String(s));
    check(!/^https?:$/.test(s) && s !== 'http:', `no bare insecure scheme in ${name}`, String(s));
  }
}
check(!/unsafe-eval/.test(csp), "no 'unsafe-eval' anywhere in the CSP");

console.log('\n[3/5] Development/prod CSP separation');

check(tauri.app.security.devCsp === undefined || tauri.app.security.devCsp === null, 'no devCsp override exists (dev falls back to the hardened prod CSP; keep it that way unless HMR requires one)');

console.log('\n[4/5] Version consistency');

const pkg = readJson('package.json');
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const confVersion = tauri.version;
check(!!cargoVersion, 'Cargo.toml has a [package] version');
check(pkg.version === confVersion, 'package.json version matches tauri.conf.json', `${pkg.version} vs ${confVersion}`);
check(cargoVersion === confVersion, 'Cargo.toml version matches tauri.conf.json', `${cargoVersion} vs ${confVersion}`);

console.log('\n[5/5] Updater configuration consistency');

const updater = tauri.plugins && tauri.plugins.updater;
const keyFile = join(root, 'fress-updater.key.pub');
check(!!updater, 'plugins.updater block present (documented migration state: the active update path is src/lib/selfUpdate.ts; the Tauri updater plugin is not wired in src-tauri/Cargo.toml yet — see docs/security/tauri-security.md)');
check(!/tauri-plugin-updater/.test(cargo), 'tauri-plugin-updater is NOT a Cargo dependency (if you wire the plugin, update docs/security/tauri-security.md and re-evaluate the plugin config)');
if (updater && existsSync(keyFile)) {
  const embedded = (updater.pubkey || '').trim();
  const published = readFileSync(keyFile, 'utf8').trim();
  check(embedded === published, 'embedded updater pubkey matches fress-updater.key.pub', 'the embedded key drifted from the published one — do not rotate keys in a config PR');
  const endpoints = updater.endpoints || [];
  check(endpoints.length > 0 && endpoints.every((e) => e.startsWith('https://')), 'updater endpoints are https-only', endpoints.join(', '));
}

console.log('');
if (failures.length > 0) {
  console.error(`validate:security FAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('validate:security PASSED — Tauri security configuration matches the audited baseline.');
