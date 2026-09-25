// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { AppItem, Platform } from '../types';
import { isTauri } from './downloads';
import {
  ReleaseAsset,
  ResolvedDownload,
  scoreAsset,
  assetCompatibleWithDevice,
  getHostArch,
  loadPersisted,
  persist,
} from './releaseFetch';

/**
 * Official download resolvers for projects whose installers do NOT live on
 * GitHub. Every entry here was verified against the vendor's live
 * infrastructure: the resolver reads the vendor's OWN manifest, directory
 * index or updater feed and hands back the exact file the vendor currently
 * distributes. Nothing is guessed from a marketing page, and nothing is
 * version-pinned (a pinned URL rots at the next release).
 *
 * Confidence model:
 *   - The VENDOR is the naming authority: whatever its manifest lists for
 *     this platform IS the app, so picks are never flagged "weak".
 *   - Architecture compatibility is still a HARD constraint shared with the
 *     GitHub resolver: a file the device provably cannot run is refused.
 *
 * Transport: in the desktop app a size-capped, host-allowlisted Rust command
 * reads vendor hosts (webview fetch would trip CORS); in the browser plain
 * fetch is used and a blocked host simply resolves to null, falling back to
 * the official page links.
 */

interface TextFetchResult {
  status: number;
  finalUrl: string;
  contentLength: number | null;
  body: string;
}

const TEXT_TIMEOUT_MS = 25_000;

/** Vendor endpoints occasionally hiccup (a CDN serves an HTML challenge
 * page, a mirror times out). One quick retry turns most of those blips
 * into answers without any user-visible delay. */
async function fetchTextOnce(url: string): Promise<TextFetchResult> {
  if (isTauri()) {
    const r = await invoke<{ status: number; final_url: string; content_length: number | null; body: string; truncated: boolean }>(
      'fetch_text',
      { url }
    );
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return { status: r.status, finalUrl: r.final_url, contentLength: r.content_length, body: r.body };
  }
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Fress official resolver', Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.text();
  return { status: resp.status, finalUrl: resp.url, contentLength: resp.headers.get('content-length') ? Number(resp.headers.get('content-length')) : null, body };
}

async function fetchText(url: string): Promise<TextFetchResult> {
  try {
    return await fetchTextOnce(url);
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/HTTP 40[1344]/.test(msg)) throw e; // 401/403/404: retrying cannot help
    await new Promise((r) => setTimeout(r, 400));
    return fetchTextOnce(url);
  }
}

/** JSON endpoints get a parse-aware retry: some vendors answer a rate
 * window with HTTP 200 + an HTML challenge page, which only blows up when
 * the body is parsed. */
async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchText(url);
    try {
      return JSON.parse(r.body) as T;
    } catch {
      if (attempt > 0) throw new Error('Response was not JSON');
      await new Promise((res) => setTimeout(res, 400));
    }
  }
}

/** Redirect-to-file endpoints (Zotero's dl link): the final URL IS the
 * answer. The desktop path never pulls the big body (the Rust command
 * skips bodies over its cap); the browser uses a HEAD so no installer is
 * downloaded just to learn its name. */
async function fetchRedirectTarget(url: string): Promise<TextFetchResult> {
  if (isTauri()) {
    return fetchText(url);
  }
  const resp = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
  });
  if (!resp.ok && resp.status !== 405) throw new Error(`HTTP ${resp.status}`);
  // 405: some hosts refuse HEAD - retry with a 1-byte ranged GET.
  if (resp.status === 405) {
    const r2 = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
    await r2.body?.cancel();
    return { status: r2.status, finalUrl: r2.url, contentLength: null, body: '' };
  }
  return { status: resp.status, finalUrl: resp.url, contentLength: resp.headers.get('content-length') ? Number(resp.headers.get('content-length')) : null, body: '' };
}

/* ------------------------------------------------------------------ */
/* Small parsing helpers (pure - unit-tested)                          */
/* ------------------------------------------------------------------ */

/** All href= values of an HTML page, HTML-unescaped, deduplicated. */
export function hrefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[1].replace(/&amp;/g, '&');
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** "5.3.2.1" -> [5,3,2,1]; "26.08" -> [26,8]; garbage -> null. */
export function parseVersion(v: string): number[] | null {
  const t = v.replace(/^v/i, '').replace(/\/$/, '');
  if (!/^\d+(\.\d+)*$/.test(t)) return null;
  return t.split('.').map(Number);
}

