// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';

/**
 * Host architecture signal, resolved once per session. Both the catalog
 * resolver and the self-updater share this single promise so every picker
 * in one session sees the same arch.
 */

let archPromise: Promise<string | undefined> | null = null;

/** The host architecture when the runtime actually knows it:
 * - Tauri: the real host_arch from Rust (never a WebView guess).
 * - Browser: 'aarch64' only on a UA that positively names ARM; otherwise
 *   undefined. Modern UA reduction hides the CPU arch (MDN's own Android
 *   example is "Linux; Android 16; Pixel 9"), and the old x86_64 guess
 *   here made ARM-phone browsers pick x86_64-only APKs that cannot
 *   install. Callers treat undefined as "unknown, be conservative". */
export function getHostArch(): Promise<string | undefined> {
  if (!archPromise) {
    archPromise = (async () => {
      if (!isTauri()) {
        // typeof guard: Node 20 (CI) has no global navigator.
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
        return /arm|aarch/i.test(ua) ? 'aarch64' : undefined;
      }
      try {
        return (await invoke<string>('host_arch')) || undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return archPromise;
}
