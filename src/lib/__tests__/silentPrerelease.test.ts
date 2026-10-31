// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// THE SILENT-PRERELEASE GATE.
//
// GitHub's prerelease FLAG and the tag/title text are independent: ShareX
// v22.0.0, rustdesk 1.5.1 and SimpleX v7.0.4 all shipped flagged
// prereleases with CLEAN tags and titles (and real assets) - verified
// against the live API on 2026-10-31 - and listmonk shipped the reverse
// (v7.0.0-beta.1 with NO prerelease flag). The feed's textual gate cannot
// see the first class, and the API's flag filter cannot see the second.
//
// This suite pins the two-layer defense:
//
//   L1 (desktop, quota-free): the /releases/latest redirect oracle - the
//      newest NON-draft NON-prerelease tag straight from GitHub - cuts
//      every feed entry ABOVE it (they are prereleases/drafts by
//      construction) before a fragment is fetched for them; 404 answers
//      "no stable release" honestly; transport failure FAILS OPEN.
//
//   L2 (both surfaces, API answers): the textual unstable gate also runs
//      over flag-filtered API results, catching unflagged betas.
//
//   VOUCH: includeFlaggedReleases entries (DevToys) bypass BOTH layers -
//      the oracle must not run, and the browser uses the list endpoint
//      because /releases/latest pins the newest UNFLAGGED release.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { getLatestRelease, getRecentReleases } from '../release/githubProvider';
import {
  getLatestStableTagViaDoc,
  getReleasesViaAtom,
} from '../release/atomReleases';

/** Feed where the TOP entry is a silent prerelease: clean tag, clean
 * title, real assets below - the exact ShareX v22.0.0 shape. */
const FEED = (repo: string, entries: Array<[tag: string, title: string]>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/${repo}/releases</id>
  <title>Release notes from ${repo}</title>
${entries
  .map(
    ([tag, title], i) => `  <entry>
    <id>tag:github.com,2008:Repository/${i}/${repo.replace('/', '-')}/${tag}</id>
    <updated>2026-10-0${i + 1}T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${repo}/releases/tag/${tag}"/>
    <title>${title}</title>
  </entry>`
  )
  .join('\n')}
</feed>`;

const fragmentFor = (repo: string, tag: string, file: string) => `<div>
  <a href="/${repo}/releases/download/${tag}/${file}" rel="nofollow" class="wb-break-all">
    <span class="text-bold">${file}</span>
  </a>
  <span class="color-fg-muted text-right">42.1 MB</span>
</div>`;

const REPO = 'example/tool';
const SILENT = FEED(REPO, [
  ['v22.0.0', 'Tool 22.0.0'], // silent prerelease - clean tag AND title
  ['v21.0.0', 'Tool 21.0.0'], // the newest real stable
]);
const FRAG_V22 = fragmentFor(REPO, 'v22.0.0', 'Tool-22.0.0.exe');
const FRAG_V21 = fragmentFor(REPO, 'v21.0.0', 'Tool-21.0.0.exe');
const API_DOC_V21 = {
  tag: 'v21.0.0',
  name: 'Tool 21.0.0',
  published_at: '2026-10-02T00:00:00Z',
  html_url: `https://github.com/${REPO}/releases/tag/v21.0.0`,
  assets: [
    { name: 'Tool-21.0.0.exe', size: 44_140_544, download_url: `https://github.com/${REPO}/releases/download/v21.0.0/Tool-21.0.0.exe` },
  ],
};
const API_LIST_WITH_UNFLAGGED_BETA = [
  {
    tag: 'v7.0.0-beta.1', // UNFLAGGED on GitHub (the listmonk shape)
    name: 'v7.0.0-beta.1',
    published_at: '2026-10-20T00:00:00Z',
    html_url: `https://github.com/${REPO}/releases/tag/v7.0.0-beta.1`,
    assets: [{ name: 'tool.exe', size: 1, download_url: `https://github.com/${REPO}/releases/download/v7.0.0-beta.1/tool.exe` }],
  },
  {
    tag: 'v6.2.0',
    name: 'v6.2.0',
    published_at: '2026-09-01T00:00:00Z',
    html_url: `https://github.com/${REPO}/releases/tag/v6.2.0`,
    assets: [{ name: 'tool.exe', size: 1, download_url: `https://github.com/${REPO}/releases/download/v6.2.0/tool.exe` }],
  },
];