/** Newest of a list of version strings by numeric comparison.
 * "26.08" beats "5.9" and "6.0.2.1" beats "5.3.4". */
export function newestVersion(list: string[]): string | null {
  let best: string | null = null;
  let bestKey: number[] | null = null;
  for (const v of list) {
    const key = parseVersion(v);
    if (!key) continue;
    if (!bestKey || cmpKey(key, bestKey) > 0) {
      best = v;
      bestKey = key;
    }
  }
  return best;
}

function cmpKey(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** First "1.2.3"-style version inside a filename, "3.0.24" from
 * "vlc-3.0.24-win64.exe". Returns '' when the name carries none. */
export function versionFromName(name: string): string {
  const m = name.match(/(\d+(?:\.\d+)+)/);
  return m ? m[1] : '';
}

function basename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url.split('/').pop() || url;
  }
}

function toAssets(items: { name: string; url: string; size?: number }[]): ReleaseAsset[] {
  return items.map((i) => ({ name: i.name, url: i.url, downloadUrl: i.url, size: i.size ?? 0 }));
}

/**
 * Ranks the vendor's own files with the shared scorer (so installer beats
 * archive, the right arch wins) but NEVER flags the result weak: the vendor
 * manifest is the naming authority. Architecture incompatibility is still a
 * hard refusal, shared with the GitHub path.
 */
