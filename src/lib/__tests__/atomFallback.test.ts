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
//      foreign-repo ids, unsafe tags, badge links, path-looking names;
//   5. the fragment walk reaches the whole recent-releases scan depth, so
//      a compatible installer sitting past the first handful of entries
//      (multi-stream repos) still resolves through the fallback;
//   6. strict SemVer prerelease identifiers (-next, -experimental, ...)
//      are gated as unstable even when the word list does not know them.
//
// The kill point is the provider wiring in githubProvider.ts: removing the
// fallback there makes (1) fail while (2)/(3) keep passing. Shrinking the
// walk back to a five-fragment budget fails (5); dropping the SemVer gate
// fails (6).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { ghCache, fdCache, peekResolveFailure } from '../release/resolveCache';
import { resolveGitHubDownload } from '../release/resolve';
import {
  parseAtomFeed,
  parseExpandedAssets,
  stageLooksUnstable,
  isSafeRepoSlug,
  getReleasesViaAtom,
  getLatestViaAtom,
  ATOM_SCAN_DEPTH,
} from '../release/atomReleases';
import { RECENT_RELEASES_COUNT } from '../release/githubProvider';
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

/** Desktop bridge mock: the Tauri transport carries the quota-free
 * documents (feed, stable-tag oracle, fragments) while the API commands
 * answer the rate-limit failure the suite's scenario needs. The shipping
 * surface IS desktop: the silent-prerelease oracle is desktop-native, so
 * "API dead, quota-free documents alive" is only honest here - a plain
 * browser can neither read github.com documents (CORS) nor see the
 * oracle's redirect target, which is exactly why the earlier browser-
 * mode mocks in this suite could not survive the fail-closed oracle.
 * `atomBody`/`fragmentBody`/`fragmentStatus` are overridable. */
function stubBridgeWithLiveFallback(opts: {
  atomBody?: string;
  fragmentBody?: string;
  fragmentStatus?: number;
  atomStatus?: number;
  oracle?: { status: number; finalUrl?: string } | Error;
  apiError?: Error;
} = {}) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const url = typeof args?.url === 'string' ? args.url : '';
    if (cmd === 'fetch_github_release_doc') {
      if (url.endsWith('/releases.atom')) {
        return { status: opts.atomStatus ?? 200, body: opts.atomBody ?? ATOM_BODY, truncated: false };
      }
      if (/\/releases\/latest$/.test(url)) {
        if (opts.oracle instanceof Error) throw opts.oracle;
        return {
          status: opts.oracle?.status ?? 200,
          final_url: opts.oracle?.finalUrl ?? 'https://github.com/example/tool/releases/tag/v2.0.0',
          body: '',
          truncated: false,
        };
      }
      if (url.includes('/expanded_assets')) {
        return { status: opts.fragmentStatus ?? 200, body: opts.fragmentBody ?? FRAGMENT_BODY, truncated: false };
      }
      throw new Error(`Unexpected release-document URL: ${url}`);
    }
    if (cmd === 'fetch_latest_release' || cmd === 'fetch_recent_releases') {
      throw opts.apiError ?? new Error('GitHub rate limit reached');
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  return invokeMock;
}

/** A feed of `tags` (newest first) whose API is dead and whose
 * expanded_assets fragments answer per tag (`fragments[tag]`, default an
 * asset-less fragment) - so a multi-release scenario can name exactly
 * which entries carry installers and count how deep the walk actually
 * went. The oracle agrees with the feed top unless the scenario pins
 * another stable (`oracleTag`). */
function stubBridgeWithPerTagFragments(
  tags: string[],
  fragments: Record<string, string> = {},
  opts: { oracleTag?: string; apiError?: Error } = {}
) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/example/tool/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/example/tool/releases"/>
  <title>Release notes from tool</title>
  <updated>2026-10-01T00:00:00Z</updated>
