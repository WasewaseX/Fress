/**
 * Self-update for Fress itself.
 *
 * Checks the WasewaseX/Fress releases on GitHub, compares the running version
 * with the newest published release (prereleases included, drafts excluded),
 * and if there is something newer, hands the platform-matched file to the
 * download manager.
 *
 * The plain /releases/latest endpoint is useless here because Fress marks its
 * pre-stable builds as prereleases; /releases?per_page=10 returns those.
 *
 * The check MUST NOT surface errors to users: the REST API shares a small
 * unauthenticated quota per IP, so it legitimately fails sometimes. When the
 * API is unavailable we fall back to the releases.atom feed, which is served
 * as a static file by github.com and is not rate limited. Only when BOTH
 * sources fail does the check report an error, and the app shows a quiet
 * note instead of a scary red toast.
 */

const REPO = 'WasewaseX/Fress';

export interface OwnRelease {
  tag: string;
  version: string; // tag without the leading "v"
  publishedAt: string;
  htmlUrl: string;
  assets: Array<{ name: string; size: number; url: string }>;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null }
  | { kind: 'error' };

/** How rough a build the user wants to hear about. */
export type UpdateChannel = 'stable' | 'beta' | 'alpha';

export const UPDATE_CHANNELS: Array<{ id: UpdateChannel; label: string }> = [
  { id: 'stable', label: 'Stable' },
  { id: 'beta', label: 'Beta' },
  { id: 'alpha', label: 'Alpha' },
];

/**
 * Pre-stable Fress treats every published build as news, so the default is
 * the widest channel. When a stable 1.0 lands this flips to 'stable' and
 * normal users stop being offered prerelease builds.
 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'alpha';

const CHANNEL_KEY = 'fress.updateChannel';

export function getUpdateChannel(): UpdateChannel {
  try {
    const v = localStorage.getItem(CHANNEL_KEY);
    if (v === 'stable' || v === 'beta' || v === 'alpha') return v;
  } catch {
    // ignore
  }
  return DEFAULT_UPDATE_CHANNEL;
}

export function setUpdateChannel(channel: UpdateChannel): void {
  try {
    localStorage.setItem(CHANNEL_KEY, channel);
  } catch {
    // ignore
  }
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  prerelease: string[];
}

/** "0.12.0-beta.2" / "v0.12.0" -> structured parts; null when unparsable. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = v
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').filter(Boolean) : [],
  };
}

function comparePrereleaseIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const va = Number(a);
    const vb = Number(b);
    return va < vb ? -1 : va > vb ? 1 : 0;
  }
  if (na) return -1; // numeric identifiers rank below alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // SemVer: a version WITHOUT prerelease outranks every prerelease of the
  // same major.minor.patch, so 1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-alpha.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = comparePrereleaseIds(a[i], b[i]);
    if (c !== 0) return c;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** -1 older, 0 equal, 1 newer. Full SemVer prerelease ordering; falls back
 * to string inequality when either side is unparsable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return comparePrerelease(pa.prerelease, pb.prerelease);
  }
  return a.trim().replace(/^v/i, '') === b.trim().replace(/^v/i, '') ? 0 : -1;
}

/**
 * How rough a version is: 0 stable, 1 beta/rc, 2 alpha/dev/anything else.
 * Used for channel filtering, not for ordering (ordering is SemVer).
 */
function prereleaseStage(v: ParsedVersion): number {
  if (v.prerelease.length === 0) return 0;
  const first = v.prerelease[0].toLowerCase();
  if (first.includes('rc')) return 1;
  if (first.startsWith('beta') || first.startsWith('b')) return 1;
  return 2;
}

/** Which versions the channel surfaces. Stable sees only stable releases;
 * Beta adds beta/rc; Alpha (the pre-stable default) sees everything. */
export function releaseMatchesChannel(version: string, channel: UpdateChannel): boolean {
  const p = parseVersion(version);
  if (!p) return true; // an unparsable version stays visible rather than hidden
  const stage = prereleaseStage(p);
  switch (channel) {
    case 'stable':
      return stage === 0;
    case 'beta':
      return stage <= 1;
    case 'alpha':
      return true;
  }
}

interface RawRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

function mapRelease(r: RawRelease): OwnRelease {
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/i, ''),
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
  };
}

function isJunkAsset(name: string): boolean {
  return /\.sig$|blockmap|checksum|sha256|latest\.json|symbols|\.zip$/i.test(name);
}