function pickOfficial(
  items: { name: string; url: string; size?: number }[],
  platform: Platform,
  arch: string | undefined
): { name: string; url: string; size: number } | null {
  let best: { name: string; url: string; size: number } | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    if (!assetCompatibleWithDevice(item.name, platform, arch)) continue;
    const s = scoreAsset(item.name, platform, arch);
    if (s === -1) continue;
    if (s > bestScore) {
      bestScore = s;
      best = { name: item.name, url: item.url, size: item.size ?? 0 };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Resolver table                                                      */
/* ------------------------------------------------------------------ */

type OfficialResolver = (app: AppItem, arch: string | undefined) => Promise<ResolvedDownload | null>;

const VLC_BASE = 'https://get.videolan.org/vlc/last/';

const resolvers: Record<string, Partial<Record<Platform, OfficialResolver>>> = {
  vlc: {
    windows: async (_app, arch) => {
      // VLC publishes one directory per Windows target; "last" always holds
      // the current stable series.
      const dir = arch === 'aarch64' ? 'winarm64' : arch === 'x86' || arch === 'i686' ? 'win32' : 'win64';
      const page = await fetchText(`${VLC_BASE}${dir}/`);
      const files = hrefs(page.body)
        .filter((h) => new RegExp(`^vlc-[\\d.]+-${dir}\\.exe$`, 'i').test(h));
      if (!files.length) return null;
      const archToken = dir === 'winarm64' ? 'arm64' : dir === 'win32' ? 'x86' : 'x64';
      const chosen =
        files.find((f) => new RegExp(`vlc-[\\d.]+-${archToken}\\.exe$`, 'i').test(f)) || files[0];
      const name = basename(chosen);
      const picked = pickOfficial([{ name, url: `${VLC_BASE}${dir}/${chosen}` }], 'windows', arch);
      if (!picked) return null;
      return {
        source: 'official',
        url: picked.url,
        filename: picked.name,
        size: picked.size,
        version: versionFromName(picked.name),
        releasePageUrl: 'https://www.videolan.org/vlc/download-windows.html',
      };
    },
    mac: async (_app, arch) => {
      const page = await fetchText(`${VLC_BASE}macosx/`);
      const files = hrefs(page.body)
        .filter((h) => /^vlc-[\d.]+-(arm64|intel64|universal)\.dmg$/i.test(h))
        .map((h) => ({ name: basename(h), url: `${VLC_BASE}macosx/${h}` }));
      const picked = pickOfficial(files, 'mac', arch);
      if (!picked) return null;
      return {
        source: 'official',
        url: picked.url,
        filename: picked.name,
        size: picked.size,
        version: versionFromName(picked.name),
        releasePageUrl: 'https://www.videolan.org/vlc/download-macosx.html',
      };
    },
  },

  blender: {
    windows: (app, arch) => resolveBlender('windows', arch, app),
    mac: (app, arch) => resolveBlender('mac', arch, app),
    linux: (app, arch) => resolveBlender('linux', arch, app),
  },

  krita: {
    windows: (app, arch) => resolveKrita('windows', arch, app),
    mac: (app, arch) => resolveKrita('mac', arch, app),
  },

  kdenlive: {
    windows: (app, arch) => resolveKdenlive('windows', arch, app),
    mac: (app, arch) => resolveKdenlive('mac', arch, app),
    linux: (app, arch) => resolveKdenlive('linux', arch, app),
  },

  libreoffice: {
    windows: (app, arch) => resolveLibreOffice('windows', arch, app),
    mac: (app, arch) => resolveLibreOffice('mac', arch, app),
    linux: (app, arch) => resolveLibreOffice('linux', arch, app),
  },

  inkscape: {
    windows: (app, arch) => resolveInkscape('windows', arch, app),
  },

  zotero: {
    windows: (app, arch) => resolveZotero('windows', arch, app),
    mac: (app, arch) => resolveZotero('mac', arch, app),
    linux: (app, arch) => resolveZotero('linux', arch, app),
  },

  signal: {
    windows: async (_app, arch) => {
      // Signal names its Windows builds "signal-desktop-win-x64-<v>.exe",
      // "signal-desktop-win-arm64-<v>.exe" and a plain unmarked alias; the
      // scorer plus the arch gate pick the right one on every host.
      const page = await fetchText('https://updates.signal.org/desktop/latest.yml');
      const parsed = parseSignalYml(page.body);
      if (!parsed.version || !parsed.files.length) return null;
      const files = parsed.files
        .filter((f) => !/blockmap/i.test(f.url))
        .map((f) => ({ name: basename(f.url), url: `https://updates.signal.org/desktop/${f.url}`, size: f.size }))
        .filter((f) => /^signal-desktop-win-.*\.exe$/i.test(f.name));
      const picked = pickOfficial(files, 'windows', arch);
      if (!picked) return null;
      return official(picked, parsed.version, 'https://signal.org/download/');
    },
    mac: async (_app, arch) => {
      const page = await fetchText('https://updates.signal.org/desktop/latest-mac.yml');
      const parsed = parseSignalYml(page.body);
      if (!parsed.version || !parsed.files.length) return null;
      const files = parsed.files
        .filter((f) => !/blockmap/i.test(f.url))
        .map((f) => ({ name: basename(f.url), url: `https://updates.signal.org/desktop/${f.url}`, size: f.size }))
        .filter((f) => f.name.endsWith('.dmg'));
      const picked = pickOfficial(files, 'mac', arch);
      if (!picked) return null;
      return official(picked, parsed.version, 'https://signal.org/download/');
    },
    linux: async (_app, arch) => {
      const page = await fetchText('https://updates.signal.org/desktop/latest-linux.yml');
      const parsed = parseSignalYml(page.body);
      if (!parsed.version || !parsed.files.length) return null;
      const files = parsed.files
        .filter((f) => !/blockmap/i.test(f.url))
        .map((f) => ({ name: basename(f.url), url: `https://updates.signal.org/desktop/${f.url}`, size: f.size }))
        .filter((f) => /\.AppImage$|\.deb$/i.test(f.name));
      const picked = pickOfficial(files, 'linux', arch);
      if (!picked) return null;
      return official(picked, parsed.version, 'https://signal.org/download/');
    },
    android: (app) => resolveSignalAndroid(app),
  },

  'tor-browser': {
    windows: (app, arch) => resolveTor('windows', arch, app),
    mac: (app, arch) => resolveTor('mac', arch, app),
    linux: (app, arch) => resolveTor('linux', arch, app),
    android: (app, arch) => resolveTor('android', arch, app),
  },

  'proton-mail': {
    windows: (app, arch) => resolveProtonMail('windows', arch, app),
    mac: (app, arch) => resolveProtonMail('mac', arch, app),
    linux: (app, arch) => resolveProtonMail('linux', arch, app),
  },

  nextcloud: {
    windows: (app, arch) => resolveNextcloud('windows', arch, app),
    mac: (app, arch) => resolveNextcloud('mac', arch, app),
    linux: (app, arch) => resolveNextcloud('linux', arch, app),
  },

  element: {
    windows: (app, arch) => resolveElement('windows', arch, app),
    mac: (app, arch) => resolveElement('mac', arch, app),
  },

  librewolf: {
    windows: (app, arch) => resolveLibrewolf('windows', arch, app),
    mac: (app, arch) => resolveLibrewolf('mac', arch, app),
    linux: (app, arch) => resolveLibrewolf('linux', arch, app),
  },

  sumatra: {
    windows: (app, arch) => resolveSumatra('windows', arch, app),
  },

  gimp: {
    windows: (app, arch) => resolveGimp('windows', arch, app),
    mac: (app, arch) => resolveGimp('mac', arch, app),
  },
};

/* ------------------------------------------------------------------ */
/* Individual vendor resolvers                                         */
/* ------------------------------------------------------------------ */

function official(
  picked: { name: string; url: string; size: number },
  version: string,
  page: string
): ResolvedDownload {
  return {
    source: 'official',
    url: picked.url,
    filename: picked.name,
    size: picked.size,
    version,
    releasePageUrl: page,
  };
}

async function resolveBlender(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://download.blender.org/release/';
  const root = await fetchText(base);
  const dirs = hrefs(root.body)
    .map((h) => h.match(/^Blender(\d+\.\d+)\/$/i)?.[1])
    .filter((v): v is string => !!v);
  const latest = newestVersion(dirs);
  if (!latest) return null;
  const dirPage = await fetchText(`${base}Blender${latest}/`);
  const files = hrefs(dirPage.body)
    .filter((h) => new RegExp(`^blender-${latest}\\.\\d+-(windows-x64\\.msi|windows-arm64\\.msi|macos-arm64\\.dmg|macos-x64\\.dmg|linux-x64\\.tar\\.xz)$`, 'i').test(h))
    .map((h) => ({ name: basename(h), url: `${base}Blender${latest}/${h}` }));
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, versionFromName(picked.name), 'https://www.blender.org/download/');
}

async function resolveKrita(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://download.kde.org/stable/krita/';
  const root = await fetchText(base);
  const dirs = hrefs(root.body)
    .map((h) => h.match(/^(\d[\d.]*)\/$/)?.[1])
    .filter((v): v is string => !!v);
  const latest = newestVersion(dirs);
  if (!latest) return null;
  const dirPage = await fetchText(`${base}${latest}/`);
  const files = hrefs(dirPage.body)
    .filter((h) => new RegExp(`^(krita-x64-${latest}-setup\\.exe|krita-${latest}-signed\\.dmg)$`, 'i').test(h))
    .map((h) => ({ name: basename(h), url: `${base}${latest}/${h}` }));
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, latest, 'https://krita.org/en/download/krita-desktop/');
}

