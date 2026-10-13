// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { AppItem } from '../types';
import { sanitizeInstallCommand, PkgManager } from '../lib/installCommands';
import { useI18n } from '../lib/i18n';
import { 
  Terminal, 
  Copy, 
  Check, 
  Download, 
  X, 
  ShieldCheck,
  AlertTriangle,
  Laptop,
  Apple,
  Cpu
} from 'lucide-react';

interface BatchInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedApps: AppItem[];
  allApps: AppItem[];
  onToggleAppSelection: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}

type ScriptType = 'winget-ps' | 'winget-cmd' | 'brew' | 'brewfile' | 'flatpak' | 'scoop' | 'apt';

export const BatchInstallModal: React.FC<BatchInstallModalProps> = ({
  isOpen,
  onClose,
  selectedApps,
  allApps,
  onToggleAppSelection,
  onSelectAll,
  onClearSelection
}) => {
  const { t } = useI18n();
  const [scriptType, setScriptType] = useState<ScriptType>('winget-ps');
  // Three states: a denied clipboard must say so ("Copy failed"), not
  // silently keep claiming "Copy" while nothing was copied.
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Switching format invalidates the previous copy feedback: the chip said
  // "Copied" for a winget script that was never the brew script now shown.
  React.useEffect(() => {
    setCopyState('idle');
  }, [scriptType]);

  const panelRef = useRef<HTMLDivElement>(null);
  // onEscape is REQUIRED here: without it Escape fell through to the
  // shell-wide closeAllDialogs, so one press closed this modal AND every
  // dialog stacked underneath it, dropping keyboard focus to <body>.
  keepFocusInside(panelRef, isOpen, { onEscape: onClose });
  // Reopening starts from a clean slate (never a stale "Copied"), and the
  // reset timer never fires after the dialog is gone.
  React.useEffect(() => {
    if (isOpen) setCopyState('idle');
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [isOpen]);
  if (!isOpen) return null;

  // Which package manager the active tab generates for.
  const tabManager: PkgManager =
    scriptType === 'brew' || scriptType === 'brewfile'
      ? 'brew'
      : scriptType === 'flatpak'
        ? 'flatpak'
        : scriptType === 'scoop'
          ? 'scoop'
          : scriptType === 'apt'
            ? 'apt'
            : 'winget';
  const tabLabel = { winget: 'winget', brew: 'Homebrew', flatpak: 'Flatpak', scoop: 'Scoop', apt: 'APT' }[tabManager];

  const rawCommandOf = (a: AppItem): string | undefined =>
    tabManager === 'winget' ? a.wingetCommand
    : tabManager === 'brew' ? a.brewCommand
    : tabManager === 'flatpak' ? a.flatpakCommand
    : tabManager === 'apt' ? a.aptCommand
    : a.scoopCommand;

  // Last line of defense: nothing reaches the script without passing the
  // shared sanitizer, even if a command slipped past an older import. Apps
  // with a missing or rejected command are counted and shown, never silent.
  const checked = selectedApps.map((a) => ({ app: a, cmd: sanitizeInstallCommand(tabManager, rawCommandOf(a)) }));
  const validCommands = checked.filter((c) => c.cmd !== null);
  const skippedCount = checked.length - validCommands.length;
  const skippedNames = checked.filter((c) => c.cmd === null).map((c) => c.app.name);
  const hasCommands = validCommands.length > 0;

  // Generate scripts based on selection
  const generateScript = () => {
    if (selectedApps.length === 0) {
      // Localized (this comment is shown in the preview and shipped in the
      // copied/downloaded file): the text used to be hardcoded English.
      return t('bs.scriptEmpty');
    }

    const skipNote =
      skippedCount > 0
        ? `${t('bs.scriptSkipLine').replace('{s}', String(skippedCount)).replace('{m}', String(selectedApps.length)).replace('{mgr}', tabLabel)}\n\n`
        : '';

    if (scriptType === 'winget-ps') {
      const commands = validCommands.map((c) => `${c.cmd} --accept-source-agreements --accept-package-agreements`);
      
      return `# ==========================================\n# Fress - Windows PowerShell Batch Install\n# Total Apps: ${commands.length}\n# ==========================================\n\n${skipNote}` + 
        commands.join('\n\n');
    }

    if (scriptType === 'winget-cmd') {
      const commands = validCommands.map((c) => `${c.cmd} --accept-source-agreements --accept-package-agreements`);
      
      return `REM ==========================================\nREM Fress - Windows CMD Batch Install\nREM ==========================================\n\n${skipNote.replace(/#/g, 'REM')}` + 
        commands.join(' && ');
    }

    if (scriptType === 'brew') {
      const casks = validCommands.map((c) => c.cmd!);

      return `#!/usr/bin/env bash\n# ==========================================\n# Fress - Homebrew Installation Script (macOS / Linux)\n# ==========================================\n\n${skipNote}set -e\n\n` + 
        casks.join('\n');
    }

    if (scriptType === 'brewfile') {
      // `brew bundle` refuses a cask entry for a formula package (e.g.
      // `brew install syncthing`): each entry must state what it is.
      const lines = validCommands.map((c) => {
        const isCask = c.cmd!.includes('--cask');
        const pkg = c.cmd!.replace('brew install --cask ', '').replace('brew install ', '');
        return isCask ? `cask "${pkg}"` : `brew "${pkg}"`;
      });

      return `# Brewfile - Generated by Fress\n${skipNote}` + lines.join('\n');
    }

    if (scriptType === 'flatpak') {
      const commands = validCommands.map((c) => `${c.cmd} -y`);

      return `#!/usr/bin/env bash\n# ==========================================\n# Fress - Linux Flatpak Batch Install\n# ==========================================\n\n${skipNote}` + 
        commands.join('\n');
    }

    if (scriptType === 'scoop') {
      const pkgs = validCommands
        .map((c) => c.cmd!.replace('scoop install ', ''))
        .join(' ');

      return `# Windows Scoop Installer\n${skipNote}# \nscoop install ${pkgs}`;
    }

    if (scriptType === 'apt') {
      const commands = validCommands.map((c) => `sudo ${c.cmd} -y`);

      return `#!/usr/bin/env bash\n# ==========================================\n# Fress - Linux APT Batch Install (Debian/Ubuntu)\n# ==========================================\n\n${skipNote}sudo apt update\n\n` +
        commands.join('\n');
    }

    return '';
  };

  const scriptOutput = generateScript();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(scriptOutput);
      setCopyState('ok');
    } catch {
      setCopyState('failed');
    } finally {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const handleDownloadFile = () => {
    let extension = 'ps1';
    let filename = 'install-apps';
    let mimeType = 'text/plain';

    if (scriptType === 'winget-cmd') extension = 'bat';
    if (scriptType === 'brew' || scriptType === 'flatpak' || scriptType === 'apt') extension = 'sh';
    if (scriptType === 'brewfile') {
      filename = 'Brewfile';
      extension = '';
    }

    const finalName = extension ? `${filename}.${extension}` : filename;
    const blob = new Blob([scriptOutput], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div 
      ref={panelRef}
      id="batch-install-modal-backdrop"
      className="fixed inset-0 z-50 fr-backdrop flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-install-title"
      onClick={onClose}
    >
      <div 
        id="batch-install-modal"
        className="w-full max-w-3xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400">
              <Terminal className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="batch-install-title" className="text-base font-bold text-slate-100 tracking-tight">
                {t('bs.title')}
              </h2>
              <p className="text-xs text-slate-400">
                {t('bs.subtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]"
            aria-label={t('common.closeDialog')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Script Format Tabs. aria-pressed exposes which format is active
            (selection was conveyed only by background color). */}
        <div className="px-5 pt-3 pb-2 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-950/50 flex items-center justify-between flex-wrap gap-2" role="group" aria-label={t('bs.title')}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setScriptType('winget-ps')}
              aria-pressed={scriptType === 'winget-ps'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'winget-ps'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.wingetPs')}
            </button>
            <button
              type="button"
              onClick={() => setScriptType('brew')}
              aria-pressed={scriptType === 'brew'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'brew'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.brew')}
            </button>
            <button
              type="button"
              onClick={() => setScriptType('brewfile')}
              aria-pressed={scriptType === 'brewfile'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'brewfile'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.brewfile')}
            </button>
            <button
              type="button"
              onClick={() => setScriptType('flatpak')}
              aria-pressed={scriptType === 'flatpak'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'flatpak'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.flatpak')}
            </button>
            <button
              type="button"
              onClick={() => setScriptType('scoop')}
              aria-pressed={scriptType === 'scoop'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'scoop'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.scoop')}
            </button>
            <button
              type="button"
              onClick={() => setScriptType('apt')}
              aria-pressed={scriptType === 'apt'}
              className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                scriptType === 'apt'
                  ? 'bg-sky-500 text-white border-sky-400 font-semibold shadow-xs'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
            >
              {t('bs.tab.apt')}
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={onSelectAll}
              className="text-sky-400 hover:text-sky-300 font-medium"
            >
              {t('bs.selectAll')} ({allApps.length})
            </button>
            <span className="text-slate-600">|</span>
            <button
              type="button"
              onClick={onClearSelection}
              className="text-slate-400 hover:text-slate-300"
            >
              {t('bs.clear')}
            </button>
          </div>
        </div>

        {/* Selected Apps Chip Bar */}
        <div
          className="px-5 py-2.5 bg-slate-900 border-b border-slate-950/10 dark:border-white/[0.04] flex items-center gap-1.5 overflow-x-auto text-xs"
          tabIndex={0}
          aria-label={t('bs.selected').replace('{n}', String(selectedApps.length))}
        >
          <span className="text-slate-400 font-mono text-[11px] uppercase tracking-wider me-1 shrink-0">
            {t('bs.selected')} ({selectedApps.length}):
          </span>
          {selectedApps.length > 0 ? (
            selectedApps.map((app) => (
              <span
                key={app.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] text-slate-100 text-[11px] shrink-0"
              >
                <span>{app.name}</span>
                <button
                  type="button"
                  onClick={() => onToggleAppSelection(app.id)}
                  className="text-slate-400 hover:text-rose-400 ms-0.5"
                  title={`${t('bs.removeApp')}: ${app.name}`}
                  aria-label={`${t('bs.removeApp')}: ${app.name}`}
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            ))
          ) : (
            <span className="text-slate-400 italic text-xs">
              {t('bs.noneSelected')}
            </span>
          )}
        </div>

        {/* Code Preview. Keyboard-scrollable: this is the modal's primary
            content, arbitrarily long, and keyboard users could not move it. */}
        <div
          className="flex-1 p-5 overflow-y-auto bg-slate-950"
          tabIndex={0}
          role="region"
          aria-label={t('bs.title')}
        >
          <pre className="font-mono text-xs text-emerald-400 whitespace-pre-wrap leading-relaxed fr-code-well border border-slate-950/10 dark:border-white/[0.08] p-4 rounded-lg select-all">
            {scriptOutput}
          </pre>
        </div>

        {/* Footer Actions. flex-wrap: safe-note + two buttons exceed the
            320px panel. */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{t('bs.safeNote')}</span>
            </div>
            {selectedApps.length > 0 && skippedCount > 0 && (
              <div className="flex flex-col gap-1 text-[11px] text-amber-300 dark:text-amber-400 min-w-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {t('bs.skipNote').replace('{s}', String(skippedCount)).replace('{m}', String(selectedApps.length)).replace('{mgr}', tabLabel)}
                  </span>
                </div>
                {/* Per-item visibility: the count alone never said WHICH
                    apps lack a package for the chosen manager (the
                    batch-download path names them in its toast). */}
                <span className="text-amber-300/80 dark:text-amber-400/80 break-words">
                  {skippedNames.join(', ')}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadFile}
              disabled={!hasCommands}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.1] text-slate-100 transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
              <span>{t('bs.downloadFile')}</span>
            </button>

            <button
              type="button"
              onClick={handleCopy}
              disabled={!hasCommands}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-400 transition-colors disabled:opacity-50"
            >
              {copyState === 'ok' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-slate-100" aria-hidden="true" />
                  <span>{t('bs.copied')}</span>
                </>
              ) : copyState === 'failed' ? (
                <>
                  <X className="w-3.5 h-3.5 text-slate-100" aria-hidden="true" />
                  <span>{t('common.copyFailed')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-100" aria-hidden="true" />
                  <span>{t('bs.copy')}</span>
                </>
              )}
            </button>
          </div>
        </div>
        {/* Clipboard outcome for the script copy, announced to AT. */}
        <span className="sr-only" role="status">
          {copyState === 'ok' ? t('bs.copied') : copyState === 'failed' ? t('common.copyFailed') : ''}
        </span>
      </div>
    </div>
  );
};
