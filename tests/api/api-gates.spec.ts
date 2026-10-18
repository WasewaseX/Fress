// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @ts-check
import { test, expect } from '@playwright/test';

/**
 * The API-gate suite: pure HTTP request-context tests (NO browser) that pin
 * the wire contracts Fress's resolvers, download engine and self-updater
 * depend on, against the hermetic api-mock origin.
 *
 * Division of labor (documented in docs/quality-gates.md):
 *   - vitest: the app's LOGIC (resolution policy, caches, retry contracts)
 *     - pure functions, no wire.
 *   - cargo tests: the NATIVE retry/cache loops (api_resilience) against
 *     loopback HTTP - the exact backoff schedules.
 *   - THIS suite: the WIRE contracts themselves - what a response must
 *     look like, which headers exist, how failure statuses behave - the
 *     shared assumption every layer above is built on. Runs in every PR
 *     (hermetic, milliseconds) so a contract regression fails before it
 *     can ship.
 *   - Bruno (network-smoke, scheduled): the same contracts against the
 *     REAL endpoints, the live complement.
 *
 * The base URL is the api-mock origin (playwright.api.config.ts starts it
 * and points baseURL at it); nothing here can touch the real network.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

test.describe('GitHub REST wire contract', () => {
  test('latest release: shape, semver tag, asset links, latency budget', async ({ request }) => {
    const started = Date.now();
    const res = await request.get('/github/repos/example/tool/releases/latest');
    expect(res.status()).toBe(200);
    // A lookup that takes longer than this budget has already failed the
    // user experience even when it eventually answers.
    expect(Date.now() - started).toBeLessThan(2000);
    const doc = await res.json();
    expect(doc.tag_name).toBe('v2.0.0');
    expect(SEMVER_RE.test(doc.tag_name.replace(/^v/, ''))).toBe(true);
    expect(typeof doc.published_at).toBe('string');
    expect(doc.html_url).toContain('/releases/tag/');
    expect(Array.isArray(doc.assets)).toBe(true);
    for (const a of doc.assets as Array<{ name: string; size: number; browser_download_url: string }>) {
      expect(typeof a.name).toBe('string');
      expect(typeof a.size).toBe('number');
      expect(a.browser_download_url).toMatch(/^https:\/\/github\.com\/.+\/releases\/download\//);
    }
    // The digest sidecar is part of the release: integrity is never optional.
    expect((doc.assets as Array<{ name: string }>).some((a) => a.name === 'SHA256SUMS.txt')).toBe(true);
  });

  test('recent releases: prerelease flag present so stable filtering is decidable', async ({ request }) => {
    const res = await request.get('/github/repos/example/tool/releases?per_page=20');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    for (const rel of list as Array<{ prerelease: unknown; tag_name: string }>) {
      expect(typeof rel.prerelease).toBe('boolean');
      expect(rel.tag_name).toBeTruthy();
    }
    // per_page is honored - the resolver's scan depth depends on it.
    const one = await request.get('/github/repos/example/tool/releases?per_page=1');
    expect((await one.json()).length).toBe(1);
  });
});

test.describe('quota-free release documents', () => {
  test('atom feed: parseable XML, alternate links, newest first', async ({ request }) => {
    const res = await request.get('/github/example/tool/releases.atom');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');
    const body = await res.text();
    expect(body).toContain('<feed');
    const entries = body.match(/<entry>/g) || [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const links = [...body.matchAll(/rel="alternate"[^>]*href="([^"]+)\/tag\/([^"]+)"/g)].map((m) => m[2]);
    expect(links[0]).toBe('v2.1.0-next.1');
    expect(links[1]).toBe('v2.0.0');
  });

  test('expanded_assets MODERN shape: real fragment carries release-download anchors', async ({ request }) => {
    const res = await request.get('/github/example/tool/releases/expanded_assets/v2.0.0');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('/releases/download/v2.0.0/');
    expect(body).toContain('Tool%202.0.0.exe');
  });

  test('asset-less tag: a 200 with zero anchors is the honest answer', async ({ request }) => {
    const res = await request.get('/github/example/tool/releases/expanded_assets/v1.9.9');
    expect(res.status()).toBe(200);
    expect((await res.text()).match(/releases\/download/g) || []).toHaveLength(0);
  });

  test('LEGACY shape stays alive as the rollback path', async ({ request }) => {
    const res = await request.get('/github/example/tool/releases/tag/v2.0.0/expanded_assets');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('/releases/download/v2.0.0/');
  });
});

test.describe('failure shapes the resilience layer is built on', () => {
  test('a rate-limit answer carries Retry-After and the quota signature', async ({ request }) => {
    const res = await request.get('/fault/429-retry-after');
    expect(res.status()).toBe(429);
    expect(res.headers()['retry-after']).toBe('1');
    expect(res.headers()['x-ratelimit-remaining']).toBe('0');
  });

  test('a bare 429 exists too - the backoff must space it when the header is absent', async ({ request }) => {
    const res = await request.get('/fault/429-bare');
    expect(res.status()).toBe(429);
    expect(res.headers()['retry-after']).toBeUndefined();
    expect(res.headers()['x-ratelimit-remaining']).toBe('0');
  });

  test('a transient 503 heals on the next attempt', async ({ request }) => {
    const first = await request.get('/fault/503-once');
    expect(first.status()).toBe(503);
    const second = await request.get('/fault/503-once');
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ healed: true });
  });

  test('a 404 is deterministic - retrying it is waste', async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const res = await request.get('/fault/deterministic-404');
      expect(res.status()).toBe(404);
    }
  });
});

test.describe('F-Droid wire contract', () => {
  test('package index: packages with versionCode + suggestedVersionCode', async ({ request }) => {
    const res = await request.get('/fdroid/api/v1/packages/org.example.tool');
    expect(res.status()).toBe(200);
    const doc = await res.json();
    expect(Array.isArray(doc.packages)).toBe(true);
    for (const p of doc.packages as Array<{ versionCode: number; versionName: string }>) {
      expect(typeof p.versionCode).toBe('number');
      expect(typeof p.versionName).toBe('string');
    }
    expect(doc.suggestedVersionCode).toBe(102);
    // The suggested code must exist among the packages - the resolver
    // picks it, then names the apk after it.
    expect(
      (doc.packages as Array<{ versionCode: number }>).some((p) => p.versionCode === doc.suggestedVersionCode)
    ).toBe(true);
  });
});

test.describe('Fress self-update chain', () => {
  test('latest.json: semver version, 8 platforms, signature + url everywhere', async ({ request }) => {
    const res = await request.get('/updater/latest.json');
    expect(res.status()).toBe(200);
    const doc = await res.json();
    expect(SEMVER_RE.test(doc.version)).toBe(true);
    const keys = Object.keys(doc.platforms);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const k of keys) {
      expect(doc.platforms[k].signature).toBeTruthy();
      expect(doc.platforms[k].url).toBeTruthy();
    }
  });

  test('the updater artifact URL answers with an ETag', async ({ request }) => {
    const manifest = await (await request.get('/updater/latest.json')).json();
    const url = new URL(manifest.platforms['windows-x86_64'].url);
    const res = await request.get(url.pathname + url.search);
    expect(res.status()).toBe(200);
    expect(res.headers()['etag']).toBeTruthy();
  });

  test('conditional revalidation: matching If-None-Match revalidates without a body (304)', async ({ request }) => {
    const first = await request.get('/updater/latest.json');
    const etag = first.headers()['etag'];
    expect(etag).toBeTruthy();
    const second = await request.get('/updater/latest.json', { headers: { 'if-none-match': etag } });
    expect(second.status()).toBe(304);
    expect((await second.text()).length).toBe(0);
  });

  test('SHA256SUMS.txt: every line is <64 hex> SP SP <asset name>', async ({ request }) => {
    const res = await request.get('/updater/SHA256SUMS.txt');
    expect(res.status()).toBe(200);
    const lines = (await res.text()).trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64}  \S+$/);
    }
  });
});
