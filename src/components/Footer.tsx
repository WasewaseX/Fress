import React from 'react';
import { ShieldCheck, Download, ExternalLink } from 'lucide-react';
import { LegalTab } from './LegalModals';

interface FooterProps {
  onOpenLegal: (tab: LegalTab) => void;
  onOpenPrivacyAudit: () => void;
  onOpenTauriModal: () => void;
}

export const Footer: React.FC<FooterProps> = ({
  onOpenLegal,
  onOpenPrivacyAudit,
  onOpenTauriModal
}) => {
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
                MIT Licensed
              </span>
            </div>
            <p id="footer-brand-desc" className="text-[11px] text-slate-400 max-w-xl leading-relaxed">
              Curated free and open-source applications directory inspired by Axorax/awesome-free-apps. Local-first, privacy-respecting, and community-maintained.
            </p>
          </div>

          <div id="footer-actions-group" className="flex items-center flex-wrap gap-2 text-xs">
            <button
              id="footer-privacy-audit-btn"
              type="button"
              onClick={onOpenPrivacyAudit}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-850 px-2.5 py-1 rounded border border-slate-800 transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>Privacy & Tracking Check</span>
            </button>

            <button
              id="footer-tauri-installer-btn"
              type="button"
              onClick={onOpenTauriModal}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-900 hover:bg-slate-850 px-2.5 py-1 rounded border border-slate-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>Windows .exe Installer</span>
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
              Privacy Policy
            </button>
            <button
              id="footer-link-terms"
              type="button"
              onClick={() => onOpenLegal('terms')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              Terms & Conditions
            </button>
            <button
              id="footer-link-cookies"
              type="button"
              onClick={() => onOpenLegal('cookies')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              Cookies Policy
            </button>
            <button
              id="footer-link-consent"
              type="button"
              onClick={() => onOpenLegal('consent')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              Cookie Consent Preferences
            </button>
            <button
              id="footer-link-refund"
              type="button"
              onClick={() => onOpenLegal('refund')}
              className="hover:text-slate-200 underline underline-offset-2"
            >
              Refund Policy & Free Guarantee
            </button>
          </div>

          <p id="footer-compliance-notice" className="text-slate-400 text-[11px]">
            Zero telemetry. Local storage only. WCAG AA compliant.
          </p>
        </div>
      </div>
    </footer>
  );
};
