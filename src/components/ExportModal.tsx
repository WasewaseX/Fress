// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { formatMessage, useI18n } from '../lib/i18n';
import { AppItem } from '../types';
import { 
  Download, 
  Copy, 
  Check, 
  FileText, 
  FileCode, 
  Table, 
  X,
  Share2
} from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  apps: AppItem[];
}

type ExportFormat = 'markdown' | 'csv' | 'json';

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  apps
}) => {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  // Three states, not a boolean: a FAILED copy must be visible and
  // actionable ("Copy failed" + the button stays usable), not silently
  // swallowed like the old `catch { /* ignore */ }`.
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  const panelRef = useRef<HTMLDivElement>(null);
  // onEscape is REQUIRED like every other stacked dialog: without it Escape
  // fell through to the shell-wide closeAllDialogs, so one press closed the
  // Export dialog AND every dialog stacked underneath it (e.g. export opened
  // from the palette over the detail modal), dropping focus to <body>.
  keepFocusInside(panelRef, isOpen, { onEscape: onClose });
  // Reopening starts from a clean slate (never show a stale "Copied"), and
  // the reset timer never fires after the dialog is gone.
  React.useEffect(() => {
    if (isOpen) setCopyState('idle');
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [isOpen]);
  if (!isOpen) return null;

  const generateMarkdown = () => {
    // Group apps by category
    const categories: string[] = Array.from(new Set(apps.map((a) => a.category as string)));
    
    let md = `# Fress: Free & Open Source Software Directory\n\n`;
    md += `> Curated collection of authentic free and open-source applications inspired by Axorax/awesome-free-apps.\n\n`;
    md += `[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)\n`;
    md += `[![Curated Tools](https://img.shields.io/badge/Curated_Tools-${apps.length}-emerald.svg)](#)\n`;
    md += `[![Offline Ready](https://img.shields.io/badge/Offline-Capable-success.svg)](#)\n\n`;
    
    md += `## Table of Contents\n\n`;
    for (const cat of categories) {
      const anchor = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      md += `- [${cat}](#${anchor})\n`;
    }
    md += `- [Command Line Installation](#command-line-installation)\n`;
    md += `- [Contributing](#contributing)\n\n`;

    for (const cat of categories) {
      const anchor = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      md += `## ${cat}\n\n`;
      md += `| Application | Description | Replaces | Platforms | License | Stars |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      
      const catApps = apps.filter((a) => a.category === cat);
      for (const app of catApps) {
        const platformsStr = app.platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
        const altStr = app.proprietaryAlternative ? `\`${app.proprietaryAlternative}\`` : '-';
        md += `| [**${app.name}**](${app.websiteUrl || '-'}) | ${app.tagline} | ${altStr} | ${platformsStr} | \`${app.license}\` | ★ ${app.stars.toLocaleString()} |\n`;
      }
      md += `\n`;
    }

    md += `## Command Line Installation\n\n`;
    md += `All tools can be installed without searching browser downloads using modern package managers:\n\n`;
    md += `\`\`\`bash\n# Windows (winget)\nwinget install LocalSend.LocalSend\n\n# macOS / Linux (Homebrew)\nbrew install --cask localsend\n\n# Linux (Flatpak)\nflatpak install flathub org.localsend.localsend\n\`\`\`\n\n`;
    md += `## Contributing\n\n`;
    md += `We welcome suggestions! All submissions must be free, open-source or local-first, and contain zero spyware/adware.\n`;

    return md;
  };

  const generateCSV = () => {
    const headers = ['ID', 'Name', 'Tagline', 'Category', 'Platforms', 'License', 'Stars', 'Replaces', 'Website', 'GitHub', 'Winget'];
    const rows = apps.map((app) => [
      `"${app.id}"`,
      `"${app.name.replace(/"/g, '""')}"`,
      `"${app.tagline.replace(/"/g, '""')}"`,
      `"${app.category}"`,
      `"${app.platforms.join(', ')}"`,
      `"${app.license}"`,
      app.stars,
      `"${(app.proprietaryAlternative || '').replace(/"/g, '""')}"`,
      `"${app.websiteUrl || ''}"`,
      `"${app.githubUrl || ''}"`,
      `"${(app.wingetCommand || '').replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  };

  const generateJSON = () => {
    return JSON.stringify(apps, null, 2);
  };

  const getContent = () => {
    if (format === 'markdown') return generateMarkdown();
    if (format === 'csv') return generateCSV();
    return generateJSON();
  };

  const content = getContent();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('ok');
    } catch {
      // Actionable feedback: the clipboard can refuse (permission denied,
      // insecure context). The user must see that the copy did NOT happen,
      // and the button must stay usable for a retry (or the Download
      // button next to it becomes the documented alternative path).
      setCopyState('failed');
    } finally {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const handleDownload = () => {
    let filename = 'fress-catalog';
    let mimeType = 'text/plain';

    if (format === 'markdown') {
      filename = 'README.md';
      mimeType = 'text/markdown';
    } else if (format === 'csv') {
      filename = 'fress-apps.csv';
      mimeType = 'text/csv';
    } else {
      filename = 'fress-apps.json';
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div 
      ref={panelRef}
      id="export-modal-backdrop"
      className="fixed inset-0 z-50 fr-backdrop flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      onClick={onClose}
    >
      <div 
        id="export-modal"
        className="w-full max-w-4xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400">
              <Share2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="export-modal-title" className="text-base font-bold text-slate-100 tracking-tight">
                {t('export.title')}
              </h2>
              <p className="text-xs text-slate-400">
                {t('export.subtitle')}
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

        {/* Format Selector. A named group whose buttons expose their
            selected state: three visually-identical toggle buttons with
            selection shown only by background color gave a screen reader
            three same-named controls and no state (aria-pressed is the
            same exclusive-chip contract the FilterBar uses). */}
        <div className="px-5 py-3 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-950/50 flex flex-wrap items-center gap-2" role="group" aria-label={t('export.formatGroupAria')}>
          <button
            type="button"
            onClick={() => setFormat('markdown')}
            aria-pressed={format === 'markdown'}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'markdown'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('export.formatReadme')}</span>
          </button>
          <button
            type="button"
            onClick={() => setFormat('csv')}
            aria-pressed={format === 'csv'}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'csv'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <Table className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('export.formatCsv')}</span>
          </button>
          <button
            type="button"
            onClick={() => setFormat('json')}
            aria-pressed={format === 'json'}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'json'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('export.formatJson')}</span>
          </button>
        </div>

        {/* Preview. Keyboard-scrollable (axe scrollable-region-focusable):
            a keyboard user must be able to scroll the generated export
            without a mouse wheel. Labelled by the modal's own title - no
            new dictionary key needed. (Finding and fix shape routed from
            Agent 2's round-27 scan; file owned by Agent 4, applied by the
            orchestrator with attribution.) */}
        <div
          className="flex-1 p-5 overflow-y-auto bg-slate-950"
          tabIndex={0}
          role="region"
          aria-label={t('export.title')}
        >
          <pre dir="ltr" className="text-left font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed fr-code-well border border-slate-950/10 dark:border-white/[0.08] p-4 rounded-lg select-all">
            {content}
          </pre>
        </div>

        {/* Footer. Wraps at the 320px floor: Copy + Download + count exceed
            the card width in several locales and the Download button was
            clipped by the panel's overflow-hidden. */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="text-xs text-slate-400 font-mono">
            {formatMessage(t('export.readyCount'), { n: apps.length })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.1] text-slate-100 transition-colors"
            >
              {copyState === 'ok' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span className="text-emerald-400">{t('common.copied')}</span>
                </>
              ) : copyState === 'failed' ? (
                <>
                  <X className="w-3.5 h-3.5 text-amber-300 dark:text-amber-400" aria-hidden="true" />
                  <span className="text-amber-300 dark:text-amber-400">{t('common.copyFailed')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
                  <span>{t('export.copyClipboard')}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-400 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-slate-100" aria-hidden="true" />
              <span>
                {t('export.download').replace(
                  '{fmt}',
                  format === 'markdown' ? 'README.md' : format.toUpperCase()
                )}
              </span>
            </button>
          </div>
        </div>
        {/* Localized clipboard completion feedback for screen readers -
            the visual button swap alone is silent to assistive tech. */}
        <span className="sr-only" role="status">
          {copyState === 'ok' ? t('common.copied') : copyState === 'failed' ? t('common.copyFailed') : ''}
        </span>
      </div>
    </div>
  );
};
