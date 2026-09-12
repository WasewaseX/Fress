import React, { useEffect, useState } from 'react';
import {
  X,
  Copy,
  Check,
  Download,
  Smartphone,
  Monitor,
  Apple,
  Terminal as TerminalIcon,
  Heart,
  ShieldCheck,
  ExternalLink,
  FolderOpen
} from 'lucide-react';
import { toast } from 'sonner';
import { openExternal } from '../lib/external';
import { useI18n } from '../lib/i18n';
import { useModalA11y } from '../lib/modalA11y';

export type GuideTab = 'install' | 'why' | 'build';

interface TauriModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to show when the modal opens (defaults to the beginner tab). */
  initialTab?: GuideTab;
  /** Closes the guide and opens the Downloads panel — wired by App. */
  onOpenDownloads?: () => void;
}

/** A batch script a beginner can double-click on Windows to build the app. */
const BAT_CONTENT = `@echo off
REM ============================================================
REM  Fress - one-click Windows build script
REM  Double-click this file. It installs the two prerequisites
REM  (Rust and Node.js) if they are missing, then builds the app.
REM ============================================================

where rustc >nul 2>nul
if errorlevel 1 (
  echo Rust is not installed. Opening https://rustup.rs ...
  echo Install it with the default options, then run this file again.
  start https://rustup.rs
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening https://nodejs.org ...
  echo Install the LTS version, then run this file again.
  pause
  exit /b 1
)

echo Installing web build dependencies...
call npm install || goto :error

echo Building the desktop installer. This can take 5-15 minutes.
call npx tauri build || goto :error

echo.
echo Done! Your installer is at:
echo   src-tauri\\target\\release\\bundle\\nsis\\
explorer "src-tauri\\target\\release\\bundle\\nsis"
pause
exit /b 0

:error
echo Something failed. Read the red error text above.
pause
exit /b 1
`;

const TERMINAL_STEPS = `npm install
npm run build
npx tauri build`;

