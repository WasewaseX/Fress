// Live download audit: runs the REAL resolver (releaseFetch.ts) against REAL
// upstream releases for every catalog app and platform, including the
// curated-direct fallback the app itself uses. Read-only; exits 0.
//
// Two modes, because getHostArch() is process-wide:
//   default          -> desktop rows, unknown host arch (a browser view)
//   AUDIT_ANDROID=1  -> android rows with a real arm64 phone user agent
//
// Usage: GITHUB_TOKEN=xxx npx tsx scripts/audit-downloads.ts
const androidMode = process.env.AUDIT_ANDROID === '1';
if (androidMode) {
  // Node ships its own navigator ("Node.js/24") as a getter-only global;
  // replace it so getHostArch() resolves aarch64 like a real phone.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 16; aarch64; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    },
    configurable: true,
    writable: true,
  });
}

const { INITIAL_APPS } = await import('../src/data/appsData');
const { resolveDownloadFor } = await import('../src/lib/releaseFetch');
const { bestDownloadFor } = await import('../src/lib/appDownloads');

const TOKEN = process.env.GITHUB_TOKEN || '';
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = { ...(init?.headers || {}) } as Record<string, string>;
  if (url.startsWith('https://api.github.com') && TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
    headers['User-Agent'] = 'fress-download-audit';
  }
  return realFetch(input, { ...init, headers });
}) as typeof fetch;

async function main() {
  const rows: string[] = [];
  for (const app of INITIAL_APPS) {
    for (const platform of app.platforms) {
      if (androidMode !== (platform === 'android')) continue;
      if (platform === 'web' || platform === 'ios') continue;
      let outcome = '';
      try {
        const r = await resolveDownloadFor(app, platform);
        if (r) {
          const src = r.source === 'fdroid' ? 'FDROID ' : r.weak ? 'WEAK ' : 'OK   ';
          outcome = `${src}${r.filename}`;
        }
      } catch (e) {
        outcome = `ERR ${(e as Error).message}`;
      }
      if (!outcome) {
        // Same fallback the batch downloader uses: a curated DIRECT link
        // still counts as a real download; a package channel (Flatpak repo
        // for apps with no upstream binary) is the official install path;
        // a page means "opens in browser".
        const target = bestDownloadFor(app, platform);
        if (target?.kind === 'direct') outcome = 'CURATED-DIRECT ' + target.url;
        else if (target?.kind === 'package') outcome = 'PACKAGE ' + target.url;
        else outcome = 'SKIP';
      }
      rows.push(`${app.id.padEnd(24)} ${platform.padEnd(8)} ${outcome}`);
    }
  }
  console.log(rows.join('\n'));
  const skips = rows.filter((r) => r.includes('SKIP'));
  const packages = rows.filter((r) => r.includes('PACKAGE'));
  console.log(`\n== ${rows.length} rows, ${skips.length} skips, ${packages.length} package-channel rows ==`);
}

main();
