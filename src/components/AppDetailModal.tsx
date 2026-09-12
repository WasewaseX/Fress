import React, { useEffect, useState } from 'react';
import { AppItem, Platform } from '../types';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Github,
  Terminal,
  ShieldCheck,
  Smartphone,
  Edit2,
  Download,
  MonitorSmartphone,
  Loader2,
  Play,
  RotateCcw
} from 'lucide-react';
import { PLATFORM_LABELS, getDownloadOptions, platformUnavailableNote, DownloadOption } from '../lib/appDownloads';
import { useDownloadActions, formatBytes, isTauri } from '../lib/downloads';
import { openExternal } from '../lib/external';
import {
  resolveGitHubDownload,
  resolveFdroidDownload,
  parseGithubRepo,
  fdroidPageUrl,
  playStoreUrl,
  githubFetchSupported,
  guessUserPlatform,
  ResolvedDownload,
} from '../lib/releaseFetch';
import { useI18n, categoryKey } from '../lib/i18n';
import { useModalA11y } from '../lib/modalA11y';
import { toast } from 'sonner';

/** Device-aware download section: pick your platform, get real targets. */
const DownloadSection: React.FC<{ app: AppItem }> = ({ app }) => {
  const { startDownload, recordExternalOpen } = useDownloadActions();
  const { t } = useI18n();
  const inApp = isTauri();
  const [platform, setPlatform] = useState<Platform>(() => guessUserPlatform(app));
  const options = getDownloadOptions(app, platform);
  const unavailable = platformUnavailableNote(app, platform);

  const [gh, setGh] = useState<ResolvedDownload | null>(null);
  const [ghState, setGhState] = useState<ResolveState>('loading');
  const [fd, setFd] = useState<ResolvedDownload | null>(null);
  const [fdState, setFdState] = useState<ResolveState>('loading');
  // Bumping this re-runs the resolvers (Retry button) — failures are not
  // cached, so an immediate retry is a fresh network round-trip.
  const [retryTick, setRetryTick] = useState(0);

  const wantGh = !unavailable && githubFetchSupported(platform) && !!parseGithubRepo(app.githubUrl);
  const wantFd = !unavailable && platform === 'android' && !!app.fdroidId;

  useEffect(() => {
    let alive = true;
    if (wantGh) {
      setGhState('loading');
      resolveGitHubDownload(app, platform).then((r) => {
        if (!alive) return;
        setGh(r);
        setGhState(r ? 'ready' : 'none');
      });
    }
    if (wantFd) {
      setFdState('loading');
      resolveFdroidDownload(app.fdroidId!).then((r) => {
        if (!alive) return;
        setFd(r);
        setFdState(r ? 'ready' : 'none');
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, platform, retryTick]);

  const published = (() => {
    if (!gh?.publishedAt) return '';
    try {
      return new Date(gh.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  })();

  const handleOption = (option: DownloadOption) => {
    if (option.kind === 'direct') {
      // The server's Content-Disposition names the file correctly; a UI label
      // would strip the extension.
      void startDownload(option.url, undefined, app.id);
    } else {
      recordExternalOpen(`${app.name}: ${option.label}`, option.url);
      void openExternal(option.url);
    }
  };

  // When the amber "couldn't check GitHub" row is visible it carries its own
  // releases jump — suppress exactly that one option below (by URL), keeping
  // any other release hosts the project exposes.
  const amberReleasesUrl = options.find(
    (o) => o.label === 'GitHub Releases' || o.label.startsWith('Releases on ') || o.label === 'GitLab Releases'
  )?.url;
  const secondary = options.filter(
    (o) =>
      !(gh && o.label === 'GitHub Releases') &&
      !(ghState === 'none' && o.url === amberReleasesUrl) &&
      // The dedicated Google Play row already covers the store listing.
      !(app.playStoreId && o.url === playStoreUrl(app.playStoreId))
  );

  return (
    <div id="detail-download-box" className="border border-sky-500/25 rounded-lg p-3 bg-sky-500/5">
      <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
        <MonitorSmartphone className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
        <span>{t('detail.downloads')}</span>
      </h3>

      {/* Platform selector: segmented control with real hit targets */}
      <div className="flex items-center gap-1 flex-wrap mb-3 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] p-1 rounded-lg w-fit max-w-full">
        {([...app.platforms, ...((Object.keys(PLATFORM_LABELS) as Platform[]).filter((p) => !app.platforms.includes(p)))] as Platform[]).map((p) => {
          const available = app.platforms.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPlatform(p)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                platform === p
                  ? 'bg-sky-600 text-white shadow-xs'
                  : available
                    ? 'text-slate-300 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08]'
                    : 'text-slate-500 cursor-not-allowed opacity-60'
              }`}
              aria-pressed={platform === p}
              aria-disabled={!available}
              title={available ? PLATFORM_LABELS[p] : `Not available on ${PLATFORM_LABELS[p]}`}
            >
              {PLATFORM_LABELS[p]}
            </button>
          );
        })}
      </div>

      {unavailable ? (
        <div className="text-center py-4">
          <MonitorSmartphone className="w-6 h-6 text-slate-500 mx-auto mb-2" aria-hidden="true" />
          <p className="text-xs text-slate-300 font-medium mb-0.5">{t('detail.notAvailable')}</p>
          <p className="text-[11px] text-slate-400 leading-relaxed">{unavailable}. {app.websiteUrl ? 'Check the official website for updates.' : ''}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* Primary: the latest STABLE file for this platform, resolved live from GitHub */}
          {wantGh && ghState === 'ready' && gh && (
            <button
              type="button"
              onClick={() => void startDownload(gh.url, gh.filename, app.id, gh.sha256)}
              className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white border border-sky-500 font-semibold transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Download className="w-3.5 h-3.5 shrink-0 text-sky-100" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate">
                    {gh.filename}
                    {gh.size > 0 && <span className="ml-1.5 opacity-80 font-normal">{formatBytes(gh.size)}</span>}
                  </span>
                  <span className="block text-[11px] font-normal opacity-80 truncate">
                    v{gh.version} · {t('detail.latestStableGithub')}
                    {published ? ` · ${t('detail.published')} ${published}` : ''}
                  </span>
                </span>
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wide bg-white/15 rounded px-1.5 py-0.5 shrink-0">{t('card.download')}</span>
            </button>
          )}
          {wantGh && ghState === 'loading' && (
            <div className="w-full flex items-center gap-2 text-xs px-3 py-2.5 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />
              <span>{t('detail.checkingStable')}</span>
            </div>
          )}
          {wantGh && ghState === 'none' && (
            <div className="w-full flex items-center justify-between gap-2 text-xs px-3 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-200">
              <span className="min-w-0 truncate">{t('detail.ghUnavailable')}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setRetryTick((n) => n + 1)}
                  className="inline-flex items-center gap-1 font-semibold text-amber-100 hover:text-white bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 px-2 py-1 rounded-md transition-colors"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  <span>{t('detail.retry')}</span>
                </button>
                {options.some((o) => o.label === 'GitHub Releases' || o.label.startsWith('Releases on ') || o.label === 'GitLab Releases') && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = options.find((o) => o.label === 'GitHub Releases' || o.label.startsWith('Releases on ') || o.label === 'GitLab Releases');
                      if (target) {
                        recordExternalOpen(`${app.name}: ${target.label}`, target.url);
                        void openExternal(target.url);
                      }
                    }}
                    className="inline-flex items-center gap-1 font-semibold text-amber-100 hover:text-white bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 px-2 py-1 rounded-md transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    <span>{t('detail.allReleases')}</span>
                  </button>
                )}
              </span>
            </div>
          )}

          {/* Android: F-Droid (direct stable apk, falls back to the F-Droid page) */}
          {wantFd && fdState === 'ready' && fd && (
            <button
              type="button"
              onClick={() => void startDownload(fd.url, fd.filename, app.id)}
              className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 font-semibold transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Smartphone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('detail.fdroid')} — v{fd.version}
                  <span className="ml-1.5 text-[11px] font-normal opacity-80">{t('detail.latestStableFdroid')}</span>
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
          {wantFd && fdState === 'none' && (
            <div className="w-full flex items-center justify-between gap-2 text-xs px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300">
              <span className="flex items-center gap-2 min-w-0 truncate">
                <Smartphone className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="truncate">{inApp ? t('detail.fdroidNone') : t('detail.fdroidNeedsDesktop')}</span>
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setRetryTick((n) => n + 1)}
                  className="inline-flex items-center gap-1 font-semibold text-slate-200 hover:text-white bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.12] dark:hover:bg-white/[0.14] border border-slate-950/10 dark:border-white/[0.1] px-2 py-1 rounded-md transition-colors"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  <span>{t('detail.retry')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    recordExternalOpen(`${app.name}: F-Droid`, fdroidPageUrl(app.fdroidId!));
                    void openExternal(fdroidPageUrl(app.fdroidId!));
                  }}
                  aria-label={t('detail.fdroid')}
                  className="inline-flex items-center gap-1 font-semibold text-slate-200 hover:text-white bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.12] dark:hover:bg-white/[0.14] border border-slate-950/10 dark:border-white/[0.1] px-2 py-1 rounded-md transition-colors"
                >
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  <span>{t('detail.fdroid')}</span>
                </button>
              </span>
            </div>
          )}

          {/* Android: Google Play listing */}
          {platform === 'android' && app.playStoreId && (
            <button
              type="button"
              onClick={() => {
                recordExternalOpen(`${app.name}: ${t('detail.googlePlay')}`, playStoreUrl(app.playStoreId!));
                void openExternal(playStoreUrl(app.playStoreId!));
              }}
              className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 rounded-md border border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Play className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="truncate">{t('detail.googlePlay')}</span>
              </span>
              <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
            </button>
          )}

          {/* Android: what to DO with the file (the #1 beginner blocker) */}
          {platform === 'android' && inApp && (
            <details id="detail-android-sideload" className="text-xs rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2">
              <summary className="cursor-pointer font-semibold text-emerald-300 select-none">
                {t('guide.android.title')}
              </summary>
              <ol className="list-decimal list-inside space-y-1 mt-1.5 text-slate-300 leading-relaxed">
                <li>{t('guide.android.transfer')}</li>
                <li>{t('guide.android.open')}</li>
                <li>{t('guide.android.playProtect')}</li>
              </ol>
              <p className="mt-1.5 text-slate-400 leading-relaxed">{t('guide.android.fdroidTip')}</p>
            </details>
          )}

          {/* Secondary: every other official target */}
          {secondary.length > 0 && (
            <div className="pt-1 space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t('detail.otherWays')}</p>
              {secondary.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => handleOption(option)}
                  className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 rounded-md border transition-colors text-slate-200 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border-slate-950/10 dark:border-white/[0.08]"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Download className="w-3.5 h-3.5 shrink-0 text-sky-400" aria-hidden="true" />
                    <span className="truncate">
                      {option.label === 'GitHub Releases' ? t('detail.allReleases') : option.label}
                      {option.kind === 'store' && <span className="ml-1.5 text-[11px] font-mono font-normal uppercase tracking-wide opacity-70">app store</span>}
                    </span>
                  </span>
                  <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-400 leading-relaxed pt-0.5">
            {inApp ? t('detail.downloadsHint') : `${t('detail.webHintTitle')} — ${t('detail.webHintBody')}`} {t('detail.checkLatest')}
          </p>
        </div>
      )}
    </div>
  );
};

type ResolveState = 'loading' | 'ready' | 'none';

interface AppDetailModalProps {
  app: AppItem | null;
  onClose: () => void;
  onEditApp?: (app: AppItem) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({ app, onClose, onEditApp }) => {
  const { t } = useI18n();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const containerRef = useModalA11y<HTMLDivElement>(!!app, onClose);

  if (!app) return null;

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedCmd(label);
        setTimeout(() => setCopiedCmd(null), 2000);
      },
      () => toast.error(t('detail.copyFail'))
    );
  };

  const hasAndroid = app.platforms.includes('android');
  // Anything from the copyleft/permissive OSS families counts as open source.
  const licenseClass = /gpl|lgpl|agpl|mit|bsd|apache|mpl|isc|eupl|zlib|unlicense|ms-pl|postgresql|wtfpl/i.test(app.license)
    ? 'foss'
    : 'notfoss';
  const repoHost = app.githubUrl.includes('github.com')
    ? 'github'
    : app.githubUrl.includes('gitlab.com')
      ? 'gitlab.com'
      : app.githubUrl.includes('gitlab')
        ? 'selfgitlab'
        : 'none';


  return (
    <div
      id="app-detail-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 fr-backdrop backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-detail-title"
      aria-label={app ? `${app.name} details` : 'Application details'}
      onClick={onClose}
    >
      <div
        id="app-detail-modal-container"
        ref={containerRef}
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div id="app-detail-modal-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-start justify-between gap-4 bg-slate-900">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span id="detail-category-badge" className="text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 rounded">
                {t(categoryKey(app.category))}
              </span>
              <span id="detail-license-badge" className="text-xs font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] text-slate-300 px-2 py-0.5 rounded">
                {app.license}
              </span>
              {hasAndroid && (
                <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded inline-flex items-center gap-1 font-medium">
                  <Smartphone className="w-3 h-3" />
                  <span>{t('detail.androidSupported')}</span>
                </span>
              )}
            </div>
            <h2 id="app-detail-title" className="text-lg font-bold text-slate-100 tracking-tight">
              {app.name}
            </h2>
            <p id="app-detail-tagline" className="text-xs text-slate-400 mt-0.5">
              {app.tagline}
            </p>
            <p className="text-[11px] text-slate-500 mt-1 font-mono">
              {t('detail.listedSince')} {app.addedAt} · {t('detail.verifiedNote')}
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
                title={t('card.edit')}
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
              aria-label="Close details modal"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content body */}
        <div id="app-detail-modal-body" className="p-4 sm:p-6 space-y-4 overflow-y-auto text-[13px] leading-relaxed text-slate-300">
          {/* Downloads by device: the primary action, above the fold */}
          <DownloadSection key={app.id} app={app} />

          {/* Overview */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              {t('detail.overview')}
            </h3>
            <p className="leading-relaxed text-slate-200 text-xs">
              {app.description}
            </p>
          </div>

          {/* Key Highlight */}
          {app.whyItsAwesome && (
            <div id="detail-why-box" className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
              <h3 className="text-xs font-semibold text-sky-400 mb-1">
                {t('detail.whyItsAwesome')}
              </h3>
              <p className="leading-relaxed text-slate-300 text-xs">
                {app.whyItsAwesome}
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
                {app.beginnerGuide}
              </p>
            </div>
          )}

          {/* Installation Commands (Winget, Brew, Flatpak) */}
          {(app.wingetCommand || app.brewCommand || app.flatpakCommand) && (
            <div id="detail-install-commands-section" className="space-y-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-slate-400" />
                <span>{t('detail.installCommands')}</span>
              </h3>
              <p className="text-[11px] text-slate-400">{t('detail.terminalNote')}</p>

              <div className="space-y-2">
                {app.wingetCommand && (
                  <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">Winget (Windows)</span>
                      <code className="font-mono text-xs text-sky-300 select-all truncate block">
                        {app.wingetCommand}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(app.wingetCommand!, 'winget')}
                      className="inline-flex items-center gap-1 bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 text-xs px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] shrink-0 transition-colors"
                    >
                      {copiedCmd === 'winget' ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 text-slate-400" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                {app.brewCommand && (
                  <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">Homebrew (macOS / Linux)</span>
                      <code className="font-mono text-xs text-amber-300 select-all truncate block">
                        {app.brewCommand}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(app.brewCommand!, 'brew')}
                      className="inline-flex items-center gap-1 bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 text-xs px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] shrink-0 transition-colors"
                    >
                      {copiedCmd === 'brew' ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 text-slate-400" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                {app.flatpakCommand && (
                  <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] p-2 rounded-lg">
                    <div className="min-w-0">
                      <span className="text-[11px] uppercase font-mono text-slate-400 block">Flatpak (Linux)</span>
                      <code className="font-mono text-xs text-emerald-300 select-all truncate block">
                        {app.flatpakCommand}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(app.flatpakCommand!, 'flatpak')}
                      className="inline-flex items-center gap-1 bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 text-xs px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] shrink-0 transition-colors"
                    >
                      {copiedCmd === 'flatpak' ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 text-slate-400" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
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
                <span>{t('detail.androidInstall')}</span>
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed">
                {t('detail.androidInstallBody')}
              </p>
            </div>
          )}

          {/* Repository & Security */}
          <div id="detail-safety-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>{t('detail.transparency')}</span>
            </h3>
            <ul className="space-y-1.5 text-slate-400 text-xs">
              <li className="flex items-center gap-2">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>
                  {licenseClass !== 'foss'
                    ? 'Distributed officially by its developer; free to download and use.'
                    : !app.githubUrl
                      ? 'Source code is published by the project.'
                      : repoHost === 'github'
                      ? (app.stars > 0
                          ? `Verified open-source repository with ${app.stars.toLocaleString()} stars on GitHub.`
                          : 'Verified open-source repository on GitHub.')
                      : repoHost === 'gitlab.com'
                        ? 'Verified open-source repository, hosted on GitLab.com.'
                        : 'Verified open-source repository, hosted on the project\'s own infrastructure.'}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>
                  {licenseClass === 'foss'
                    ? `Distributed under the ${app.license} open-source license.`
                    : app.license === 'Free for Personal Use'
                      ? 'Free to download and use, but the license is proprietary (not open source).'
                      : app.license === 'Source-available'
                        ? 'Source code is published under a custom license (source-available, not OSI-approved).'
                        : `Distributed under the ${app.license} license.`}
                </span>
              </li>
              {app.proprietaryAlternative && (
                <li className="flex items-center gap-2">
                  <Check className="w-3 h-3 text-sky-400 shrink-0" />
                  <span>Free replacement for proprietary software: <strong className="text-slate-200 font-normal">{app.proprietaryAlternative}</strong>.</span>
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* Footer actions */}
        <div id="app-detail-modal-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between gap-3">
          <button
            id="close-detail-modal-footer-btn"
            type="button"
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-100 px-3 py-1.5 rounded-lg hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.04] transition-colors"
          >
            {t('common.close')}
          </button>

          <div className="flex items-center gap-2">
            {repoHost !== 'none' && (
              <a
                id="detail-github-link"
                href={app.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); void openExternal(app.githubUrl); }}
                className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 border border-slate-950/10 dark:border-white/[0.1] px-3 py-1.5 rounded-lg transition-colors"
              >
                <Github className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{repoHost === 'github' ? 'GitHub' : 'GitLab'}</span>
                <ExternalLink className="w-3 h-3 text-slate-400" aria-hidden="true" />
              </a>
            )}

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
      </div>
    </div>
  );
};
