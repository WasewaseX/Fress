import React, { useEffect, useState, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { X, Check, Sparkles, ExternalLink, Wrench, RefreshCw, Minus, ChevronDown } from 'lucide-react';
import { BrandMark } from './Header';
import { notesForVersion } from '../lib/releaseNotes';
import { CHANGELOG_ENTRIES, changelogForVersion, earlierChangelog, ChangelogSection } from '../lib/changelog';
import { openExternal } from '../lib/external';
import pkg from '../../package.json';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CHANGELOG_URL = 'https://github.com/WasewaseX/Fress/blob/main/CHANGELOG.md';

const SECTION_ICONS: Record<string, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>> = {
  Added: Sparkles,
  Fixed: Wrench,
  Changed: RefreshCw,
  Removed: Minus,
};

function SectionIcon({ heading, className }: { heading: string; className: string }) {
  const Icon = SECTION_ICONS[heading] || Check;
  return <Icon className={className} aria-hidden />;
}

/**
 * "What's new" is a small, calm summary of the release you just updated to,
 * with the full detailed changelog embedded (parsed from CHANGELOG.md, so it
 * always matches what ships in the repo). Opened automatically once per
 * version (see App.tsx) and reachable any time from the header menu. Reading
 * it marks nothing; the version is recorded on launch regardless of whether
 * the popup was dismissed.
 */
export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const [showDetails, setShowDetails] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [openEarlierVersion, setOpenEarlierVersion] = useState<string | null>(null);

  // Escape closes, like every other modal in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Reset the expanded views each time the popup opens.
  useEffect(() => {
    if (isOpen) {
      setShowDetails(false);
      setShowEarlier(false);
      setOpenEarlierVersion(null);
    }
  }, [isOpen]);

  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen);
  if (!isOpen) return null;

  const note = notesForVersion(pkg.version);
  const detail = changelogForVersion(pkg.version);
  const earlier = earlierChangelog(detail ? detail.version : pkg.version);
  const hasDetails = !!detail && detail.sections.some((s) => s.items.length > 0);

  return (
    <div
      ref={panelRef}
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
        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {note ? (
            <>
              <p className="text-sm font-semibold text-slate-100 mb-3">{note.title}</p>
              <ul className="space-y-2.5">
                {note.items.map((item, i) => (
                  <li key={i} id={`whats-new-item-${i}`} className="flex items-start gap-2.5 text-[13px] text-slate-300 leading-relaxed">
                    {item.startsWith('New:') ? (
                      <Sparkles className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
                    )}
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

          {/* Detailed changelog, parsed straight from CHANGELOG.md */}
          {hasDetails && detail && (
            <div className="mt-4">
              <button
                id="whats-new-details-toggle"
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                className="w-full flex items-center justify-between gap-2 text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors py-1.5"
              >
                <span>All details for this release</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>

              {showDetails && (
                <div id="whats-new-details" className="mt-2 space-y-4">
                  {detail.intro && (
                    <p className="text-xs text-slate-400 leading-relaxed">{detail.intro}</p>
                  )}
                  {detail.sections
                    .filter((s) => s.items.length > 0)
                    .map((s) => (
                      <div key={s.heading}>
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5 flex items-center gap-1.5">
                          <SectionIcon heading={s.heading} className="w-3 h-3" />
                          {s.heading}
                        </h3>
                        <ul className="space-y-1.5">
                          {s.items.map((item, i) => (
                            <li key={i} className="text-[12px] text-slate-300 leading-relaxed pl-3 border-l border-slate-700/60">
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Earlier releases, collapsed by default */}
          {earlier.length > 0 && (
            <div className="mt-3">
              <button
                id="whats-new-earlier-toggle"
                type="button"
                onClick={() => setShowEarlier((v) => !v)}
                aria-expanded={showEarlier}
                className="w-full flex items-center justify-between gap-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors py-1.5"
              >
                <span>Earlier releases ({earlier.length})</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showEarlier ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>

              {showEarlier && (
                <div id="whats-new-earlier" className="mt-1 space-y-2">
                  {earlier.map((entry) => {
                    const open = openEarlierVersion === entry.version;
                    return (
                      <div key={entry.version} className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setOpenEarlierVersion(open ? null : entry.version)}
                          aria-expanded={open}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-850 transition-colors"
                        >
                          <span className="font-mono font-semibold">
                            v{entry.version}
                            {entry.date ? <span className="text-slate-500 font-normal"> · {entry.date}</span> : null}
                          </span>
                          <ChevronDown className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </button>
                        {open && (
                          <div className="px-3 pb-3 pt-1 space-y-2.5">
                            {entry.intro && <p className="text-[11px] text-slate-400 leading-relaxed">{entry.intro}</p>}
                            {entry.sections
                              .filter((s) => s.items.length > 0)
                              .map((s: ChangelogSection) => (
                                <div key={s.heading}>
                                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1.5">
                                    <SectionIcon heading={s.heading} className="w-2.5 h-2.5" />
                                    {s.heading}
                                  </h4>
                                  <ul className="space-y-1">
                                    {s.items.map((item, i) => (
                                      <li key={i} className="text-[11.5px] text-slate-300 leading-relaxed pl-2.5 border-l border-slate-700/60">
                                        {item}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
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
            <span>Full changelog on GitHub</span>
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