export const TauriModal: React.FC<TauriModalProps> = ({ isOpen, onClose, initialTab = 'install', onOpenDownloads }) => {
  const [activeTab, setActiveTab] = useState<GuideTab>(initialTab);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const { t } = useI18n();
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);

  // Re-openings can request a different tab (e.g. from a download hint).
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const handleCopyCmd = () => {
    navigator.clipboard.writeText(TERMINAL_STEPS).then(
      () => {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 2000);
      },
      () => toast.error(t('common.copy') + ' failed')
    );
  };

  // The old build linked to /api/export/... which only worked when a dev
  // server was running, so the button silently did nothing in the packaged
  // app. Generating the file locally always works, offline included. Batch
  // files need CRLF line endings for cmd.exe to parse labels reliably.
  const handleDownloadBat = () => {
    try {
      const blob = new Blob([BAT_CONTENT.replace(/\n/g, '\r\n')], { type: 'application/x-bat' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'build-fress-windows.bat';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(t('guide.batSaved'), {
        description: t('guide.batSavedBody'),
      });
    } catch {
      toast.error(t('guide.batFail'));
    }
  };

  const tabClass = (active: boolean) =>
    `py-2.5 px-3 font-medium whitespace-nowrap border-b-2 transition-colors ${
      active ? 'border-sky-500 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div
      id="tauri-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 fr-backdrop backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tauri-modal-title"
      onClick={onClose}
    >
      <div
        id="tauri-modal-container"
        ref={containerRef}
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div id="tauri-modal-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-start justify-between bg-slate-900">
          <div>
            <h2 id="tauri-modal-title" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              {t('guide.title')}
            </h2>
            <p id="tauri-modal-desc" className="text-xs text-slate-400 mt-0.5">
              {t('guide.subtitle')}
            </p>
          </div>
          <button
            id="close-tauri-modal-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab selector */}
        <div id="tauri-tabs-row" className="flex border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950 px-4 text-xs overflow-x-auto">
          <button id="tab-btn-install" type="button" onClick={() => setActiveTab('install')} className={tabClass(activeTab === 'install')}>
            {t('guide.tabInstall')}
          </button>
          <button id="tab-btn-why" type="button" onClick={() => setActiveTab('why')} className={tabClass(activeTab === 'why')}>
            {t('guide.tabWhy')}
          </button>
          <button id="tab-btn-dev" type="button" onClick={() => setActiveTab('build')} className={tabClass(activeTab === 'build')}>
            {t('guide.tabBuild')}
          </button>
        </div>

        {/* Content area */}
        <div id="tauri-tab-body" className="p-4 sm:p-6 space-y-4 overflow-y-auto text-xs text-slate-300">

          {/* ------------------------------------------------ INSTALL */}
          {activeTab === 'install' && (
            <div className="space-y-3">
              <p className="text-slate-400 leading-relaxed">
                {t('guide.installIntro')}
              </p>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <Monitor className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" /> Windows
                </h3>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed">
                  <li>{t('guide.win.step1')}</li>
                  <li>{t('guide.win.step2')}</li>
                  <li>{t('guide.win.step3')}</li>
                </ol>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <Apple className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" /> macOS
                </h3>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed">
                  <li>{t('guide.mac.step1')}</li>
                  <li>{t('guide.mac.step2')}</li>
                  <li>{t('guide.mac.step3')}</li>
                </ol>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <TerminalIcon className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" /> Linux
                </h3>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed">
                  <li>{t('guide.linux.step1')}</li>
                  <li>{t('guide.linux.step2')}</li>
                  <li>{t('guide.linux.step3')}</li>
                </ol>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <Smartphone className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> Android
                </h3>
                <p className="font-semibold text-slate-300 mb-1">{t('guide.android.title')}</p>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed">
                  <li>{t('guide.android.transfer')}</li>
                  <li>{t('guide.android.open')}</li>
                  <li>{t('guide.android.playProtect')}</li>
                </ol>
                <p className="text-slate-400 leading-relaxed mt-2">{t('guide.android.fdroidTip')}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {onOpenDownloads && (
                  <button
                    id="guide-open-downloads-btn"
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenDownloads();
                    }}
                    className="inline-flex items-center gap-1.5 text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-3 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
                  >
                    <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t('guide.openDownloads')}</span>
                  </button>
                )}
                <button
                  id="guide-fdroid-btn"
                  type="button"
                  onClick={() => void openExternal('https://f-droid.org')}
                  className="inline-flex items-center gap-1.5 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 px-3 py-2 rounded-lg border border-slate-950/10 dark:border-white/[0.1] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('guide.fdroidSite')}</span>
                </button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ WHY FOSS */}
          {activeTab === 'why' && (
            <div className="space-y-3">
              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <Heart className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" /> {t('guide.why.heading')}
                </h3>
                <p className="text-slate-400 leading-relaxed">{t('guide.why.body1')}</p>
                <p className="text-slate-400 leading-relaxed mt-2">{t('guide.why.body2')}</p>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> {t('guide.why.safeHeading')}
                </h3>
                <p className="text-slate-400 leading-relaxed">{t('guide.why.safeBody')}</p>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h3 className="font-semibold text-slate-200 text-xs mb-1.5">{t('guide.why.licenseHeading')}</h3>
                <ul className="space-y-1.5 text-slate-400 leading-relaxed">
                  <li><code className="font-mono text-sky-300">MIT</code> — {t('guide.why.licenseMit')}</li>
                  <li><code className="font-mono text-sky-300">GPL</code> — {t('guide.why.licenseGpl')}</li>
                  <li><code className="font-mono text-sky-300">AGPL</code> — {t('guide.why.licenseAgpl')}</li>
                  <li><code className="font-mono text-sky-300">Apache</code> — {t('guide.why.licenseApache')}</li>
                </ul>
                <button
                  id="guide-opensource-btn"
                  type="button"
                  onClick={() => void openExternal('https://opensource.org/faq')}
                  className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 underline underline-offset-2 mt-2"
                >
                  {t('guide.why.learnMore')} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ BUILD (developers) */}
          {activeTab === 'build' && (
            <div className="space-y-4">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  Easy way (script)
                </h3>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed text-xs">
                  <li>
                    Rust — install it from{' '}
                    <button type="button" onClick={() => void openExternal('https://rustup.rs')} className="text-sky-400 hover:text-sky-300 underline underline-offset-2 inline-flex items-center gap-0.5">
                      rustup.rs <ExternalLink className="w-3 h-3" />
                    </button>{' '}
                    (keep the default options).
                  </li>
                  <li>
                    Node.js LTS — install it from{' '}
                    <button type="button" onClick={() => void openExternal('https://nodejs.org')} className="text-sky-400 hover:text-sky-300 underline underline-offset-2 inline-flex items-center gap-0.5">
                      nodejs.org <ExternalLink className="w-3 h-3" />
                    </button>
                    .
                  </li>
                  <li>
                    <button
                      id="download-build-bat-btn"
                      type="button"
                      onClick={handleDownloadBat}
                      className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 underline underline-offset-2"
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>Download the build script (.bat)</span>
                    </button>{' '}
                    and double-click it in the project folder. 5–15 minutes later the installer is in{' '}
                    <code className="font-mono text-emerald-300">src-tauri/target/release/bundle/nsis/</code>
                  </li>
                </ol>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-slate-200">Terminal commands</span>
                  <button
                    id="copy-tauri-cmd-btn"
                    type="button"
                    onClick={handleCopyCmd}
                    className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] transition-colors"
                  >
                    {copiedCmd ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 text-slate-400" aria-hidden="true" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <pre id="tauri-commands-codeblock" className="bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 text-xs font-mono text-sky-300 overflow-x-auto select-all">
                  {TERMINAL_STEPS}
                </pre>
              </div>

              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  Fully automatic (CI)
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  The workflow in <code className="text-sky-300 font-mono">.github/workflows/release.yml</code> builds installers for every platform automatically. Push a version tag (for example <code className="text-sky-300 font-mono">vX.Y.Z-beta</code>) and GitHub publishes the finished installers on the Releases page — nothing to install on your PC.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div id="tauri-modal-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            {t('guide.footerNote')}
          </span>
          <button
            id="close-tauri-done-btn"
            type="button"
            onClick={onClose}
            className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-4 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