${tags
  .map(
    (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/example-tool/${tag}</id>
    <updated>2026-10-01T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/${tag}"/>
    <title>${tag}</title>
  </entry>`
  )
  .join('\n')}
</feed>`;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const url = typeof args?.url === 'string' ? args.url : '';
    if (cmd === 'fetch_github_release_doc') {
      if (url.endsWith('/releases.atom')) return { status: 200, body: feed, truncated: false };
      // GitHub's oracle agrees with the feed top unless the scenario pins
      // another stable. (An unflagged SemVer prerelease at the top IS
      // what the real oracle would answer - the textual gate cuts it.)
      if (/\/releases\/latest$/.test(url)) {
        const tag = opts.oracleTag ?? tags[0];
        return {
          status: 200,
          final_url: `https://github.com/example/tool/releases/tag/${tag}`,
          body: '',
          truncated: false,
        };
      }
      // Both fragment URL shapes answer identically: the walk fetches the
      // MODERN shape (`/releases/expanded_assets/<tag>`) and must spend
      // exactly ONE request per tag on it - the legacy shape
      // (`/releases/tag/<tag>/expanded_assets`) is routed too so a future
      // URL change cannot silently redirect the fixture's answers.
      if (url.includes('/expanded_assets')) {
        const m = /\/expanded_assets\/([^/?]+)$/.exec(url) ?? /\/releases\/tag\/([^/]+)\/expanded_assets$/.exec(url);
        const tag = m ? decodeURIComponent(m[1]) : '';
        return { status: 200, body: fragments[tag] ?? '<div></div>', truncated: false };
      }
      throw new Error(`Unexpected release-document URL: ${url}`);
    }
    if (cmd === 'fetch_latest_release' || cmd === 'fetch_recent_releases') {
      throw opts.apiError ?? new Error('GitHub rate limit reached');
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  return invokeMock;
}

const invokeFragmentFetches = () =>
  invokeMock.mock.calls.filter(
    ([cmd, args]) => cmd === 'fetch_github_release_doc' && String((args as { url?: string })?.url ?? '').includes('/expanded_assets')
  ).length;

const invokeDocUrls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'fetch_github_release_doc')
    .map(([, args]) => String((args as { url?: string })?.url ?? ''));

const invokeApiCommands = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === 'fetch_latest_release' || cmd === 'fetch_recent_releases');

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
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('atom fallback end-to-end (provider wiring)', () => {
  it('a rate-limited API lookup now RESOLVES through releases.atom + expanded_assets', async () => {
    const app = appTool();
    stubBridgeWithLiveFallback();
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r).not.toBeNull();
    expect(r?.source).toBe('github');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe');
    expect(r?.filename).toBe('Tool 2.0.0.exe');
    expect(r?.version).toBe('2.0.0');
    // The fallback answered from the quota-free documents alone: not ONE
    // api.github.com command was spent (the stable-tag oracle is a
    // github.com document too), in order: feed, oracle, fragment.
    expect(invokeApiCommands()).toEqual([]);
    const urls = invokeDocUrls();
    expect(urls[0]).toBe('https://github.com/example/tool/releases.atom');
    expect(urls[1]).toBe('https://github.com/example/tool/releases/latest');
    expect(urls.some((u) => u.includes('/expanded_assets'))).toBe(true);
  });

  it('an unstable-stage feed entry is never served while a stable one exists', async () => {
    const app = appTool();
    stubBridgeWithLiveFallback();
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.version).toBe('2.0.0');
  });

  it('a v2.1.0-next prerelease is never served while a stable release exists', async () => {
    // The word list has no opinion about "next": the strict SemVer gate
    // must catch the identifier space, or the newest entry - whose assets
    // match this platform perfectly - would be served to a stable channel.
    // (The unflagged -next tag IS what GitHub's oracle answers - the flag
    // does not see it either - so this cut is L2's textual gate.)
    const app = appTool();
    stubBridgeWithPerTagFragments(['v2.1.0-next', 'v2.0.0'], {
      'v2.1.0-next': '<a href="/example/tool/releases/download/v2.1.0-next/Tool%202.1.0-next.exe">next</a>',
      'v2.0.0': FRAGMENT_BODY,
    });
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.version).toBe('2.0.0');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe');
  });

  it('finds a compatible release at position seven, past the old five-fragment budget', async () => {
    // Six asset-less releases ahead of the real one: the API path sees it
    // inside its 20-release scan; the fallback walk must reach just as
    // deep instead of returning five empty entries and a dead end.
    const app = appTool();
    stubBridgeWithPerTagFragments(
      [
        'stream-a-1.0.0',
        'stream-b-1.0.0',
        'stream-c-1.0.0',
        'stream-d-1.0.0',
        'stream-e-1.0.0',
        'stream-f-1.0.0',
        'v2.0.0',
      ],
      { 'v2.0.0': FRAGMENT_BODY }
    );
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe');
    expect(invokeFragmentFetches()).toBe(7);
  });

  it('keeps walking past five other-stream releases that do carry assets', async () => {
    // The audit's exact shape: the newest entries belong to other product
    // streams and have real (wrong-platform) assets, so a budget spent on
    // them never reaches the desktop installer six entries deeper.
    const app = appTool();
    const tags = ['v1.9.0', 'v1.9.1', 'v1.9.2', 'v1.9.3', 'v1.9.4', 'v1.9.5', 'v2.0.0'];
    const fragments: Record<string, string> = { 'v2.0.0': FRAGMENT_BODY };
    for (const t of tags.slice(0, -1)) {
      fragments[t] = `<a href="/example/tool/releases/download/${t}/tool-${t}.apk">mobile</a>`;
    }
    stubBridgeWithPerTagFragments(tags, fragments);
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.url).toBe('https://github.com/example/tool/releases/download/v2.0.0/Tool%202.0.0.exe');
    expect(invokeFragmentFetches()).toBeGreaterThanOrEqual(7);
  });

  it('when the fallback is ALSO dead, the original classified error survives', async () => {
    const app = appInRepo();
    // Everything fails: the feed 403s on the native transport, and the
    // API commands answer the rate limit.
    stubBridgeWithLiveFallback({ atomStatus: 403 });
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    const failure = peekResolveFailure(app, 'windows');
    expect(failure).not.toBeNull();
    expect(failure?.kind).toBe('rate-limit');
    expect(failure?.message).toMatch(/rate limit/i);
  });

  it('a feed with no usable entries keeps the original API error too', async () => {
    const app = appInRepo();
    stubBridgeWithLiveFallback({ atomBody: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' });
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(peekResolveFailure(app, 'windows')?.kind).toBe('rate-limit');
  });

  it('the honest 404 (no stable release) stays a quiet miss with no fragment spend', async () => {
    const app = appInRepo();
    // A genuinely release-less repo: the native API command answers the
    // classified 404 and the recent scan answers empty - the resolver's
    // existing "quiet miss" shape. No fragment may be probed for a repo
    // with nothing to show.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      const url = typeof args?.url === 'string' ? args.url : '';
      if (cmd === 'fetch_github_release_doc') {
        if (url.endsWith('/releases.atom')) {
          return { status: 200, body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', truncated: false };
        }
        throw new Error(`Unexpected release-document URL: ${url}`);
      }
      if (cmd === 'fetch_latest_release') throw new Error('No stable release found for this project');
      if (cmd === 'fetch_recent_releases') return [];
      throw new Error(`Unexpected command: ${cmd}`);
    });
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(peekResolveFailure(app, 'windows')).toBeNull();
    expect(invokeFragmentFetches()).toBe(0);
  });

  it('fragments that answer 404 degrade to asset-less entries, not a crash', async () => {
    const app = appTool();
    stubBridgeWithLiveFallback({ fragmentStatus: 404, fragmentBody: 'nope' });
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

  it('a dotted repo slug (calcom/cal.diy) never matches a lookalike repository', () => {
    // Live-catalog regression: the slug was interpolated into the asset
    // RegExp unescaped, so the "." in "cal.diy" meant "any character" and
    // a fragment carrying a calXdiy link produced a download URL under a
    // foreign repository. The segment-count check could not catch it: it
    // sliced by the EXPECTED prefix's length without comparing the actual
    // prefix. Escaping pins the pattern to the literal slug.
    const body = `<a href="/calcom/calXdiy/releases/download/v9/app.apk">lookalike</a>
      <a href="/calcom/cal.diy/releases/download/v9/app.apk">real</a>`;
    const assets = parseExpandedAssets(body, 'calcom/cal.diy');
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe('app.apk');
    expect(assets[0].downloadUrl).toBe(
      'https://github.com/calcom/cal.diy/releases/download/v9/app.apk'
    );
  });

  it('every download URL sits under the exact requested repo prefix (boundary pin)', () => {
    // The explicit startsWith check is the second wall: even if a future
    // pattern edit re-widened the match, a sibling slug's href can never
    // become this repo's download URL.
    const body = `<a href="/example/tool/releases/download/v1/real.exe">real</a>
      <a href="/example/tool2/releases/download/v1/sibling.exe">sibling</a>`;
    const assets = parseExpandedAssets(body, 'example/tool');
    expect(assets).toHaveLength(1);
    expect(assets[0].downloadUrl).toBe(
      'https://github.com/example/tool/releases/download/v1/real.exe'
    );
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

  it('a strict SemVer prerelease identifier is unstable whatever it says', () => {
    // The API path filters by GitHub's own prerelease flag; the feed has
    // no such flag, and the stage vocabulary above cannot enumerate the
    // identifier space. The strict parser can - any valid SemVer with a
    // prerelease part is a prerelease, custom identifier or not.
    for (const t of ['v2.1.0-next', 'v2.1.0-experimental', '2.0.0-nightly.1', '1.0.0-20261018', 'v1.2.3-next.5'])
      expect(stageLooksUnstable(t, ''), t).toBe(true);
  });

  it('build metadata is not a prerelease stage', () => {
    expect(stageLooksUnstable('v1.2.3+build.5', '')).toBe(false);
  });
});

describe('fallback search depth (the walk reaches the whole scan)', () => {
  it('returns real assets for every entry of the requested slice, not just the first five', async () => {
    const tags = Array.from({ length: 8 }, (_, i) => `v1.0.${i}`);
    const fragments: Record<string, string> = {};
    for (const t of tags) {
      fragments[t] = `<a href="/example/tool/releases/download/${t}/tool-${t}.exe">installer</a>`;
    }
    stubBridgeWithPerTagFragments(tags, fragments);
    const list = await getReleasesViaAtom('example/tool', 20, false);
    expect(list).toHaveLength(8);
    for (const rel of list) {
      expect(rel.assets.map((a) => a.name)).toEqual([`tool-${rel.tag}.exe`]);
    }
    expect(invokeFragmentFetches()).toBe(8);
  });

  it('the walk stays bounded by the requested count even when the feed is longer', async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `v1.0.${i}`);
    const fragments: Record<string, string> = {};
    for (const t of tags) {
      fragments[t] = `<a href="/example/tool/releases/download/${t}/tool-${t}.exe">installer</a>`;
    }
    stubBridgeWithPerTagFragments(tags, fragments);
    const list = await getReleasesViaAtom('example/tool', ATOM_SCAN_DEPTH, false);
    expect(list).toHaveLength(ATOM_SCAN_DEPTH);
    expect(invokeFragmentFetches()).toBe(ATOM_SCAN_DEPTH);
  });

  it('the latest lookup stops at the first asset-bearing entry but reaches deep when earlier ones have none', async () => {
    const tags = ['v1.0.0', 'v1.0.1', 'v1.0.2', 'v1.0.3', 'v1.0.4', 'v1.0.5', 'v2.0.0'];
    stubBridgeWithPerTagFragments(tags, { 'v2.0.0': FRAGMENT_BODY });
    const latest = await getLatestViaAtom('example/tool', false);
    expect(latest?.tag).toBe('v2.0.0');
    expect(latest?.assets.map((a) => a.name)).toEqual(['Tool 2.0.0.exe', 'Tool-2.0.0.zip']);
    expect(invokeFragmentFetches()).toBe(7);
  });
});

describe('slug safety and scan depth', () => {
  it('accepts real GitHub slugs and refuses escapes', () => {
    expect(isSafeRepoSlug('localsend/localsend')).toBe(true);
    expect(isSafeRepoSlug('obsidianmd/obsidian-releases')).toBe(true);
    expect(isSafeRepoSlug('a/b/c')).toBe(false);
    expect(isSafeRepoSlug('../etc/passwd')).toBe(false);
    expect(isSafeRepoSlug('example/tool?x=1')).toBe(false);
    expect(isSafeRepoSlug('')).toBe(false);
  });

  it('walks as deep as the API path it stands in for', () => {
    expect(ATOM_SCAN_DEPTH).toBe(RECENT_RELEASES_COUNT);
  });
});
