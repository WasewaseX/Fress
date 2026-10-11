// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useRef, useEffect } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { useI18n } from '../lib/i18n';
import {
  X,
  Copy,
  Check,
  Download,
  Box
} from 'lucide-react';

interface TauriModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TauriModal: React.FC<TauriModalProps> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'build' | 'config' | 'github'>('build');
  // Honest clipboard feedback: the old code fired writeText without awaiting
  // it and showed "Copied" unconditionally, so a denied clipboard still lied.
  const [copiedCmd, setCopiedCmd] = useState<boolean | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen, { onEscape: onClose });
  if (!isOpen) return null;

  const buildCommand = `npm install
npm run build
npx @tauri-apps/cli build`;

  const handleCopyCmd = async () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    let ok = false;
    try {
      await navigator.clipboard.writeText(buildCommand);
      ok = true;
    } catch {
      ok = false;
    }
    setCopiedCmd(ok);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedCmd(null);
      copyTimerRef.current = null;
    }, 2000);
  };

  const ciBodyParts = t('tauri.ciBody').split('{file}');
  const ciBodyTail = (ciBodyParts[1] || '').split('{exe}');

  return (
    <div
      ref={panelRef}
      id="tauri-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tauri-modal-title"
    >
      <div
        id="tauri-modal-container"
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div id="tauri-modal-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-start justify-between bg-slate-900">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span id="tauri-arch-badge" className="text-xs font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded">
                {t('tauri.badgeStack')}
              </span>
              <span id="tauri-target-badge" className="text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                {t('tauri.badgeTarget')}
              </span>
            </div>
            <h2 id="tauri-modal-title" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              {t('tauri.title')}
            </h2>
            <p id="tauri-modal-desc" className="text-xs text-slate-400 mt-0.5">
              {t('tauri.desc')}
            </p>
          </div>
          <button
            id="close-tauri-modal-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label={t('common.closeDialog')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab selector */}
        <div id="tauri-tabs-row" className="flex border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950 px-4 text-xs">
          <button
            id="tab-btn-compile"
            type="button"
            onClick={() => setActiveTab('build')}
            aria-pressed={activeTab === 'build'}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'build'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('tauri.tabBuild')}
          </button>
          <button
            id="tab-btn-github-actions"
            type="button"
            onClick={() => setActiveTab('github')}
            aria-pressed={activeTab === 'github'}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'github'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('tauri.tabCi')}
          </button>
          <button
            id="tab-btn-config-files"
            type="button"
            onClick={() => setActiveTab('config')}
            aria-pressed={activeTab === 'config'}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'config'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('tauri.tabConfig')}
          </button>
        </div>

        {/* Content area */}
        <div id="tauri-tab-body" className="p-4 sm:p-6 space-y-4 overflow-y-auto text-xs text-slate-300">
          {activeTab === 'build' && (
            <div className="space-y-4">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  {t('tauri.buildHeading')}
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  {t('tauri.buildBody')}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-slate-200">
                    {t('tauri.cmdLabel')}
                  </span>
                  <div className="flex items-center gap-2">
                    <a
                      id="download-build-bat-btn"
                      href="/api/export/tauri-installer-guide"
                      download="build-windows-exe.bat"
                      className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-sky-400 px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] transition-colors"
                      title={t('tauri.batTitle')}
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>{t('tauri.batBtn')}</span>
                    </a>
                    <button
                      id="copy-tauri-cmd-btn"
                      type="button"
                      onClick={() => void handleCopyCmd()}
                      className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] transition-colors"
                    >
                      {copiedCmd === null ? (
                        <>
                          <Copy className="w-3 h-3 text-slate-400" aria-hidden="true" />
                          <span>{t('common.copy')}</span>
                        </>
                      ) : copiedCmd ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                          <span className="text-emerald-400">{t('common.copied')}</span>
                        </>
                      ) : (
                        <>
                          <X className="w-3 h-3 text-rose-400" aria-hidden="true" />
                          <span className="text-rose-400">{t('common.copyFailed')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <pre id="tauri-commands-codeblock" className="bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 text-xs font-mono text-sky-300 overflow-x-auto select-all">
                  {buildCommand}
                </pre>
                {/* Localized clipboard feedback for screen readers. */}
                <span className="sr-only" role="status">
                  {copiedCmd === null ? '' : copiedCmd ? t('common.copied') : t('common.copyFailed')}
                </span>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h4 className="font-semibold text-slate-200 mb-1.5 flex items-center gap-1.5">
                  <Box className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                  <span>{t('tauri.deliverables')}</span>
                </h4>
                <p className="text-slate-400 mb-2 text-xs">
                  {t('tauri.deliverablesIntro')}
                </p>
                <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                  <li className="bg-slate-950 p-2 rounded border border-slate-950/10 dark:border-white/[0.06]">
                    {t('tauri.nsisLine')} <span className="text-emerald-300">src-tauri/target/release/bundle/nsis/Fress_1.0.0_x64-setup.exe</span>
                  </li>
                  <li className="bg-slate-950 p-2 rounded border border-slate-950/10 dark:border-white/[0.06]">
                    {t('tauri.msiLine')} <span className="text-emerald-300">src-tauri/target/release/bundle/msi/Fress_1.0.0_x64_en-US.msi</span>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'github' && (
            <div className="space-y-3">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  {t('tauri.ciHeading')}
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  {ciBodyParts[0]}
                  <code className="text-sky-300 font-mono">.github/workflows/build-windows-exe.yml</code>
                  {ciBodyTail[0]}
                  <code className="text-sky-300 font-mono">.exe</code>
                  {ciBodyTail[1] || ''}
                </p>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02] space-y-2">
                <h4 className="font-semibold text-slate-200 text-xs">
                  {t('tauri.ciStepsTitle')}
                </h4>
                <ol className="list-decimal list-inside space-y-1 text-slate-300 text-xs">
                  <li>{t('tauri.ciStep1')}</li>
                  <li>
                    {t('tauri.ciStep2').split('{tab}')[0]}
                    <strong className="text-slate-100">Actions</strong>
                    {t('tauri.ciStep2').split('{tab}')[1] || ''}
                  </li>
                  <li>
                    {t('tauri.ciStep3').split('{workflow}')[0]}
                    <strong className="text-slate-100">Build Windows Tauri Installer</strong>
                    {t('tauri.ciStep3').split('{workflow}')[1] || ''}
                  </li>
                  <li>
                    {t('tauri.ciStep4').split('{run}')[0]}
                    <strong className="text-slate-100">Run workflow</strong>
                    {t('tauri.ciStep4').split('{run}')[1] || ''}
                  </li>
                  <li>
                    {t('tauri.ciStep5').split('{artifact}')[0]}
                    <code className="font-mono text-sky-300">Fress_setup.exe</code>
                    {t('tauri.ciStep5').split('{artifact}')[1] || ''}
                  </li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'config' && (
            <div className="space-y-3">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  {t('tauri.configHeading')}
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  {t('tauri.configBody')}
                </p>
                <ul className="mt-2 space-y-1 text-slate-300 font-mono text-[11px]">
                  <li>• <strong className="text-sky-300">src-tauri/tauri.conf.json</strong> {t('tauri.confItem1')}</li>
                  <li>• <strong className="text-sky-300">src-tauri/Cargo.toml</strong> {t('tauri.confItem2')}</li>
                  <li>• <strong className="text-sky-300">src-tauri/src/main.rs</strong> {t('tauri.confItem3')}</li>
                  <li>• <strong className="text-sky-300">src-tauri/build.rs</strong> {t('tauri.confItem4')}</li>
                  <li>• <strong className="text-sky-300">.github/workflows/build-windows-exe.yml</strong> {t('tauri.confItem5')}</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div id="tauri-modal-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            {t('tauri.footerNote')}
          </span>
          <button
            id="close-tauri-done-btn"
            type="button"
            onClick={onClose}
            className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-4 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
