import React, { useState } from 'react';
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
  MonitorSmartphone
} from 'lucide-react';
import { PLATFORM_LABELS, getDownloadOptions, platformUnavailableNote, DownloadOption } from '../lib/appDownloads';
import { useDownloads } from '../lib/downloads';
import { useI18n } from '../lib/i18n';
import { toast } from 'sonner';

/** Device-aware download section: pick your platform, get real targets. */
function detectUserPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

const DownloadSection: React.FC<{ app: AppItem }> = ({ app }) => {
  const { startDownload, recordExternalOpen } = useDownloads();
  const { t } = useI18n();
  const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const preferred = (() => {
    const guess = detectUserPlatform();
    return app.platforms.includes(guess) ? guess : (app.platforms[0] || 'windows');
  })();
  const [platform, setPlatform] = useState<Platform>(preferred);
  const options = getDownloadOptions(app, platform);
  const unavailable = platformUnavailableNote(app, platform);

  const handleOption = (option: DownloadOption) => {
    if (option.kind === 'direct') {
      void startDownload(option.url, option.label);
    } else {
      recordExternalOpen(`${app.name}: ${option.label}`, option.url);
      window.open(option.url, '_blank', 'noopener,noreferrer');
    }
  };

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
      ) : options.length > 0 ? (
        <div className="space-y-1.5">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => handleOption(option)}
              className={`w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 rounded-md border transition-colors ${
                option.kind === 'direct'
                  ? 'bg-sky-600 hover:bg-sky-500 text-white border-sky-500 font-semibold'
                  : 'text-slate-200 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border-slate-950/10 dark:border-white/[0.08]'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Download className={`w-3.5 h-3.5 shrink-0 ${option.kind === 'direct' ? 'text-sky-100' : 'text-sky-400'}`} aria-hidden="true" />
                <span className="truncate">
                  {option.label}
                  {option.kind === 'direct' && <span className="ml-1.5 text-[11px] font-mono font-normal uppercase tracking-wide opacity-80">progress in app</span>}
                  {option.kind === 'store' && <span className="ml-1.5 text-[11px] font-mono font-normal uppercase tracking-wide opacity-70">app store</span>}
                </span>
              </span>
              {option.kind !== 'direct' && <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />}
            </button>
          ))}
          <p className="text-[11px] text-slate-400 leading-relaxed pt-0.5">
            {inApp ? t('detail.downloadsHint') : 'Downloads open in a new browser tab. The Fress desktop app adds a built-in download manager with live progress and SHA-256 verification.'} {t('detail.checkLatest')}
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-400 leading-relaxed">No direct download found. Visit the official website to get this app.</p>
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
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  if (!app) return null;

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(label);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  const hasAndroid = app.platforms.includes('android');
  const FOSS_LICENSES = ['GPL-2.0+', 'GPL-3.0', 'GPL-2.0', 'MIT', 'Apache-2.0', 'MPL-2.0', 'LGPL-2.1', 'GNU LGPL', 'LGPL-3.0', 'GPL-2.0+', 'AGPL-3.0', 'EUPL-1.2', 'BSD', 'ISC'];
  const licenseClass = FOSS_LICENSES.includes(app.license) ? 'foss' : 'notfoss';
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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-detail-title"
      aria-label={app ? `${app.name} details` : 'Application details'}
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
              <span id="detail-category-badge" className="text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 rounded">
                {app.category}
              </span>
              <span id="detail-license-badge" className="text-xs font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] text-slate-300 px-2 py-0.5 rounded">
                {app.license}
              </span>
              {hasAndroid && (
                <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded inline-flex items-center gap-1 font-medium">
                  <Smartphone className="w-3 h-3" />
                  <span>Android Supported</span>
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
              Listed since {app.addedAt} · links verified at review time
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
                title="Edit this custom application"
              >
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Edit</span>
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
              About
            </h3>
              <p className="text-[11px] text-slate-400 mb-2">Advanced: paste these into your system terminal. Not sure? Use the download buttons at the top instead.</p>
            <p className="leading-relaxed text-slate-200 text-xs">
              {app.description}
            </p>
          </div>

          {/* Key Highlight */}
          {app.whyItsAwesome && (
            <div id="detail-why-box" className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
              <h3 className="text-xs font-semibold text-sky-400 mb-1">
                Key Highlight
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
                Setup Note
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
                <span>Install commands (terminal)</span>
              </h3>

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
                <span>Android Installation</span>
              </h3>
              <p className="text-slate-300 text-xs leading-relaxed">
                Available via F-Droid, Google Play, or direct APK releases on the official GitHub repository.
              </p>
            </div>
          )}

          {/* Repository & Security */}
          <div id="detail-safety-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>Community & Transparency</span>
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
            Close
          </button>

          <div className="flex items-center gap-2">
            {repoHost !== 'none' && (
              <a
                id="detail-github-link"
                href={app.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
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
                className="inline-flex items-center gap-1 text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-3 py-1.5 rounded-lg border border-sky-400 transition-colors shadow-xs"
              >
                <span>Official Website</span>
                <ExternalLink className="w-3 h-3 text-sky-200" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
