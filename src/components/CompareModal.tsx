// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { useI18n, CATEGORY_I18N_KEYS, RATING_I18N_KEYS } from '../lib/i18n';
import { AppItem } from '../types';
import { openExternal } from '../lib/external';
import {
  Columns,
  X,
  Check,
  Minus,
  ExternalLink,
  Star,
  ShieldCheck,
  HardDrive,
  Cpu,
  Terminal
} from 'lucide-react';

interface CompareModalProps {
  isOpen: boolean;
  onClose: () => void;
  appsToCompare: AppItem[];
  allApps: AppItem[];
  onAddAppToCompare: (appId: string) => void;
  onRemoveAppFromCompare: (appId: string) => void;
  onClearCompare: () => void;
}

export const CompareModal: React.FC<CompareModalProps> = ({
  isOpen,
  onClose,
  appsToCompare,
  allApps,
  onAddAppToCompare,
  onRemoveAppFromCompare,
  onClearCompare
}) => {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen, { onEscape: onClose });
  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      id="compare-modal-backdrop"
      role="dialog" aria-modal="true" aria-labelledby="compare-modal-title" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        id="compare-modal"
        className="w-full max-w-5xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400">
              <Columns className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="compare-modal-title" className="text-base font-bold text-slate-100 tracking-tight">
                {t('cmp.title')}
              </h2>
              <p className="text-xs text-slate-400">
                {t('cmp.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {appsToCompare.length > 0 && (
              <button
                type="button"
                onClick={onClearCompare}
                className="text-xs text-slate-400 hover:text-slate-100 transition-colors"
              >
                {t('cmp.clear')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]"
              aria-label={t('common.closeDialog')}
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Matrix Content */}
        <div className="flex-1 overflow-auto p-5">
          {appsToCompare.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-slate-400 text-sm mb-4">
                {t('cmp.empty')}
              </p>
              <p className="text-slate-400 text-xs max-w-md mx-auto">
                {t('cmp.emptyHint')}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-2xl mx-auto">
                {allApps.slice(0, 6).map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => onAddAppToCompare(app.id)}
                    className="text-xs px-2.5 py-1 rounded bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-sky-300 border border-slate-950/10 dark:border-white/[0.08]"
                  >
                    {t('cmp.addApp').replace('{name}', app.name)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="min-w-[650px]">
              {/* Table header with software names */}
              <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] border-b border-slate-950/10 dark:border-white/[0.08] pb-4">
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400 pt-2">
                  {t('table.head.app')}
                </div>
                {appsToCompare.map((app) => (
                  <div key={app.id} className="px-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-slate-100 text-base truncate">{app.name}</h3>
                      <button
                        type="button"
                        onClick={() => onRemoveAppFromCompare(app.id)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                        title={t('cmp.removeTitle')}
                        aria-label={`${t('cmp.removeTitle')}: ${app.name}`}
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{app.tagline}</p>
                    <div className="flex items-center gap-1.5 mt-2">
                      {/* Guarded: custom apps may have no website at all
                          (websiteUrl is '' in that case). */}
                      {app.websiteUrl && (
                        <a
                          href={app.websiteUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
                          className="text-[11px] text-sky-400 hover:underline inline-flex items-center gap-1"
                        >
                          <span>{t('common.websiteShort')}</span>
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      )}
                      {app.githubUrl && (
                        <>
                          {app.websiteUrl && <span className="text-slate-600" aria-hidden="true">·</span>}
                          <a
                            href={app.githubUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => { e.preventDefault(); void openExternal(app.githubUrl); }}
                            className="text-[11px] text-slate-400 hover:text-slate-100 inline-flex items-center gap-1"
                          >
                            <span>GitHub</span>
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Rows */}
              <div className="divide-y divide-slate-950/10 dark:divide-white/[0.06] text-xs">
                {/* Replaces proprietary */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowReplaces')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.proprietaryAlternative ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-amber-400/10 border border-amber-400/20 text-amber-300">
                          {app.proprietaryAlternative}
                        </span>
                      ) : (
                        <span className="text-slate-400">{t('cmp.universal')}</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Category */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('table.head.category')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 text-slate-200">
                      {t(CATEGORY_I18N_KEYS[app.category])}
                    </div>
                  ))}
                </div>

                {/* License */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('table.head.license')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      <span className="font-mono text-emerald-400">{app.license}</span>
                    </div>
                  ))}
                </div>

                {/* GitHub Stars */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowStars')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 flex items-center gap-1.5 text-amber-300 font-mono">
                      <Star className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                      <span>{app.stars.toLocaleString()}</span>
                    </div>
                  ))}
                </div>

                {/* Platforms */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('table.head.platforms')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 flex flex-wrap gap-1">
                      {app.platforms.map((p) => (
                        <span key={p} className="px-1.5 py-0.5 rounded text-[11px] uppercase font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] text-slate-300">
                          {t(`common.platform.${p}`)}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Offline Ready */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowOffline')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.offlineReady ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <Check className="w-4 h-4" aria-hidden="true" />
                          <span>{t('cmp.offlineYes')}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-400">
                          <Minus className="w-4 h-4" aria-hidden="true" />
                          <span>{t('cmp.offlineNo')}</span>
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Portable Mode */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowPortable')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.isPortable ? (
                        <span className="text-emerald-400 font-mono text-[11px]">{t('cmp.portableYes')}</span>
                      ) : (
                        <span className="text-slate-400 font-mono text-[11px]">{t('cmp.portableNo')}</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Architectures */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowArch')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 font-mono text-[11px] text-slate-300">
                      {app.architectures ? app.architectures.join(', ') : 'x86_64, arm64'}
                    </div>
                  ))}
                </div>

                {/* Beginner Curve */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowCurve')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 text-slate-300">
                      {t(RATING_I18N_KEYS[app.beginnerRating] ?? app.beginnerRating)}
                    </div>
                  ))}
                </div>

                {/* Package Manager Command */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">{t('cmp.rowInstall')}</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      <code className="fr-code-well text-[11px] font-mono text-sky-300 border px-2 py-1 rounded block truncate select-all">
                        {app.wingetCommand || app.brewCommand || t('cmp.directInstaller')}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with add extra tool dropdown */}
        <div className="px-5 py-3 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between">
          <div className="text-xs text-slate-400">
            {(appsToCompare.length === 1 ? t('cmp.comparingOne') : t('cmp.comparingMany')).replace('{n}', String(appsToCompare.length))}
          </div>
          {appsToCompare.length < 4 && (
            <div className="flex items-center gap-2">
              <label htmlFor="compare-add-select" className="text-xs text-slate-400">{t('cmp.addToCompare')}</label>
              <select
                id="compare-add-select"
                onChange={(e) => {
                  if (e.target.value) {
                    onAddAppToCompare(e.target.value);
                    e.target.value = '';
                  }
                }}
                className="bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] text-xs text-slate-100 px-2 py-1 rounded focus:outline-none"
                defaultValue=""
              >
                <option value="" disabled>{t('cmp.selectPlaceholder')}</option>
                {allApps
                  .filter((a) => !appsToCompare.some((c) => c.id === a.id))
                  .map((app) => (
                    <option key={app.id} value={app.id} className="bg-slate-900 text-slate-100">
                      {app.name} ({t(CATEGORY_I18N_KEYS[app.category])})
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
