import { AppItem } from '../types';
import { bestDownloadFor } from './appDownloads';
import { openExternal } from './external';
import { resolveGitHubDownload, resolveFdroidDownload, guessUserPlatform } from './releaseFetch';
import { translate } from './i18n';
import { toast } from 'sonner';

interface DownloadsApi {
  startDownload: (url: string, nameHint?: string, appRef?: string, expectedSha256?: string) => Promise<boolean> | Promise<void>;
  recordExternalOpen: (name: string, url: string) => void;
}

interface SmartDownloadCallbacks extends Partial<DownloadsApi> {
  onOpenDetail?: (app: AppItem) => void;
  /** Receives the app id while a release lookup is in flight (null when done). */
  onResolving?: (id: string | null) => void;
}

/**
 * The one shared "download this app for my device" flow, used by the card
 * button and the table view: live-resolve the latest stable GitHub asset,
 * fall back to F-Droid, then to curated targets, and finally open the
 * in-app guide with a clear explanation instead of dumping a releases page.
 */
export async function startDownloadSmart(app: AppItem, callbacks: SmartDownloadCallbacks = {}): Promise<void> {
  const { onOpenDetail, onResolving, startDownload, recordExternalOpen } = callbacks;
  const platform = guessUserPlatform(app);
  onResolving?.(app.id);
  try {
    // 1) Latest STABLE file for this platform from GitHub Releases
    const resolved = await resolveGitHubDownload(app, platform);
    if (resolved) {
      void startDownload?.(resolved.url, resolved.filename, app.id, resolved.sha256);
      return;
    }
    // 2) Android: try the app's F-Droid package next
    if (platform === 'android' && app.fdroidId) {
      const fd = await resolveFdroidDownload(app.fdroidId);
      if (fd) {
        void startDownload?.(fd.url, fd.filename, app.id);
        return;
      }
    }
    // 3) Curated targets
    const target = bestDownloadFor(app, platform);
    if (!target) {
      toast.info(translate('toast.chooseDownload'), { description: app.name });
      onOpenDetail?.(app);
      return;
    }
    if (target.kind === 'direct') {
      // No filename hint: the server's Content-Disposition gives the real,
      // extension-carrying name (labels like "Thunderbird for Windows" would
      // otherwise become a broken extensionless file).
      void startDownload?.(target.url, undefined, app.id);
    } else if (target.kind === 'store' || !/github\.com\/[^/]+\/[^/]+\/releases/i.test(target.url)) {
      // Official vendor pages are beginner-friendly; open them in the browser
      recordExternalOpen?.(`${app.name}: ${target.label}`, target.url);
      toast.info(translate('toast.openingOfficialPage').replace('{name}', app.name), {
        description: target.label,
      });
      void openExternal(target.url);
    } else {
      // A raw releases page is not beginner-friendly: open the in-app guide
      toast.info(translate('toast.chooseDownload'), { description: app.name });
      onOpenDetail?.(app);
    }
  } finally {
    onResolving?.(null);
  }
}
