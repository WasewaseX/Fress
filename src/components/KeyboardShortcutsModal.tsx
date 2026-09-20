import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose
}) => {
  if (!isOpen) return null;

  const shortcuts = [
    { key: '⌘K / Ctrl+K', description: 'Open Quick Action Command Palette' },
    { key: '/', description: 'Focus header search input' },
    { key: 'Esc', description: 'Close any active modal or clear search' },
    { key: 'V', description: 'Toggle between Card Grid and Table View' },
    { key: 'B', description: 'Open Batch Install Script Generator' },
    { key: 'M', description: 'Open Side-by-Side Comparison Matrix' },
    { key: 'E', description: 'Open Awesome List README & Export Tool' },
    { key: 'A', description: 'Open Add Application dialog' },
    { key: 'F', description: 'Toggle Bookmarks / Favorites filter' },
    { key: 'T', description: 'Toggle GitHub Trending Today filter' },
    { key: 'O', description: 'Toggle Curator Recommendations filter' },
    { key: 'D', description: 'Open Windows (.exe) desktop packaging guide' }
  ];

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs"
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
              Keyboard Navigation Shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-md"
            aria-label="Close keyboard shortcuts dialog"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-2 max-h-[65vh] overflow-y-auto">
          {shortcuts.map((s) => (
            <div 
              key={s.key} 
              className="flex items-center justify-between py-1.5 px-2 bg-slate-950 rounded border border-slate-800 text-xs"
            >
              <span className="text-slate-300">{s.description}</span>
              <kbd className="font-mono text-[11px] bg-slate-800 border border-slate-700 text-slate-200 px-2 py-0.5 rounded">
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