async function resolveKdenlive(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://download.kde.org/stable/kdenlive/';
  const root = await fetchText(base);
  const dirs = hrefs(root.body)
    .map((h) => h.match(/^(\d[\d.]*)\/$/)?.[1])
    .filter((v): v is string => !!v);
  const latest = newestVersion(dirs);
  if (!latest) return null;
  const sub = platform === 'windows' ? 'windows/' : platform === 'mac' ? 'macOS/' : 'linux/';
  const extRe =
    platform === 'windows'
      ? new RegExp(`^kdenlive-${latest}([._][\\d.]+)?(_standalone)?\\.exe$`, 'i')
      : platform === 'mac'
        ? new RegExp(`^kdenlive-${latest}([._][\\d.]+)?-(arm64|x86_64)\\.dmg$`, 'i')
        : new RegExp(`^kdenlive-${latest}([._][\\d.]+)?-x86_64\\.AppImage$`, 'i');
  const dirPage = await fetchText(`${base}${latest}/${sub}`);
  // The standalone Windows build bundles its dependencies: rank it first.
  const files = hrefs(dirPage.body)
    .filter((h) => extRe.test(h))
    .sort((a, b) => Number(/standalone/i.test(b)) - Number(/standalone/i.test(a)))
    .map((h) => ({ name: basename(h), url: `${base}${latest}/${sub}${h}` }));
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, versionFromName(picked.name), 'https://kdenlive.org/download/');
}

