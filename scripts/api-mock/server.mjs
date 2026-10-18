// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The hermetic API-contract mock: the single HTTP origin every API-gate
 * layer (Bruno collection in mock mode, Playwright request-context gates)
 * runs against in CI.
 *
 * Why a mock: the PR gates must be deterministic - shared GitHub quota and
 * upstream outages must never decide whether a PR is green. The mock pins
 * the WIRE CONTRACTS the app's resolvers and updater rely on, byte for
 * byte, including the failure shapes (429 with and without Retry-After, a
 * 503 that heals on the second request, a deterministic 404) whose
 * handling is the difference between a resilient lookup and the error
 * toast this project exists to prevent.
 *
 * Endpoints are grouped under first-class path prefixes so a test can
 * never accidentally hit the real network:
 *   /github/...     - GitHub REST JSON + quota-free release documents
 *   /fdroid/...     - F-Droid package index
 *   /updater/...    - Fress's own release chain (latest.json, SHA256SUMS)
 *   /fault/...      - fault injection (transient/deterministic statuses)
 *
 * Zero dependencies (node:http only), so it starts in milliseconds and
 * never needs an install step of its own.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.API_MOCK_PORT || 8787);

const STABLE = {
  tag_name: 'v2.0.0',
  name: 'Tool 2.0.0',
  published_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/example/tool/releases/tag/v2.0.0',
  prerelease: false,
  assets: [
    { name: 'Tool 2.0.0.exe', size: 44140544, browser_download_url: 'https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe' },
    { name: 'Tool-2.0.0.zip', size: 42000000, browser_download_url: 'https://github.com/example/tool/releases/download/v2.0.0/Tool-2.0.0.zip' },
    { name: 'SHA256SUMS.txt', size: 128, browser_download_url: 'https://github.com/example/tool/releases/download/v2.0.0/SHA256SUMS.txt' },
  ],
};

const PRERELEASE = {
  tag_name: 'v2.1.0-next.1',
  name: 'Tool 2.1.0-next.1',
  published_at: '2026-10-10T00:00:00Z',
  html_url: 'https://github.com/example/tool/releases/tag/v2.1.0-next.1',
  prerelease: true,
  assets: [
    { name: 'Tool-2.1.0-next.1.exe', size: 45000000, browser_download_url: 'https://github.com/example/tool/releases/download/v2.1.0-next.1/Tool-2.1.0-next.1.exe' },
  ],
};

const fragmentFor = (tag) =>
  tag === 'v2.0.0'
    ? `<div>
  <a href="/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe" class="Truncate">Tool 2.0.0.exe</a>
  <span class="Truncate-text text-bold">42.1 MB</span>
  <a href="/example/tool/releases/download/v2.0.0/Tool-2.0.0.zip">Tool-2.0.0.zip</a>
  <img src="/example/tool/releases/download/v2.0.0/badge.svg">
  <a href="/other/repo/releases/download/v9.9.9/evil.exe">evil.exe</a>
</div>`
    : '<div></div>';

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/example/tool/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/example/tool/releases"/>
  <title>Release notes from tool</title>
  <updated>2026-10-10T00:00:00Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.1.0-next.1</id>
    <updated>2026-10-10T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.1.0-next.1"/>
    <title>v2.1.0-next.1</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.0.0</id>
    <updated>2026-10-01T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.0.0"/>
    <title>Tool 2.0.0</title>
  </entry>
</feed>`;

const PLATFORM_KEYS = [
  'linux-x86_64', 'linux-aarch64', 'darwin-x86_64', 'darwin-aarch64',
  'windows-x86_64', 'windows-i686', 'windows-aarch64', 'android-arm64',
];

const latestJson = () => ({
  version: '2.0.0',
  pub_date: '2026-10-18T20:57:56Z',
  platforms: Object.fromEntries(
    PLATFORM_KEYS.map((k) => [
      k,
      { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHNpZ25hdHVyZQ==', url: `http://127.0.0.1:${PORT}/updater/artifact/Fress_2.0.0_${k}.exe` },
    ])
  ),
});

const sha256sums =
  PLATFORM_KEYS.map((k, i) => `${String(i).padStart(64, '0')}  Fress_2.0.0_${k}.exe`).join('\n') + '\n';

let onceCounter = 0;

const json = (res, code, body, extraHeaders = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    etag: '"api-mock-1"',
    ...extraHeaders,
  });
  res.end(text);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // ---- Readiness probe (Playwright webServer / CI job) ------------------
  if (p === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // ---- Fault injection -------------------------------------------------
  if (p === '/fault/429-retry-after') {
    return json(res, 429, { message: 'API rate limit exceeded' }, { 'retry-after': '1', 'x-ratelimit-remaining': '0' });
  }
  if (p === '/fault/429-bare') {
    return json(res, 429, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
  }
  if (p === '/fault/503-once') {
    onceCounter += 1;
    if (onceCounter % 2 === 1) return json(res, 503, { message: 'service unavailable' });
    return json(res, 200, { healed: true });
  }
  if (p === '/fault/deterministic-404') {
    return json(res, 404, { message: 'Not Found' });
  }

  // ---- GitHub REST (JSON) ----------------------------------------------
  let m = /^\/github\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(p);
  if (m) return json(res, 200, STABLE);

  m = /^\/github\/repos\/([^/]+)\/([^/]+)\/releases$/.exec(p);
  if (m) {
    const perPage = Number(url.searchParams.get('per_page') || 20);
    const list = [PRERELEASE, STABLE].slice(0, Math.max(1, Math.min(perPage, 2)));
    return json(res, 200, list);
  }

  // ---- Quota-free release documents ------------------------------------
  if (p === '/github/example/tool/releases.atom') {
    res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
    return res.end(ATOM_FEED);
  }
  m = /^\/github\/([^/]+)\/([^/]+)\/releases\/expanded_assets\/([^/]+)$/.exec(p);
  if (m) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fragmentFor(decodeURIComponent(m[3])));
  }
  m = /^\/github\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)\/expanded_assets$/.exec(p);
  if (m) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fragmentFor(decodeURIComponent(m[3])));
  }

  // ---- F-Droid ----------------------------------------------------------
  m = /^\/fdroid\/api\/v1\/packages\/([^/]+)$/.exec(p);
  if (m) {
    return json(res, 200, {
      packages: [
        { versionCode: 100, versionName: '1.0.0' },
        { versionCode: 102, versionName: '1.0.2' },
      ],
      suggestedVersionCode: 102,
    });
  }

  // ---- Fress updater chain ----------------------------------------------
  if (p === '/updater/latest.json') {
    // Conditional-request contract: a matching If-None-Match revalidates
    // without a body, exactly like the native cache's revalidation.
    if (req.headers['if-none-match'] === '"api-mock-1"') {
      res.writeHead(304, { etag: '"api-mock-1"' });
      return res.end();
    }
    return json(res, 200, latestJson());
  }
  if (p === '/updater/SHA256SUMS.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(sha256sums);
  }
  m = /^\/updater\/artifact\/(.+)$/.exec(p);
  if (m) {
    // The body length and the header MUST agree byte for byte: a framing
    // desync poisons the keep-alive connection for every later request,
    // which is exactly the kind of contract break this mock exists to
    // catch, not cause.
    const body = Buffer.from('artifact!', 'utf8');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      etag: `"artifact-${m[1]}"`,
    });
    return res.end(body);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('api-mock: no route for ' + p);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`api-mock listening on http://127.0.0.1:${PORT}`);
});
