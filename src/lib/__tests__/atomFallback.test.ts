// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The rate-limit-proof release lookup: when api.github.com fails (the
// unauthenticated 60 req/h per-IP quota is shared with the live-star
// refresh, so exhaustion is routine), the provider falls back to GitHub's
// own quota-free web documents - releases.atom for the release list and
// the per-tag expanded_assets fragments for the asset names. This suite
// pins:
//
//   1. a rate-limited lookup now RESOLVES through the fallback instead of
//      showing "No download was started: the download sources could not
//      be reached";
//   2. the failure path is unchanged when the fallback is ALSO dead: the
//      ORIGINAL classified error survives (rate-limit stays a rate limit)
//      so the card's retryable toast keeps working;
//   3. the honest 404 ("no stable release") never spends requests on the
//      feed - it is an answer, not a failure;
//   4. the parsers refuse everything they cannot parse confidently:
//      foreign-repo ids, unsafe tags, badge links, path-looking names.
//
// The kill point is the provider wiring in githubProvider.ts: removing the
// fallback there makes (1) fail while (2)/(3) keep passing.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { ghCache, fdCache, peekResolveFailure } from '../release/resolveCache';
import { resolveGitHubDownload } from '../release/resolve';
import {
  parseAtomFeed,
  parseExpandedAssets,
  stageLooksUnstable,
  isSafeRepoSlug,
  ATOM_ASSET_FETCH_BUDGET,
} from '../release/atomReleases';
import type { AppItem } from '../../types';

const CACHE_KEY = 'fress.resolveCache.v1';

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

const ATOM_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/example/tool/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/example/tool/releases"/>
  <title>Release notes from tool</title>
  <updated>2026-10-01T00:00:00Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.0.0</id>
    <updated>2026-10-01T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.0.0"/>
    <title>Tool &amp; Tools 2.0.0 &quot;Stable&quot;</title>
    <author><name>example</name></author>
    <media:thumbnail height="30" width="30" url="..."/>
    <content type="html">Release notes &lt;b&gt;here&lt;/b&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/v2.1.0-beta.1</id>
    <updated>2026-10-02T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v2.1.0-beta.1"/>
    <title>2.1.0-beta.1</title>
  </entry>
</feed>`;

const FRAGMENT_BODY = `<div>
  <a href="/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe" class="Truncate">Tool 2.0.0.exe</a>
  <span class="Truncate-text text-bold">42.1 MB</span>
  <a href="/example/tool/releases/download/v2.0.0/Tool-2.0.0.zip">Tool-2.0.0.zip</a>
  <img src="/example/tool/releases/download/v2.0.0/badge.svg">
  <a href="/other/repo/releases/download/v9.9.9/evil.exe">evil.exe</a>
  <a href="/example/tool/actions/runs/123">CI run</a>
  <a href="/example/tool/releases/download/v2.0.0/..">dotdot</a>
</div>`;

/** Routing mock: the API is dead (403), github.com's quota-free documents
 * answer. `atomBody`/`fragmentBody`/`fragmentStatus` are overridable. */
function stubFetchWithLiveFallback(opts: {
  atomBody?: string;
  fragmentBody?: string;
  fragmentStatus?: number;
  atomStatus?: number;
} = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith('https://api.github.com/')) {
      return new Response('rate limited', { status: 403 });
    }
    if (u.endsWith('/releases.atom')) {
      return new Response(opts.atomBody ?? ATOM_BODY, { status: opts.atomStatus ?? 200 });
    }
    if (u.includes('/expanded_assets')) {
      return new Response(opts.fragmentBody ?? FRAGMENT_BODY, { status: opts.fragmentStatus ?? 200 });
    }
    return new Response('Unexpected URL', { status: 404 });
  });
}

let n = 0;
const appInRepo = (over: Partial<AppItem> = {}) =>
  makeApp({ githubUrl: `https://github.com/example/fb-${++n}`, ...over });

