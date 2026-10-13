// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Framework-free mirror of the active UI language.
 *
 * The I18nProvider writes here whenever the language changes (including
 * during its very first render, before any effect fires). Pure formatting
 * helpers - format.ts is deliberately dependency-free and must not import
 * the React-side i18n module - read the localized fragments they need from
 * this leaf instead, so a formatter rendered inside a provider tree always
 * speaks the active language without prop drilling.
 */

export type SupportedLanguage = 'en' | 'fa' | 'es' | 'fr' | 'de';

let activeLanguage: SupportedLanguage = 'en';
// Localized "left" suffix for download ETAs; sourced from the i18n
// dictionary ('downloads.eta') so translators own the wording.
let etaSuffix = 'left';

export function setActiveLanguage(lang: SupportedLanguage): void {
  activeLanguage = lang;
}

export function getActiveLanguage(): SupportedLanguage {
  return activeLanguage;
}

export function setEtaSuffix(suffix: string): void {
  // Never let an empty/missing dictionary value erase the suffix entirely.
  etaSuffix = typeof suffix === 'string' && suffix.trim() ? suffix : 'left';
}

export function getEtaSuffix(): string {
  return etaSuffix;
}

/** Test hook: restore the pristine module state between cases. */
export function resetCurrentLangForTest(): void {
  activeLanguage = 'en';
  etaSuffix = 'left';
}
