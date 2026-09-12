import { translate } from './i18n';
import { AppItem, Platform } from '../types';

export type DownloadKind = 'direct' | 'page' | 'store' | 'package';

export interface DownloadOption {
  kind: DownloadKind;
  label: string;
  url: string;
  note?: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
};

/** Human label for a repo-hosted releases page, derived from the actual host. */
function repoReleasesLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'github.com') return 'GitHub Releases';
    if (host === 'gitlab.com') return 'GitLab Releases';
    return `Releases on ${host}`;
  } catch {
    return 'Official releases';
  }
}

/**
 * Resolves what "Download" means for an app on a specific platform.
 * Order: curated direct links first, then official pages.
 * Direct = streamed through the Fress download manager with progress.
 * Page   = opens the official download page in the system browser.
 */
export function getDownloadOptions(app: AppItem, platform: Platform): DownloadOption[] {
  const options: DownloadOption[] = [];
  const curated = CURATED[app.id]?.[platform] || [];

  for (const c of curated) {
    options.push(c);
  }

  // Generic fallbacks, deduplicated. The label comes from the real host so a
  // GitLab-hosted project (e.g. VLC) is never mislabeled as "GitHub Releases".
  if (app.githubUrl) {
    const releases = `${app.githubUrl.replace(/\/+$/, '')}/releases`;
    if (!options.some((o) => o.url === releases)) {
      options.push({
        kind: 'page',
        label: repoReleasesLabel(releases),
        url: releases,
        note: 'Official builds and changelogs',
      });
    }
  }

  if (app.downloadUrl && !options.some((o) => o.url === app.downloadUrl)) {
    options.push({ kind: 'page', label: 'Official download page', url: app.downloadUrl });
  }

  if (options.length === 0 && app.websiteUrl) {
    options.push({ kind: 'page', label: 'Official website', url: app.websiteUrl });
  }

  return options;
}

export function bestDownloadFor(app: AppItem, platform: Platform): DownloadOption | null {
  const options = getDownloadOptions(app, platform);
  return options.find((o) => o.kind === 'direct') || options[0] || null;
}

interface CuratedEntry {
  [platform: string]: DownloadOption[];
}

/**
 * Hand-verified download targets for flagship apps.
 * Only links that are stable (do not embed a version number) are marked direct.
 */