/** Pick the file a user on this platform actually needs. */
export function pickOwnAsset(release: OwnRelease): { name: string; size: number; url: string } | null {
  const assets = (release.assets || []).filter((a) => !isJunkAsset(a.name));
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const platform =
    ua.includes('android') ? 'android' :
    ua.includes('mac os') || ua.includes('macintosh') ? 'mac' :
    ua.includes('linux') ? 'linux' : 'windows';
  const isArmHost = /arm|aarch/i.test(ua);
  const score = (n: string): number => {
    const s = n.toLowerCase();
    switch (platform) {
      case 'windows': {
        if (!s.endsWith('.exe')) return -1;
        if (!s.includes('setup')) return 5;
        // Architecture must match the host: an x64 machine must never be
        // handed the ARM64 installer just because it sorts earlier in the
        // asset list (regression caught by unit tests).
        const armAsset = s.includes('arm64') || s.includes('aarch64');
        const x64Asset = s.includes('x64') || s.includes('x86_64') || s.includes('amd64');
        if (isArmHost) return armAsset ? 10 : x64Asset ? 6 : 4;
        return x64Asset ? 10 : armAsset ? 3 : 7;
      }
      case 'android':
        if (!s.endsWith('.apk')) return -1;
        if (s.includes('universal')) return 10;
        if (s.includes('arm64')) return 8;
        return 4;
      case 'mac':
        if (!s.endsWith('.dmg')) return -1;
        if (s.includes('aarch64') || s.includes('arm64')) return isArmHost ? 10 : 6;
        if (s.includes('x64') || s.includes('x86_64')) return isArmHost ? 6 : 10;
        return 4;
      case 'linux':
        if (s.endsWith('.appimage')) return 10;
        if (s.endsWith('.deb')) return 7;
        if (s.endsWith('.rpm')) return 5;
        return -1;
      default:
        return -1;
    }
  };
  let best: { name: string; size: number; url: string } | null = null;
  let bestScore = 0;
  for (const a of assets) {
    const s = score(a.name);
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  return best;
}

/** Newest published release (drafts dropped, channel-filtered, SemVer order). */
async function fetchFromApi(channel: UpdateChannel): Promise<OwnRelease> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const raw = (await res.json()) as RawRelease[];
  const published = (raw || []).filter(
    (r) => !r.draft && releaseMatchesChannel(r.tag_name.replace(/^v/i, ''), channel)
  );
  if (published.length === 0) throw new Error('No published releases');
  published.sort((a, b) => compareVersions(a.tag_name, b.tag_name));
  return mapRelease(published[published.length - 1]);
}

/**
 * Fallback: the releases.atom feed. Static file, no rate limit, no API.
 * Only carries the tag name, so assets stay empty; the header then links to
 * the releases page instead of starting a direct download.
 */
async function fetchFromAtom(): Promise<OwnRelease> {
  const res = await fetch(`https://github.com/${REPO}/releases.atom`);
  if (!res.ok) throw new Error(`Atom feed ${res.status}`);
  const xml = await res.text();
  // First <entry> is the newest release. The id looks like
  // "tag:github.com,2008:Repository/123456/v1.0.1-alpha".
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/i);
  const idMatch = entryMatch?.[0].match(/<id>[^<]*\/([^<]+)<\/id>/i);
  const tag = idMatch?.[1]?.trim();
  if (!tag) throw new Error('Atom feed has no release entries');
  const updated = entryMatch?.[0].match(/<updated>([^<]+)<\/updated>/i)?.[1] || '';
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    publishedAt: updated,
    htmlUrl: `https://github.com/${REPO}/releases`,
    assets: [],
  };
}

/** Newest published release on the channel, API first, atom feed fallback. */
export async function fetchOwnLatestRelease(channel: UpdateChannel = getUpdateChannel()): Promise<OwnRelease | null> {
  try {
    return await fetchFromApi(channel);
  } catch {
    try {
      const release = await fetchFromAtom();
      if (!releaseMatchesChannel(release.version, channel)) return null;
      return release;
    } catch {
      return null;
    }
  }
}

/**
 * Fetch the release's SHA256SUMS.txt and return the trusted hash published
 * for `assetName`. This is what turns the download manager's "calculated a
 * hash" into an actual verification: the hash is compared against the value
 * CI published next to the file, not merely computed and shown.
 */
async function fetchExpectedSha256(release: OwnRelease, assetName: string): Promise<string | null> {
  const sums = release.assets.find((a) => /^sha256sums\.txt$/i.test(a.name));
  if (!sums) return null;
  try {
    const res = await fetch(sums.url);
    if (!res.ok) return null;
    const text = await res.text();
    for (const line of text.split('\n')) {
      // "<hex>  <name>" (two spaces, sha256sum format)
      const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (m && m[2].trim() === assetName) return m[1].toLowerCase();
    }
  } catch {
    // A missing/unreachable checksum file degrades to "unverified", never to
    // a fake "verified".
  }
  return null;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateState> {
  try {
    const channel = getUpdateChannel();
    const release = await fetchOwnLatestRelease(channel);
    if (!release) return { kind: 'error' };
    const cmp = compareVersions(release.version, currentVersion);
    if (cmp <= 0) {
      return { kind: 'latest', version: release.version };
    }
    const asset = pickOwnAsset(release);
    let expectedSha256: string | null = null;
    if (asset) {
      expectedSha256 = await fetchExpectedSha256(release, asset.name);
    }
    return { kind: 'available', release, asset, expectedSha256 };
  } catch {
    return { kind: 'error' };
  }
}
