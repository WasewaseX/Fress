// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// DESKTOP SOURCE PRIORITY (the quota is the scarce resource - spend it
// last): inside Tauri the quota-free github.com documents (releases.atom +
// expanded_assets fragments) answer the latest-release lookup FIRST and
// api.github.com is spent only when the documents cannot answer. This
// suite pins, in Tauri mode (window.__TAURI_INTERNALS__ present, invoke
// mocked at the @tauri-apps/api/core boundary):
//
//   1. a healthy atom path resolves with ZERO api.github.com commands
//      (the headline guarantee - the lookup cannot die with "the download
//      sources could not be reached" when the API quota is gone);
//   2. the NEW fragment URL (/releases/expanded_assets/<tag>) is tried
//      before the OLD one (/releases/tag/<tag>/expanded_assets), and the
//      old shape remains the rollback path;
//   3. an inconclusive atom path (shell fragment, unreachable feed) hands
//      the decision to the API, whose exact document (prerelease flags,
//      byte-exact sizes) wins;
//   4. the fragment's sha256 span and human size label ride into the
//      resolved download (digest verification WITHOUT the API);
//   5. the latest path stops fetching fragments at the first asset-ful
//      entry (the scan keeps the full budget);
//   6. a browser-mode timeout error classifies as a network failure.
//
// The kill point is the ordering in githubProvider.getLatestRelease plus
// the URL-shape fallback in atomReleases.fetchAssetsForTag.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { ghCache, fdCache, peekResolveFailure } from '../release/resolveCache';
import { resolveGitHubDownload } from '../release/resolve';
import { getLatestRelease } from '../release/githubProvider';
import {
  parseAtomFeed,
  parseExpandedAssets,
  parseHumanSizeToBytes,
} from '../release/atomReleases';
import type { AppItem } from '../../types';

const makeApp = (over: Partial<AppItem>): AppItem =>
  ({
    id: 'tool',
    name: 'Tool',
    tagline: '',
    description: '',
    whyItsAwesome: '',
    githubUrl: 'https://github.com/example/tool',
    websiteUrl: 'https://example.com',
    category: 'Privacy & Security',
    platforms: ['windows', 'mac', 'linux', 'android'],
    license: 'MIT',
    stars: 10,
    beginnerRating: '',
    isOwnerPick: false,
    isTrendingToday: false,
    tags: [],
    architectures: ['x86_64'],
    offlineReady: false,
    ...over,
  }) as AppItem;

const SHA_A = 'AAAA1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';
const SHA_B = 'FFFF9999eeee8888dddd7777cccc6666bbbb5555aaaa4444ffff3333eeee2222';

const ATOM_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/example/tool/releases</id>
  <title>Release notes from tool</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.0.0</id>
    <updated>2026-10-01T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.0.0"/>
    <title>Tool 2.0.0</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.1.0-beta.1</id>
    <updated>2026-10-02T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.1.0-beta.1"/>
    <title>2.1.0-beta.1</title>
  </entry>
</feed>`;

/** A fragment in the shape GitHub's release pages render since the 2026-10
 * rollout: per asset an anchor (name), then a sha256:<hex> span, then a
 * human size label. */
const FRAGMENT_BODY = `<div>
  <a href="/example/tool/releases/download/v2.0.0/Tool-2.0.0.exe" rel="nofollow" class="wb-break-all">
    <span class="text-bold">Tool-2.0.0.exe</span>
  </a>
  <span class="Truncate-text">sha256:${SHA_A}</span>
  <span class="color-fg-muted text-right">42.1 MB</span>
  <a href="/example/tool/releases/download/v2.0.0/Tool-2.0.0.zip" rel="nofollow">
    <span class="text-bold">Tool-2.0.0.zip</span>
  </a>
  <span class="Truncate-text">sha256:${SHA_B}</span>
  <span class="color-fg-muted text-right">38.0 MB</span>
</div>`;

/** The rollout shell: the OLD fragment URL answers this during the
 * transition - a page that lazy-loads the real document and carries ZERO
 * asset anchors. */
const SHELL_BODY = `<html><body>
  <include-fragment loading="lazy" src="https://github.com/example/tool/releases/expanded_assets/v2.0.0"></include-fragment>
