import React, { useState } from 'react';
import { useModalA11y } from '../lib/modalA11y';
import { X, CheckCircle2 } from 'lucide-react';
import { CookieConsentState } from '../types';

export type LegalTab = 'privacy' | 'terms' | 'cookies' | 'refund' | 'consent';

interface LegalModalsProps {
  isOpen: boolean;
  initialTab?: LegalTab;
  onClose: () => void;
  cookieConsent: CookieConsentState;
  onUpdateCookieConsent: (consent: CookieConsentState) => void;
}

export const LegalModals: React.FC<LegalModalsProps> = ({
  isOpen,
  initialTab = 'privacy',
  onClose,
  cookieConsent,
  onUpdateCookieConsent
}) => {
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);

  // Re-sync the requested tab each time the modal opens (state persists between opens)
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);
  const [functionalCookies, setFunctionalCookies] = useState(cookieConsent.functional);
  const [analyticsCookies, setAnalyticsCookies] = useState(cookieConsent.analytics);
  const [savedNotice, setSavedNotice] = useState(false);

  if (!isOpen) return null;

  const handleSaveCookiePreferences = () => {
    onUpdateCookieConsent({
      decided: true,
      essential: true,
      functional: functionalCookies,
      analytics: analyticsCookies,
      updatedAt: new Date().toISOString()
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleAcceptAll = () => {
    setFunctionalCookies(true);
    setAnalyticsCookies(true);
    onUpdateCookieConsent({
      decided: true,
      essential: true,
      functional: true,
      analytics: true,
      updatedAt: new Date().toISOString()
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fr-backdrop backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-modal-heading"
    >
      <div 
 ref={containerRef}
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between bg-slate-900">
          <div className="flex items-center gap-2">
            <h2 id="legal-modal-heading" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              Legal, Policies & Compliance
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Close legal documents dialog"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950 px-4 text-xs overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('privacy')}
            className={`py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === 'privacy'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Privacy Policy
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('terms')}
            className={`py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === 'terms'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Terms of Use
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('cookies')}
            className={`py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === 'cookies'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Cookies Policy
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('consent')}
            className={`py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === 'consent'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Preferences
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('refund')}
            className={`py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === 'refund'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Free Guarantee
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto text-xs text-slate-300 leading-relaxed">
          {activeTab === 'privacy' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Privacy Policy (Local-First Architecture)
              </h3>
              <p className="text-slate-400 text-[11px]">
                Effective Date: September 2025. Last updated: September 2025.
              </p>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-200">1. Zero Telemetry Commitment</h4>
                <p>
                  Fress does not track, collect, sell, or transmit personal data, device identifiers, or browsing histories. This software operates on a client-side, local-first architecture.
                </p>

                <h4 className="font-bold text-slate-200">2. Local Storage Usage</h4>
                <p>
                  Any applications you add to your custom library, favorite bookmarks, and interface preferences are stored directly in your web browser local storage or local application container. They are never uploaded to any remote server.
                </p>

                <h4 className="font-bold text-slate-200">3. Outbound External Links</h4>
                <p>
                  When clicking external links to GitHub repositories or official software websites, requests connect directly from your browser to those respective third-party domains. All links contain <code className="font-mono text-sky-300">rel="noopener noreferrer"</code> to protect your privacy and prevent referrer header leakage. One feature intentionally contacts a third-party API: Live Search sends the text you type to GitHub&apos;s public search endpoint so it can suggest repositories — nothing else is transmitted, and the query is not stored by Fress.
                </p>

                <h4 className="font-bold text-slate-200">4. Third-Party Analytics</h4>
                <p>
                  This application does not load Google Analytics, Meta Pixel, tracking pixels, or cross-site tracking beacons.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'terms' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Terms and Conditions of Use
              </h3>
              <p className="text-slate-400 text-[11px]">
                Effective Date: September 2025.
              </p>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-200">1. Directory Purpose</h4>
                <p>
                  Fress is an educational and informational directory dedicated to organizing verified free and open-source applications for beginners and professionals without commercial paywalls or deceptive monetization.
                </p>

                <h4 className="font-bold text-slate-200">2. Software Licenses</h4>
                <p>
                  Each cataloged application retains its individual open-source or freeware license (such as MIT, GPL-2.0, GPL-3.0, Apache-2.0, MPL, or Freeware). Users must comply with the licensing terms provided by each respective software project.
                </p>

                <h4 className="font-bold text-slate-200">3. User Submitted Software & Quality Standards</h4>
                <p>
                  Users who add custom applications to their local library or propose entries confirm that the software is free from malware, adware, cryptocurrency mining payloads, and predatory monetization tactics.
                </p>

                <h4 className="font-bold text-slate-200">4. Disclaimer of Warranty</h4>
                <p>
                  This directory provides information on an as-is basis without warranties of any kind. Users are encouraged to verify hashes and download exclusively from verified official project websites or trusted repositories.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'cookies' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Cookies and Local Storage Policy
              </h3>
              <p className="text-slate-400 text-[11px]">
                Transparent explanation of local storage usage.
              </p>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-200">1. What We Store</h4>
                <p>
                  We do not use tracking cookies or marketing cookies. We strictly utilize browser Web Storage (localStorage) to remember:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-300 pl-1">
                  <li>Your bookmarked favorite tools.</li>
                  <li>Custom applications you have added to your library.</li>
                  <li>Your active cookie consent preferences.</li>
                  <li>Active view sorting choices.</li>
                  <li>Your theme, language, and chosen download folder.</li>
                </ul>

                <h4 className="font-bold text-slate-200">2. Cookie Categories</h4>
                <div className="bg-slate-950 p-2.5 rounded border border-slate-800 space-y-1.5">
                  <p>
                    <strong className="text-emerald-400">Strictly Essential:</strong> Required for the application to function (storing your saved applications and preferences locally).
                  </p>
                  <p>
                    <strong className="text-slate-400">Marketing & Tracking:</strong> Disabled by default (0 cookies created, 0 trackers loaded).
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'consent' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Cookie Consent and Preferences Manager
              </h3>
              <p className="text-slate-400">
                Configure how data is stored in your browser for this application.
              </p>

              <div className="space-y-2.5 pt-2">
                {/* Essential */}
                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="text-slate-100">Essential Local Storage</strong>
                      <span className="text-[11px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                        Always Active
                      </span>
                    </div>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Required for storing your bookmarks, custom added tools, and application filter state in your local browser memory.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={true}
                    disabled={true}
                    className="w-4 h-4 rounded text-sky-600 bg-slate-800 border-slate-700 opacity-60"
                  />
                </div>

                {/* Functional */}
                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-slate-100">Functional Storage</strong>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Remembers your language, theme, view mode, and download-folder preference between sessions. Nothing here is shared or synced.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={functionalCookies}
                    onChange={(e) => setFunctionalCookies(e.target.checked)}
                    className="w-4 h-4 rounded text-sky-600 bg-slate-900 border-slate-700 focus:ring-sky-500 cursor-pointer"
                  />
                </div>

                {/* Analytics */}
                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-slate-100">Aggregated Diagnostic Metrics</strong>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Currently unused: Fress collects no diagnostics at all — local or remote. The toggle is kept so your consent choice stays future-proof; nothing changes today.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={analyticsCookies}
                    onChange={(e) => setAnalyticsCookies(e.target.checked)}
                    className="w-4 h-4 rounded text-sky-600 bg-slate-900 border-slate-700 focus:ring-sky-500 cursor-pointer"
                  />
                </div>
              </div>

              {savedNotice && (
                <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 p-2 rounded flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  <span>Your cookie preferences have been successfully updated.</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={handleAcceptAll}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md border border-slate-700"
                >
                  Accept All
                </button>
                <button
                  type="button"
                  onClick={handleSaveCookiePreferences}
                  className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-1.5 rounded-md border border-sky-500"
                >
                  Save Preferences
                </button>
              </div>
            </div>
          )}

          {activeTab === 'refund' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">
                Refund Policy and Free Software Guarantee
              </h3>
              <p className="text-slate-400 text-[11px]">
                100% Free and Open-Source Guarantee.
              </p>

              <div className="bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] p-3.5 rounded-lg space-y-2">
                <h4 className="font-bold text-slate-200">1. Zero Monetary Charges</h4>
                <p>
                  Fress is completely free to use. We do not charge subscription fees, one-time fees, credit card authorizations, or hidden in-app payments.
                </p>

                <h4 className="font-bold text-slate-200">2. Refund Applicability</h4>
                <p>
                  Because this application collects zero monetary payments and charges no fees, traditional financial refunds do not apply. You will never be billed by Fress.
                </p>

                <h4 className="font-bold text-slate-200">3. Third-Party Software Donations</h4>
                <p>
                  If you choose to donate directly to independent open-source developers (for instance donating to Blender Foundation or VideoLAN), those contributions are subject to each developer's respective organization donation and refund terms.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            Compliance status: local-first by design (no personal data ever leaves your device)
          </span>
          <button
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
