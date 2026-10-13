// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useEffect, useState, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { AppItem, Platform } from '../types';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Github,
  Gitlab,
  Code2,
  Terminal,
  ShieldCheck,
  Smartphone,
  Edit2,
  Download,
  MonitorSmartphone,
  Loader2,
  Play,
  AlertTriangle,
  RotateCcw
} from 'lucide-react';
import { getDownloadOptions, platformUnavailableNote, DownloadOption } from '../lib/appDownloads';
import { officialSupported, resolveOfficialDownload } from '../lib/officialResolvers';
import { useDownloadActions, formatBytes } from '../lib/downloads';
import { openExternal } from '../lib/external';
import {
  resolveGitHubDownload,
  resolveFdroidDownload,
  parseGithubRepo,
  fdroidPageUrl,
  playStoreUrl,
  githubFetchSupported,
  peekResolveError,
  ResolvedDownload,
} from '../lib/releaseFetch';
// The agreed retry seam: the dialog NEVER touches resolver caches itself;
// what a retry does (including evicting the failed memo entry) is resolver-
// side code behind this interface. See src/lib/resolveRetry.ts.
import { resolverRetry } from '../lib/resolveRetry';
import { useI18n, CATEGORY_I18N_KEYS, translateLicenseDisplay } from '../lib/i18n';
import { useAppText } from '../lib/appText';
import { useLiveStars } from '../lib/starFetch';
import { sourceLinksFor, SourceLink } from '../lib/sourceLinks';
import { AppIcon } from './AppCard';
import { toast } from 'sonner';

/** Forge icon for source links. A module-level component: the previous
 *  inline definition was re-created per render, remounting every rendered
 *  icon (the file's own rule for renderCopyChip applies here too). */
const SourceIcon = ({ kind }: { kind: SourceLink['kind'] }) =>
  kind === 'github' ? <Github className="w-3.5 h-3.5" aria-hidden="true" /> : kind === 'gitlab' ? <Gitlab className="w-3.5 h-3.5" aria-hidden="true" /> : <Code2 className="w-3.5 h-3.5" aria-hidden="true" />;

function detectUserPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

/**
 * Lifecycle of one automatic download lookup.
 *
 * 'ready'  - a file was resolved (possibly weak-flagged; see ResolvedDownload).
 * 'none'   - the resolver ANSWERED: no automatic installer exists for this
 *            platform right now. An honest result, not a failure - the
 *            official-page fallbacks below are the intended path.
 * 'error'  - the lookup itself failed (rate limit, network, unexpected
 *            response). Retrying is meaningful; a bare 'none' would lie
 *            about the app while the truth is about the network.
 * 'loading' - a request is in flight. Rejections always land in 'error' -
 *            no lookup may stay loading forever.
 */
type ResolveState = 'loading' | 'ready' | 'none' | 'error';

/** Why a lookup failed, when the reason changes what the UI should say. */
type ResolveFailure = 'rate-limit' | 'network';

/**
 * Generic download-option labels from the per-app data (src/lib/appDownloads.ts)
 * translated at RENDER time: the data file stays untouched (labels are its
 * identifiers - the fallback-row filter compares against them), while the
 * words the user reads follow the active language. Product-specific labels
 * ("Thunderbird for Windows", "Signal on Google Play") go through the
 * forPlatform/onStore templates so the product proper noun stays and only
 * the glue word translates; anything unmatched falls through unchanged.
 */
const DOWNLOAD_LABEL_KEYS: Record<string, string> = {
  'Official download page': 'detail.dl.officialPage',
  'Official website': 'detail.dl.officialWebsite',
  'GitLab Releases': 'detail.dl.gitlabReleases',
  'Windows installer': 'detail.dl.windowsInstaller',
  'macOS installer': 'detail.dl.macInstaller',
  'Linux builds': 'detail.dl.linuxBuilds',
  'Linux packages': 'detail.dl.linuxPackages',
  'Windows bundle': 'detail.dl.windowsBundle',
  'macOS bundle': 'detail.dl.macBundle',
  'Linux bundle': 'detail.dl.linuxBundle',
  'Install via Flatpak (official build)': 'detail.dl.flatpakOfficial',
  'Windows .exe installer': 'detail.dl.windowsExeInstaller',
  'Official macOS installer page': 'detail.dl.macInstallerPage',
  'Download .exe from GitHub': 'detail.dl.exeFromGithub',
  'Get the .apk': 'detail.dl.getApk',
  'Download .apk': 'detail.dl.downloadApk',
  'Download .apk (F-Droid)': 'detail.dl.downloadApkFdroid',
  'F-Droid .apk (direct)': 'detail.dl.fdroidApkDirect',
  'Download from GitHub': 'detail.dl.fromGithub',
  'Download installer or portable': 'detail.dl.installerOrPortable',
  'Installation options': 'detail.dl.installationOptions',
  'Self-hosting guide': 'detail.dl.selfHostingGuide',
  'Signal APK (sideload)': 'detail.dl.signalSideload',
};
const PRODUCT_PLACE_RE = /^(.+?) (?:for|on) (?:the )?(Windows|macOS|Linux|Android|App Store|Google Play)$/;

