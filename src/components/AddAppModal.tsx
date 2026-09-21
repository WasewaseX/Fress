import React, { useState, useEffect, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { AppItem, Category, Platform } from '../types';
import { X, Plus, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { fetchLiveStarCount } from '../lib/starFetch';

interface AddAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveApp: (app: AppItem) => void;
  initialApp?: AppItem | null;
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
  showTabs = false,
  onSwitchTab
}) => {
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [category, setCategory] = useState<Category>('Utilities & System');
  const [platforms, setPlatforms] = useState<Platform[]>(['windows']);
  const [license, setLicense] = useState('MIT');
  const [stars, setStars] = useState<number>(0);
  const [starsAutoFilled, setStarsAutoFilled] = useState(false);
  const [description, setDescription] = useState('');
  const [whyItsAwesome, setWhyItsAwesome] = useState('');
  const [beginnerGuide, setBeginnerGuide] = useState('');
  const [wingetCommand, setWingetCommand] = useState('');
  const [brewCommand, setBrewCommand] = useState('');
  const [flatpakCommand, setFlatpakCommand] = useState('');
  const [proprietaryAlternative, setProprietaryAlternative] = useState('');
  const [tags, setTags] = useState('');
  
  const [errorMsg, setErrorMsg] = useState('');
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
      setStars(initialApp.stars);
      setStarsAutoFilled(false);
      setDescription(initialApp.description);
      setWhyItsAwesome(initialApp.whyItsAwesome);
      setBeginnerGuide(initialApp.beginnerGuide);
      setWingetCommand(initialApp.wingetCommand || '');
      setBrewCommand(initialApp.brewCommand || '');
      setFlatpakCommand(initialApp.flatpakCommand || '');
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
      setStars(1000);
      setDescription('');
      setWhyItsAwesome('');
      setBeginnerGuide('');
      setWingetCommand('');
      setBrewCommand('');
      setFlatpakCommand('');
      setProprietaryAlternative('');
      setTags('');
    }
    setErrorMsg('');
    setInspectSuccessMsg('');
  }, [initialApp, isOpen]);

  // Stars are never guessed: once a GitHub/GitLab URL is pasted, the live
  // count is pulled from the forge API and prefilled. A manual override is
  // still possible for repos the forge APIs don't cover.
  useEffect(() => {
    if (!isOpen) return;
    const url = githubUrl.trim();
    if (!url) return;
    let alive = true;
    const timer = setTimeout(() => {
      void fetchLiveStarCount(url).then((n) => {
        if (alive && typeof n === 'number' && n >= 0) {
          setStars(n);
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
  keepFocusInside(panelRef, isOpen);
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
        throw new Error('Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo)');
      }
      const [, owner, repo] = match;
      const cleanRepo = repo.replace(/\.git$/, '');

      const res = await fetch(`https://api.github.com/repos/${owner}/${cleanRepo}`);
      if (!res.ok) {
        throw new Error(`GitHub API returned status ${res.status}. Please verify the repository exists and is public.`);
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

      if (data.topics && data.topics.length > 0 && !tags) {
        setTags(data.topics.slice(0, 5).join(', '));
      }

      setInspectSuccessMsg(`Successfully populated metadata for ${data.name || cleanRepo}!`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to inspect GitHub repository.');
    } finally {
      setIsInspecting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Application name is required.');
      return;
    }
    if (!description.trim()) {
      setErrorMsg('Description is required.');
      return;
    }

    const tagArray = tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    const newApp: AppItem = {
      id: initialApp ? initialApp.id : `custom-${Date.now()}`,
      name: name.trim(),
      tagline: tagline.trim() || name.trim(),
      websiteUrl: websiteUrl.trim() || githubUrl.trim() || '#',
      githubUrl: githubUrl.trim() || undefined,
      gitlabUrl: gitlabUrl.trim() || undefined,
      category,
      platforms,
      license: license.trim() || 'Open Source',
      stars: Number(stars) || 0,
      description: description.trim(),
      whyItsAwesome: whyItsAwesome.trim() || 'Curated community open-source application.',
      beginnerGuide: beginnerGuide.trim() || 'Download and install from the official release page.',
      wingetCommand: wingetCommand.trim() || undefined,
      brewCommand: brewCommand.trim() || undefined,
      flatpakCommand: flatpakCommand.trim() || undefined,
      proprietaryAlternative: proprietaryAlternative.trim() || undefined,
      tags: tagArray.length > 0 ? tagArray : ['open-source', 'desktop'],
      isOwnerPick: initialApp ? initialApp.isOwnerPick : false,
      isTrendingToday: initialApp ? initialApp.isTrendingToday : false,
      isCustom: true,
      offlineReady: true,
      addedAt: initialApp?.addedAt || new Date().toISOString().split('T')[0]
    };

    onSaveApp(newApp);
    onClose();
  };

  return (
    <div 
      ref={panelRef}
      id="add-app-modal-backdrop" 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm"
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
              {initialApp ? 'Edit Tool' : 'Enter manually'}
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Saved on this device only.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Shared tabs: one entry point for both ways of adding an app */}
        {showTabs && onSwitchTab && !initialApp && (
          <div className="flex items-center gap-1 px-4 sm:px-5 py-2 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-900" role="tablist" aria-label="Add app method">
            {([['search', 'Search GitHub'], ['manual', 'Enter manually']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === 'manual'}
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 text-xs">
          {errorMsg && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {inspectSuccessMsg && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-lg flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <span>{inspectSuccessMsg}</span>
            </div>
          )}

          {/* GitHub Auto-Fill */}
          <div className="space-y-1">
            <label htmlFor="input-github-url" className="block text-slate-300 font-medium">
              GitHub Repository URL
            </label>
            <div className="flex items-center gap-2">
              <input
                id="input-github-url"
                type="url"
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
                <RefreshCw className={`w-3.5 h-3.5 ${isInspecting ? 'animate-spin' : ''}`} />
                <span>{isInspecting ? 'Fetching...' : 'Auto-Fill'}</span>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="input-gitlab-url" className="block text-slate-300 font-medium">
              GitLab Repository URL <span className="text-slate-500 font-normal">(optional, shown as a second source button)</span>
            </label>
            <input
              id="input-gitlab-url"
              type="url"
              value={gitlabUrl}
              onChange={(e) => setGitlabUrl(e.target.value)}
              placeholder="https://gitlab.com/owner/repository"
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="input-app-name" className="block text-slate-300 font-medium mb-1">
                Application Name *
              </label>
              <input
                id="input-app-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-app-tagline" className="block text-slate-300 font-medium mb-1">
                Short Tagline
              </label>
              <input
                id="input-app-tagline"
                type="text"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="e.g. Continuous decentralized file synchronization"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="input-website-url" className="block text-slate-300 font-medium mb-1">
                Official Website URL
              </label>
              <input
                id="input-website-url"
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://syncthing.net"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-alt" className="block text-slate-300 font-medium mb-1">
                Replaces Proprietary Software (Optional)
              </label>
              <input
                id="input-alt"
                type="text"
                value={proprietaryAlternative}
                onChange={(e) => setProprietaryAlternative(e.target.value)}
                placeholder="e.g. Dropbox, Google Drive"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="select-category" className="block text-slate-300 font-medium mb-1">
                Category
              </label>
              <select
                id="select-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="w-full bg-slate-900 border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="input-license" className="block text-slate-300 font-medium mb-1">
                License
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
                GitHub Stars
              </label>
              <input
                id="input-stars"
                type="number"
                min="0"
                value={stars}
                onChange={(e) => {
                  setStars(Number(e.target.value));
                  setStarsAutoFilled(false);
                }}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {starsAutoFilled
                  ? 'Filled automatically from the live GitHub API.'
                  : 'Filled automatically from GitHub once a repository URL is set.'}
              </p>
            </div>
          </div>

          {/* Operating Systems */}
          <div>
            <span className="block text-slate-300 font-medium mb-1.5">
              Supported Platforms
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['windows', 'mac', 'linux', 'android', 'web'] as Platform[]).map((p) => {
                const isSelected = platforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    className={`px-3 py-1.5 rounded-lg text-xs uppercase font-mono border transition-colors ${
                      isSelected
                        ? 'bg-sky-600 text-white border-sky-400 font-semibold'
                        : 'bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-400 border-slate-950/10 dark:border-white/[0.08] hover:text-slate-100'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="input-description" className="block text-slate-300 font-medium mb-1">
              Description *
            </label>
            <textarea
              id="input-description"
              required
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this tool do?"
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          {/* Highlight */}
          <div>
            <label htmlFor="input-why" className="block text-slate-300 font-medium mb-1">
              Highlight
            </label>
            <input
              id="input-why"
              type="text"
              value={whyItsAwesome}
              onChange={(e) => setWhyItsAwesome(e.target.value)}
              placeholder="e.g. End-to-end encrypted, zero central servers."
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>

          {/* Install Commands */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="input-winget" className="block text-slate-300 font-medium mb-1">
                Winget Command
              </label>
              <input
                id="input-winget"
                type="text"
                value={wingetCommand}
                onChange={(e) => setWingetCommand(e.target.value)}
                placeholder="winget install syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-brew" className="block text-slate-300 font-medium mb-1">
                Homebrew Command
              </label>
              <input
                id="input-brew"
                type="text"
                value={brewCommand}
                onChange={(e) => setBrewCommand(e.target.value)}
                placeholder="brew install --cask syncthing"
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="input-flatpak" className="block text-slate-300 font-medium mb-1">
                Flatpak Command
              </label>
              <input
                id="input-flatpak"
                type="text"
                value={flatpakCommand}
                onChange={(e) => setFlatpakCommand(e.target.value)}
                placeholder="flatpak install flathub ..."
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </div>

          {/* Footer Save */}
          <div className="pt-2 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs px-4 py-2 rounded-lg border border-sky-400 transition-colors shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{initialApp ? 'Save' : 'Add'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
