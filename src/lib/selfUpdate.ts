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
  | { kind: 'available'; release: OwnRelease; asset: { name: string; size: number; url: string } | null }
  | { kind: 'error' };

/** "0.12.0-beta" / "v0.12.0-beta" -> [0, 12, 0]; returns null when unparsable. */
export function parseVersion(v: string): number[] | null {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 older, 0 equal, 1 newer. Falls back to string inequality when unparsable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
  }
  return a.trim().replace(/^v/i, '') === b.trim().replace(/^v/i, '') ? 0 : -1;
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
  const isArmMac = /arm|aarch/i.test(ua);
  const score = (n: string): number => {
    const s = n.toLowerCase();
    switch (platform) {
      case 'windows':
        if (!s.endsWith('.exe')) return -1;
        return s.includes('setup') ? 10 : 5;
      case 'android':
        if (!s.endsWith('.apk')) return -1;
        if (s.includes('universal')) return 10;
        if (s.includes('arm64')) return 8;
        return 4;
      case 'mac':
        if (!s.endsWith('.dmg')) return -1;
        if (s.includes('aarch64') || s.includes('arm64')) return isArmMac ? 10 : 6;
        if (s.includes('x64') || s.includes('x86_64')) return isArmMac ? 6 : 10;
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

/** Newest published release (drafts dropped), newest first from the API. */
async function fetchFromApi(): Promise<OwnRelease> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const raw = (await res.json()) as RawRelease[];
  const published = (raw || []).filter((r) => !r.draft);
  if (published.length === 0) throw new Error('No published releases');
  return mapRelease(published[0]);
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

/** Newest published release, API first, static atom feed as the fallback. */
export async function fetchOwnLatestRelease(): Promise<OwnRelease | null> {
  try {
    return await fetchFromApi();
  } catch {
    try {
      return await fetchFromAtom();
    } catch {
      return null;
    }
  }
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateState> {
  try {
    const release = await fetchOwnLatestRelease();
    if (!release) return { kind: 'error' };
    const cmp = compareVersions(release.version, currentVersion);
    if (cmp <= 0) {
      return { kind: 'latest', version: release.version };
    }
    return { kind: 'available', release, asset: pickOwnAsset(release) };
  } catch {
    return { kind: 'error' };
  }
}
