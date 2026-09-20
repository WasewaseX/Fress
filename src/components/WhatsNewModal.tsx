import React, { useEffect, useRef } from 'react';
import { Sparkles, Check } from 'lucide-react';
import { whatsNewFor } from '../data/whatsNew';
import pkg from '../../package.json';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * "What's new" release notes. Opens by itself on the first launch after an
 * update (App.tsx decides when) and stays reachable from the header menu.
 */
export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus the dialog when it opens so keyboard users land inside it.
  useEffect(() => {
    if (isOpen) {
      modalRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const entry = whatsNewFor(pkg.version);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsnew-heading"
        aria-describedby="whatsnew-desc"
        tabIndex={-1}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl shadow-2xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-950/10 dark:border-white/[0.08]">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h2 id="whatsnew-heading" className="text-base font-bold text-slate-100 tracking-tight">
              What&apos;s new in Fress
            </h2>
            <span
              id="whatsnew-version-chip"
              className="text-[11px] font-mono font-semibold text-slate-400 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded"
            >
              v{entry.version}
            </span>
          </div>
          <p id="whatsnew-desc" className="text-xs text-slate-400 leading-relaxed">
            {entry.title}
          </p>
        </div>

        {/* Notes */}
        <div id="whatsnew-items" className="p-5 space-y-3">
          {entry.items.map((item, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-slate-300 leading-relaxed">{item}</p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 pt-1 flex items-center justify-end border-t border-slate-950/10 dark:border-white/[0.08]">
          <button
            id="whatsnew-continue-btn"
            type="button"
            onClick={onClose}
            className="mt-3 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-4 py-1.5 rounded-md border border-sky-500 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
