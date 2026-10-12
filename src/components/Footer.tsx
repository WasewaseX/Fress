// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState } from 'react';
import { RefreshCw, Check, Download, ExternalLink } from 'lucide-react';
import { LegalTab } from './LegalModals';
import { openExternal } from '../lib/external';
import { useDownloadActions } from '../lib/downloads';
import { checkForUpdate, planUpdateDelivery, UpdateState } from '../lib/selfUpdate';
import { useI18n } from '../lib/i18n';
import pkg from '../../package.json';

interface FooterProps {
  onOpenLegal: (tab: LegalTab) => void;
  onOpenTauriModal: () => void;
}

/** Replaces the old "Get Fress" link: checks GitHub for a newer release and
 *  only downloads when your installed version is behind. */
const UpdateButton: React.FC = () => {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const { startDownload } = useDownloadActions();
  const { t } = useI18n();

  const run = async () => {
    if (state.kind === 'checking') return;
    setState({ kind: 'checking' });
    const next = await checkForUpdate(pkg.version);
    setState(next);
  };

  const startUpdate = () => {
    if (state.kind !== 'available') return;
    // Same shared decision as the header update pill (useSelfUpdate):
    // download ONLY when the published SHA-256 entry is in hand; otherwise
    // open the releases page instead of delivering an unverified installer.
    const plan = planUpdateDelivery(state.release, state.asset, state.expectedSha256);
    if (plan.kind === 'download') {
      void startDownload(plan.asset.url, plan.asset.name, { expectedSha256: plan.sha256 });
    } else {
      void openExternal(plan.release.htmlUrl);
    }
  };

  const label = (() => {
    switch (state.kind) {
      case 'idle':
        return t('update.check');
      case 'checking':
        return t('update.checking');
      case 'latest':
        return t('update.uptodate');
      case 'available':
        return state.asset
          ? `${t('update.download')} v${state.release.version}`
          : t('update.available');
      case 'error':
        return t('update.error');
    }
  })();

  const icon = (() => {
    if (state.kind === 'checking') return <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />;
    if (state.kind === 'latest') return <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />;
    if (state.kind === 'available') return <Download className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />;
    return <RefreshCw className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />;
  })();

  const active = state.kind === 'idle' || state.kind === 'error';
  const primary = state.kind === 'available';

  return (
    <button
      id="footer-update-btn"
      type="button"
      onClick={() => void (state.kind === 'available' ? startUpdate() : run())}
      disabled={!active && state.kind !== 'available'}
      title={t('update.tooltip')}
      aria-live="polite"
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border transition-colors ${
        primary
          ? 'bg-sky-600 hover:bg-sky-500 text-white border-sky-500 font-semibold'
          : 'text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-800 border-slate-800'
      }`}
    >
      {icon}
      <span>{label}</span>
      {state.kind === 'available' && !state.asset && <ExternalLink className="w-3 h-3" aria-hidden="true" />}
    </button>
  );
};

export const Footer: React.FC<FooterProps> = ({
  onOpenLegal,
  onOpenTauriModal
}) => {
  const { t } = useI18n();

  return (
    <footer id="main-app-footer" className="border-t border-slate-800 bg-slate-950 py-8 px-4 sm:px-6 text-xs text-slate-400">
      <div className="max-w-7xl mx-auto space-y-6">
        <div id="footer-top-row" className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span id="footer-brand-name" className="font-bold text-slate-200">
                Fress
              </span>
              <span id="footer-license-badge" className="text-[11px] font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded text-slate-400">
                {t('footer.licenseBadge')}
              </span>
            </div>
            <p id="footer-brand-desc" className="text-[11px] text-slate-400 max-w-xl leading-relaxed">
              {t('footer.description')}
            </p>
          </div>

          <div id="footer-actions-group" className="flex items-center flex-wrap gap-2 text-xs">
            <UpdateButton />

            <button
              id="footer-tauri-installer-btn"
              type="button"
              onClick={onOpenTauriModal}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-800 px-2.5 py-1 rounded border border-slate-800 transition-colors"
              title={t('footer.installerGuideTip')}
            >
              <span>{t('footer.installerGuide')}</span>
            </button>
          </div>
        </div>

        {/* Legal links */}
        <div id="footer-legal-row" className="pt-4 border-t border-slate-850 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11px]">
          <div id="footer-legal-links" className="flex items-center flex-wrap gap-x-4 gap-y-2 text-slate-400">
            <button
              id="footer-link-privacy"
              type="button"
              onClick={() => onOpenLegal('privacy')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.tabPrivacy')}
            </button>
            <button
              id="footer-link-terms"
              type="button"
              onClick={() => onOpenLegal('terms')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.tabTerms')}
            </button>
          </div>

        </div>
      </div>
    </footer>
  );
};