async function resolveLibreOffice(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://download.documentfoundation.org/libreoffice/stable/';
  const root = await fetchText(base);
  const dirs = hrefs(root.body)
    .map((h) => h.match(/^(\d+\.\d+\.\d+)\/$/)?.[1])
    .filter((v): v is string => !!v);
  const latest = newestVersion(dirs);
  if (!latest) return null;
  const page = 'https://www.libreoffice.org/download/download-libreoffice/';
  if (platform === 'windows') {
    const dirPage = await fetchText(`${base}${latest}/win/x86_64/`);
    const files = hrefs(dirPage.body)
      .filter((h) => new RegExp(`^LibreOffice_${latest}_Win_x86-64\\.msi$`, 'i').test(h))
      .map((h) => ({ name: basename(h), url: `${base}${latest}/win/x86_64/${h}` }));
    const picked = pickOfficial(files, platform, arch);
    return picked ? official(picked, latest, page) : null;
  }
  if (platform === 'mac') {
    const macDir = arch === 'x86_64' ? 'x86_64' : 'aarch64';
    const dirPage = await fetchText(`${base}${latest}/mac/${macDir}/`);
    const files = hrefs(dirPage.body)
      .filter((h) => new RegExp(`^LibreOffice_${latest}_MacOS_${macDir}\\.dmg$`, 'i').test(h))
      .map((h) => ({ name: basename(h), url: `${base}${latest}/mac/${macDir}/${h}` }));
    const picked = pickOfficial(files, platform, arch);
    return picked ? official(picked, latest, page) : null;
  }
  const linDir = arch === 'aarch64' ? 'aarch64' : 'x86_64';
  const token = linDir === 'aarch64' ? 'aarch64' : 'x86-64';
  const dirPage = await fetchText(`${base}${latest}/deb/${linDir}/`);
  const files = hrefs(dirPage.body)
    .filter((h) => new RegExp(`^LibreOffice_${latest}_Linux_${token}_deb\\.tar\\.gz$`, 'i').test(h))
    .map((h) => ({ name: basename(h), url: `${base}${latest}/deb/${linDir}/${h}` }));
  const picked = pickOfficial(files, platform, arch);
  return picked ? official(picked, latest, page) : null;
}

/** Inkscape publishes hashed URLs on its own CDN with a JS-rendered release
 * page. The Windows installer URL is published, with a stable path, in
 * Microsoft's winget community manifests (the manifests point at the
 * vendor's own CDN - this only discovers the current hashed path). */
async function resolveInkscape(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const entries = await fetchJson<{ name: string; type: string }[]>(
    'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/i/Inkscape/Inkscape'
  );
  const versions = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.type === 'dir' && parseVersion(e.name))
    .map((e) => e.name);
  const latest = newestVersion(versions);
  if (!latest) return null;
  const yamlResp = await fetchText(
    `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/i/Inkscape/Inkscape/${latest}/Inkscape.Inkscape.installer.yaml`
  );
  const files = parseWingetInstallers(yamlResp.body);
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, latest, 'https://inkscape.org/release/');
}

/** Pulls (Architecture, InstallerUrl) pairs out of a winget installer YAML. */
export function parseWingetInstallers(yaml: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  let lastArch = '';
  for (const line of yaml.split('\n')) {
    const arch = line.match(/^\s*-?\s*Architecture:\s*(\S+)/);
    if (arch) {
      lastArch = arch[1];
      continue;
    }
    const url = line.match(/^\s*-?\s*InstallerUrl:\s*(\S+)/);
    if (url) {
      const name = basename(url[1]);
      if (lastArch && name) out.push({ name, url: url[1] });
      lastArch = '';
    }
  }
  return out;
}

