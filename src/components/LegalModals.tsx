import React, { useState, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { X } from 'lucide-react';

export type LegalTab = 'privacy' | 'terms';

interface LegalModalsProps {
  isOpen: boolean;
  initialTab?: LegalTab;
  onClose: () => void;
}

export const LegalModals: React.FC<LegalModalsProps> = ({
  isOpen,
  initialTab = 'privacy',
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);

  // Re-sync the requested tab each time the modal opens (state persists between opens)
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen);
  if (!isOpen) return null;

  const tabClass = (id: LegalTab) => `py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
    activeTab === id
      ? 'border-sky-500 text-sky-400'
      : 'border-transparent text-slate-400 hover:text-slate-200'
  }`;

  return (
    <div
      ref={panelRef}
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
            Privacy &amp; terms
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
                Fress is a directory. It lists other people's software and links to their official downloads; it does not host or modify anything. Every app keeps its own license (MIT, GPL, Apache, and so on). Read and respect the license of whatever you install.
              </p>
              <p>
                The catalog is provided as-is. We check links and facts when we list an app, but projects change and we are not liable for what happens after you leave the app. If you add custom entries yourself, they are yours, not ours.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-end">
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
