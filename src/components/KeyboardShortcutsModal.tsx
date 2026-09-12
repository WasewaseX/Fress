import { useModalA11y } from '../lib/modalA11y';
import React from 'react';
import { useI18n } from '../lib/i18n';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose
}) => {
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);
  const { t } = useI18n();

  if (!isOpen) return null;

  const shortcuts = [
    { key: 'Ctrl+K', description: t('shortcuts.palette') },
    { key: '/', description: t('shortcuts.focusSearch') },
    { key: 'Esc', description: t('shortcuts.escape') },
    { key: 'V', description: t('shortcuts.toggleView') },
    { key: 'B', description: t('shortcuts.batch') },
    { key: 'M', description: t('shortcuts.compare') },
    { key: 'E', description: t('shortcuts.export') },
    { key: 'A', description: t('shortcuts.addApp') },
    { key: 'F', description: t('shortcuts.favorites') },
    { key: 'T', description: t('shortcuts.trending') },
    { key: 'O', description: t('shortcuts.picks') },
    { key: 'D', description: t('shortcuts.guide') },
    { key: 'P', description: t('shortcuts.privacy') },
  ];

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fr-backdrop backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-dialog-title"
    >
      <div 
        ref={containerRef}
        className="bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-md w-full max-w-md overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between bg-slate-950">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h2 id="shortcuts-dialog-title" className="text-sm font-bold text-slate-100">
              {t('shortcuts.title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-md"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-2 max-h-[65vh] overflow-y-auto">
          {shortcuts.map((s) => (
            <div 
              key={s.key} 
              className="flex items-center justify-between py-1.5 px-2 bg-slate-950 rounded border border-slate-950/10 dark:border-white/[0.06] text-xs"
            >
              <span className="text-slate-300">{s.description}</span>
              <kbd className="font-mono text-[11px] bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.08] text-slate-200 px-2 py-0.5 rounded">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 px-3.5 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08]"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
