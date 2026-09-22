// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { isTauri } from './downloads';

/**
 * Opens a URL in the user's system browser.
 * Inside the Tauri desktop app, window.open() and <a target="_blank"> are
 * silently swallowed by the webview, so every external link MUST go through
 * the opener plugin. In a plain browser tab this is a normal new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url || !/^https?:\/\//i.test(url)) return;

  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      // fall through to the browser path below
    }
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
