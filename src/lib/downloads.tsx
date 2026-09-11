import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';

export type DownloadStatus = 'active' | 'completed' | 'error' | 'cancelled' | 'browser';

export interface DownloadItem {
  id: number;
  url: string;
  name: string;
  dir: string;
  bytes: number;
  total: number;
  speed: number;
  eta: number;
  status: DownloadStatus;
  error?: string;
  path?: string;
  sha256?: string;
  startedAt: number;
}

const DIR_KEY = 'fress.downloadDir';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface DownloadsContextValue {
  items: DownloadItem[];
  activeCount: number;
  downloadDir: string | null;
  startDownload: (url: string, nameHint?: string) => Promise<void>;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  clearFinished: () => void;
  openFile: (path: string) => void;
  openFolder: (path?: string) => void;
  chooseFolder: () => Promise<void>;
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null);

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const itemsRef = useRef<DownloadItem[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisteners: Array<() => void> = [];

    invoke<string>('default_download_dir')
      .then((dir) => {
        try {
          const saved = localStorage.getItem(DIR_KEY);
          setDownloadDir(saved || dir);
        } catch {
          setDownloadDir(dir);
        }
      })
      .catch(() => setDownloadDir(null));

    listen<{ id: number; downloaded: number; total: number; speed_bps: number; eta_secs: number }>(
      'download-progress',
      (event) => {
        const p = event.payload;
        setItems((prev) =>
          prev.map((it) =>
            it.id === p.id
              ? {
                  ...it,
                  bytes: p.downloaded,
                  total: p.total,
                  speed: p.speed_bps,
                  eta: p.eta_secs,
                }
              : it
          )
        );
      }
    ).then((un) => unlisteners.push(un));

    listen<{ id: number; path: string; bytes: number; sha256: string }>('download-complete', (event) => {
      const p = event.payload;
      setItems((prev) =>
        prev.map((it) =>
          it.id === p.id ? { ...it, status: 'completed', path: p.path, bytes: p.bytes, sha256: p.sha256, total: p.bytes, speed: 0, eta: 0 } : it
        )
      );
      const item = itemsRef.current.find((it) => it.id === p.id);
      toast.success(`Downloaded ${item?.name || 'file'}`, {
        description: p.path,
      });
    });

    listen<{ id: number; message: string }>('download-error', (event) => {
      const p = event.payload;
      if (p.message === 'Cancelled') {
        setItems((prev) => prev.map((it) => (it.id === p.id ? { ...it, status: 'cancelled' } : it)));
        toast.info('Download cancelled');
      } else {
        setItems((prev) => prev.map((it) => (it.id === p.id ? { ...it, status: 'error', error: p.message } : it)));
        toast.error('Download failed', { description: p.message });
      }
    }).then((un) => unlisteners.push(un));

    return () => {
      unlisteners.forEach((un) => un());
    };
  }, []);

  const startDownload = useCallback(
    async (url: string, nameHint?: string) => {
      if (!url || !/^https?:\/\//i.test(url)) {
        toast.error('This link is not a direct download');
        return;
      }

      const guessedName = nameHint || decodeURIComponent(url.split('/').pop()?.split('?')[0] || '') || undefined;

      if (!isTauri()) {
        // Browser fallback (web preview / dev in a normal tab):
        // open a NEW tab, record it in the panel, explain. Never navigate away.
        window.open(url, '_blank', 'noopener,noreferrer');
        setItems((prev) => [
          {
            id: Date.now(),
            url,
            name: guessedName || url,
            dir: 'Browser downloads folder',
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'browser',
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info('Opened the download in a new browser tab', {
          description: 'The Fress desktop app adds a download manager with live progress and SHA-256 verification.',
        });
        return;
      }

      let dir: string;
      try {
        const saved = localStorage.getItem(DIR_KEY);
        dir = saved || (await invoke<string>('default_download_dir'));
      } catch {
        dir = await invoke<string>('default_download_dir');
      }

      try {
        const id = await invoke<number>('start_download', {
          url,
          filename: guessedName || null,
          directory: dir,
        });
        setItems((prev) => [
          {
            id,
            url,
            name: guessedName || 'download',
            dir,
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'active',
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info('Download started', { description: guessedName || url });
      } catch (e) {
        toast.error('Could not start download', { description: String(e) });
      }
    },
    []
  );

  const cancel = useCallback((id: number) => {
    invoke('cancel_download', { id }).catch(() => undefined);
  }, []);

  const retry = useCallback(
    (id: number) => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (item) {
        setItems((prev) => prev.filter((it) => it.id !== id));
        void startDownload(item.url, item.name);
      }
    },
    [startDownload]
  );

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.status === 'active'));
  }, []);

  const openFile = useCallback((path: string) => {
    if (isTauri()) {
      openPath(path).catch(() => toast.error('Could not open the file'));
    }
  }, []);

  const openFolder = useCallback((path?: string) => {
    if (!isTauri()) return;
    const target = path || downloadDir;
    if (!target) return;
    if (path) {
      revealItemInDir(path).catch(() => openPath(target).catch(() => toast.error('Could not open the folder')));
    } else {
      openPath(target).catch(() => toast.error('Could not open the folder'));
    }
  }, [downloadDir]);

  const chooseFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info('Folder picker is available in the desktop app');
      return;
    }
    const selected = await openDialog({ directory: true, multiple: false, title: 'Choose download folder' });
    if (typeof selected === 'string') {
      setDownloadDir(selected);
      try {
        localStorage.setItem(DIR_KEY, selected);
      } catch {
        // ignore
      }
      toast.success('Download folder updated', { description: selected });
    }
  }, []);

  const activeCount = items.filter((it) => it.status === 'active').length;

  return (
    <DownloadsContext.Provider
      value={{ items, activeCount, downloadDir, startDownload, cancel, retry, clearFinished, openFile, openFolder, chooseFolder }}
    >
      {children}
    </DownloadsContext.Provider>
  );
}

export function useDownloads(): DownloadsContextValue {
  const ctx = useContext(DownloadsContext);
  if (!ctx) throw new Error('useDownloads must be used inside DownloadsProvider');
  return ctx;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatEta(secs: number): string {
  if (!secs || !isFinite(secs) || secs <= 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m < 60) return `${m}m ${s}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}