const CURATED: Record<string, CuratedEntry> = {
  vlc: {
    windows: [
      { kind: 'page', label: 'VLC for Windows', url: 'https://www.videolan.org/vlc/download-windows.html', note: 'Installer, x86_64 and ARM' },
    ],
    mac: [{ kind: 'page', label: 'VLC for macOS', url: 'https://www.videolan.org/vlc/download-macosx.html', note: 'Universal .dmg' }],
    linux: [{ kind: 'page', label: 'VLC for Linux', url: 'https://www.videolan.org/vlc/#download', note: 'Packages, snaps and flatpaks per distribution' }],
    android: [{ kind: 'page', label: 'VLC on Google Play', url: 'https://play.google.com/store/apps/details?id=org.videolan.vlc' }],
    ios: [{ kind: 'store', label: 'VLC on the App Store', url: 'https://apps.apple.com/app/vlc-media-player/id6503779629' }],
  },
  localsend: {
    windows: [{ kind: 'page', label: 'Download .exe from GitHub', url: 'https://github.com/localsend/localsend/releases/latest' }],
    android: [{ kind: 'page', label: 'Get the .apk', url: 'https://github.com/localsend/localsend/releases/latest', note: 'Pick the .apk asset' }],
  },
  'obs-studio': {
    windows: [{ kind: 'page', label: 'Windows installer', url: 'https://obsproject.com/download' }],
    mac: [{ kind: 'page', label: 'macOS installer', url: 'https://obsproject.com/download' }],
    linux: [{ kind: 'page', label: 'Linux builds', url: 'https://obsproject.com/download' }],
  },
  gimp: {
    windows: [{ kind: 'page', label: 'Windows installer', url: 'https://www.gimp.org/downloads/' }],
    mac: [{ kind: 'page', label: 'macOS installer', url: 'https://www.gimp.org/downloads/' }],
    linux: [{ kind: 'page', label: 'Linux packages', url: 'https://www.gimp.org/downloads/' }],
  },
  'tor-browser': {
    windows: [{ kind: 'page', label: 'Windows bundle', url: 'https://www.torproject.org/download/' }],
    mac: [{ kind: 'page', label: 'macOS bundle', url: 'https://www.torproject.org/download/' }],
    linux: [{ kind: 'page', label: 'Linux bundle', url: 'https://www.torproject.org/download/' }],
    android: [{ kind: 'page', label: 'Tor Browser for Android', url: 'https://www.torproject.org/download/#android', note: 'Direct .apk links on the page' }],
  },
  qbittorrent: {
    windows: [{ kind: 'page', label: 'Windows installer', url: 'https://www.qbittorrent.org/download' }],
    mac: [{ kind: 'page', label: 'macOS installer', url: 'https://www.qbittorrent.org/download' }],
    linux: [{ kind: 'page', label: 'Linux packages', url: 'https://www.qbittorrent.org/download' }],
  },
  signal: {
    windows: [{ kind: 'page', label: 'Windows installer', url: 'https://signal.org/download/' }],
    mac: [{ kind: 'page', label: 'macOS installer', url: 'https://signal.org/download/' }],
    linux: [{ kind: 'page', label: 'Linux builds', url: 'https://signal.org/download/' }],
    android: [{ kind: 'page', label: 'Signal on Google Play', url: 'https://play.google.com/store/apps/details?id=org.thoughtcrime.securesms' }],
    ios: [{ kind: 'store', label: 'Signal on the App Store', url: 'https://apps.apple.com/app/signal-private-messenger/id874139669' }],
  },
  'f-droid': {
    android: [{ kind: 'direct', label: 'F-Droid .apk (direct)', url: 'https://f-droid.org/F-Droid.apk', note: 'Official client installer' }],
  },
  sumatra: {
    windows: [{ kind: 'page', label: 'Download installer or portable', url: 'https://www.sumatrapdfreader.org/download-free-pdf-viewer' }],
  },
  powertoys: {
    windows: [{ kind: 'page', label: 'Download from GitHub', url: 'https://github.com/microsoft/PowerToys/releases/latest' }],
  },
  '7zip': {
    windows: [{ kind: 'page', label: 'Windows .exe installer', url: 'https://www.7-zip.org/download.html' }],
    linux: [{ kind: 'page', label: 'Linux builds', url: 'https://www.7-zip.org/download.html' }],
  },
  thunderbird: {
    windows: [{ kind: 'direct', label: 'Thunderbird for Windows', url: 'https://download.mozilla.org/?product=thunderbird-latest&os=win64&lang=en-US', note: 'Full installer' }],
    mac: [{ kind: 'direct', label: 'Thunderbird for macOS', url: 'https://download.mozilla.org/?product=thunderbird-latest&os=osx&lang=en-US' }],
    linux: [{ kind: 'direct', label: 'Thunderbird for Linux', url: 'https://download.mozilla.org/?product=thunderbird-latest&os=linux64&lang=en-US' }],
  },
  upscayl: {
    windows: [{ kind: 'page', label: 'Windows installer', url: 'https://github.com/upscayl/upscayl/releases/latest' }],
    mac: [{ kind: 'page', label: 'macOS installer', url: 'https://github.com/upscayl/upscayl/releases/latest' }],
    linux: [{ kind: 'page', label: 'Linux builds', url: 'https://github.com/upscayl/upscayl/releases/latest' }],
  },
  immich: {
    web: [{ kind: 'page', label: 'Self-hosting guide', url: 'https://immich.app/docs/install/script-install' }],
  },
  'home-assistant': {
    web: [{ kind: 'page', label: 'Installation options', url: 'https://www.home-assistant.io/installation/' }],
  },
  newpipe: {
    android: [{ kind: 'page', label: 'Download .apk', url: 'https://newpipe.net/FAQ/tutorials/install-add-f-droid/', note: 'Via F-Droid or GitHub' }],
  },
  termux: {
    android: [{ kind: 'page', label: 'Download .apk (F-Droid)', url: 'https://f-droid.org/en/packages/com.termux/', note: 'Use the F-Droid build, not Play Store' }],
  },
};

/** Human explanation shown when a platform has no build. */
export function platformUnavailableNote(app: AppItem, platform: Platform): string | null {
  if (app.platforms.includes(platform)) return null;
  if (platform === 'ios') {
    return app.platforms.includes('android')
      ? translate('platform.noIOSWithAndroid')
      : translate('platform.noIOS');
  }
  if (platform === 'android') {
    return translate('platform.noAndroid');
  }
  return translate('platform.noBuild')
    .replace('{platform}', PLATFORM_LABELS[platform])
    .replace('{list}', app.platforms.map((p) => PLATFORM_LABELS[p]).join(', '));
}
