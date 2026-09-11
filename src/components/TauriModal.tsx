import React, { useState } from 'react';
import { 
  X, 
  Copy, 
  Check, 
  Download, 
  Box
} from 'lucide-react';

interface TauriModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TauriModal: React.FC<TauriModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'build' | 'config' | 'github'>('build');
  const [copiedCmd, setCopiedCmd] = useState(false);

  if (!isOpen) return null;

  const buildCommand = `npm install
npm run build
npx @tauri-apps/cli build`;

  const handleCopyCmd = () => {
    navigator.clipboard.writeText(buildCommand);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  return (
    <div 
      id="tauri-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tauri-modal-title"
    >
      <div 
        id="tauri-modal-container"
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div id="tauri-modal-header" className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-start justify-between bg-slate-900">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span id="tauri-arch-badge" className="text-xs font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded">
                Tauri v2 + Rust
              </span>
              <span id="tauri-target-badge" className="text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                Windows .exe Target
              </span>
            </div>
            <h2 id="tauri-modal-title" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              Desktop Installer Packaging
            </h2>
            <p id="tauri-modal-desc" className="text-xs text-slate-400 mt-0.5">
              Compile Fress into a lightweight native Windows executable using Rust and WebView2.
            </p>
          </div>
          <button
            id="close-tauri-modal-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab selector */}
        <div id="tauri-tabs-row" className="flex border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950 px-4 text-xs">
          <button
            id="tab-btn-compile"
            type="button"
            onClick={() => setActiveTab('build')}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'build'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            1. Compile on Windows
          </button>
          <button
            id="tab-btn-github-actions"
            type="button"
            onClick={() => setActiveTab('github')}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'github'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            2. Automated CI/CD (.exe)
          </button>
          <button
            id="tab-btn-config-files"
            type="button"
            onClick={() => setActiveTab('config')}
            className={`py-2.5 px-3 font-medium border-b-2 transition-colors ${
              activeTab === 'config'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            3. Project Configuration
          </button>
        </div>

        {/* Content area */}
        <div id="tauri-tab-body" className="p-4 sm:p-6 space-y-4 overflow-y-auto text-xs text-slate-300">
          {activeTab === 'build' && (
            <div className="space-y-4">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  How the Desktop Installer is Generated
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  Tauri uses Rust as the backend binary and connects directly to the native Microsoft Edge WebView2 control pre-installed in Windows 10 and 11. This creates a lightweight executable that opens in milliseconds with minimal RAM consumption.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-slate-200">
                    Terminal Command
                  </span>
                  <div className="flex items-center gap-2">
                    <a
                      id="download-build-bat-btn"
                      href="/api/export/tauri-installer-guide"
                      download="build-windows-exe.bat"
                      className="inline-flex items-center gap-1 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-sky-400 px-2.5 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.1] transition-colors"
                      title="Download the automated build-windows-exe.bat script"
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>Download .bat</span>
                    </a>
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
                </div>

                <pre id="tauri-commands-codeblock" className="bg-slate-950 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 text-xs font-mono text-sky-300 overflow-x-auto select-all">
                  {buildCommand}
                </pre>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02]">
                <h4 className="font-semibold text-slate-200 mb-1.5 flex items-center gap-1.5">
                  <Box className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                  <span>Output Deliverables</span>
                </h4>
                <p className="text-slate-400 mb-2 text-xs">
                  Once compiled, Tauri produces two installable packages in the target directory:
                </p>
                <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                  <li className="bg-slate-950 p-2 rounded border border-slate-950/10 dark:border-white/[0.06]">
                    NSIS Installer: <span className="text-emerald-300">src-tauri/target/release/bundle/nsis/Fress_1.0.0_x64-setup.exe</span>
                  </li>
                  <li className="bg-slate-950 p-2 rounded border border-slate-950/10 dark:border-white/[0.06]">
                    MSI Package: <span className="text-emerald-300">src-tauri/target/release/bundle/msi/Fress_1.0.0_x64_en-US.msi</span>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'github' && (
            <div className="space-y-3">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  Automated Cloud Compilation via GitHub Actions
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  A GitHub Actions workflow is provided in <code className="text-sky-300 font-mono">.github/workflows/build-windows-exe.yml</code>. Whenever you push to GitHub, a virtual machine builds the Windows <code className="text-sky-300 font-mono">.exe</code> installer automatically.
                </p>
              </div>

              <div className="border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3 bg-slate-950/[0.03] dark:bg-white/[0.02] space-y-2">
                <h4 className="font-semibold text-slate-200 text-xs">
                  Download Steps:
                </h4>
                <ol className="list-decimal list-inside space-y-1 text-slate-300 text-xs">
                  <li>Push this codebase to your GitHub repository.</li>
                  <li>Go to the <strong>Actions</strong> tab in your repository.</li>
                  <li>Select the <strong>Build Windows Tauri Installer</strong> workflow.</li>
                  <li>Click <strong>Run workflow</strong>.</li>
                  <li>Download the compiled <code className="font-mono text-sky-300">Fress_setup.exe</code> artifact.</li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'config' && (
            <div className="space-y-3">
              <div className="bg-slate-950/[0.03] dark:bg-white/[0.02] border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-3">
                <h3 className="font-semibold text-slate-200 text-xs mb-1">
                  Configured Tauri Rust Files
                </h3>
                <p className="text-slate-400 leading-relaxed text-xs">
                  All necessary files are initialized and pre-configured in this repository:
                </p>
                <ul className="mt-2 space-y-1 text-slate-300 font-mono text-[11px]">
                  <li>• <strong className="text-sky-300">src-tauri/tauri.conf.json</strong> (window resolution, NSIS bundle, permissions)</li>
                  <li>• <strong className="text-sky-300">src-tauri/Cargo.toml</strong> (Rust dependencies: tauri v2, serde)</li>
                  <li>• <strong className="text-sky-300">src-tauri/src/main.rs</strong> (entry point)</li>
                  <li>• <strong className="text-sky-300">src-tauri/build.rs</strong> (build script)</li>
                  <li>• <strong className="text-sky-300">.github/workflows/build-windows-exe.yml</strong> (CI/CD release builder)</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div id="tauri-modal-footer" className="p-3 sm:p-4 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            Tauri 2.0 configuration ready for distribution.
          </span>
          <button
            id="close-tauri-done-btn"
            type="button"
            onClick={onClose}
            className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-4 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