function translateDownloadLabel(t: (key: string) => string, label: string): string {
  const generic = DOWNLOAD_LABEL_KEYS[label];
  if (generic) return t(generic);
  const m = PRODUCT_PLACE_RE.exec(label);
  if (m) {
    const [, product, place] = m;
    const template = place === 'App Store' || place === 'Google Play'
      ? t('detail.dl.onStore')
      : t('detail.dl.forPlatform');
    return template
      .replace('{product}', product)
      .replace('{store}', place)
      .replace('{platform}', place);
  }
  if (label.endsWith(' public instance')) {
    return t('detail.dl.publicInstance').replace('{product}', label.replace(/ public instance$/, ''));
  }
  return label;
}

const DownloadSection: React.FC<{ app: AppItem }> = ({ app }) => {
  const { startDownload, recordExternalOpen } = useDownloadActions();
  const { t } = useI18n();
  const tx = useAppText(app);
  const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  // Re-entry guard for the transfer start itself: startDownload has no
  // per-URL dedupe, so a rapid double-click used to enqueue the SAME file
  // twice. Repeat clicks of the same URL inside a short window are
  // ignored; different targets stay independently clickable.
  const lastLaunchRef = useRef<{ url: string; at: number } | null>(null);
  const launchDownload = (url: string, name: string, opts?: { expectedSha256?: string; expectedSha512?: string }) => {
    const now = Date.now();
    if (lastLaunchRef.current && lastLaunchRef.current.url === url && now - lastLaunchRef.current.at < 1500) return;
    lastLaunchRef.current = { url, at: now };
    void startDownload(url, name, opts);
  };
  const preferred = (() => {
    const guess = detectUserPlatform();
    return app.platforms.includes(guess) ? guess : (app.platforms[0] || 'windows');
  })();
  const [platform, setPlatform] = useState<Platform>(preferred);
  const options = getDownloadOptions(app, platform);
  const unavailable = platformUnavailableNote(app, platform);

  const [gh, setGh] = useState<ResolvedDownload | null>(null);
  const [ghState, setGhState] = useState<ResolveState>('loading');
  const [ghErr, setGhErr] = useState<ResolveFailure | null>(null);
  const [fd, setFd] = useState<ResolvedDownload | null>(null);
  const [fdState, setFdState] = useState<ResolveState>('loading');
  const [fdErr, setFdErr] = useState<ResolveFailure | null>(null);

  const wantGh = !unavailable && githubFetchSupported(platform) && !!parseGithubRepo(app.githubUrl);
  const wantFd = !unavailable && platform === 'android' && !!app.fdroidId;
  const wantOfficial = !unavailable && officialSupported(app, platform);

  const [official, setOfficial] = useState<ResolvedDownload | null>(null);
  const [officialState, setOfficialState] = useState<ResolveState>('loading');
  const [officialErr, setOfficialErr] = useState<ResolveFailure | null>(null);

  // Lifecycle guards: each lookup carries its own generation counter, so a
  // superseded response (platform switched mid-flight, dialog closed, a
  // retry racing the original request) can never update state that no
  // longer describes it. Unmounted dialogs are dropped by mountedRef.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const ghGenRef = useRef(0);
  const fdGenRef = useRef(0);
  const officialGenRef = useRef(0);

  const runGh = (isRetry: boolean) => {
    const myGen = ++ghGenRef.current;
    setGhState('loading');
    setGhErr(null);
    (isRetry ? resolverRetry.retryGitHubResolve(app, platform) : resolveGitHubDownload(app, platform))
      .then((r) => {
        if (!mountedRef.current || ghGenRef.current !== myGen) return;
        setGh(r ?? null);
        if (r) {
          setGhState('ready');
        } else {
          // A rate limit is a lookup failure, not an honest "none": the
          // network's shared API quota ran out, which says nothing about
          // whether the project publishes installers.
          const peek = peekResolveError(app, platform) || '';
          if (/rate limit/i.test(peek)) {
            setGhState('error');
            setGhErr('rate-limit');
          } else {
            setGhState('none');
          }
        }
      })
      .catch(() => {
        if (!mountedRef.current || ghGenRef.current !== myGen) return;
        setGh(null);
        setGhState('error');
        setGhErr('network');
      });
  };

  const runFd = (isRetry: boolean) => {
    if (!app.fdroidId) return;
    const myGen = ++fdGenRef.current;
    setFdState('loading');
    setFdErr(null);
    (isRetry ? resolverRetry.retryFdroidResolve(app.fdroidId) : resolveFdroidDownload(app.fdroidId))
      .then((r) => {
        if (!mountedRef.current || fdGenRef.current !== myGen) return;
        setFd(r ?? null);
        setFdState(r ? 'ready' : 'none');
      })
      .catch(() => {
        if (!mountedRef.current || fdGenRef.current !== myGen) return;
        setFd(null);
        setFdState('error');
        setFdErr('network');
      });
  };

  const runOfficial = (isRetry: boolean) => {
    const myGen = ++officialGenRef.current;
    setOfficialState('loading');
    setOfficialErr(null);
    (isRetry ? resolverRetry.retryOfficialResolve(app, platform) : resolveOfficialDownload(app, platform))
      .then((r) => {
        if (!mountedRef.current || officialGenRef.current !== myGen) return;
        setOfficial(r ?? null);
        setOfficialState(r ? 'ready' : 'none');
      })
      .catch(() => {
        if (!mountedRef.current || officialGenRef.current !== myGen) return;
        setOfficial(null);
        setOfficialState('error');
        setOfficialErr('network');
      });
  };

  useEffect(() => {
    // Every resolver only runs when it is actually relevant for this
    // platform; a Retry re-runs exactly one failed lookup, never all of
    // them.
    if (wantGh) runGh(false);
    if (wantFd) runFd(false);
    if (wantOfficial) runOfficial(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, platform]);

  const published = (() => {
    if (!gh?.publishedAt) return '';
    try {
      return new Date(gh.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  })();

  const handleOption = (option: DownloadOption) => {
    // The translated label travels with the download/external-open record so
    // the download list names the entry exactly as the button the user read.
    const label = translateDownloadLabel(t, option.label);
    if (option.kind === 'direct') {
      launchDownload(option.url, label);
    } else {
      recordExternalOpen(`${app.name}: ${label}`, option.url);
      void openExternal(option.url);
    }
  };

  // A failed lookup keeps the forge fallback visible: the user must always
  // have an official path even while the automatic resolver is down.
  const secondary = options.filter((o) => !(
    (gh && !gh.weak && o.label === 'GitHub Releases') ||
    (official && !official.weak && o.kind === 'page' && o.url === official.releasePageUrl)
  ));

  /** One reusable failure row: message + Retry + the fallback stays below. */
  const renderLookupError = (
    key: string,
    err: ResolveFailure | null,
    onRetry: () => void
  ) => (
    <div
      key={key}
      role="alert"
      className="text-[11px] leading-snug px-3 py-2 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-300"
    >
      <p className="flex items-start gap-1.5">
        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
        <span>{err === 'rate-limit' ? t('detail.rateLimited') : t('detail.resolver.lookupFailed')}</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-100 hover:text-white bg-slate-950/[0.25] dark:bg-white/[0.1] hover:bg-slate-950/[0.35] dark:hover:bg-white/[0.16] border border-slate-950/20 dark:border-white/[0.2] px-2 py-1 rounded transition-colors"
      >
        <RotateCcw className="w-3 h-3" aria-hidden="true" />
        <span>{t('downloads.retry')}</span>
      </button>
    </div>
  );

  return (
    <div id="detail-download-box" className="border border-sky-500/25 rounded-lg p-3 bg-sky-500/5">
      <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
        <MonitorSmartphone className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
        <span>{t('detail.downloads')}</span>
      </h3>

      {/* Platform selector: only the platforms this app actually ships for,
          with this device preselected. */}
      <div className="flex items-center gap-1 flex-wrap mb-3 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] p-1 rounded-lg w-fit max-w-full">
        {app.platforms.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPlatform(p)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
              platform === p
                ? 'bg-sky-600 text-white shadow-xs'
                : 'text-slate-300 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08]'
            }`}
            aria-pressed={platform === p}
            title={t(`common.platform.${p}`)}
          >
            {t(`common.platform.${p}`)}
          </button>
        ))}
      </div>

      {unavailable ? (
        <div className="text-center py-4">
          <MonitorSmartphone className="w-6 h-6 text-slate-500 mx-auto mb-2" aria-hidden="true" />
          <p className="text-xs text-slate-300 font-medium mb-0.5">{t('detail.notAvailable')}</p>
          {/* The note's WORDS are rendered here (translated); the lib's return
              value is only the availability signal. Same branch structure as
              platformUnavailableNote, pinned by test so they cannot drift. */}
          <p className="text-[11px] text-slate-400 leading-relaxed">
            {platform === 'ios'
              ? t(app.platforms.includes('android') ? 'detail.unavailable.noIosHasAndroid' : 'detail.unavailable.noIos')
              : platform === 'android'
                ? t('detail.unavailable.noAndroid')
                : t('detail.unavailable.noBuild')
                    .replace('{platform}', t(`common.platform.${platform}`))
                    .replace('{list}', app.platforms.map((p) => t(`common.platform.${p}`)).join(', '))
            }{' '}
            {app.websiteUrl ? t('detail.resolver.checkWebsite') : ''}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* Primary: the latest STABLE file for this platform, resolved live from GitHub */}
          {wantGh && ghState === 'ready' && gh && (
            <button
              type="button"
              onClick={() =>
                launchDownload(gh.url, gh.filename, {
                  expectedSha256: gh.expectedSha256,
                  expectedSha512: gh.expectedSha512,
                })
              }
              className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white border border-sky-500 font-semibold transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Download className="w-3.5 h-3.5 shrink-0 text-sky-100" aria-hidden="true" />
                <span className="min-w-0">
                  {/* dir=ltr: the resolver returns underscore+digit asset
                      names whose bidi resolution scrambles inside an RTL
                      dialog (e.g. Fress_1.0.0_x64-setup.exe). */}
                  <span dir="ltr" className="block truncate text-left">
                    {gh.filename}
                    {gh.size > 0 && <span className="ms-1.5 opacity-80 font-normal">{formatBytes(gh.size)}</span>}
                  </span>
                  <span className="block text-[11px] font-normal opacity-80 truncate">
                    <span dir="ltr">v{gh.version}</span> · {t('detail.latestStableGithub')}
                    {published ? ` · ${t('detail.published')} ${published}` : ''}
                  </span>
                </span>
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wide bg-white/15 rounded px-1.5 py-0.5 shrink-0">{t('card.download')}</span>
            </button>
          )}
          {wantGh && ghState === 'ready' && gh?.weak && (
            <p className="text-[11px] text-amber-300 dark:text-amber-400 leading-snug flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t('detail.weakPick')}</span>
            </p>
          )}
          {wantGh && ghState === 'none' && (
            <p
              className="text-[11px] text-slate-400 leading-snug px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04]"
              role="status"
            >
              {t('detail.noAutoDownload')}
            </p>
          )}
          {wantGh && ghState === 'error' && renderLookupError('gh-err', ghErr, () => runGh(true))}
          {wantGh && ghState === 'loading' && (
            <div className="w-full flex items-center gap-2 text-xs px-3 py-2.5 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />
              <span>{t('detail.checkingStable')}</span>
            </div>
          )}

          {/* Primary for apps that distribute outside GitHub: the file the
              vendor's own manifest currently names. */}
          {wantOfficial && officialState === 'ready' && official && (
            <button
              type="button"
              onClick={() =>
                launchDownload(official.url, official.filename, {
                  expectedSha256: official.expectedSha256,
                  expectedSha512: official.expectedSha512,
                })
              }
              className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white border border-sky-500 font-semibold transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Download className="w-3.5 h-3.5 shrink-0 text-sky-100" aria-hidden="true" />
                <span className="min-w-0">
                  <span dir="ltr" className="block truncate text-left">
                    {official.filename}
                    {official.size > 0 && <span className="ms-1.5 opacity-80 font-normal">{formatBytes(official.size)}</span>}
                  </span>
                  <span className="block text-[11px] font-normal opacity-80 truncate">
                    {official.version ? <span dir="ltr">v{official.version}</span> : null}{official.version ? ' · ' : ''}{t('detail.latestStableOfficial')}
                  </span>
                </span>
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wide bg-white/15 rounded px-1.5 py-0.5 shrink-0">{t('card.download')}</span>
            </button>
          )}
          {wantOfficial && officialState === 'loading' && ghState !== 'loading' && (
            <div className="w-full flex items-center gap-2 text-xs px-3 py-2.5 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />
              <span>{t('detail.checkingStable')}</span>
            </div>
          )}

          {wantOfficial && officialState === 'error' && renderLookupError('official-err', officialErr, () => runOfficial(true))}

          {/* Android: F-Droid (direct stable apk, falls back to the F-Droid page) */}
          {wantFd && fdState === 'ready' && fd && (
            <button
              type="button"
              onClick={() =>
                launchDownload(fd.url, fd.filename, {
                  expectedSha256: fd.expectedSha256,
                  expectedSha512: fd.expectedSha512,
                })
              }
              className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-900 dark:text-emerald-300 font-semibold transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Smartphone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('detail.fdroid')} (<span dir="ltr">v{fd.version}</span>)
                  <span className="ms-1.5 text-[11px] font-normal opacity-80">{t('detail.latestStableFdroid')}</span>
                </span>
              </span>
              <Download className="w-3 h-3 shrink-0" aria-hidden="true" />
            </button>
          )}
          {wantFd && fdState === 'loading' && (
            <div className="w-full flex items-center gap-2 text-xs px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" aria-hidden="true" />
              <span>{t('detail.fdroid')} · {t('detail.checkingStable')}</span>
            </div>
          )}
          {wantFd && fdState === 'error' && renderLookupError('fd-err', fdErr, () => runFd(true))}
          {wantFd && (fdState === 'none' || fdState === 'error') && (
            <button
              type="button"
              onClick={() => {
                recordExternalOpen(`${app.name}: F-Droid`, fdroidPageUrl(app.fdroidId!));
                void openExternal(fdroidPageUrl(app.fdroidId!));
              }}
              className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Smartphone className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="truncate">{t('detail.fdroid')}</span>
              </span>
              <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
            </button>
          )}

          {/* Android: Google Play listing */}
          {platform === 'android' && app.playStoreId && (
            <button
              type="button"
              onClick={() => {
                recordExternalOpen(`${app.name}: ${t('detail.googlePlay')}`, playStoreUrl(app.playStoreId!));
                void openExternal(playStoreUrl(app.playStoreId!));
              }}
              className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Play className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="truncate">{t('detail.googlePlay')}</span>
              </span>
              <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
            </button>
          )}

          {/* Secondary: at most two other official targets. The primary button
              above is the one we recommend. */}
          {secondary.length > 0 && (
            <div className="pt-1 space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t('detail.otherWays')}</p>
              {secondary.slice(0, 2).map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => handleOption(option)}
                  className="w-full flex items-center justify-between gap-2 text-start text-xs px-3 py-2 rounded-md border transition-colors text-slate-200 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border-slate-950/10 dark:border-white/[0.08]"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Download className="w-3.5 h-3.5 shrink-0 text-sky-400" aria-hidden="true" />
                    <span className="truncate">
                      {option.label === 'GitHub Releases' ? t('detail.allReleases') : translateDownloadLabel(t, option.label)}
                      {option.kind === 'store' && <span className="ms-1.5 text-[11px] font-mono font-normal uppercase tracking-wide opacity-70">{t('detail.resolver.storeBadge')}</span>}
                    </span>
                  </span>
                  <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-400 leading-relaxed pt-0.5">
            {inApp ? t('detail.downloadsHint') : t('detail.downloadsHintBrowser')}
          </p>
        </div>
      )}
    </div>
  );
};

interface AppDetailModalProps {
  app: AppItem | null;
  onClose: () => void;
  onEditApp?: (app: AppItem) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({ app, onClose, onEditApp }) => {
  const [copiedCmd, setCopiedCmd] = useState<{ label: string; ok: boolean } | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const { t } = useI18n();
  const tx = useAppText(app);
  const liveStars = useLiveStars(app?.githubUrl);

  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, !!app, { onEscape: onClose });

  // Clipboard flash timer cleanup. Kept BEFORE the early return below:
  // hooks must run unconditionally on every render, app or no app.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // The modal instance stays mounted across app switches (app -> null ->
  // app), so copy feedback keyed by command label survived into the NEXT
  // app's dialog: app B rendered a stale "Copied" chip for a copy that
  // happened in app A. Reset per app.
  useEffect(() => {
    setCopiedCmd(null);
  }, [app?.id]);

  if (!app) return null;

  const shownStars = liveStars ?? app.stars;

  // Clipboard feedback, localized and honest: a denied clipboard shows
  // "Copy failed" instead of pretending success, and the flash timer is
  // cleaned up so a closed dialog never sets state after unmount.
  const handleCopy = async (text: string, label: string) => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd({ label, ok: true });
    } catch {
      setCopiedCmd({ label, ok: false });
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedCmd(null);
      copyTimerRef.current = null;
    }, 2000);
  };

  /** The Copy/Copied/failed chip for one install command. A plain function
   * (not a nested component) so no component identity is recreated. */
  const renderCopyChip = (cmd: string, label: string) => {
    const state = copiedCmd?.label === label ? copiedCmd : null;
    return (
      <button
        type="button"
        onClick={() => void handleCopy(cmd, label)}
        className="inline-flex items-center gap-1 bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 text-xs px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] shrink-0 transition-colors"
      >
        {state ? (
          state.ok ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              <span className="text-emerald-400">{t('common.copied')}</span>
            </>
          ) : (
            <>
              <X className="w-3 h-3 text-rose-400" aria-hidden="true" />
              <span className="text-rose-400">{t('common.copyFailed')}</span>
            </>
          )
        ) : (
          <>
            <Copy className="w-3 h-3 text-slate-400" aria-hidden="true" />
            <span>{t('common.copy')}</span>
          </>
        )}
      </button>
    );
  };

  const hasAndroid = app.platforms.includes('android');
  const FOSS_LICENSES = ['GPL-2.0+', 'GPL-3.0', 'GPL-2.0', 'MIT', 'Apache-2.0', 'MPL-2.0', 'LGPL-2.1', 'GNU LGPL', 'LGPL-3.0', 'AGPL-3.0', 'EUPL-1.2', 'BSD', 'ISC'];
  const licenseClass = FOSS_LICENSES.includes(app.license) ? 'foss' : 'notfoss';
  const repoHost = app.githubUrl.includes('github.com')
    ? 'github'
    : app.githubUrl.includes('gitlab.com')
      ? 'gitlab.com'
      : app.githubUrl.includes('gitlab')
        ? 'selfgitlab'
        : 'none';
  // One button per official home: GitHub next to GitLab when a project
  // publishes on both, a single button when it does not.
  const sourceLinks = sourceLinksFor(app);

  return (
    <div
      ref={panelRef}
      id="app-detail-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 fr-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-detail-title"
      onClick={onClose}
    >
      <div 
        id="app-detail-modal-container"
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div id="app-detail-modal-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-start justify-between gap-4 bg-slate-900">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              {/* Same shared category mapping as cards, table, compare and
                  live search - the raw id is data, never display copy. */}
              <span id="detail-category-badge" className="text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 rounded">
                {t(CATEGORY_I18N_KEYS[app.category])}
              </span>
              <span id="detail-license-badge" className="text-xs font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] text-slate-300 px-2 py-0.5 rounded">
                {translateLicenseDisplay(t, app.license)}
              </span>
              {app.lastVerifiedAt && (
                // Freshness is only ever claimed when a human actually
                // re-checked the entry - never faked for the whole catalog.
                <span
                  id="detail-verified-badge"
                  className="text-xs text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-2 py-0.5 rounded inline-flex items-center gap-1"
                  title={t('detail.lastVerifiedHint')}
                >
                  <ShieldCheck className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                  <span>{t('detail.lastVerified').replace('{d}', app.lastVerifiedAt)}</span>
                </span>
              )}
              {hasAndroid && (
                <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded inline-flex items-center gap-1 font-medium">
                  <Smartphone className="w-3 h-3" />
                  <span>{t('detail.resolver.androidSupported')}</span>
                </span>
              )}
            </div>
            <h2 id="app-detail-title" className="text-lg font-bold text-slate-100 tracking-tight flex items-center gap-2.5">
              <AppIcon appId={app.id} name={app.name} size={34} />
              {app.name}
            </h2>
            <p id="app-detail-tagline" className="text-xs text-slate-400 mt-0.5">
              {tx.tagline}
            </p>
            <p className="text-[11px] text-slate-400 mt-1 font-mono">
              {t('detail.metaLine').replace('{d}', app.addedAt)}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {app.isCustom && onEditApp && (
              <button
                id="edit-from-detail-btn"
                type="button"
                onClick={() => {
                  onClose();
                  onEditApp(app);
                }}
                className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 border border-slate-950/10 dark:border-white/[0.1] px-2.5 py-1.5 rounded-lg transition-colors"
                title={t('detail.resolver.editTitle')}
              >
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('common.edit')}</span>
              </button>
            )}
            <button
              id="close-app-detail-btn"
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content body. Keyboard-scrollable region: the focus trap makes
            wheel-only scrolling unreachable for keyboard users once the
            content overflows (long guides, small viewport heights). */}
        <div
          id="app-detail-modal-body"
          className="p-4 sm:p-6 space-y-4 overflow-y-auto text-[13px] leading-relaxed text-slate-300"
          tabIndex={0}
          role="region"
          aria-label={app.name}
        >
          {/* Downloads by device: the primary action, above the fold */}
          <DownloadSection key={app.id} app={app} />

          {/* Overview */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              {t('detail.overview')}
            </h3>
            <p className="leading-relaxed text-slate-200 text-xs">
              {tx.description}
            </p>
          </div>

          {/* Key Highlight */}
          {app.whyItsAwesome && (
            <div id="detail-why-box" className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
              <h3 className="text-xs font-semibold text-sky-400 mb-1">
                {t('detail.whyItsAwesome')}
              </h3>
              <p className="leading-relaxed text-slate-300 text-xs">
                {tx.whyItsAwesome}
              </p>
            </div>
          )}

          {/* Quick Start Guide */}
          {app.beginnerGuide && (
            <div id="detail-guide-box" className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
              <h3 className="text-xs font-semibold text-emerald-400 mb-1">
                {t('detail.beginnerGuide')}
              </h3>
              <p className="leading-relaxed text-slate-300 text-xs">
                {tx.beginnerGuide}
              </p>
            </div>
          )}

          {/* Installation Commands (Winget, Brew, Flatpak) */}
          {(app.wingetCommand || app.brewCommand || app.flatpakCommand) && (
            <div id="detail-install-commands-section" className="space-y-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-slate-400" />
                <span>{t('detail.packageManagers')}</span>
              </h3>
              <p className="text-[11px] text-slate-400 mb-2">{t('detail.resolver.terminalHint')}</p>

              <div className="space-y-2">
                {app.wingetCommand && (
                  <div className="flex items-center justify-between gap-2 fr-code-well p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">{t('detail.resolver.wingetLabel')}</span>
                      <code dir="ltr" className="text-left font-mono text-xs text-sky-300 select-all truncate block">
                        {app.wingetCommand}
                      </code>
                    </div>
                    {renderCopyChip(app.wingetCommand!, 'winget')}
                  </div>
                )}

                {app.brewCommand && (
                  <div className="flex items-center justify-between gap-2 fr-code-well p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">{t('detail.resolver.brewLabel')}</span>
                      <code dir="ltr" className="text-left font-mono text-xs text-amber-300 select-all truncate block">
                        {app.brewCommand}
                      </code>
                    </div>
                    {renderCopyChip(app.brewCommand!, 'brew')}
                  </div>
                )}

                {app.flatpakCommand && (
                  <div className="flex items-center justify-between gap-2 fr-code-well p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">{t('detail.resolver.flatpakLabel')}</span>
                      <code dir="ltr" className="text-left font-mono text-xs text-emerald-300 select-all truncate block">
                        {app.flatpakCommand}
                      </code>
                    </div>
                    {renderCopyChip(app.flatpakCommand!, 'flatpak')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Android notes if applicable */}
          {hasAndroid && (
            <div className="bg-emerald-950/20 border border-emerald-500/20 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-emerald-400 mb-1 flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5" />
                <span>{t('detail.resolver.androidInstallTitle')}</span>
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed">
                {t('detail.resolver.androidInstallBody')}
              </p>
            </div>
          )}

          {/* Repository & Security */}
          <div id="detail-safety-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>{t('detail.resolver.sourceLicense')}</span>
            </h3>
            <ul className="space-y-1.5 text-slate-400 text-xs">
              <li className="flex items-center gap-2">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>
                  {licenseClass !== 'foss'
                    ? t('detail.resolver.sourceNotFoss')
                    : !app.githubUrl
                      ? t('detail.resolver.sourceNoRepo')
                      : repoHost === 'github'
                      ? (shownStars > 0
                          ? t('detail.resolver.sourceGithubStars').replace('{stars}', shownStars.toLocaleString())
                          : t('detail.resolver.sourceGithub'))
                      : repoHost === 'gitlab.com'
                        ? (shownStars > 0
                            ? t('detail.resolver.sourceGitlabStars').replace('{stars}', shownStars.toLocaleString())
                            : t('detail.resolver.sourceGitlab'))
                        : (shownStars > 0
                            ? t('detail.resolver.sourceForgeStars').replace('{stars}', shownStars.toLocaleString())
                            : t('detail.resolver.sourceForge'))}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>
                  {licenseClass === 'foss'
                    ? t('detail.resolver.licenseFoss').replace('{license}', translateLicenseDisplay(t, app.license))
                    : app.license === 'Free for Personal Use'
                      ? t('detail.resolver.licensePersonal')
                      : app.license === 'Source-available'
                        ? t('detail.resolver.licenseSourceAvailable')
                        : t('detail.resolver.licenseOther').replace('{license}', translateLicenseDisplay(t, app.license))}
                </span>
              </li>
              {app.proprietaryAlternative && (
                <li className="flex items-center gap-2">
                  <Check className="w-3 h-3 text-sky-400 shrink-0" />
                  <span>
                    {/* {name} is terminal in the contract's English string, so
                        the strong-wrapped name stays in JSX between the two
                        template halves. */}
                    {t('detail.resolver.fossReplacement').split('{name}')[0]}
                    <strong className="text-slate-200 font-normal">{app.proprietaryAlternative}</strong>
                    {t('detail.resolver.fossReplacement').split('{name}')[1] || '.'}
                  </span>
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* Footer actions. flex-wrap: at the 320px floor the close button
            plus the forge/website links exceed the panel and the website
            link was unreachable, clipped by the panel's overflow-hidden. */}
        <div id="app-detail-modal-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex flex-wrap items-center justify-between gap-3">
          <button
            id="close-detail-modal-footer-btn"
            type="button"
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-100 px-3 py-1.5 rounded-lg hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.04] transition-colors"
          >
            {t('common.close')}
          </button>

          <div className="flex flex-wrap items-center gap-2">
            {sourceLinks.map((link, i) => {
              // The self-hosted-forge fallback label ('Source') is a real
              // English word; the forges' own names are proper nouns.
              const hostLabel = link.kind === 'forge' ? t('card.source.forge') : link.label;
              return (
                <a
                  key={link.url}
                  id={link.kind === 'gitlab' ? 'detail-gitlab-link' : i === 0 ? 'detail-github-link' : `detail-source-link-${i}`}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.preventDefault(); void openExternal(link.url); }}
                  title={link.url}
                  className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 border border-slate-950/10 dark:border-white/[0.1] px-3 py-1.5 rounded-lg transition-colors"
                >
                  <SourceIcon kind={link.kind} />
                  <span>{hostLabel}</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" aria-hidden="true" />
                </a>
              );
            })}

            {app.websiteUrl && (
              <a
                id="detail-website-link"
                href={app.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
                className="inline-flex items-center gap-1 text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-3 py-1.5 rounded-lg border border-sky-400 transition-colors shadow-xs"
              >
                <span>{t('detail.website')}</span>
                <ExternalLink className="w-3 h-3 text-sky-200" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        {/* Localized clipboard completion feedback for screen readers. */}
        <span className="sr-only" role="status">
          {copiedCmd ? (copiedCmd.ok ? t('common.copied') : t('common.copyFailed')) : ''}
        </span>
      </div>
    </div>
  );
};