/** The feed/fragment fixtures name the repo example/tool; end-to-end tests
 * must resolve THAT repo so the parser's repo attribution matches. */
const appTool = (over: Partial<AppItem> = {}) =>
  makeApp({ githubUrl: 'https://github.com/example/tool', ...over });

beforeEach(() => {
  ghCache.clear();
  fdCache.clear();
  localStorage.removeItem(CACHE_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('atom fallback end-to-end (provider wiring)', () => {
  it('a rate-limited API lookup now RESOLVES through releases.atom + expanded_assets', async () => {
    const app = appTool();
    const f = stubFetchWithLiveFallback();
    vi.stubGlobal('fetch', f);
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r).not.toBeNull();
    expect(r?.source).toBe('github');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe');
    expect(r?.filename).toBe('Tool 2.0.0.exe');
    expect(r?.version).toBe('2.0.0');
    // The fallback answered from the quota-free documents, in order: API,
    // atom feed, one expanded_assets fragment.
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/^https:\/\/api\.github\.com\//);
    expect(urls.some((u) => u.endsWith('/releases.atom'))).toBe(true);
    expect(urls.some((u) => u.includes('/expanded_assets'))).toBe(true);
  });

  it('an unstable-stage feed entry is never served while a stable one exists', async () => {
    const app = appTool();
    vi.stubGlobal('fetch', stubFetchWithLiveFallback());
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.version).toBe('2.0.0');
  });

  it('when the fallback is ALSO dead, the original classified error survives', async () => {
    const app = appInRepo();
    // Everything 403s: API, atom feed, fragments.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })));
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    const failure = peekResolveFailure(app, 'windows');
    expect(failure).not.toBeNull();
    expect(failure?.kind).toBe('rate-limit');
    expect(failure?.message).toMatch(/rate limit/i);
  });

  it('a feed with no usable entries keeps the original API error too', async () => {
    const app = appInRepo();
    vi.stubGlobal(
      'fetch',
      stubFetchWithLiveFallback({ atomBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' })
    );
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(peekResolveFailure(app, 'windows')?.kind).toBe('rate-limit');
  });

  it('the honest 404 (no stable release) never spends requests on the feed', async () => {
    const app = appInRepo();
    // A genuinely release-less repo: /releases/latest answers 404 while
    // the list endpoint answers 200 with an empty array - the resolver's
    // existing "quiet miss" shape. The feed must not be contacted at all.
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith('/releases/latest')) return new Response('Not Found', { status: 404 });
      if (u.includes('/releases?per_page=')) return new Response('[]', { status: 200 });
      return new Response('Unexpected URL', { status: 404 });
    });
    vi.stubGlobal('fetch', f);
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(peekResolveFailure(app, 'windows')).toBeNull();
    for (const call of f.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/api\.github\.com\//);
    }
  });

  it('fragments that answer 404 degrade to asset-less entries, not a crash', async () => {
    const app = appTool();
    vi.stubGlobal(
      'fetch',
      stubFetchWithLiveFallback({ fragmentStatus: 404, fragmentBody: 'nope' })
    );
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
  });
});

