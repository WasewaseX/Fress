import React from 'react';
import { Cookie, Check, Shield } from 'lucide-react';
import { CookieConsentState } from '../types';

interface CookieBannerProps {
  cookieConsent: CookieConsentState;
  onAcceptNecessary: () => void;
  onAcceptAll: () => void;
  onOpenPreferences: () => void;
}

export const CookieBanner: React.FC<CookieBannerProps> = ({
  cookieConsent,
  onAcceptNecessary,
  onAcceptAll,
  onOpenPreferences
}) => {
  if (cookieConsent.decided) return null;

  return (
    <aside 
      className="fixed bottom-0 inset-x-0 z-40 bg-slate-950 border-t border-slate-800 p-3 sm:p-4 shadow-2xl"
      aria-label="Cookie and storage notice"
    >
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
        <div className="flex items-start gap-2.5">
          <Cookie className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-slate-200 font-medium">
              Privacy-First Storage Notice
            </p>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              We store your bookmarks and custom added applications locally on your machine. We do not use third-party advertising or telemetry tracking cookies.
            </p>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenPreferences}
            className="text-slate-300 hover:text-slate-100 bg-slate-800 hover:bg-slate-750 border border-slate-700 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            aria-label="Customize storage and cookie preferences"
          >
            Customize
          </button>
          <button
            type="button"
            onClick={onAcceptNecessary}
            className="text-slate-200 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-600 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
            aria-label="Accept strictly necessary local storage only"
          >
            Essential Only
          </button>
          <button
            type="button"
            onClick={onAcceptAll}
            className="text-white bg-sky-600 hover:bg-sky-500 border border-sky-500 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors"
            aria-label="Accept all local storage preferences"
          >
            Accept All
          </button>
        </div>
      </div>
    </aside>
  );
};
