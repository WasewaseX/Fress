// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Columns, X } from 'lucide-react';

/**
 * Floating indicator for apps staged for comparison while the matrix is
 * closed and the batch bar is not occupying the corner. Presentation only.
 */
export function CompareDock(props: {
  count: number;
  onOpenMatrix: () => void;
  onClear: () => void;
}) {
  const { count, onOpenMatrix, onClear } = props;

  return (
    <aside
      id="floating-compare-action-bar"
      aria-label="Comparison dock"
      className="fixed bottom-5 right-6 z-40 bg-slate-900/95 border border-indigo-500/40 rounded-xl shadow-2xl px-3.5 py-2 flex items-center gap-2.5 backdrop-blur-md"
    >
      <Columns className="w-4 h-4 text-indigo-400" />
      <span className="text-xs text-slate-200 font-medium">
        {count} app{count > 1 ? 's' : ''} in comparison
      </span>
      <button
        type="button"
        onClick={onOpenMatrix}
        className="text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-md transition-colors ml-1"
      >
        View Matrix
      </button>
      <button
        type="button"
        onClick={onClear}
        className="text-slate-400 hover:text-slate-100 p-1 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08]"
        title="Clear comparison"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </aside>
  );
}
