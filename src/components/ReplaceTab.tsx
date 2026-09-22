import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckSquare,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Replace,
  RotateCcw,
  ShieldHalf,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PRIVACY_PACK, PP_SOURCE_URL } from '../data/privacyPack';
import type { PpAlternative, PpCategory, PpLevel } from '../data/privacyPack';
import { COMBOS } from '../data/combos';
import { AppItem } from '../types';
import { AppIcon } from './AppCard';
import { useI18n } from '../lib/i18n';

const MAX_PICKS_PER_CATEGORY = 3;
const STORAGE_KEY = 'fress.replace.picks';

interface ReplaceTabProps {
  apps: AppItem[];
  onOpenDetail: (app: AppItem) => void;
  onAddToBatch: (ids: string[]) => void;
}

interface PicksState {
  [categoryId: string]: { m: string; a: string[] };
}

/** Logo for a privacypack app that has no catalog entry: ships with the app. */
const PPLogo: React.FC<{ id: string; name: string; size?: number }> = ({ id, name, size = 20 }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-md bg-slate-800 text-slate-200 font-bold select-none shrink-0 overflow-hidden"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center shrink-0 overflow-hidden rounded-md" style={{ width: size, height: size }}>
      <img
        src={`pp-logos/${id}.jpg`}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        className="object-cover"
        style={{ width: size, height: size }}
        onError={(e) => { setFailed(true); (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
      />
    </span>
  );
};

/** Logo for a private alternative: the Fress icon when it is a catalog app. */
const AltLogo: React.FC<{ alt: PpAlternative; name: string; size?: number }> = ({ alt, name, size = 20 }) => {
  if (alt.catalogId) {
    return <AppIcon appId={alt.catalogId} name={name} size={size} />;
  }
  return <PPLogo id={alt.id} name={name} size={size} />;
};

const LevelDots: React.FC<{ level: PpLevel; title?: string }> = ({ level, title }) => (
  <span className="inline-flex items-center gap-0.5 shrink-0" title={title}>
    {[1, 2, 3].map((i) => (
      <span
        key={i}
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${i <= level ? PP_LEVEL_DOT[level] : 'bg-slate-400/25 dark:bg-white/15'}`}
      />
    ))}
  </span>
);

/** Small style map kept local: the grade colors only. */
const PP_LEVEL_DOT: Record<PpLevel, string> = {
  1: 'bg-amber-400',
  2: 'bg-sky-400',
  3: 'bg-emerald-400',
};

/**
 * The Privacy Pack tab: pick what you use today, pick up to three private
 * replacements per category, and install the ones that are already vetted
 * catalog apps straight from here. Explanation and the grade legend live in
 * the About popover, so the first look stays calm.
 */
export const ReplaceTab: React.FC<ReplaceTabProps> = ({ apps, onOpenDetail, onAddToBatch }) => {
  const { t } = useI18n();

  const byId = useMemo(() => {
    const m = new Map<string, AppItem>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);

  const maxPrivacyCombo = useMemo(() => COMBOS.find((c) => c.id === 'maximum-privacy') || null, []);

  const [picks, setPicks] = useState<PicksState>(() => {
    const defaults: PicksState = {};
    for (const c of PRIVACY_PACK) {
      defaults[c.id] = { m: c.mainstream[0].id, a: [] };
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PicksState | null;
      if (saved && typeof saved === 'object') {
        for (const c of PRIVACY_PACK) {
          const s = saved[c.id];
          if (s && typeof s.m === 'string' && Array.isArray(s.a)) {
            const m = c.mainstream.some((x) => x.id === s.m) ? s.m : c.mainstream[0].id;
            const a = s.a
              .filter((id) => c.alternatives.some((x) => x.id === id))
              .slice(0, MAX_PICKS_PER_CATEGORY);
            defaults[c.id] = { m, a };
          }
        }
      }
    } catch {
      // ignore
    }
    return defaults;
  });

  /** `main:<catId>` for the "you use now" dropdown, `alt:<catId>` for the picker. */
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const warnedFullRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(picks));
    } catch {
      // ignore
    }
  }, [picks]);

  // One Escape handler for whichever picker is open.
  useEffect(() => {
    if (!openPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPicker(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPicker]);

  const setMainstream = (cat: PpCategory, mainstreamId: string) => {
    setPicks((prev) => ({
      ...prev,
      [cat.id]: { m: mainstreamId, a: prev[cat.id]?.a ?? [] },
    }));
  };

  const toggleAlt = (cat: PpCategory, alt: PpAlternative) => {
    setPicks((prev) => {
      const cur = prev[cat.id] ?? { m: cat.mainstream[0].id, a: [] };
      if (cur.a.includes(alt.id)) {
        return { ...prev, [cat.id]: { ...cur, a: cur.a.filter((id) => id !== alt.id) } };
      }
      if (cur.a.length >= MAX_PICKS_PER_CATEGORY) {
        if (!warnedFullRef.current) {
          toast.info(t('pp.toastLimit'));
          warnedFullRef.current = true;
          window.setTimeout(() => { warnedFullRef.current = false; }, 2500);
        }
        return prev;
      }
      return { ...prev, [cat.id]: { ...cur, a: [...cur.a, alt.id] } };
    });
  };

  const clearCategory = (cat: PpCategory) => {
    setPicks((prev) => ({ ...prev, [cat.id]: { m: prev[cat.id]?.m ?? cat.mainstream[0].id, a: [] } }));
  };

  const totalPicks = Object.values(picks).reduce((n, p) => n + p.a.length, 0);

  const sendPicksToBatch = (cat: PpCategory) => {
    const state = picks[cat.id];
    const ids = (state?.a ?? [])
      .map((id) => cat.alternatives.find((x) => x.id === id))
      .filter((x): x is PpAlternative => Boolean(x && x.catalogId && byId.has(x.catalogId)))
      .map((x) => x.catalogId as string);
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) {
      toast.info(t('pp.toastNoneCatalog'));
      return;
    }
    onAddToBatch(unique);
    toast.success(`${unique.length} × "${cat.name}" — ${t('pp.toastAdded')}`);
  };

  const sendComboToBatch = () => {
    if (!maxPrivacyCombo) return;
    const ids = maxPrivacyCombo.appIds.filter((id) => byId.has(id));
    onAddToBatch(ids);
    toast.success(`${ids.length} × "${maxPrivacyCombo.name}" — ${t('pp.toastAdded')}`);
  };

  const LEVEL_INFO: Record<PpLevel, { label: string; blurb: string }> = {
    1: { label: t('grade.basic.label'), blurb: t('grade.basic.blurb') },
    2: { label: t('grade.strong.label'), blurb: t('grade.strong.blurb') },
    3: { label: t('grade.fortress.label'), blurb: t('grade.fortress.blurb') },
  };

  return (
    <div id="replace-tab">
      {/* Page header: one calm line. The long explanation lives in About. */}
      <div className="flex items-start gap-3 mb-4">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-sky-500/15 text-sky-400 shrink-0">
          <Replace className="w-5 h-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-slate-100 tracking-tight">{t('pp.title')}</h2>
            <button
              type="button"
              id="pp-about-toggle"
              onClick={() => setAboutOpen(!aboutOpen)}
              aria-expanded={aboutOpen}
              aria-controls="replace-about"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.08] rounded-full px-2 py-0.5 transition-colors"
            >
              <Info className="w-3 h-3" aria-hidden="true" />
              <span>{t('pp.about')}</span>
            </button>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed mt-0.5">{t('pp.subtitle')}</p>
        </div>
      </div>

      {/* About: what this list is, where it comes from, what the dots mean. */}
      {aboutOpen && (
        <div
          id="replace-about"
          className="mb-5 bg-slate-900 dark:bg-slate-800 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-4"
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-xs font-bold text-slate-100">{t('pp.about')}</p>
            <button
              type="button"
              onClick={() => setAboutOpen(false)}
              className="p-1 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] transition-colors"
              aria-label={t('common.close')}
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {t('pp.aboutList')}{' '}
            <a
              href={PP_SOURCE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sky-400 hover:text-sky-300 underline decoration-dotted underline-offset-2"
            >
              ente's PrivacyPack
              <ExternalLink className="inline w-3 h-3 ml-0.5 mb-0.5" aria-hidden="true" />
            </a>
            {`, ${PRIVACY_PACK.length} ${t('pp.categories')}.`}
          </p>

          {/* Grade legend */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 mt-3">
            {([3, 2, 1] as PpLevel[]).map((lvl) => {
              const info = LEVEL_INFO[lvl];
              return (
                <div key={lvl} className="flex items-start gap-2.5 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.06] rounded-lg px-3 py-2.5">
                  <LevelDots level={lvl} />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-100">{info.label}</p>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">{info.blurb}</p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed mt-3">{t('pp.aboutGrades')}</p>
        </div>
      )}

      {/* The one kit on this tab: the strongest pick for every category */}
      {maxPrivacyCombo && (
        <article
          id="replace-max-privacy-card"
          className="mb-5 bg-slate-900 dark:bg-slate-800 border border-emerald-500/25 dark:border-emerald-400/25 rounded-lg p-4 shadow-sm"
          aria-label={maxPrivacyCombo.name}
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-emerald-500/15 text-emerald-400">
              <ShieldHalf className="w-5 h-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-slate-100 tracking-tight">{maxPrivacyCombo.name}</h3>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-500 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 rounded-full px-2 py-0.5">
                  {t('pp.maxBadge')}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-snug mt-0.5">{maxPrivacyCombo.purpose}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {maxPrivacyCombo.appIds.filter((id) => byId.has(id)).map((id) => {
              const app = byId.get(id) as AppItem;
              return (
                <button
                  key={id}
                  type="button"
                  id={`max-privacy-app-${id}`}
                  onClick={() => onOpenDetail(app)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium bg-slate-950/[0.04] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 pl-1 pr-2 py-1 rounded-md border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                  title={`${t('pp.openApp')}: ${app.name}`}
                >
                  <AppIcon appId={app.id} name={app.name} size={16} />
                  <span>{app.name}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-slate-950/10 dark:border-white/[0.06] flex items-center gap-2">
            <button
              type="button"
              id="max-privacy-batch-btn"
              onClick={sendComboToBatch}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 rounded-md transition-colors"
            >
              <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('pp.addToSelection')}</span>
            </button>
          </div>
        </article>
      )}

      {/* Category cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {PRIVACY_PACK.map((cat) => {
          const state = picks[cat.id] ?? { m: cat.mainstream[0].id, a: [] };
          const picked = state.a
            .map((id) => cat.alternatives.find((x) => x.id === id))
            .filter((x): x is PpAlternative => Boolean(x));
          const mainstream = cat.mainstream.find((x) => x.id === state.m) ?? cat.mainstream[0];
          const canBatch = picked.some((x) => x.catalogId && byId.has(x.catalogId));
          const mainOpen = openPicker === `main:${cat.id}`;
          const altOpen = openPicker === `alt:${cat.id}`;
          return (
            <article
              key={cat.id}
              id={`pp-card-${cat.id}`}
              className="group relative bg-slate-900 dark:bg-slate-800 border border-slate-950/10 dark:border-white/[0.08] hover:border-slate-950/30 dark:hover:border-white/[0.2] rounded-lg p-4 flex flex-col transition-all duration-150 shadow-sm hover:shadow-md dark:shadow-lg dark:shadow-black/40"
              aria-label={cat.name}
            >
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-100 tracking-tight mr-auto">{cat.name}</h3>
                <span
                  id={`pp-counter-${cat.id}`}
                  className={`text-[10px] font-bold rounded-full px-2 py-0.5 border ${
                    picked.length > 0
                      ? 'text-emerald-500 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25'
                      : 'text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.05] border-slate-950/10 dark:border-white/[0.08]'
                  }`}
                >
                  {picked.length}/{MAX_PICKS_PER_CATEGORY}
                </span>
                {picked.length > 0 && (
                  <button
                    type="button"
                    id={`pp-clear-${cat.id}`}
                    onClick={() => clearCategory(cat)}
                    className="p-1 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] transition-colors"
                    title={t('pp.clearPicks')}
                    aria-label={`${t('pp.clearPicks')}: ${cat.name}`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Mainstream side: custom themed dropdown (native select popups
                  ignore the app theme on Windows and show a white list). */}
              <div className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{t('pp.youUseNow')}</p>
                <div className="relative flex items-center gap-2">
                  <PPLogo id={mainstream.id} name={mainstream.name} size={22} />
                  <button
                    type="button"
                    id={`pp-main-${cat.id}`}
                    onClick={() => setOpenPicker(mainOpen ? null : `main:${cat.id}`)}
                    aria-expanded={mainOpen}
                    aria-haspopup="listbox"
                    aria-label={`${t('pp.youUseNow')}: ${cat.name}`}
                    className="flex-1 min-w-0 inline-flex items-center justify-between gap-1.5 text-xs font-medium text-slate-200 bg-slate-950/[0.04] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.08] rounded-md px-2 py-1.5 transition-colors"
                  >
                    <span className="truncate">{mainstream.name}</span>
                    <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${mainOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>

                  {mainOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setOpenPicker(null)} aria-hidden="true" />
                      <div
                        id={`pp-main-dropdown-${cat.id}`}
                        role="listbox"
                        aria-label={`${t('pp.youUseNow')}: ${cat.name}`}
                        className="absolute right-0 top-full mt-1 z-40 w-full min-w-[14rem] max-h-60 overflow-y-auto bg-slate-800 border border-slate-950/10 dark:border-white/[0.12] rounded-xl shadow-2xl py-1"
                      >
                        {cat.mainstream.map((m) => {
                          const selected = state.m === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              id={`pp-main-opt-${cat.id}-${m.id}`}
                              onClick={() => {
                                setMainstream(cat, m.id);
                                setOpenPicker(null);
                              }}
                              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                                selected
                                  ? 'bg-sky-500/10 text-sky-400'
                                  : 'text-slate-200 hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.06]'
                              }`}
                            >
                              <PPLogo id={m.id} name={m.name} size={18} />
                              <span className="truncate flex-1">{m.name}</span>
                              {selected && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="flex justify-center my-2" aria-hidden="true">
                <ArrowRight className="w-4 h-4 text-slate-400 rotate-90 md:rotate-0" />
              </div>

              {/* Private side */}
              <div className="relative">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{t('pp.replaceWith')}</p>
                <button
                  type="button"
                  id={`pp-picker-${cat.id}`}
                  onClick={() => setOpenPicker(altOpen ? null : `alt:${cat.id}`)}
                  aria-expanded={altOpen}
                  aria-haspopup="listbox"
                  className="w-full inline-flex items-center justify-between gap-2 text-xs font-medium text-slate-200 bg-slate-950/[0.04] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 transition-colors"
                >
                  <span className="truncate">
                    {picked.length === 0
                      ? t('pp.pick')
                      : picked.length === 1
                        ? picked[0].name
                        : `${picked[0].name} +${picked.length - 1}`}
                  </span>
                  <span className="text-slate-400 text-[10px]">{picked.length}/{MAX_PICKS_PER_CATEGORY}</span>
                </button>

                {altOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setOpenPicker(null)} aria-hidden="true" />
                    <div
                      id={`pp-dropdown-${cat.id}`}
                      role="listbox"
                      aria-label={`${t('pp.replaceWith')}: ${cat.name}`}
                      className="absolute right-0 top-full mt-1 z-40 w-full min-w-[17rem] max-h-72 overflow-y-auto bg-slate-800 border border-slate-950/10 dark:border-white/[0.12] rounded-xl shadow-2xl py-1"
                    >
                      {cat.alternatives.map((alt) => {
                        const selected = state.a.includes(alt.id);
                        return (
                          <button
                            key={alt.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            id={`pp-alt-${cat.id}-${alt.id}`}
                            onClick={() => toggleAlt(cat, alt)}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                              selected
                                ? 'bg-sky-500/10 text-sky-400'
                                : 'text-slate-200 hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.06]'
                            }`}
                          >
                            <AltLogo alt={alt} name={alt.name} size={18} />
                            <span className="truncate flex-1">{alt.name}</span>
                            {cat.pick === alt.id && (
                              <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-500 dark:text-emerald-400 shrink-0">
                                {t('pp.startHere')}
                              </span>
                            )}
                            <LevelDots level={alt.level} title={`${LEVEL_INFO[alt.level].label}: ${LEVEL_INFO[alt.level].blurb}`} />
                            {alt.catalogId && (
                              <Download className="w-3 h-3 text-slate-400 shrink-0" aria-label={t('pp.inCatalog')} />
                            )}
                            {selected && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* Picked replacements with actions */}
              {picked.length > 0 && (
                <ul className="mt-2.5 flex flex-col gap-1.5" aria-label={`${t('pp.replaceWith')}: ${cat.name}`}>
                  {picked.map((alt) => {
                    const app = alt.catalogId ? byId.get(alt.catalogId) : undefined;
                    return (
                      <li
                        key={alt.id}
                        id={`pp-picked-${cat.id}-${alt.id}`}
                        className="flex items-center gap-2 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.06] rounded-md pl-1.5 pr-1 py-1"
                      >
                        <AltLogo alt={alt} name={alt.name} size={18} />
                        <span className="text-xs font-medium text-slate-200 truncate flex-1">{alt.name}</span>
                        <LevelDots level={alt.level} title={`${LEVEL_INFO[alt.level].label}: ${LEVEL_INFO[alt.level].blurb}`} />
                        {app ? (
                          <button
                            type="button"
                            id={`pp-get-${cat.id}-${alt.id}`}
                            onClick={() => onOpenDetail(app)}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 rounded transition-colors shrink-0"
                            title={`${t('pp.get')}: ${app.name}`}
                          >
                            <Download className="w-3 h-3" aria-hidden="true" />
                            <span>{t('pp.get')}</span>
                          </button>
                        ) : (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] rounded px-1.5 py-0.5 shrink-0"
                            title={t('pp.guideOnlyHint')}
                          >
                            {t('pp.guideOnly')}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleAlt(cat, alt)}
                          className="p-0.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] transition-colors shrink-0"
                          title={`${t('pp.remove')}: ${alt.name}`}
                          aria-label={`${t('pp.remove')}: ${alt.name}`}
                        >
                          <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {canBatch && (
                <div className="mt-3 pt-3 border-t border-slate-950/10 dark:border-white/[0.06]">
                  <button
                    type="button"
                    id={`pp-batch-${cat.id}`}
                    onClick={() => sendPicksToBatch(cat)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 px-2.5 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                    title={t('pp.addPicksHint')}
                  >
                    <CheckSquare className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>{t('pp.addPicksToSelection')}</span>
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <p className="text-[11px] text-slate-400 mt-5 leading-relaxed">
        {totalPicks === 0
          ? t('pp.footNone')
          : `${t('pp.pickedSoFar').replace('{n}', String(totalPicks))} ${t('pp.footSome')}`}
      </p>
    </div>
  );
};
