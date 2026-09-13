import React, { useState } from 'react';
import {
  X,
  CheckCircle2,
  Check
} from 'lucide-react';
import { CookieConsentState } from '../types';

export type LegalTab = 'privacy' | 'terms' | 'consent';

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
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);
  const [functional, setFunctional] = useState(cookieConsent.functional);
  const [analytics, setAnalytics] = useState(cookieConsent.analytics);
  const [savedNotice, setSavedNotice] = useState(false);

  // Re-sync the requested tab each time the modal opens (state persists between opens)
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setFunctional(cookieConsent.functional);
      setAnalytics(cookieConsent.analytics);
    }
  }, [isOpen, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  const save = (functionalValue: boolean, analyticsValue: boolean) => {
    setFunctional(functionalValue);
    setAnalytics(analyticsValue);
    onUpdateCookieConsent({
      decided: true,
      essential: true,
      functional: functionalValue,
      analytics: analyticsValue,
      updatedAt: new Date().toISOString()
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const tabClass = (id: LegalTab) => `py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
    activeTab === id
      ? 'border-sky-500 text-sky-400'
      : 'border-transparent text-slate-400 hover:text-slate-200'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-modal-heading"
    >
      <div
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between bg-slate-900">
          <h2 id="legal-modal-heading" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
            Privacy & terms
          </h2>
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
          <button type="button" onClick={() => setActiveTab('privacy')} className={tabClass('privacy')}>
            Privacy
          </button>
          <button type="button" onClick={() => setActiveTab('terms')} className={tabClass('terms')}>
            Terms
          </button>
          <button type="button" onClick={() => setActiveTab('consent')} className={tabClass('consent')}>
            Storage preferences
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto text-xs text-slate-300 leading-relaxed">
          {activeTab === 'privacy' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">What Fress collects</h3>
              <p>
                Short answer: nothing. Fress has no accounts, no servers and no analytics. Your bookmarks, the apps you add, and your settings live in this device's local storage and never leave it.
              </p>
              <p>
                When you click a link to a project's GitHub page or website, your browser talks to that site directly. Fress adds nothing to those requests and sees none of them.
              </p>
            </div>
          )}

          {activeTab === 'terms' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">Terms</h3>
              <p>
                Fress is a directory. It lists other people's software and links to their official downloads; it does not host or modify anything. Every app keeps its own license (MIT, GPL, Apache, and so on) — read and respect the license of whatever you install.
              </p>
              <p>
                The catalog is provided as-is. We check links and facts when we list an app, but projects change and we are not liable for what happens after you leave the app. If you add custom entries yourself, they are yours, not ours.
              </p>
            </div>
          )}

          {activeTab === 'consent' && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-100">Storage preferences</h3>
              <p className="text-slate-400">
                What Fress keeps on this device.
              </p>

              <div className="space-y-2.5 pt-2">
                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="text-slate-100">Bookmarks & your apps</strong>
                      <span className="text-[11px] bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded border border-slate-700">
                        always on
                      </span>
                    </div>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Needed for the app to work at all. Stored locally only.
                    </p>
                  </div>
                  <input type="checkbox" checked={true} disabled={true} className="w-4 h-4 rounded text-sky-600 bg-slate-800 border-slate-700 opacity-60" />
                </div>

                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-slate-100">Filters & view</strong>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Remembers your sorting, category and view choices between sessions.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={functional}
                    onChange={(e) => setFunctional(e.target.checked)}
                    className="w-4 h-4 rounded text-sky-600 bg-slate-900 border-slate-700 focus:ring-sky-500 cursor-pointer"
                  />
                </div>

                <div className="bg-slate-950 border border-slate-800 p-3 rounded flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-slate-100">Diagnostics</strong>
                    <p className="text-slate-400 text-[11px] mt-0.5">
                      Optional local error logging. Nothing is sent anywhere; there is nowhere to send it.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={analytics}
                    onChange={(e) => setAnalytics(e.target.checked)}
                    className="w-4 h-4 rounded text-sky-600 bg-slate-900 border-slate-700 focus:ring-sky-500 cursor-pointer"
                  />
                </div>
              </div>

              {savedNotice && (
                <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 p-2 rounded flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  <span>Saved.</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => save(true, true)}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md border border-slate-700"
                >
                  Keep everything
                </button>
                <button
                  type="button"
                  onClick={() => save(functional, analytics)}
                  className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-1.5 rounded-md border border-sky-500 inline-flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            No telemetry. Everything stays on this device.
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