async function resolveZotero(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const param =
    platform === 'windows' ? (arch === 'aarch64' ? 'win-arm64' : 'win-x64') : platform === 'mac' ? 'mac' : 'linux-x86_64';
  const r = await fetchRedirectTarget(
    `https://www.zotero.org/download/client/dl?channel=release&platform=${param}`
  );
  if (!/\/client\/release\/\d+(\.\d+)+\//.test(r.finalUrl)) return null;
  const name = basename(r.finalUrl);
  if (!assetCompatibleWithDevice(name, platform, arch)) return null;
  return {
    source: 'official',
    url: r.finalUrl,
    filename: name,
    size: r.contentLength ?? 0,
    version: r.finalUrl.match(/\/client\/release\/(\d+(?:\.\d+)+)\//)?.[1] ?? '',
    releasePageUrl: 'https://www.zotero.org/download/',
  };
}

/** Parses Signal's electron-updater YAML feeds (version + file list). */
export function parseSignalYml(yaml: string): { version: string; files: { url: string; size: number }[] } {
  const version = yaml.match(/^version:\s*(\S+)/m)?.[1] ?? '';
  const files: { url: string; size: number }[] = [];
  const blocks = yaml.split(/^\s*- url:\s*/m).slice(1);
  for (const b of blocks) {
    const url = b.match(/^(\S+)/)?.[1];
    if (!url) continue;
    const size = Number(b.match(/^\s*size:\s*(\d+)/m)?.[1] ?? 0);
    files.push({ url, size });
  }
  return { version, files };
}

async function resolveSignalAndroid(_app: AppItem): Promise<ResolvedDownload | null> {
  const d = await fetchJson<{ url?: string; versionName?: string }>('https://updates.signal.org/android/latest.json');
  if (!d.url) return null;
  return {
    source: 'official',
    url: d.url,
    filename: basename(d.url),
    size: 0,
    version: d.versionName ?? '',
    releasePageUrl: 'https://signal.org/android/apk/',
  };
}

/** Tor's per-platform update manifests name the exact current bundle.
 * Keys are "<platform>|<getHostArch() value>" - on Android the host arch
 * string ("aarch64") differs from the device ABI name ("arm64"), which once
 * made every Android lookup miss its manifest. */
export const TOR_MANIFESTS: Record<string, string> = {
  'windows|x86_64': 'download-windows-x86_64.json',
  'windows|aarch64': 'download-windows-x86_64.json',
  'windows|unknown': 'download-windows-x86_64.json',
  'windows|x86': 'download-windows-i686.json',
  'mac|aarch64': 'download-macos.json',
  'mac|x86_64': 'download-macos.json',
  'mac|unknown': 'download-macos.json',
  'mac|x86': 'download-macos.json',
  'linux|x86_64': 'download-linux-x86_64.json',
  'linux|unknown': 'download-linux-x86_64.json',
  'linux|aarch64': 'download-linux-aarch64.json',
  'linux|x86': 'download-linux-i686.json',
  'android|aarch64': 'download-android-aarch64.json',
  'android|arm64': 'download-android-aarch64.json',
  'android|arm': 'download-android-armv7.json',
  'android|x86_64': 'download-android-x86_64.json',
  'android|x86': 'download-android-x86.json',
};

async function resolveTor(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const manifest = TOR_MANIFESTS[`${platform}|${arch ?? 'unknown'}`];
  if (!manifest) return null;
  const d = await fetchJson<{ binary?: string; version?: string }>(
    `https://aus1.torproject.org/torbrowser/update_3/release/${manifest}`
  );
  if (!d.binary) return null;
  const name = basename(d.binary);
  if (!assetCompatibleWithDevice(name, platform, arch)) return null;
  return {
    source: 'official',
    url: d.binary,
    filename: name,
    size: 0,
    version: d.version ?? '',
    releasePageUrl: 'https://www.torproject.org/download/',
  };
}

/** Picks the STABLE channel out of Proton's version.json manifests. */
export function pickProtonStable(json: string): { version: string; files: { identifier: string; url: string }[] } | null {
  let d: { Releases?: { CategoryName?: string; Version?: string; File?: { Identifier?: string; Url?: string }[] }[] };
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  const releases = Array.isArray(d.Releases) ? d.Releases : [];
  const stable = releases.find((r) => r.CategoryName === 'Stable') ?? releases[0];
  if (!stable?.Version) return null;
  const files = (stable.File ?? [])
    .filter((f) => f.Url)
    .map((f) => ({ identifier: f.Identifier ?? '', url: f.Url as string }));
  return { version: stable.Version, files };
}

async function resolveProtonMail(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const os = platform === 'windows' ? 'windows' : platform === 'mac' ? 'macos' : 'linux';
  const r = await fetchText(`https://proton.me/download/mail/${os}/version.json`);
  const parsed = pickProtonStable(r.body);
  if (!parsed) return null;
  const files = parsed.files.map((f) => ({ name: basename(f.url), url: f.url }));
  const wanted =
    platform === 'windows'
      ? files.filter((f) => f.name.endsWith('.exe'))
      : platform === 'mac'
        ? files.filter((f) => f.name.endsWith('.dmg'))
        : files.filter((f) => f.name.endsWith('.deb') || f.name.endsWith('.rpm'));
  const picked = pickOfficial(wanted, platform, arch);
  if (!picked) return null;
  return official(picked, parsed.version, 'https://proton.me/mail/download');
}

async function resolveNextcloud(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://download.nextcloud.com/desktop/releases/';
  const page = 'https://nextcloud.com/install/';
  if (platform === 'windows') {
    const r = await fetchText(`${base}Windows/`);
    const files = hrefs(r.body)
      .map((h) => h.match(/^Nextcloud-(\d+\.\d+\.\d+)(-x64)?\.msi$/i)?.[0])
      .filter((v): v is string => !!v)
      .map((h) => ({ name: basename(h), url: `${base}Windows/${h.replace(/ /g, '%20')}` }));
    const byName = files
      .map((f) => ({ f, v: f.name.match(/Nextcloud-(\d+\.\d+\.\d+)/i)?.[1] ?? '' }))
      .filter((x) => x.v);
    const latest = newestVersion(byName.map((x) => x.v));
    if (!latest) return null;
    const picked = pickOfficial(byName.filter((x) => x.v === latest).map((x) => x.f), platform, arch);
    return picked ? official(picked, latest, page) : null;
  }
  if (platform === 'mac') {
    const r = await fetchText(`${base}Mac/Installer/`);
    const files = hrefs(r.body)
      .map((h) => h.match(/^Nextcloud-(\d+\.\d+\.\d+(\.\d+)?)\.pkg$/i)?.[0])
      .filter((v): v is string => !!v)
      .map((h) => ({ name: basename(h), url: `${base}Mac/Installer/${h.replace(/ /g, '%20')}` }));
    const latest = newestVersion(
      files.map((f) => f.name.match(/Nextcloud-([\d.]+)\.pkg/i)?.[1] ?? '')
    );
    if (!latest) return null;
    const picked = pickOfficial(files.filter((f) => f.name.includes(`-${latest}.pkg`)), platform, arch);
    return picked ? official(picked, latest, page) : null;
  }
  const r = await fetchText(`${base}Linux/`);
  const files = hrefs(r.body)
    .map((h) => h.match(/^Nextcloud-(\d+\.\d+\.\d+)-x86_64\.AppImage$/i)?.[0])
    .filter((v): v is string => !!v)
    .map((h) => ({ name: basename(h), url: `${base}Linux/${h.replace(/ /g, '%20')}` }));
  const latest = newestVersion(
    files.map((f) => f.name.match(/Nextcloud-([\d.]+)-x86_64/i)?.[1] ?? '')
  );
  if (!latest) return null;
  const picked = pickOfficial(files.filter((f) => f.name.includes(`-${latest}-x86_64`)), platform, arch);
  return picked ? official(picked, latest, page) : null;
}

async function resolveElement(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const base = 'https://packages.element.io/desktop/install/';
  const page = 'https://element.io/download';
  if (platform === 'windows') {
    // Element serves one directory per arch; the unversioned "Element
    // Setup.exe" inside is always the current release.
    const dir = arch === 'aarch64' ? 'arm64' : arch === 'x86' || arch === 'i686' ? 'ia32' : 'x64';
    const r = await fetchText(`${base}win32/${dir}/index.html`);
    const links = hrefs(r.body);
    const unversioned = links.find((h) => /^Element Setup\.exe$/i.test(h));
    const versioned = links
      .map((h) => h.match(/^Element Setup (\d+\.\d+\.\d+)\.exe$/i))
      .filter((m): m is RegExpMatchArray => !!m);
    if (unversioned) {
      const url = `${base}win32/${dir}/${encodeURIComponent(unversioned)}`;
      return official({ name: basename(url), url, size: 0 }, versionFromName(unversioned), page);
    }
    const latest = newestVersion(versioned.map((m) => m[1]));
    if (!latest) return null;
    const href = versioned.find((m) => m[1] === latest)?.[0];
    if (!href) return null;
    const url = `${base}win32/${dir}/${encodeURIComponent(href)}`;
    return official({ name: basename(url), url, size: 0 }, latest, page);
  }
  const r = await fetchText(`${base}macos/index.html`);
  const links = hrefs(r.body);
  const unversioned = links.find((h) => /^Element\.dmg$/i.test(h));
  const versioned = links
    .map((h) => h.match(/^Element-(\d+\.\d+\.\d+)-universal\.dmg$/i))
    .filter((m): m is RegExpMatchArray => !!m);
  if (unversioned) {
    const url = `${base}macos/${encodeURIComponent(unversioned)}`;
    return official({ name: basename(url), url, size: 0 }, versionFromName(unversioned), page);
  }
  const latest = newestVersion(versioned.map((m) => m[1]));
  if (!latest) return null;
  const href = versioned.find((m) => m[1] === latest)?.[0];
  if (!href) return null;
  const url = `${base}macos/${encodeURIComponent(href)}`;
  return official({ name: basename(url), url, size: 0 }, latest, page);
}

async function resolveLibrewolf(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const api =
    'https://gitlab.com/api/v4/projects/librewolf-community%2Fbrowser%2Fbsys6/releases?per_page=5';
  const list = await fetchJson<{
    tag_name?: string;
    released_at?: string;
    assets?: { links?: { name?: string; direct_asset_url?: string; url?: string }[] };
  }[]>(api);
  const rel = Array.isArray(list) ? list[0] : null;
  const links = rel?.assets?.links ?? [];
  const files = links
    .filter((l) => (l.direct_asset_url || l.url) && l.name)
    .map((l) => ({ name: l.name as string, url: (l.direct_asset_url || l.url) as string }));
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, (rel?.tag_name ?? '').replace(/^v/, ''), 'https://librewolf.net/install/');
}

async function resolveSumatra(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const r = await fetchText('https://www.sumatrapdfreader.org/download-free-pdf-viewer');
  const links = hrefs(r.body)
    .map((h) => h.match(/^\/dl\/rel\/([\d.]+)\/(SumatraPDF-[\d.]+(?:-64|-arm64)?)-install\.exe$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ version: m[1], variant: (m[2] as string).toLowerCase(), href: m[0] }));
  if (!links.length) return null;
  const latest = newestVersion(links.map((l) => l.version));
  const candidates = links.filter((l) => l.version === latest);
  const variant = arch === 'aarch64' ? '-arm64' : arch === 'x86' || arch === 'i686' ? '' : '-64';
  const chosen =
    candidates.find((c) => c.variant === `sumatrapdf-${latest}${variant}`) ||
    candidates.find((c) => c.variant.endsWith(variant)) ||
    candidates.find((c) => !/-64|-arm64/.test(c.variant));
  if (!chosen) return null;
  const url = `https://www.sumatrapdfreader.org${chosen.href}`;
  const name = basename(url);
  if (!assetCompatibleWithDevice(name, platform, arch)) return null;
  return official({ name, url, size: 0 }, latest, 'https://www.sumatrapdfreader.org/download-free-pdf-viewer');
}

