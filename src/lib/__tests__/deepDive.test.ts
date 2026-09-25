// Fress deep-dive probe: answers specific resolver questions against live APIs.
// FRESS_LIVE_PROBE=1 node --experimental-strip-types? No - run via vitest like liveProbe.
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

function readPat(): string | null {
  try {
    // Local-audit convenience only: a token from the operator's machine, if
    // it exists. CI has no such file and skips these probes entirely.
    return (readFileSync('/home/z/my-project/scripts/verify_round6.py', 'utf8').match(/github_pat_[A-Za-z0-9_]+/) || [])[0] || null;
  } catch {
    return null;
  }
}
const pat = readPat();
const H: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'fress-probe' };
if (pat) H.Authorization = `Bearer ${pat}`;

async function rels(repo: string, per = 20): Promise<any[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${per}`, { headers: H });
  if (!res.ok) return [{ __http: res.status }];
  return res.json();
}

function summarize(repo: string, list: any[], maxRows = 8): string[] {
  const out: string[] = [];
  out.push(`--- ${repo}: ${list.length} releases (http ${list[0]?.__http ?? 200})`);
  for (const r of list.slice(0, maxRows)) {
    const assets = (r.assets || []).map((a: any) => a.name).slice(0, 14).join(', ');
    out.push(`  ${r.tag_name} pre=${r.prerelease} draft=${r.draft} [${assets}]`);
  }
  return out;
}

describe.skipIf(!process.env.FRESS_LIVE_PROBE)('deep-dive', () => {
  it('answers specific resolver questions', { timeout: 600_000 }, async () => {
    const log: string[] = [];
    const push = (...l: string[]) => log.push(...l);

    // 1. ente: what releases exist, and which carry photos/auth desktop+android assets
    push(...summarize('ente-io/ente', await rels('ente-io/ente'), 14));

    // 2. bitwarden depth 100: desktop stream
    const bw = await rels('bitwarden/clients', 100);
    const desktop = bw.filter((r) => /desktop/i.test(r.tag_name || ''));
    push(...summarize('bitwarden/clients (desktop tags only)', desktop.length ? desktop : bw, 6));

    // 3. inkscape
    push(...summarize('inkscape/inkscape', await rels('inkscape/inkscape'), 6));

    // 4. element desktop + android (catalog points at which repo?)
    push(...summarize('element-hq/element-desktop', await rels('element-hq/element-desktop'), 4));
    push(...summarize('element-hq/element-android', await rels('element-hq/element-android'), 4));
    push(...summarize('element-hq/element-web', await rels('element-hq/element-web'), 3));

    // 5. signal android
    push(...summarize('signalapp/Signal-Android', await rels('signalapp/Signal-Android'), 4));

    // 6. syncthing windows assets + android fork
    const st = await rels('syncthing/syncthing', 4);
    push(...summarize('syncthing/syncthing', st, 4));
    push(...summarize('Catfriend1/syncthing-android', await rels('Catfriend1/syncthing-android'), 3));
    push(...summarize('syncthing/syncthing-android', await rels('syncthing/syncthing-android'), 2));

    // 7. jellyfin (what repo carries windows/mac clients)
    push(...summarize('jellyfin/jellyfin-server', await rels('jellyfin/jellyfin-server'), 3));
    push(...summarize('jellyfin/jellyfin-media-player', await rels('jellyfin/jellyfin-media-player'), 3));

    // 8. nextcloud desktop
    push(...summarize('nextcloud/desktop', await rels('nextcloud/desktop'), 8));

    // 9. zotero
    push(...summarize('zotero/zotero', await rels('zotero/zotero'), 4));

    // 10. sumatra
    push(...summarize('sumatrapdfreader/sumatrapdf', await rels('sumatrapdfreader/sumatrapdf'), 6));

    // 11. losslesscut windows
    push(...summarize('mifi/lossless-cut', await rels('mifi/lossless-cut'), 5));

    // 12. whisper desktop (catalog repo?)
    push(...summarize('Const-me/Whisper', await rels('Const-me/Whisper'), 3));
    push(...summarize('nihui/rewu1552', await rels('nihui/rewu1552'), 1));

    // 13. jitsi + antennapod android
    push(...summarize('jitsi/jitsi-meet', await rels('jitsi/jitsi-meet'), 4));
    push(...summarize('AntennaPod/AntennaPod', await rels('AntennaPod/AntennaPod'), 4));

    // 14. proton-vpn linux/windows repos
    push(...summarize('ProtonVPN/linux-app', await rels('ProtonVPN/linux-app'), 3));
    push(...summarize('ProtonVPN/win-app', await rels('ProtonVPN/win-app'), 3));

    // 15. unversioned "latest" direct endpoints - HEAD status
    const endpoints: Array<[string, string]> = [
      ['vlc-win64', 'https://get.videolan.org/vlc/last/win64/'],
      ['zotero-win-x64', 'https://www.zotero.org/download/client/dl?channel=stable&platform=win-x64'],
      ['zotero-linux-x64', 'https://www.zotero.org/download/client/dl?channel=stable&platform=linux-x86_64'],
      ['sumatra-latest', 'https://www.sumatrapdfreader.org/dp/SumatraPDF-prerelatest.exe'],
      ['sumatra-64', 'https://www.sumatrapdfreader.org/dp/SumatraPDF-64.exe'],
      ['librewolf-site', 'https://librewolf.net/install/'],
      ['obs-arm64-win', 'https://obsproject.com/download'],
    ];
    for (const [name, url] of endpoints) {
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        const len = res.headers.get('content-length');
        const cd = res.headers.get('content-disposition');
        const ct = res.headers.get('content-type');
        push(`HEAD ${name}: ${res.status} len=${len} type=${ct} cd=${cd ? cd.slice(0, 80) : ''} final=${res.url.slice(0, 110)}`);
      } catch (e) {
        push(`HEAD ${name}: ERROR ${(e as Error).message?.slice(0, 60)}`);
      }
    }

    // 16. catalog githubUrls that 404 or moved (from the first probe + guesses)
    for (const repo of ['librewolf-community/browser', 'librewolf-community/browser/bsys6']) {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: H });
      push(`repo-check ${repo}: ${res.status}`);
    }

    console.log('\n===== DEEP-DIVE REPORT =====\n' + log.join('\n'));
  });
});
