// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useEffect, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { formatMessage, useI18n, CATEGORY_I18N_KEYS } from '../lib/i18n';
import { AppItem, Category, Platform } from '../types';
import { X, Plus, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { fetchLiveStarCount } from '../lib/starFetch';
import { sanitizeInstallCommand } from '../lib/installCommands';

interface AddAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveApp: (app: AppItem) => void;
  initialApp?: AppItem | null;
  /** Catalog snapshot: powers the duplicate-entry guard (the search flow
   *  has this check via its own existingApps; manual add used to create
   *  silent duplicates). */
  existingApps?: AppItem[];
  /** Shows the Search/Manual tabs when the modal is opened from the shared Add flow. */
  showTabs?: boolean;
  onSwitchTab?: (tab: 'search' | 'manual') => void;
}

const CATEGORIES: Category[] = [
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video'
];

export const AddAppModal: React.FC<AddAppModalProps> = ({
  isOpen,
  onClose,
  onSaveApp,
  initialApp,
  existingApps = [],
  showTabs = false,
  onSwitchTab
}) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [category, setCategory] = useState<Category>('Utilities & System');
  const [platforms, setPlatforms] = useState<Platform[]>(['windows']);
  const [license, setLicense] = useState('MIT');
  // The RAW text, not a number: a number state snapped an emptied field to
  // "0" mid-edit (you could never blank it) and "-5" triggered a native
  // WebView-locale validation bubble instead of the modal's own errors.
  const [stars, setStars] = useState<string>('');
  const [starsAutoFilled, setStarsAutoFilled] = useState(false);
  const [description, setDescription] = useState('');
  const [whyItsAwesome, setWhyItsAwesome] = useState('');
  const [beginnerGuide, setBeginnerGuide] = useState('');
  const [wingetCommand, setWingetCommand] = useState('');
  const [brewCommand, setBrewCommand] = useState('');
  const [flatpakCommand, setFlatpakCommand] = useState('');
  const [scoopCommand, setScoopCommand] = useState('');
  const [aptCommand, setAptCommand] = useState('');
  const [proprietaryAlternative, setProprietaryAlternative] = useState('');
  const [tags, setTags] = useState('');
  
  const [errorMsg, setErrorMsg] = useState('');
  // Which field the current error refers to: the alert names the problem,
  // aria-invalid + aria-describedby tie it to the exact input for AT.
  const [errorField, setErrorField] = useState<'name' | 'description' | 'form' | null>(null);
  // Set once the user edits the stars field by hand: the URL auto-fill must
  // never clobber a manual entry when its (debounced) fetch lands late.
  const starsTouchedRef = useRef(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectSuccessMsg, setInspectSuccessMsg] = useState('');

  useEffect(() => {
    if (initialApp) {
      setName(initialApp.name);
      setTagline(initialApp.tagline);
      setWebsiteUrl(initialApp.websiteUrl);
      setGithubUrl(initialApp.githubUrl);
      setGitlabUrl(initialApp.gitlabUrl || '');
      setCategory(initialApp.category);
      setPlatforms(initialApp.platforms);
      setLicense(initialApp.license);
      setStars(String(initialApp.stars || ''));
      setStarsAutoFilled(false);
      setDescription(initialApp.description);
      setWhyItsAwesome(initialApp.whyItsAwesome);
      setBeginnerGuide(initialApp.beginnerGuide);
      setWingetCommand(initialApp.wingetCommand || '');
      setBrewCommand(initialApp.brewCommand || '');
      setFlatpakCommand(initialApp.flatpakCommand || '');
      setScoopCommand(initialApp.scoopCommand || '');
      setAptCommand(initialApp.aptCommand || '');
      setProprietaryAlternative(initialApp.proprietaryAlternative || '');
      setTags(initialApp.tags.join(', '));
    } else {
      setName('');
      setTagline('');
      setWebsiteUrl('');
      setGithubUrl('');
      setGitlabUrl('');
      setCategory('Utilities & System');
      setPlatforms(['windows']);
      setLicense('MIT');
      setStars(''); // never invent a star count for a manually added app
      setDescription('');
      setWhyItsAwesome('');
      setBeginnerGuide('');
      setWingetCommand('');
      setBrewCommand('');
      setFlatpakCommand('');
      setScoopCommand('');
      setAptCommand('');
      setProprietaryAlternative('');
      setTags('');
    }
    setErrorMsg('');
    setErrorField(null);
    setInspectSuccessMsg('');
    starsTouchedRef.current = false;
  }, [initialApp, isOpen]);

  // Stars are never guessed: once a GitHub/GitLab URL is pasted, the live
  // count is pulled from the forge API and prefilled. A manual override is
  // still possible for repos the forge APIs don't cover.
  useEffect(() => {
    if (!isOpen) return;
    // The user typed a star count by hand: never overwrite it with the
    // fetch result that was still in flight (the flag used to be set but
    // never consulted, so a manual value was clobbered ~600ms later).
    if (starsTouchedRef.current) return;
    const url = githubUrl.trim();
    if (!url) return;
    let alive = true;
    const timer = setTimeout(() => {
      void fetchLiveStarCount(url).then((n) => {
        if (alive && typeof n === 'number' && n >= 0) {
          setStars(String(n));
          setStarsAutoFilled(true);
        }
      });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [githubUrl, isOpen]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Focus lands on the first form control (the GitHub URL field) - the
  // useful control for both add and edit flows - not on the close button.
  const firstFieldRef = useRef<HTMLInputElement>(null);
  keepFocusInside(panelRef, isOpen, { onEscape: onClose, initialFocus: firstFieldRef });
  if (!isOpen) return null;

  const togglePlatform = (p: Platform) => {
    if (platforms.includes(p)) {
      if (platforms.length > 1) {
        setPlatforms(platforms.filter((item) => item !== p));
      }
    } else {
      setPlatforms([...platforms, p]);
    }
  };

  const handleInspectGitHub = async () => {
    if (!githubUrl) return;
    setIsInspecting(true);
    setErrorMsg('');
    setInspectSuccessMsg('');

    try {
      const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        throw new Error(t('add.invalidGithubUrl'));
      }
      const [, owner, repo] = match;
      const cleanRepo = repo.replace(/\.git$/, '');

      const res = await fetch(`https://api.github.com/repos/${owner}/${cleanRepo}`);
      if (!res.ok) {
        throw new Error(formatMessage(t('add.githubApiStatus'), { status: res.status }));
      }

      const data = await res.json();
      if (!name) setName(data.name || cleanRepo);
      if (!tagline && data.description) setTagline(data.description.slice(0, 110));
      if (!description && data.description) setDescription(data.description);
      if (data.stargazers_count !== undefined) setStars(data.stargazers_count);
      if (data.homepage && !websiteUrl) setWebsiteUrl(data.homepage);
      if (data.license?.spdx_id) setLicense(data.license.spdx_id);

      if (!wingetCommand) setWingetCommand(`winget install ${data.name || cleanRepo}`);
      if (!brewCommand) setBrewCommand(`brew install --cask ${(data.name || cleanRepo).toLowerCase()}`);
      if (!flatpakCommand) setFlatpakCommand(`flatpak install flathub ${(data.name || cleanRepo).toLowerCase()}`);
      if (!scoopCommand) setScoopCommand(`scoop install ${(data.name || cleanRepo).toLowerCase()}`);
      if (!aptCommand) setAptCommand(`apt install ${(data.name || cleanRepo).toLowerCase()}`);

      if (data.topics && data.topics.length > 0 && !tags) {
        setTags(data.topics.slice(0, 5).join(', '));
      }

      setInspectSuccessMsg(formatMessage(t('add.inspectSuccess'), { name: data.name || cleanRepo }));
    } catch (err: any) {
      // Only our own validation throws carry translated messages; a raw
      // network failure (TypeError) leaked browser-locale English like
      // "Failed to fetch" - fall back to the translated generic instead.
      setErrorMsg(err instanceof TypeError ? t('add.inspectFailed') : (err.message || t('add.inspectFailed')));
    } finally {
      setIsInspecting(false);
    }
  };

  const fail = (msg: string, field: 'name' | 'description' | 'form') => {
    setErrorMsg(msg);
    setErrorField(field);
  };

  // Only http(s) URLs are meaningful for repo/website links; the type="url"
  // input constraint used to be the only check and produced a native
  // browser-locale bubble, not this modal's translated error UI.
  const isHttpUrl = (value: string): boolean => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      fail(t('add.nameRequired'), 'name');
      return;
    }
    if (!description.trim()) {
      fail(t('add.descriptionRequired'), 'description');
      return;
    }
    if (githubUrl.trim() && !isHttpUrl(githubUrl.trim())) {
      fail(t('add.invalidGithubUrl'), 'form');
      return;
    }
    if (gitlabUrl.trim() && !isHttpUrl(gitlabUrl.trim())) {
      fail(t('add.invalidGithubUrl'), 'form');
      return;
    }

    // Duplicate-entry guard (edit path exempt - it updates its own entry):
    // adding "VLC" twice used to create two catalog entries with two
    // success toasts and no hint of the conflict.
    if (!initialApp) {
      const nameKey = name.trim().toLowerCase();
      const repoKey = githubUrl.trim().toLowerCase().replace(/\/$/, '');
      const duplicate = existingApps.some((a) => {
        if (a.name.trim().toLowerCase() === nameKey) return true;
        return !!repoKey && (a.githubUrl || '').trim().toLowerCase().replace(/\/$/, '') === repoKey;
      });
      if (duplicate) {
        fail(t('add.duplicate'), 'name');
        return;
      }
    }

    const tagArray = tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    // Install commands end up in generated batch scripts, so anything that
    // is not a plain single install invocation is refused here, at the door.
    if (wingetCommand.trim() && !sanitizeInstallCommand('winget', wingetCommand)) {
      fail(t('add.cmdUnsafeWinget'), 'form');
      return;
    }
    if (brewCommand.trim() && !sanitizeInstallCommand('brew', brewCommand)) {
      fail(t('add.cmdUnsafeBrew'), 'form');
      return;
    }
    if (flatpakCommand.trim() && !sanitizeInstallCommand('flatpak', flatpakCommand)) {
      fail(t('add.cmdUnsafeFlatpak'), 'form');
      return;
    }
    if (scoopCommand.trim() && !sanitizeInstallCommand('scoop', scoopCommand)) {
      fail(t('add.cmdUnsafeScoop'), 'form');
      return;
    }
    if (aptCommand.trim() && !sanitizeInstallCommand('apt', aptCommand)) {
      fail(t('add.cmdUnsafeApt'), 'form');
      return;
    }

    const newApp: AppItem = {
      id: initialApp ? initialApp.id : `custom-${Date.now()}`,
      name: name.trim(),
      tagline: tagline.trim() || name.trim(),
      // Empty string, never a "#" placeholder: AppDetailModal, TableView,
      // CompareModal and the download options all treat a falsy websiteUrl
      // as "no website", while "#" used to survive those guards and render
      // a dead Official Website button.
      websiteUrl: websiteUrl.trim() || githubUrl.trim() || '',
      // ALWAYS a string (possibly empty), never undefined: AppCard and
      // AppDetailModal call githubUrl.includes(...) unguarded, so a manual
      // entry saved without a repo URL used to white-screen the whole app
      // on the next render. The storage loader sanitizes undefined to '' -
      // the save path must produce the same shape.
      githubUrl: githubUrl.trim(),
      gitlabUrl: gitlabUrl.trim(),
      category,
      platforms,
      license: license.trim() || 'Open Source',
      // Clamp on the way out: no native min-constraint bubble, no negative
      // or fractional garbage reaching the catalog metadata row.
      stars: Math.max(0, Math.floor(Number(stars) || 0)),
      description: description.trim(),
      whyItsAwesome: whyItsAwesome.trim() || 'Curated community open-source application.',
      beginnerGuide: beginnerGuide.trim() || 'Download and install from the official release page.',
      wingetCommand: sanitizeInstallCommand('winget', wingetCommand) || undefined,
      brewCommand: sanitizeInstallCommand('brew', brewCommand) || undefined,
      flatpakCommand: sanitizeInstallCommand('flatpak', flatpakCommand) || undefined,
      scoopCommand: sanitizeInstallCommand('scoop', scoopCommand) || undefined,
      aptCommand: sanitizeInstallCommand('apt', aptCommand) || undefined,
      proprietaryAlternative: proprietaryAlternative.trim() || undefined,
      tags: tagArray.length > 0 ? tagArray : ['open-source', 'desktop'],
      isOwnerPick: initialApp ? initialApp.isOwnerPick : false,
      isTrendingToday: initialApp ? initialApp.isTrendingToday : false,
      isCustom: true,
      // offlineReady is a claim about the software, not a default: it stays
      // empty unless the app itself is known to work offline.
      offlineReady: initialApp?.offlineReady,
      addedAt: initialApp?.addedAt || new Date().toISOString().split('T')[0]
    };

    onSaveApp(newApp);
    onClose();
  };

  return (
    <div 
      ref={panelRef}
      id="add-app-modal-backdrop" 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 fr-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-modal-title"
    >
      <div 
        id="add-app-card"
        className="bg-slate-900 border border-slate-950/[0.12] dark:border-white/[0.12] rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between gap-3 bg-slate-900">
          <div>
            <h2 id="add-modal-title" className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
              {initialApp ? t('add.titleEdit') : t('ls.tabManual')}
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {t('common.savedLocal')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Shared tabs: one entry point for both ways of adding an app.
            Plain pressed buttons, matching LiveSearchModal - the tab roles
            promised an ARIA pattern (arrows, tabpanels) that was never
            implemented. */}
        {showTabs && onSwitchTab && !initialApp && (
          <div className="flex items-center gap-1 px-4 sm:px-5 py-2 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-900" role="group" aria-label={t('ls.tabsAria')}>
            {([['search', t('ls.title')], ['manual', t('ls.tabManual')]] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={id === 'manual'}
                onClick={() => onSwitchTab(id)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                  id === 'manual'
                    ? 'bg-sky-600 text-white border border-sky-500'
                    : 'text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Form Body. noValidate: native constraint bubbles (type=url,
            number min) render in the WebView's locale, not the app's -
            every validation message goes through the translated alert
            instead. The fields scroll INSIDE the form; the save/cancel row
            is pinned below the scroll region (like every other modal
            footer) so the primary action stays reachable at the 320px
            floor without scrolling the whole form. */}
        <form onSubmit={handleSubmit} noValidate className="flex-1 min-h-0 flex flex-col text-xs">
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
          {errorMsg && (
            <div id="add-form-error" role="alert" className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          {inspectSuccessMsg && (
            <div role="status" className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-lg flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{inspectSuccessMsg}</span>
            </div>
          )}

          {/* GitHub Auto-Fill */}
          <div className="space-y-1">
            <label htmlFor="input-github-url" className="block text-slate-300 font-medium">
              {t('add.githubLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="input-github-url"
                ref={firstFieldRef}
                type="url"
                dir="ltr"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/owner/repository"
                className="flex-1 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
              <button
                type="button"
                onClick={handleInspectGitHub}
                disabled={isInspecting || !githubUrl}
                className="inline-flex items-center gap-1.5 text-xs bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] disabled:opacity-50 text-sky-400 font-semibold px-3 py-2 rounded-lg border border-slate-950/10 dark:border-white/[0.1] transition-colors shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isInspecting ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isInspecting ? t('add.fetching') : t('add.autoFill')}</span>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="input-gitlab-url" className="block text-slate-300 font-medium">
              {t('add.gitlabLabel')} <span className="text-slate-400 font-normal">{t('add.gitlabHint')}</span>
            </label>
            <input
              id="input-gitlab-url"
              type="url"
              dir="ltr"
              value={gitlabUrl}
              onChange={(e) => setGitlabUrl(e.target.value)}
              placeholder="https://gitlab.com/owner/repository"
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="input-app-name" className="block text-slate-300 font-medium mb-1">
                {t('add.nameLabel')}
              </label>
              <input
                id="input-app-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('add.namePlaceholder')}
                aria-invalid={errorField === 'name' || undefined}
                aria-describedby={errorMsg ? 'add-form-error' : undefined}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-app-tagline" className="block text-slate-300 font-medium mb-1">
                {t('add.taglineLabel')}
              </label>
              <input
                id="input-app-tagline"
                type="text"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder={t('add.taglinePlaceholder')}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="input-website-url" className="block text-slate-300 font-medium mb-1">
                {t('add.websiteLabel')}
              </label>
              <input
                id="input-website-url"
                type="url"
                dir="ltr"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://syncthing.net"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-alt" className="block text-slate-300 font-medium mb-1">
                {t('add.replacesLabel')}
              </label>
              <input
                id="input-alt"
                type="text"
                value={proprietaryAlternative}
                onChange={(e) => setProprietaryAlternative(e.target.value)}
                placeholder={t('add.replacesPlaceholder')}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="select-category" className="block text-slate-300 font-medium mb-1">
                {t('add.categoryLabel')}
              </label>
              <select
                id="select-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="w-full bg-slate-900 border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(CATEGORY_I18N_KEYS[c])}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="input-license" className="block text-slate-300 font-medium mb-1">
                {t('table.head.license')}
              </label>
              <input
                id="input-license"
                type="text"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                placeholder="MIT / GPL-3.0"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-stars" className="block text-slate-300 font-medium mb-1">
                {t('add.starsLabel')}
              </label>
              <input
                id="input-stars"
                type="number"
                inputMode="numeric"
                dir="ltr"
                value={stars}
                onChange={(e) => {
                  starsTouchedRef.current = true;
                  setStars(e.target.value);
                  setStarsAutoFilled(false);
                }}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {starsAutoFilled
                  ? t('add.starsAutoFilled')
                  : t('add.starsAutoHint')}
              </p>
            </div>
          </div>

          {/* Operating Systems */}
          <div>
            <span id="add-platforms-label" className="block text-slate-300 font-medium mb-1.5">
              {t('add.platformsLabel')}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-labelledby="add-platforms-label">
              {(['windows', 'mac', 'linux', 'android', 'web'] as Platform[]).map((p) => {
                const isSelected = platforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    aria-pressed={isSelected}
                    className={`px-3 py-1.5 rounded-lg text-xs uppercase font-mono border transition-colors ${
                      isSelected
                        ? 'bg-sky-600 text-white border-sky-400 font-semibold'
                        : 'bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-400 border-slate-950/10 dark:border-white/[0.08] hover:text-slate-100'
                    }`}
                  >
                    {t(`common.platform.${p}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="input-description" className="block text-slate-300 font-medium mb-1">
              {t('add.descriptionLabel')}
            </label>
            <textarea
              id="input-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('add.descriptionPlaceholder')}
              aria-invalid={errorField === 'description' || undefined}
              aria-describedby={errorMsg ? 'add-form-error' : undefined}
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          {/* Highlight */}
          <div>
            <label htmlFor="input-why" className="block text-slate-300 font-medium mb-1">
              {t('add.highlightLabel')}
            </label>
            <input
              id="input-why"
              type="text"
              value={whyItsAwesome}
              onChange={(e) => setWhyItsAwesome(e.target.value)}
              placeholder={t('add.highlightPlaceholder')}
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          {/* Install Commands */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="input-winget" className="block text-slate-300 font-medium mb-1">
                {t('add.wingetLabel')}
              </label>
              <input
                id="input-winget"
                type="text"
                dir="ltr"
                value={wingetCommand}
                onChange={(e) => setWingetCommand(e.target.value)}
                placeholder="winget install syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-brew" className="block text-slate-300 font-medium mb-1">
                {t('add.brewLabel')}
              </label>
              <input
                id="input-brew"
                type="text"
                dir="ltr"
                value={brewCommand}
                onChange={(e) => setBrewCommand(e.target.value)}
                placeholder="brew install --cask syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-flatpak" className="block text-slate-300 font-medium mb-1">
                {t('add.flatpakLabel')}
              </label>
              <input
                id="input-flatpak"
                type="text"
                dir="ltr"
                value={flatpakCommand}
                onChange={(e) => setFlatpakCommand(e.target.value)}
                placeholder="flatpak install flathub ..."
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="input-scoop" className="block text-slate-300 font-medium mb-1">
                {t('add.scoopLabel')}
              </label>
              <input
                id="input-scoop"
                type="text"
                dir="ltr"
                value={scoopCommand}
                onChange={(e) => setScoopCommand(e.target.value)}
                placeholder="scoop install syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-apt" className="block text-slate-300 font-medium mb-1">
                {t('add.aptLabel')}
              </label>
              <input
                id="input-apt"
                type="text"
                dir="ltr"
                value={aptCommand}
                onChange={(e) => setAptCommand(e.target.value)}
                placeholder="apt install syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          </div>

          {/* Footer Save. Pinned: outside the scroll region, always visible. */}
          <div className="shrink-0 px-4 sm:px-6 py-3 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs px-4 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{initialApp ? t('common.save') : t('common.add')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
