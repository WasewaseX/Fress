// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Platform-actual command-palette key. Shared by the Header (search-field
 * chip) and the KeyboardShortcutsModal (first row): advertising "⌘K /
 * Ctrl+K" verbatim on every platform used to imply the wrong combo works.
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(`${navigator.platform || ''} ${navigator.userAgent}`);
export const PALETTE_KEY = IS_MAC ? '⌘K' : 'Ctrl+K';