/** The same documents in the REST shape the browser fetch path reads
 * (tag_name / browser_download_url / prerelease). */
const rest = (r: (typeof API_LIST_WITH_UNFLAGGED_BETA)[number], prerelease: boolean) => ({
  tag_name: r.tag,
  name: r.name,
  published_at: r.published_at,
  html_url: r.html_url,
  prerelease,
  assets: r.assets.map((a) => ({ name: a.name, size: a.size, browser_download_url: a.download_url })),
});
const REST_UNFLAGGED_BETA = rest(API_LIST_WITH_UNFLAGGED_BETA[0], false);
const REST_STABLE_V6 = rest(API_LIST_WITH_UNFLAGGED_BETA[1], false);

/** Same routing contract as atomFirst.test.ts, plus the oracle route:
 * /releases/latest answers {status, final_url} - the redirect the native
 * transport already resolved (TextFetch.final_url, no body needed). */
function stubInvoke(opts: {
  atomBody?: string | Error;
  fragmentByTag?: Record<string, string | Error>;
  oracle?: { status: number; finalUrl?: string } | Error;
  apiDoc?: object | Error;
  apiList?: object[] | Error;
} = {}) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const url = typeof args?.url === 'string' ? args.url : '';
    switch (cmd) {
      case 'fetch_github_release_doc':
        if (url.endsWith('/releases.atom')) {
          if (opts.atomBody instanceof Error) throw opts.atomBody;
          return { status: 200, body: opts.atomBody ?? SILENT, truncated: false };
        }
        if (/\/releases\/latest$/.test(url)) {
          if (opts.oracle instanceof Error) throw opts.oracle;
          return {
            status: opts.oracle?.status ?? 200,
            final_url: opts.oracle?.finalUrl ?? '',
            body: '',
            truncated: false,
          };
        }
        {
          const m = /\/releases\/expanded_assets\/([^/]+)$/.exec(url);
          if (m) {
            const frag = opts.fragmentByTag?.[m[1]];
            if (frag instanceof Error) throw frag;
            if (frag === undefined) return { status: 404, final_url: url, body: '', truncated: false };
            return { status: 200, body: frag, truncated: false };
          }
        }
        throw new Error(`Unexpected release-document URL: ${url}`);
      case 'fetch_latest_release':
        if (opts.apiDoc instanceof Error) throw opts.apiDoc;
        return opts.apiDoc ?? API_DOC_V21;
      case 'fetch_recent_releases':
        if (opts.apiList instanceof Error) throw opts.apiList;
        return opts.apiList ?? API_LIST_WITH_UNFLAGGED_BETA;
      default:
        throw new Error(`Unexpected command: ${cmd}`);
    }
  });
}

/** Browser-mode fetch mock: github.com refuses CORS (every github.com
 * URL rejects, exactly like the real webview), api.github.com answers
 * the JSON documents. */