</body></html>`;

const API_DOC = {
  tag: 'v2.0.0',
  name: 'Tool 2.0.0',
  published_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/example/tool/releases/tag/v2.0.0',
  assets: [{ name: 'Tool-2.0.0.exe', size: 44_140_544, download_url: 'https://github.com/example/tool/releases/download/v2.0.0/Tool-2.0.0.exe' }],
};

const API_LIST = [API_DOC];

/** Routes the mocked invoke surface: the release-document reader serves
 * the quota-free documents (with per-URL overrides), the API commands
 * serve the exact REST-shaped documents. */
function stubInvoke(opts: {
  atomBody?: string | Error;
  newFragment?: string | Error;
  oldFragment?: string | Error;
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
          return { status: 200, body: opts.atomBody ?? ATOM_BODY, truncated: false };
        }
        if (/\/releases\/expanded_assets\//.test(url)) {
          if (opts.newFragment instanceof Error) throw opts.newFragment;
          return { status: 200, body: opts.newFragment ?? FRAGMENT_BODY, truncated: false };
        }
        if (/\/releases\/tag\/[^/]+\/expanded_assets$/.test(url)) {
          if (opts.oldFragment instanceof Error) throw opts.oldFragment;
          return { status: 200, body: opts.oldFragment ?? FRAGMENT_BODY, truncated: false };
        }
        throw new Error(`Unexpected release-document URL: ${url}`);
      case 'fetch_latest_release':
        if (opts.apiDoc instanceof Error) throw opts.apiDoc;
        return opts.apiDoc ?? API_DOC;
      case 'fetch_recent_releases':
        if (opts.apiList instanceof Error) throw opts.apiList;
        return opts.apiList ?? API_LIST;
      case 'host_arch':
        return 'x86_64';
      default:
        throw new Error(`Unexpected command: ${cmd}`);
    }
  });
}

const invokeCalls = (cmd?: string) =>
  invokeMock.mock.calls
    .filter((c) => (cmd ? c[0] === cmd : true))
    .map((c) => (typeof c[1]?.url === 'string' ? c[1].url : c[0]));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  ghCache.clear();
  fdCache.clear();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Unexpected browser fetch', { status: 500 })));
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop atom-first source priority (Tauri)', () => {
  it('a healthy atom path resolves with ZERO api.github.com commands', async () => {
    stubInvoke();
    const rel = await getLatestRelease('example/tool');
    expect(rel.tag).toBe('v2.0.0');
    expect(rel.assets.map((a) => a.name)).toEqual(['Tool-2.0.0.exe', 'Tool-2.0.0.zip']);
    expect(invokeCalls('fetch_latest_release')).toEqual([]);
    expect(invokeCalls('fetch_recent_releases')).toEqual([]);
    // Order: the feed first, then its asset fragment.
    const docs = invokeCalls('fetch_github_release_doc');
    expect(docs[0]).toBe('https://github.com/example/tool/releases.atom');
  });

  it('the NEW fragment URL is tried before the OLD shape', async () => {
    stubInvoke();
    await getLatestRelease('example/tool');
    const docs = invokeCalls('fetch_github_release_doc');
    expect(docs[1]).toBe('https://github.com/example/tool/releases/expanded_assets/v2.0.0');
    expect(docs.some((u) => u.endsWith('/releases/tag/v2.0.0/expanded_assets'))).toBe(false);
  });

  it('the OLD fragment shape remains the rollback path', async () => {
    stubInvoke({ newFragment: new Error('HTTP 404') });
    const rel = await getLatestRelease('example/tool');
    expect(rel.tag).toBe('v2.0.0');
    expect(rel.assets.length).toBe(2);
    const docs = invokeCalls('fetch_github_release_doc');
    expect(docs[1]).toBe('https://github.com/example/tool/releases/expanded_assets/v2.0.0');
    expect(docs[2]).toBe('https://github.com/example/tool/releases/tag/v2.0.0/expanded_assets');
  });

  it('a shell-page fragment (zero anchors on both shapes) hands the decision to the API', async () => {
    // Both shapes answer the rollout shell: no anchors anywhere. The atom
    // path is inconclusive - the API owns the exact answer.
    stubInvoke({ newFragment: SHELL_BODY, oldFragment: SHELL_BODY });
    const rel = await getLatestRelease('example/tool');
    expect(rel.tag).toBe('v2.0.0');
    // Byte-exact API size, not a parsed human label - the exactness proof.
    expect(rel.assets[0].size).toBe(44_140_544);
    expect(invokeCalls('fetch_latest_release').length).toBe(1);
  });

  it('an unreachable feed hands the decision to the API', async () => {
    stubInvoke({ atomBody: new Error('HTTP 503') });
    const rel = await getLatestRelease('example/tool');
    expect(rel.tag).toBe('v2.0.0');
    expect(invokeCalls('fetch_latest_release').length).toBe(1);
  });

  it('the API error is the classified final state when the atom path is also dead', async () => {
    stubInvoke({ atomBody: new Error('HTTP 503'), apiDoc: new Error('GitHub rate limit reached') });
    await expect(getLatestRelease('example/tool')).rejects.toThrow(/rate limit/i);
  });

  it('the full resolve path spends NO API commands when the documents answer', async () => {
    stubInvoke();
    const r = await resolveGitHubDownload(makeApp({}), 'windows');
    expect(r).not.toBeNull();
    expect(r?.source).toBe('github');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool-2.0.0.exe');
    expect(invokeCalls('fetch_latest_release')).toEqual([]);
    expect(invokeCalls('fetch_recent_releases')).toEqual([]);
  });

  it('the fragment digest and size ride into the resolved download', async () => {
    stubInvoke();
    const r = await resolveGitHubDownload(makeApp({}), 'windows');
    expect(r?.expectedSha256).toBe(SHA_A.toLowerCase());
    expect(r?.size).toBe(Math.round(42.1 * 1024 * 1024));
  });

  it('the latest path stops fetching fragments at the first asset-ful entry', async () => {
    stubInvoke();
    await getLatestRelease('example/tool');
    const fragmentCalls = invokeCalls('fetch_github_release_doc').filter((u) =>
      u.includes('/expanded_assets/')
    );
    expect(fragmentCalls.length).toBe(1);
  });

  it('an environment without the document reader degrades to the API', async () => {
    // A bridge that resolves the command to null (unknown command): the
    // reader is "unavailable", never a document - the API decides.
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fetch_latest_release') return API_DOC;
      if (cmd === 'host_arch') return 'x86_64';
      return null;
    });
    const rel = await getLatestRelease('example/tool');
    expect(rel.tag).toBe('v2.0.0');
    expect(invokeCalls('fetch_latest_release').length).toBe(1);
  });
});

describe('parseExpandedAssets enrichment', () => {
  it('attaches the sha256 span and human size of each asset, windows not bleeding', () => {
    const assets = parseExpandedAssets(FRAGMENT_BODY, 'example/tool');
    expect(assets).toHaveLength(2);
    expect(assets[0].name).toBe('Tool-2.0.0.exe');
    expect(assets[0].sha256).toBe(SHA_A.toLowerCase());
    expect(assets[0].size).toBe(Math.round(42.1 * 1024 * 1024));
    expect(assets[1].name).toBe('Tool-2.0.0.zip');
    expect(assets[1].sha256).toBe(SHA_B.toLowerCase());
    expect(assets[1].size).toBe(Math.round(38.0 * 1024 * 1024));
  });

  it('a missing span degrades to size 0 / no digest, never a guess', () => {
    const body = `<div>
      <a href="/example/tool/releases/download/v1.0.0/A.exe"><span>A.exe</span></a>
      <span class="Truncate-text">sha256:${SHA_A}</span>
      <a href="/example/tool/releases/download/v1.0.0/B.exe"><span>B.exe</span></a>
    </div>`;
    const assets = parseExpandedAssets(body, 'example/tool');
    expect(assets[0].sha256).toBe(SHA_A.toLowerCase());
    expect(assets[0].size).toBe(0);
    // B's window carries no spans at all - the digest of A must NOT bleed.
    expect(assets[1].sha256).toBeUndefined();
    expect(assets[1].size).toBe(0);
    expect(assets[1].downloadUrl).toBe('https://github.com/example/tool/releases/download/v1.0.0/B.exe');
  });

  it('the feed parser is unchanged by the enrichment', () => {
    const entries = parseAtomFeed(ATOM_BODY, 'example/tool');
    expect(entries.map((e) => e.tag)).toEqual(['v2.0.0', 'v2.1.0-beta.1']);
  });
});

describe('parseHumanSizeToBytes', () => {
  it('parses the label vocabulary the fragment uses', () => {
    expect(parseHumanSizeToBytes('37.5 MB')).toBe(Math.round(37.5 * 1024 * 1024));
    expect(parseHumanSizeToBytes('950 kB')).toBe(950 * 1024);
    expect(parseHumanSizeToBytes('42.1 KB')).toBe(Math.round(42.1 * 1024));
    expect(parseHumanSizeToBytes('1.2 GB')).toBe(Math.round(1.2 * 1024 ** 3));
    expect(parseHumanSizeToBytes('863 B')).toBe(863);
    expect(parseHumanSizeToBytes('12 TB')).toBe(Math.round(12 * 1024 ** 4));
  });

  it('refuses everything else', () => {
    expect(parseHumanSizeToBytes('')).toBeNull();
    expect(parseHumanSizeToBytes('12 bytes')).toBeNull();
    expect(parseHumanSizeToBytes('MB')).toBeNull();
    expect(parseHumanSizeToBytes('-4 MB')).toBeNull();
    expect(parseHumanSizeToBytes('1.2.3 MB')).toBeNull();
  });
});

describe('browser-mode failure classification', () => {
  it('a timeout error classifies as a network failure (retryable)', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    // Both sources reject with the browser timeout shape: the recorded
    // failure must be 'network' (the retryable kind), not an api error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('TimeoutError: signal timed out');
      })
    );
    const app = makeApp({ githubUrl: 'https://github.com/example/timeout' });
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    const failure = peekResolveFailure(app, 'windows');
    expect(failure?.kind).toBe('network');
  });
});
