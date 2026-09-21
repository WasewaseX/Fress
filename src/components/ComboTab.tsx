import React, { useMemo } from 'react';
import { Terminal, CheckSquare, ExternalLink, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { COMBOS, Combo } from '../data/combos';
import { AppItem } from '../types';
import { AppIcon } from './AppCard';

interface ComboTabProps {
  apps: AppItem[];
  onOpenDetail: (app: AppItem) => void;
  onAddToBatch: (ids: string[]) => void;
}

/**
 * The Combos tab: curated kits of apps that solve one problem together.
 * Inspired by ente's PrivacyPack, but only apps already in the catalog
 * are used, so everything on this page went through the same checks.
 */
export const ComboTab: React.FC<ComboTabProps> = ({ apps, onOpenDetail, onAddToBatch }) => {
  const byId = useMemo(() => {
    const m = new Map<string, AppItem>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);

  const copyInstallScript = (combo: Combo) => {
    const list = combo.appIds.map((id) => byId.get(id)).filter(Boolean) as AppItem[];
    const lines: string[] = [`# ${combo.name} (from Fress)`];
    const winget = list.filter((a) => a.wingetCommand);
    const brew = list.filter((a) => a.brewCommand);
    const flatpak = list.filter((a) => a.flatpakCommand);
    if (winget.length) {
      lines.push('', '# Windows (winget)');
      winget.forEach((a) => lines.push(`${a.wingetCommand} --accept-source-agreements --accept-package-agreements`));
    }
    if (brew.length) {
      lines.push('', '# macOS (Homebrew)');
      brew.forEach((a) => lines.push(a.brewCommand as string));
    }
    if (flatpak.length) {
      lines.push('', '# Linux (Flatpak)');
      flatpak.forEach((a) => lines.push(a.flatpakCommand as string));
    }
    const missing = list.filter((a) => !a.wingetCommand && !a.brewCommand && !a.flatpakCommand);
    if (missing.length) {
      lines.push('', '# No package manager entry, get these from their official pages:');
      missing.forEach((a) => lines.push(`# ${a.name}: ${a.websiteUrl || a.downloadUrl}`));
    }
    void navigator.clipboard.writeText(lines.join('\n'));
    toast.success(`Install script for "${combo.name}" copied.`);
  };

  const sendToBatch = (combo: Combo) => {
    const ids = combo.appIds.filter((id) => byId.has(id));
    onAddToBatch(ids);
    toast.success(`${ids.length} apps from "${combo.name}" added to the batch selection.`);
  };

  return (
    <div id="combo-tab">
      <div className="flex items-start gap-3 mb-5">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-sky-500/15 text-sky-400 shrink-0">
          <Layers className="w-5 h-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-bold text-slate-100 tracking-tight">Combos</h2>
          <p className="text-xs text-slate-400 leading-relaxed mt-0.5">
            Kits of apps that work well together: install one set, solve one whole problem.
            Every app in a combo is already in the catalog and passed the same checks.
            The idea comes from{' '}
            <a
              href="https://github.com/ente/privacypack"
              target="_blank"
              rel="noreferrer noopener"
              className="text-sky-400 hover:text-sky-300 underline decoration-dotted underline-offset-2"
            >
              ente's PrivacyPack
              <ExternalLink className="inline w-3 h-3 ml-0.5 mb-0.5" aria-hidden="true" />
            </a>
            , rebuilt with the apps vetted here.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {COMBOS.map((combo) => {
          const list = combo.appIds.map((id) => byId.get(id)).filter(Boolean) as AppItem[];
          const Icon = combo.icon;
          return (
            <article
              key={combo.id}
              id={`combo-card-${combo.id}`}
              className="group relative bg-slate-900 dark:bg-slate-800 border border-slate-950/10 dark:border-white/[0.08] hover:border-slate-950/30 dark:hover:border-white/[0.2] rounded-lg p-4 flex flex-col transition-all duration-150 shadow-sm hover:shadow-md dark:shadow-lg dark:shadow-black/40"
              aria-label={`App combo: ${combo.name}`}
            >
              <div className="flex items-start gap-3">
                <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${combo.tile}`}>
                  <Icon className="w-5 h-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-100 tracking-tight">{combo.name}</h3>
                  <p className="text-[11px] text-slate-400 leading-snug mt-0.5">{combo.purpose}</p>
                </div>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed mt-3 flex-1">{combo.note}</p>

              <div className="flex flex-wrap gap-1.5 mt-3">
                {list.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    id={`combo-app-${combo.id}-${app.id}`}
                    onClick={() => onOpenDetail(app)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium bg-slate-950/[0.04] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 pl-1 pr-2 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                    title={`Open ${app.name}`}
                  >
                    <AppIcon appId={app.id} name={app.name} size={16} />
                    <span>{app.name}</span>
                  </button>
                ))}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-950/10 dark:border-white/[0.06] flex items-center gap-2">
                <button
                  type="button"
                  id={`combo-copy-script-${combo.id}`}
                  onClick={() => copyInstallScript(combo)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1.5 rounded-md transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Copy install script</span>
                </button>
                <button
                  type="button"
                  id={`combo-add-batch-${combo.id}`}
                  onClick={() => sendToBatch(combo)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 px-2.5 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                  title="Add these apps to the batch selection"
                >
                  <CheckSquare className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>Add to selection</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};
