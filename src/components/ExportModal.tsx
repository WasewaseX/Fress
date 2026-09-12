import React, { useState } from 'react';
import { useModalA11y } from '../lib/modalA11y';
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
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const generateMarkdown = () => {
    // Group apps by category
    const categories: string[] = Array.from(new Set(apps.map((a) => a.category as string)));
    
    let md = `# Fress — Free & Open Source Software Directory\n\n`;
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
      md += `## ${cat}\n\n`;
      md += `| Application | Description | Replaces | Platforms | License | Stars |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      
      const catApps = apps.filter((a) => a.category === cat);
      for (const app of catApps) {
        const platformsStr = app.platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
        const altStr = app.proprietaryAlternative ? `\`${app.proprietaryAlternative}\`` : '-';
        const starsStr = app.stars > 0 ? `★ ${app.stars.toLocaleString()}` : '-';
        md += `| [**${app.name}**](${app.websiteUrl}) | ${app.tagline} | ${altStr} | ${platformsStr} | \`${app.license}\` | ${starsStr} |\n`;
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
    // CSV safety: quote every field, escape embedded quotes, and neutralize
    // leading formula characters so a crafted catalog can't produce
    // =HYPERLINK()/=CMD() cells that execute when the export opens in Excel.
    const cell = (value: unknown): string => {
      let s = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s.replace(/\r/g, '')}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = apps.map((app) => [
      cell(app.id),
      cell(app.name),
      cell(app.tagline),
      cell(app.category),
      cell(app.platforms.join(', ')),
      cell(app.license),
      cell(app.stars > 0 ? app.stars : '-'),
      cell(app.proprietaryAlternative || ''),
      cell(app.websiteUrl),
      cell(app.githubUrl),
      cell(app.wingetCommand || '')
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
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
      id="export-modal-backdrop"
      className="fixed inset-0 z-50 fr-backdrop backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div 
        id="export-modal"
        ref={containerRef}
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
              <h2 className="text-base font-bold text-slate-100 tracking-tight">
                Export Catalog Data
              </h2>
              <p className="text-xs text-slate-400">
                Generate a catalog README.md, CSV spreadsheet, or complete JSON export.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Format Selector */}
        <div className="px-5 py-3 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-950/50 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFormat('markdown')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'markdown'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>README.md</span>
          </button>
          <button
            type="button"
            onClick={() => setFormat('csv')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'csv'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <Table className="w-3.5 h-3.5" />
            <span>Spreadsheet CSV</span>
          </button>
          <button
            type="button"
            onClick={() => setFormat('json')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              format === 'json'
                ? 'bg-sky-500 text-white border-sky-400 font-semibold'
                : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-300 border-slate-950/10 dark:border-white/[0.08] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Full JSON</span>
          </button>
        </div>

        {/* Preview */}
        <div className="flex-1 p-5 overflow-y-auto bg-slate-950">
          <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed bg-black/40 border border-slate-950/10 dark:border-white/[0.08] p-4 rounded-lg select-all">
            {content}
          </pre>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between">
          <span className="text-xs text-slate-400 font-mono">
            {apps.length} records ready for export
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.1] text-slate-100 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-300" />
                  <span>Copy to Clipboard</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-400 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-slate-100" />
              <span>Download {format === 'markdown' ? 'README.md' : format.toUpperCase()}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
