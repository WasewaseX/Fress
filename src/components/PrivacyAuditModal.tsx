import React from 'react';
import {
  X,
  CheckCircle2,
  Lock,
  EyeOff,
  Keyboard,
  ShieldCheck
} from 'lucide-react';
import { useModalA11y } from '../lib/modalA11y';

interface PrivacyAuditModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Privacy facts you can actually verify in this build — no self-certified
 * "audits", no invented server headers, no network calls from this panel.
 */
const FACTS: Array<{ title: string; detail: string }> = [
  {
    title: 'No telemetry or analytics',
    detail:
      'There is no analytics SDK, pixel, or beacon anywhere in the app. The only network traffic Fress itself initiates is release lookups and downloads from the hosts you explicitly interact with (GitHub, F-Droid, and Mozilla\'s download CDN for Thunderbird), plus searches you trigger in Live Search.',
  },
  {
    title: 'Local-first storage',
    detail:
      'Everything personal lives on your device: custom tools, bookmarks, theme, language, consent choices, and your download folder preference. Nothing is uploaded — there is no Fress server.',
  },
  {
    title: 'Strict Content Security Policy',
    detail:
      'The desktop app enforces a CSP that forbids inline scripts and forbids the webview from fetching anything remote. Release lookups, searches, and downloads all happen in the Rust core; scripts and fonts are bundled locally.',
  },
  {
    title: 'External links are sanitized',
    detail:
      'Every external link opens through the system browser with rel="noopener noreferrer", and the download engine only accepts https URLs from official release hosts (GitHub, F-Droid, Mozilla).',
  },
  {
    title: 'Checksums you can check',
    detail:
      'Downloads are hashed with SHA-256 while they stream; the hash is shown in the Downloads panel so you can compare it against the values published by each project.',
  },
];

export const PrivacyAuditModal: React.FC<PrivacyAuditModalProps> = ({ isOpen, onClose }) => {
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;

  return (
    <div
      id="privacy-audit-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 fr-backdrop backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-audit-title"
      onClick={onClose}
    >
      <div
        id="privacy-audit-modal-container"
        ref={containerRef}
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="privacy-audit-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between bg-slate-900">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span id="audit-live-badge" className="text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                Verifiable facts
              </span>
            </div>
            <h2 id="privacy-audit-title" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              Privacy &amp; Security
            </h2>
            <p id="privacy-audit-desc" className="text-xs text-slate-400 mt-0.5">
              What this app does and does not do — stated so you can check it yourself.
            </p>
          </div>
          <button
            id="close-privacy-audit-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div id="privacy-audit-body" className="p-4 sm:p-6 space-y-3 overflow-y-auto text-xs text-slate-300">
          <div id="audit-facts-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>What we can prove</span>
            </h3>
            <ul className="space-y-2.5">
              {FACTS.map((fact) => (
                <li key={fact.title} className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-slate-200">{fact.title}:</strong>
                    <span className="text-slate-400 ml-1">{fact.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div id="audit-storage-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <EyeOff className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>Every key we store (all local)</span>
            </h3>
            <ul className="font-mono text-[11px] text-slate-400 space-y-1">
              <li>fress.customItems — tools you added</li>
              <li>fress.favorites — your bookmarks</li>
              <li>fress.theme / fress.lang — appearance and language</li>
              <li>fress.viewMode — grid or table preference</li>
              <li>fress.cookieConsent — your consent choices</li>
              <li>fress.downloadDir — your chosen download folder</li>
            </ul>
          </div>

          <div id="audit-keys-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <Keyboard className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              <span>Keyboard friendly</span>
            </h3>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Every control is reachable by keyboard with a visible focus ring, Escape closes dialogs, and the
              interface respects your system reduced-motion setting. Press <code className="font-mono text-sky-300">?</code> shortcuts via the “...” menu to see the full list.
            </p>
          </div>

          <div id="audit-crypto-box" className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>Honest limits</span>
            </h3>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Fress is a directory, not an antivirus: it never runs installers for you and cannot vouch for the
              contents of a project&apos;s release files. Installers are not code-signed by Fress, so your OS may show a
              standard warning the first time you run a downloaded build — verify the SHA-256 above against the
              project&apos;s published checksums when in doubt.
            </p>
          </div>
        </div>

        <div id="privacy-audit-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-end">
          <button
            id="close-privacy-audit-footer-btn"
            type="button"
            onClick={onClose}
            className="text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 px-4 py-2 rounded-lg border border-slate-950/10 dark:border-white/[0.1] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
