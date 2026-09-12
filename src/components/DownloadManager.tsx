import React, { useState } from 'react';
import {
  X,
  CheckCircle2,
  XCircle,
  MinusCircle,
  FolderOpen,
  FileCheck2,
  RotateCcw,
  Trash2,
  DownloadCloud,
  Copy,
  Check,
  BadgeCheck,
  ExternalLink,
} from 'lucide-react';
import { useDownloads, formatBytes, formatSpeed, formatEta } from '../lib/downloads';
import { translate } from '../lib/i18n';
import { useI18n } from '../lib/i18n';
import { useModalA11y } from '../lib/modalA11y';
import { openExternal } from '../lib/external';

/** Beginner "what now" hint per downloaded file type. */
function hintFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'apk') return translate('downloads.hint.apk');
  if (ext === 'exe' || ext === 'msi') return translate('downloads.hint.exe');
  if (ext === 'dmg' || ext === 'pkg') return translate('downloads.hint.dmg');
  if (ext === 'appimage') return translate('downloads.hint.appimage');
  if (ext === 'deb') return translate('downloads.hint.deb');
  if (ext === 'rpm') return translate('downloads.hint.rpm');
  return '';
}

export const DownloadManager: React.FC<{ isOpen: boolean; onClose: () => void; onOpenGuide?: () => void }> = ({ isOpen, onClose, onOpenGuide }) => {
  const {
    items,
    cancel,
    retry,
    clearFinished,
    openFile,
    openFolder,
    downloadDir,
    chooseFolder,
  } = useDownloads();
  const { t } = useI18n();
  const [copiedHash, setCopiedHash] = useState<number | null>(null);
  const panelRef = useModalA11y<HTMLElement>(isOpen, onClose);

  if (!isOpen) return null;

  const active = items.filter((it) => it.status === 'active');
  const finished = items.filter((it) => it.status !== 'active');

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t('downloads.title')}>
      <div className="fr-backdrop absolute inset-0" onClick={onClose} aria-hidden="true" />

      <aside
        ref={panelRef}
        className="absolute end-0 top-0 h-full w-full max-w-md bg-slate-950 border-s border-slate-950/10 dark:border-white/[0.08] shadow-2xl flex flex-col"
        data-testid="download-manager-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-900">
          <div className="flex items-center gap-2">
            <DownloadCloud className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h2 className="text-sm font-bold text-slate-100">{t('downloads.title')}</h2>
            {active.length > 0 && (
              <span className="text-[11px] font-mono bg-sky-500/15 text-sky-300 border border-sky-500/30 px-1.5 py-0.5 rounded-full">
                {active.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] rounded-md transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {items.length === 0 && (
            <div className="text-center py-16">
              <DownloadCloud className="w-8 h-8 text-slate-500 mx-auto mb-3" aria-hidden="true" />
              <p className="text-sm font-semibold text-slate-200 mb-1">{t('downloads.empty')}</p>
              <p className="text-xs text-slate-400 leading-relaxed max-w-[240px] mx-auto">{t('downloads.emptyHint')}</p>
            </div>
          )}

          {items.map((item) => {
            const pct = item.total > 0 ? Math.min(100, Math.round((item.bytes / item.total) * 100)) : item.status === 'completed' ? 100 : 0;
            return (
              <div
                key={item.id}
                className="bg-slate-800 border border-slate-950/10 dark:border-white/[0.06] rounded-lg p-3"
                data-status={item.status}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold text-slate-100 break-all leading-snug" title={item.url}>
                    {item.name}
                  </p>
                  <StatusChip status={item.status} error={item.error} />
                </div>

                {/* Progress bar */}
                <div className="h-1.5 w-full bg-slate-950/10 dark:bg-white/[0.06] rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-[width] duration-200 ${
                      item.status === 'completed'
                        ? 'bg-emerald-500'
                        : item.status === 'error'
                          ? 'bg-rose-500'
                          : item.status === 'cancelled'
                            ? 'bg-slate-500'
                            : 'bg-sky-500'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400 mb-2.5">
                  <span>
                    {formatBytes(item.bytes)}
                    {item.total > 0 && ` / ${formatBytes(item.total)}`}
                    {item.status === 'completed' && ` (${pct}%)`}
                  </span>
                  <span className="flex items-center gap-2">
                    {item.status === 'active' && <span>{formatSpeed(item.speed)}</span>}
                    {item.status === 'active' && item.eta > 0 && <span>{formatEta(item.eta)}</span>}
                  </span>
                </div>

                {item.status === 'error' && item.error && (
                  <p className="text-[11px] text-rose-300 mb-2 leading-snug">{item.error}</p>
                )}

                {item.status === 'completed' && hintFor(item.name) && (
                  onOpenGuide ? (
                    <button
                      type="button"
                      onClick={onOpenGuide}
                      className="text-[11px] text-sky-400 hover:text-sky-300 mb-2 leading-snug text-start underline underline-offset-2"
                    >
                      {hintFor(item.name)}
                    </button>
                  ) : (
                    <p className="text-[11px] text-slate-400 mb-2 leading-snug">{hintFor(item.name)}</p>
                  )
                )}

                {item.status === 'completed' && item.verified === true && (
                  <div id={`download-verified-${item.id}`} className="text-[11px] font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1 mb-2.5 flex items-center gap-1.5">
                    <BadgeCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('downloads.verified')}</span>
                  </div>
                )}

                {item.sha256 && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(item.sha256!).then(
                        () => {
                          setCopiedHash(item.id);
                          setTimeout(() => setCopiedHash(null), 2000);
                        },
                        () => undefined
                      );
                    }}
                    className="w-full text-left text-[11px] font-mono text-slate-400 hover:text-slate-200 bg-slate-950/[0.04] dark:bg-white/[0.03] border border-slate-950/10 dark:border-white/[0.06] rounded px-2 py-1 mb-2.5 break-all flex items-center gap-1.5"
                    title={t('common.copy')}
                  >
                    <FileCheck2 className="w-3 h-3 shrink-0 text-emerald-400" />
                    <span className="truncate">{t('downloads.hash')}: {item.sha256}</span>
                    {copiedHash === item.id ? (
                      <Check className="w-3 h-3 shrink-0 ml-auto text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3 shrink-0 ml-auto" />
                    )}
                  </button>
                )}

                <div className="flex items-center gap-1.5">
                  {item.status === 'active' && (
                    <PanelButton onClick={() => cancel(item.id)} icon={<MinusCircle className="w-3 h-3" />} label={t('downloads.cancel')} />
                  )}
                  {(item.status === 'error' || item.status === 'cancelled') && (
                    <PanelButton onClick={() => retry(item.id)} icon={<RotateCcw className="w-3 h-3" />} label={t('downloads.retry')} />
                  )}
                  {item.status === 'page' && (
                    <PanelButton
                      onClick={() => void openExternal(item.url)}
                      icon={<ExternalLink className="w-3 h-3" />}
                      label={t('downloads.openPage')}
                      primary
                    />
                  )}
                  {item.status === 'completed' && item.path && (
                    <>
                      <PanelButton onClick={() => openFile(item.path!)} icon={<CheckCircle2 className="w-3 h-3" />} label={t('downloads.openFile')} primary />
                      <PanelButton onClick={() => openFolder(item.path)} icon={<FolderOpen className="w-3 h-3" />} label={t('downloads.showFolder')} />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-900 px-4 py-3 space-y-2">
          {finished.length > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-3 py-1.5 rounded-md transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('downloads.clearFinished')} ({finished.length})</span>
            </button>
          )}
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <div className="min-w-0">
              <p className="text-slate-400 font-medium">{t('downloads.folder')}</p>
              <p className="text-slate-300 font-mono truncate text-[11px]" title={downloadDir || ''}>
                {downloadDir || t('downloads.defaultFolder')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-sky-300 hover:text-sky-200 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 px-2.5 py-1 rounded-md transition-colors"
            >
              <FolderOpen className="w-3 h-3" />
              <span>{t('downloads.changeFolder')}</span>
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
};

function StatusChip({ status, error }: { status: string; error?: string }) {
  const { t } = useI18n();
  if (status === 'active') {
    return <span className="shrink-0 text-[11px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 px-1.5 py-0.5 rounded">{t('downloads.active')}</span>;
  }
  if (status === 'browser') {
    return <span className="shrink-0 text-[11px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.5 rounded">{t('downloads.openedBrowser')}</span>;
  }
  if (status === 'page') {
    return <span className="shrink-0 text-[11px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.5 rounded">{t('downloads.openedPage')}</span>;
  }
  if (status === 'completed') {
    return <span className="shrink-0 text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded flex items-center gap-1"><Check className="w-2.5 h-2.5" />{t('downloads.completed')}</span>;
  }
  if (status === 'error') {
    return <span className="shrink-0 text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30 px-1.5 py-0.5 rounded flex items-center gap-1"><XCircle className="w-2.5 h-2.5" />{t('downloads.failed')}</span>;
  }
  return <span className="shrink-0 text-[11px] font-medium bg-slate-500/15 text-slate-400 border border-slate-500/30 px-1.5 py-0.5 rounded">{t('downloads.cancelled')}</span>;
}

function PanelButton({
  onClick,
  icon,
  label,
  primary,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
        primary
          ? 'bg-sky-600 hover:bg-sky-500 text-white border-sky-500'
          : 'text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border-slate-950/10 dark:border-white/[0.08]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
