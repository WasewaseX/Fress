// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { useI18n } from '../lib/i18n';
import { PALETTE_KEY } from '../lib/utils';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose
}) => {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  // Escape through the shared stack: the topmost open surface answers, so a
  // dialog opened above this one is never closed together with it.
  keepFocusInside(panelRef, isOpen, { onEscape: onClose });
  if (!isOpen) return null;

  const shortcuts = [
    // Platform-actual combo, same source as the header chip: advertising
    // "⌘K / Ctrl+K" verbatim implied the wrong combo works on Windows/Linux
    // (and vice versa on macOS).
    { key: PALETTE_KEY, description: t('ks.desc.palette') },
    { key: '/', description: t('ks.desc.search') },
    { key: 'Esc', description: t('ks.desc.escape') },
    { key: 'V', description: t('ks.desc.view') },
    { key: 'B', description: t('ks.desc.batch') },
    { key: 'M', description: t('ks.desc.compare') },
    { key: 'E', description: t('ks.desc.export') },
    { key: 'A', description: t('ks.desc.add') },
    { key: 'F', description: t('ks.desc.favorites') },
    { key: 'T', description: t('ks.desc.trending') },
    { key: 'O', description: t('ks.desc.picks') },
    { key: 'D', description: t('ks.desc.desktop') }
  ];

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fr-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-dialog-title"
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-md w-full max-w-md overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h2 id="shortcuts-dialog-title" className="text-sm font-bold text-slate-100">
              {t('ks.title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-md"
            aria-label={t('ks.closeAria')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* dir=ltr on every kbd: "⌘K / Ctrl+K" starts with a neutral-bidi
            symbol that detaches and reorders inside an RTL paragraph (fa
            rendered it as "K / Ctrl+K⌘"). Key caps are technical tokens -
            they read LTR in every locale. */}
        <div className="p-4 space-y-2 max-h-[65vh] overflow-y-auto" tabIndex={0} role="region" aria-label={t('ks.title')}>
          {shortcuts.map((s) => (
            <div
              key={s.key}
              className="flex items-center justify-between py-1.5 px-2 bg-slate-950 rounded border border-slate-800 text-xs"
            >
              <span className="text-slate-300">{s.description}</span>
              <kbd dir="ltr" className="font-mono text-[11px] bg-slate-800 border border-slate-700 text-slate-200 px-2 py-0.5 rounded">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-slate-800 bg-slate-950 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 px-3.5 py-1.5 rounded-md border border-slate-700"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