function stubBrowserFetch(opts: { latestApi?: object; listApi?: object[]; perPage1?: object[] } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://github.com/')) {
      throw new TypeError('Failed to fetch (CORS)');
    }
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify(opts.latestApi ?? REST_UNFLAGGED_BETA), { status: 200 });
    }
    if (url.includes('/releases?per_page=1')) {
      return new Response(JSON.stringify(opts.perPage1 ?? [REST_UNFLAGGED_BETA]), { status: 200 });
    }
    if (url.includes('/releases?per_page=')) {
      return new Response(JSON.stringify(opts.listApi ?? [REST_UNFLAGGED_BETA, REST_STABLE_V6]), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const docUrls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'fetch_github_release_doc')
    .map(([, args]) => (args as { url?: string }).url ?? '');

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('L1: the /releases/latest oracle cuts silent prereleases (desktop, quota-free)', () => {
  it('serves the oracle tag, never the silent prerelease above it', async () => {
    stubInvoke({
      atomBody: SILENT,
      fragmentByTag: { 'v22.0.0': FRAG_V22, 'v21.0.0': FRAG_V21 },
      oracle: { status: 200, finalUrl: `https://github.com/${REPO}/releases/tag/v21.0.0` },
    });
    const rel = await getLatestRelease(REPO);
    expect(rel.tag).toBe('v21.0.0');
    // The cut happens BEFORE the fragment walk: the prerelease's fragment
    // is never fetched - the oracle costs one document, not one per entry.
    expect(docUrls().some((u) => u.includes('/expanded_assets/v22.0.0'))).toBe(false);
    expect(docUrls().some((u) => u.includes('/expanded_assets/v21.0.0'))).toBe(true);
    expect(docUrls().some((u) => u.endsWith('/releases/latest'))).toBe(true);
  });

  it('oracle 404 (no stable release) -> atom answers null, the API owns the honest answer', async () => {
    stubInvoke({
      atomBody: SILENT,
      fragmentByTag: { 'v22.0.0': FRAG_V22 },
      oracle: { status: 404 },
    });
    const rel = await getLatestRelease(REPO);
    expect(rel.tag).toBe('v21.0.0'); // from the API document, not the feed
  });

  it('oracle transport failure FAILS OPEN - today\'s behavior is preserved', async () => {
    stubInvoke({
      atomBody: SILENT,
      fragmentByTag: { 'v22.0.0': FRAG_V22 },
      oracle: new Error('connection reset'),
    });
    const rel = await getLatestRelease(REPO);
    expect(rel.tag).toBe('v22.0.0'); // pre-fix behavior; hardening never adds a way to die
  });

  it('VOUCHED repos skip the oracle entirely (DevToys contract)', async () => {
    stubInvoke({
      atomBody: SILENT,
      fragmentByTag: { 'v22.0.0': FRAG_V22 },
      oracle: { status: 200, finalUrl: `https://github.com/${REPO}/releases/tag/v21.0.0` },
    });
    const rel = await getLatestRelease(REPO, true);
    expect(rel.tag).toBe('v22.0.0');
    expect(docUrls().some((u) => u.endsWith('/releases/latest'))).toBe(false);
  });

  it('the recent-scan mirror drops everything above the oracle tag', async () => {
    stubInvoke({
      atomBody: SILENT,
      fragmentByTag: { 'v22.0.0': FRAG_V22, 'v21.0.0': FRAG_V21 },
      oracle: { status: 200, finalUrl: `https://github.com/${REPO}/releases/tag/v21.0.0` },
    });
    const list = await getReleasesViaAtom(REPO, 20, false);
    expect(list.map((r) => r.tag)).toEqual(['v21.0.0']);
  });

  it('the scan keeps every stream stable AT or BELOW the oracle tag', async () => {
    // Multi-stream shape (Ente/Tuta-style stream-prefixed tags): a second
    // stream's stable release sits BELOW the newest stable - the cut must
    // never remove it. (Slash-tagged streams like mullvad's ios/2026.7 are
    // excluded by the feed parser's own isSafeTag contract and resolve
    // through the API - the oracle stays consistent with that.)
    const multi = FEED('example/multi', [
      ['desktop-2.0.0', 'Multi 2.0.0'],
      ['mobile-1.8.0', 'Multi Mobile 1.8.0'],
      ['desktop-1.9.0', 'Multi 1.9.0'],
    ]);
    stubInvoke({
      atomBody: multi,
      fragmentByTag: {
        'desktop-2.0.0': fragmentFor('example/multi', 'desktop-2.0.0', 'm.exe'),
        'mobile-1.8.0': fragmentFor('example/multi', 'mobile-1.8.0', 'm.apk'),
        'desktop-1.9.0': fragmentFor('example/multi', 'desktop-1.9.0', 'm.exe'),
      },
      // GitHub's latest = desktop-2.0.0: the newest stable of ANY stream.
      oracle: { status: 200, finalUrl: 'https://github.com/example/multi/releases/tag/desktop-2.0.0' },
    });
    const list = await getReleasesViaAtom('example/multi', 20, false);
    expect(list.map((r) => r.tag)).toEqual(['desktop-2.0.0', 'mobile-1.8.0', 'desktop-1.9.0']);
  });
});

describe('the oracle itself', () => {
  it('decodes a percent-encoded tag (plus-encoded build metadata)', async () => {
    stubInvoke({ oracle: { status: 200, finalUrl: 'https://github.com/example/tool/releases/tag/v1.0%2Bbuild.5' } });
    expect(await getLatestStableTagViaDoc('example/tool')).toBe('v1.0+build.5');
  });

  it('a tag outside the feed parser\'s charset throws - the cut then fails open, matching the feed\'s own contract', async () => {
    // Slash-tagged streams (mullvad ios%2F2026.7) are excluded by
    // parseAtomFeed's isSafeTag gate too: the oracle must not accept what
    // the feed could never match.
    stubInvoke({ oracle: { status: 200, finalUrl: 'https://github.com/mullvad/mullvadvpn-app/releases/tag/ios%2F2026.7' } });
    await expect(getLatestStableTagViaDoc('mullvad/mullvadvpn-app')).rejects.toThrow('Unsafe tag');
  });

  it('404 -> null (the honest no-stable answer)', async () => {
    stubInvoke({ oracle: { status: 404 } });
    expect(await getLatestStableTagViaDoc('example/tool')).toBeNull();
  });

  it('non-200 non-404 -> throws (caller fails open)', async () => {
    stubInvoke({ oracle: { status: 502 } });
    await expect(getLatestStableTagViaDoc('example/tool')).rejects.toThrow('HTTP 502');
  });

  it('a final URL without a tag -> throws (caller fails open)', async () => {
    stubInvoke({ oracle: { status: 200, finalUrl: 'https://github.com/example/tool' } });
    await expect(getLatestStableTagViaDoc('example/tool')).rejects.toThrow('no tag');
  });
});

describe('L2: the textual gate over API answers (the flag misses unflagged betas)', () => {
  it('desktop recent scan filters the unflagged beta', async () => {
    stubInvoke({ apiList: API_LIST_WITH_UNFLAGGED_BETA });
    const list = await getRecentReleases(REPO, 20, false);
    expect(list.map((r) => r.tag)).toEqual(['v6.2.0']);
  });

  it('desktop recent scan KEEPS everything for a vouched repo', async () => {
    stubInvoke({ apiList: API_LIST_WITH_UNFLAGGED_BETA });
    const list = await getRecentReleases(REPO, 20, true);
    expect(list.map((r) => r.tag)).toEqual(['v7.0.0-beta.1', 'v6.2.0']);
  });

  it('browser latest: an unflagged beta on /releases/latest throws the classified unstable-stage error', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    stubBrowserFetch({ latestApi: REST_UNFLAGGED_BETA });
    // The atom fallback cannot answer in a browser (github.com CORS), so
    // the original classified error surfaces instead of a beta as stable.
    await expect(getLatestRelease(REPO)).rejects.toThrow('unstable stage');
  });

  it('browser latest: a vouched repo uses the list endpoint and takes the newest verbatim', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const fetchMock = stubBrowserFetch({ perPage1: [REST_UNFLAGGED_BETA] });
    const rel = await getLatestRelease(REPO, true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/releases?per_page=1'))).toBe(true);
    expect(rel.tag).toBe('v7.0.0-beta.1');
  });

  it('browser recent scan filters the unflagged beta', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    stubBrowserFetch({ listApi: [REST_UNFLAGGED_BETA, REST_STABLE_V6] });
    const list = await getRecentReleases(REPO, 20, false);
    expect(list.map((r) => r.tag)).toEqual(['v6.2.0']);
  });
});