async function resolveGimp(platform: Platform, arch: string | undefined, _app: AppItem): Promise<ResolvedDownload | null> {
  const d = await fetchJson<{ STABLE?: { version?: string; windows?: { filename?: string }[]; macos?: { filename?: string }[] }[] }>(
    'https://www.gimp.org/gimp_versions.json'
  );
  const stable = d.STABLE?.[0];
  if (!stable?.version) return null;
  const majMin = stable.version.split('.').slice(0, 2).join('.');
  const base = `https://download.gimp.org/gimp/v${majMin}/${platform === 'windows' ? 'windows' : 'macos'}/`;
  const names =
    platform === 'windows'
      ? (stable.windows ?? []).map((w) => w.filename).filter((n): n is string => !!n)
      : (stable.macos ?? []).map((w) => w.filename).filter((n): n is string => !!n);
  const files = names.map((n) => ({ name: n, url: base + n }));
  const picked = pickOfficial(files, platform, arch);
  if (!picked) return null;
  return official(picked, stable.version, 'https://www.gimp.org/downloads/');
}

/* ------------------------------------------------------------------ */
/* Public API (cached)                                                 */
/* ------------------------------------------------------------------ */

const officialCache = new Map<string, Promise<ResolvedDownload | null>>();

/** True when the catalog knows an official (non-GitHub) resolver for this
 * app and platform. The detail modal uses this to decide whether to even
 * show the "checking the official source" row. */
export function officialSupported(app: AppItem, platform: Platform): boolean {
  return !!resolvers[app.id]?.[platform];
}

export function resolveOfficialDownload(app: AppItem, platform: Platform): Promise<ResolvedDownload | null> {
  if (!officialSupported(app, platform)) return Promise.resolve(null);
  const key = `official|${app.id}|${platform}`;
  if (!officialCache.has(key)) {
    const p = (async () => {
      try {
        const arch = await getHostArch();
        const persistKey = `${key}|${arch ?? 'u'}`;
        const cached = loadPersisted(persistKey);
        if (cached !== undefined) return cached;
        const hit = await resolvers[app.id]![platform]!(app, arch);
        persist(persistKey, hit);
        return hit;
      } catch {
        return null;
      }
    })();
    officialCache.set(key, p);
    p.then((r) => {
      if (r === null) {
        globalThis.setTimeout(() => {
          if (officialCache.get(key) === p) officialCache.delete(key);
        }, 30_000);
      }
    });
  }
  return officialCache.get(key)!;
}
