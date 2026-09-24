// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
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

  // Generic fallbacks, deduplicated. The OFFICIAL download page comes
  // before the forge releases page: for a beginner "the project's own
  // download page with a big green button" beats "a releases page full of
  // build artifacts" - and for apps whose GitHub repo is only one platform
  // (e.g. an Android-only repo next to a desktop app) the releases page
  // would not even carry the user's platform. The forge page is skipped
  // entirely when the curated table already covers this platform: for
  // projects like Tor Browser the primary repo is a launcher/mirror whose
  // Releases page holds no installers, and a dead "GitHub Releases" link
  // next to the real official targets only confuses.
  if (app.downloadUrl && !options.some((o) => o.url === app.downloadUrl)) {
    options.push({ kind: 'page', label: 'Official download page', url: app.downloadUrl });
  }

  if (app.githubUrl && curated.length === 0) {
    // The primary repo may live on GitLab (LibreWolf builds there), so the
    // label and the releases path follow the forge instead of assuming
    // GitHub. GitLab exposes releases under /-/releases.
    const onGitlab = /gitlab/.test(app.githubUrl);
    const base = app.githubUrl.replace(/\/+$/, '');
    const releases = onGitlab ? `${base}/-/releases` : `${base}/releases`;
    if (!options.some((o) => o.url === releases)) {
      options.push({
        kind: 'page',
        label: onGitlab ? 'GitLab Releases' : 'GitHub Releases',
        url: releases,
        note: 'Official builds and changelogs',
      });
    }
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
    android: [
      { kind: 'page', label: 'Signal APK (sideload)', url: 'https://signal.org/android/apk/', note: 'Direct APK, no Play Services needed' },
      { kind: 'page', label: 'Signal on Google Play', url: 'https://play.google.com/store/apps/details?id=org.thoughtcrime.securesms' },
    ],
    ios: [{ kind: 'store', label: 'Signal on the App Store', url: 'https://apps.apple.com/app/signal-private-messenger/id874139669' }],
  },
  'f-droid': {
    android: [{ kind: 'direct', label: 'F-Droid .apk (direct)', url: 'https://f-droid.org/F-Droid.apk', note: 'Official client installer' }],
  },
  bitwarden: {
    // The desktop installers live on the bitwarden/clients repo under
    // desktop-v* tags, which a single githubUrl cannot reach; these vault
    // aliases always redirect to the current release (verified: exe, dmg,
    // AppImage).
    windows: [{ kind: 'direct', label: 'Bitwarden for Windows', url: 'https://vault.bitwarden.com/download/?app=desktop&platform=windows', note: 'Official installer, always the current release' }],
    mac: [{ kind: 'direct', label: 'Bitwarden for macOS', url: 'https://vault.bitwarden.com/download/?app=desktop&platform=macos', note: 'Universal .dmg, always the current release' }],
    linux: [{ kind: 'direct', label: 'Bitwarden for Linux', url: 'https://vault.bitwarden.com/download/?app=desktop&platform=linux', note: 'AppImage, always the current release' }],
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
      ? 'No iOS build; this app ships for Android and desktop'
      : 'No iOS build of this app';
  }
  if (platform === 'android') {
    return 'No Android build; check the desktop or web options';
  }
  return `No ${PLATFORM_LABELS[platform]} build; the app ships for: ${app.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}`;
}
