import { isTauri } from './downloads';

/**
 * Opens a URL in the user's system browser.
 * Inside the Tauri desktop app, window.open() and <a target="_blank"> are
 * silently swallowed by the webview, so every external link MUST go through
 * the opener plugin. In a plain browser tab this is a normal new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  // URL() instead of a regex: a crafted string with embedded control
  // characters or a lookalike scheme (java\nscript:…) fails to parse or
  // lands on a non-http(s) protocol and is refused outright.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  // Control characters must never reach the OS opener.
  if (/[\u0000-\u001f\u007f]/.test(url)) return;
  const clean = parsed.toString();

  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(clean);
      return;
    } catch {
      // fall through to the browser path below
    }
  }

  window.open(clean, '_blank', 'noopener,noreferrer');
}