describe('parseAtomFeed', () => {
  it('extracts tag, decoded title, updated and the tag URL for the right repo', () => {
    const entries = parseAtomFeed(ATOM_BODY, 'example/tool');
    expect(entries.map((e) => e.tag)).toEqual(['v2.0.0', 'v2.1.0-beta.1']);
    expect(entries[0].title).toBe('Tool & Tools 2.0.0 "Stable"');
    expect(entries[0].updated).toBe('2026-10-01T00:00:00Z');
    expect(entries[0].htmlUrl).toBe('https://github.com/example/tool/releases/tag/v2.0.0');
  });

  it('skips foreign-repo links, unsafe tags and link-less entries instead of guessing', () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>tag:github.com,2008:Repository/1/other/v1.0.0</id><link rel="alternate" type="text/html" href="https://github.com/other/repo/releases/tag/v1.0.0"/><title>foreign</title></entry>
      <entry><id>tag:github.com,2008:Repository/2/x</id><link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v1..%2F..%2Fetc"/><title>escape</title></entry>
      <entry><id>tag:github.com,2008:Repository/3/x</id><link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/ok-1.2.3+build"/><title>ok</title></entry>
      <entry><id>tag:github.com,2008:Repository/4/x</id><title>no link at all</title></entry>
    </feed>`;
    const entries = parseAtomFeed(body, 'example/tool');
    expect(entries.map((e) => e.tag)).toEqual(['ok-1.2.3+build']);
  });

  it('percent escapes in the link are decoded once into the tag', () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>tag:github.com,2008:Repository/1/x</id><link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/release%201.0"/><title>r</title></entry>
    </feed>`;
    expect(parseAtomFeed(body, 'example/tool')[0].tag).toBe('release 1.0');
  });
});

describe('parseExpandedAssets', () => {
  it('extracts release-download assets with decoded names and canonical URLs', () => {
    const assets = parseExpandedAssets(FRAGMENT_BODY, 'example/tool');
    expect(assets.map((a) => a.name)).toEqual(['Tool 2.0.0.exe', 'Tool-2.0.0.zip']);
    expect(assets[0].downloadUrl).toBe(
      'https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe'
    );
    // The fragment's own size label is parsed (best-effort, byte-rounded);
    // the download engine still learns the exact size from Content-Length.
    expect(assets[0].size).toBe(Math.round(42.1 * 1024 * 1024));
  });

  it('ignores badge images, other repos and non-download links', () => {
    const assets = parseExpandedAssets(
      '<a href="/example/tool/releases/download/v1/bad%ZZ esc.exe">malformed</a>',
      'example/tool'
    );
    expect(assets).toEqual([]);
  });

  it('never returns a path-looking or dot asset name', () => {
    const assets = parseExpandedAssets(
      `<a href="/example/tool/releases/download/v1/a/b.exe">nested</a>
       <a href="/example/tool/releases/download/v1/..">dotdot</a>
       <a href="/example/tool/releases/download/v1/ok.exe">ok</a>`,
      'example/tool'
    );
    // Nested paths are not flat asset names: only the plain file survives.
    expect(assets.map((a) => a.name)).toEqual(['ok.exe']);
  });
});

describe('stageLooksUnstable (the feed has no prerelease flag)', () => {
  it('flags every unstable-stage marker', () => {
    for (const t of ['v2.1.0-beta.1', 'v3.0.0-rc.2', '1.0-alpha', 'nightly-2026.10', 'canary', 'v1-preview.1'])
      expect(stageLooksUnstable(t, ''), t).toBe(true);
  });

  it('leaves stable tags and look-alike words alone', () => {
    for (const t of ['v2.0.0', '1.2.3', 'release-2026.10.01', 'v1.0.0 prebuilt', 'v9/devtools-bundle'])
      expect(stageLooksUnstable(t, ''), t).toBe(false);
  });
});

describe('slug safety and budget', () => {
  it('accepts real GitHub slugs and refuses escapes', () => {
    expect(isSafeRepoSlug('localsend/localsend')).toBe(true);
    expect(isSafeRepoSlug('obsidianmd/obsidian-releases')).toBe(true);
    expect(isSafeRepoSlug('a/b/c')).toBe(false);
    expect(isSafeRepoSlug('../etc/passwd')).toBe(false);
    expect(isSafeRepoSlug('example/tool?x=1')).toBe(false);
    expect(isSafeRepoSlug('')).toBe(false);
  });

  it('keeps the fragment budget bounded', () => {
    expect(ATOM_ASSET_FETCH_BUDGET).toBeGreaterThan(0);
    expect(ATOM_ASSET_FETCH_BUDGET).toBeLessThanOrEqual(8);
  });
});
