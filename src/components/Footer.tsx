import React from 'react';
import { ShieldCheck, Download } from 'lucide-react';
import { LegalTab } from './LegalModals';
import { openExternal } from '../lib/external';
import { useI18n } from '../lib/i18n';

interface FooterProps {
  onOpenLegal: (tab: LegalTab) => void;
  onOpenPrivacyAudit: () => void;
  onOpenTauriModal: (tab?: 'install' | 'why' | 'build') => void;
}

export const Footer: React.FC<FooterProps> = ({
  onOpenLegal,
  onOpenPrivacyAudit,
  onOpenTauriModal
}) => {
  const { t } = useI18n();
  return (
    <footer id="main-app-footer" className="border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 py-8 px-4 sm:px-6 text-xs text-slate-400">
      <div className="max-w-7xl mx-auto space-y-6">
        <div id="footer-top-row" className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span id="footer-brand-name" className="font-bold text-slate-200">
                Fress
              </span>
              <span id="footer-license-badge" className="text-[11px] font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded text-slate-400">
                MIT Licensed
              </span>
            </div>
            <p id="footer-brand-desc" className="text-[11px] text-slate-400 max-w-xl leading-relaxed">
              {t('footer.description')} Inspired by Axorax/awesome-free-apps.
            </p>
          </div>

          <div id="footer-actions-group" className="flex items-center flex-wrap gap-2 text-xs">
            <button
              id="footer-privacy-audit-btn"
              type="button"
              onClick={onOpenPrivacyAudit}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-850 px-2.5 py-1 rounded border border-slate-950/10 dark:border-white/[0.08] transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>{t('footer.privacyCheck')}</span>
            </button>

            <a
              id="footer-get-fress-btn"
              href="https://github.com/WasewaseX/Fress/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); void openExternal('https://github.com/WasewaseX/Fress/releases/latest'); }}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-850 px-2.5 py-1 rounded border border-slate-950/10 dark:border-white/[0.08] transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>{t('footer.getFress')}</span>
            </a>

            <button
              id="footer-tauri-installer-btn"
              type="button"
              onClick={() => onOpenTauriModal('build')}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-850 px-2.5 py-1 rounded border border-slate-950/10 dark:border-white/[0.08] transition-colors"
              title="For developers: how to build the desktop installer from source"
            >
              <span>{t('footer.buildGuide')}</span>
            </button>
          </div>
        </div>

        {/* Legal & Compliance navigation links */}
        <div id="footer-legal-row" className="pt-4 border-t border-slate-850 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11px]">
          <div id="footer-legal-links" className="flex items-center flex-wrap gap-x-4 gap-y-2 text-slate-400">
            <button
              id="footer-link-privacy"
              type="button"
              onClick={() => onOpenLegal('privacy')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.privacy')}
            </button>
            <button
              id="footer-link-terms"
              type="button"
              onClick={() => onOpenLegal('terms')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.terms')}
            </button>
            <button
              id="footer-link-cookies"
              type="button"
              onClick={() => onOpenLegal('cookies')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.cookies')}
            </button>
            <button
              id="footer-link-consent"
              type="button"
              onClick={() => onOpenLegal('consent')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.consent')}
            </button>
            <button
              id="footer-link-refund"
              type="button"
              onClick={() => onOpenLegal('refund')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              {t('legal.refund')}
            </button>
          </div>

          <p id="footer-compliance-notice" className="text-slate-400 text-[11px]">
            {t('footer.compliance')}
          </p>
        </div>
      </div>
    </footer>
  );
};
