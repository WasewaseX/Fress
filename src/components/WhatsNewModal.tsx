import React from 'react';
import { X, Check, Sparkles, ExternalLink } from 'lucide-react';
import { BrandMark } from './Header';
import { notesForVersion } from '../lib/releaseNotes';
import { openExternal } from '../lib/external';
import pkg from '../../package.json';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CHANGELOG_URL = 'https://github.com/WasewaseX/Fress/blob/main/CHANGELOG.md';

/**
 * "What's new" — a small, calm summary of the release you just updated to.
 * Opened automatically once per version (see App.tsx) and reachable any time
 * from the header menu. Reading it marks nothing; the version is recorded on
 * launch regardless of whether the popup was dismissed.
 */
export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const note = notesForVersion(pkg.version);

  return (
    <div
      id="whats-new-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      onClick={onClose}
    >
      <div
        id="whats-new-modal"
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-950/10 dark:border-white/[0.06] flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <BrandMark size={36} />
            <div className="min-w-0">
              <h2 id="whats-new-title" className="text-base font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-sky-400" aria-hidden="true" />
                <span>What's new in Fress</span>
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                v{note ? note.version : pkg.version}
                {note ? ` · ${note.date}` : ''}
              </p>
            </div>
          </div>
          <button
            id="whats-new-close-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors shrink-0"
            aria-label="Close what's new"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[55vh] overflow-y-auto">
          {note ? (
            <>
              <p className="text-sm font-semibold text-slate-100 mb-3">{note.title}</p>
              <ul className="space-y-2.5">
                {note.items.map((item, i) => (
                  <li key={i} id={`whats-new-item-${i}`} className="flex items-start gap-2.5 text-[13px] text-slate-300 leading-relaxed">
                    <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[13px] text-slate-300 leading-relaxed">
              Fress was updated to v{pkg.version}. This build brings small fixes and polish.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.06] flex items-center justify-between gap-3">
          <button
            id="whats-new-changelog-btn"
            type="button"
            onClick={() => void openExternal(CHANGELOG_URL)}
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <span>Full changelog</span>
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </button>
          <button
            id="whats-new-got-it-btn"
            type="button"
            onClick={onClose}
            className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-4 py-1.5 rounded-lg border border-sky-500 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
