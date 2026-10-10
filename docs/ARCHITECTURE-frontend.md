# Fress Frontend Architecture

A short map of the frontend's module responsibilities and dependency
directions, as established by the Agent 4 maintainability refactoring
(pull requests `agent4/release-fetch-modules`, `agent4/app-decomposition`,
`agent4/pattern-hardening`, `agent4/accessibility`,
`agent4/perf-and-architecture`).

The guiding rules:

1. **One responsibility per module.** Files that grew past a single
   responsibility (`App.tsx`, `releaseFetch.ts`) were split along the
   seams the code itself showed, not an arbitrary file count.
2. **Composition, not logic, at the top.** `App.tsx` wires features
   together and holds no domain logic of its own.
3. **Dependencies point one way.** `features/` and `components/` may use
   `lib/`; `lib/` never imports from `features/` or `components/`.
4. **Trust boundaries are explicit.** Anything entering from a file, the
   network, or localStorage passes a sanitizer before it becomes state.

```
src/
  main.tsx                  entry
  App.tsx                   COMPOSITION ONLY: providers + feature wiring
  types.ts                  shared domain types (AppItem, FilterState, ...)
  data/                     the shipped catalog (appsData*, combos, privacyPack)
  features/                 product responsibilities (state + their UI bits)
    catalog/                app list + favorites state, filters, view prefs,
                            EmptyCatalogState
    batch/                  batch selection + download flow, BatchActionBar
    compare/                compare selection, CompareDock
    dialogs/                open/closed state for every modal (no domain data)
    shortcuts/              the global keyboard map
    selfUpdate/             in-app updater flow
    whatsNew/               once-per-version release summary
  components/               shared presentation (Header, cards, modals, ...)
  lib/
    release/                the download resolver, split by responsibility:
      types.ts              shared release/asset shapes (types only)
      repo.ts               repo identity + tag-to-version strings
      assetMatching.ts      BAD_* filters, Android ABI gates, scoring,
                            pickAsset/pickAssetDetailed (+ overrides)
      githubProvider.ts     GitHub Releases API access
      fdroidProvider.ts     F-Droid index access
      hostArch.ts           once-per-session host architecture signal
      resolveCache.ts       session memo + persistent cache + error map
      resolve.ts            resolution POLICY (stream scan, confidence order)
    releaseFetch.ts         compatibility facade: single stable import path,
                            re-exports only
    patternSafety.ts        safe-subset validator for imported regexes
    appValidation.ts        AppItem sanitizer for backups + localStorage
    i18n.tsx / theme / downloads / appDownloads / officialResolvers / ...
```

## Dependency rules per layer

- `lib/release/*` modules depend only on `types.ts`, `../types`, and each
  other downward (`resolve.ts` orchestrates; providers and matching never
  import it). `resolve.ts` -> `officialResolvers` mirrors the historical
  facade cycle and is call-time-safe (ESM live bindings, functions only).
- `features/*` hooks receive collaborators via parameters (e.g.
  `useBatchSelection(apps, openDownloads)`, `useSelfUpdate(startDownload)`)
  instead of reaching into other features. Cross-feature cleanup (delete ->
  batch + compare + detail modal) is composed in `App.tsx`.
- `components/*` are presentation + their own local UI state; they may call
  `lib/` resolvers directly (AppCard/AppDetailModal resolve downloads) but
  never mutate another feature's state.

## Persistence ownership (localStorage)

| Key | Owner |
|-----|-------|
| `fress_custom_items`, `fress_favorites` | `features/catalog/useAppCatalog` |
| `fress_platform_filter` | `features/catalog/useCatalogFilters` |
| `awesome_free_apps_view_mode`, `fress.page` | `features/catalog/useViewPreferences` |
| `fress.lang` | `lib/i18n` |
| `fress.resolveCache.v1` | `lib/release/resolveCache` |
| `fress.last_update_check`, `fress.seen_version` | `features/selfUpdate`, `features/whatsNew` |

## The resolver's confidence order (unchanged behavior)

`resolveDownloadFor`: confident GitHub pick -> F-Droid (Android, never
preempted by a weak GitHub pick) -> official vendor manifest -> weak GitHub
pick (flagged) -> null. The scan covers the recent stable releases for
multi-stream repos; `assetPatterns` overrides are a naming authority that
can never bypass the hard architecture gate.

## Imported-regex safety

Patterns that cross a trust boundary (backup import, hand-edited catalog,
storage written by older builds) are restricted to a safe subset by
`lib/patternSafety.ts` and compiled through `compileSafePattern` at both
the sanitization boundary and the use sites. The exponential backtracking
class (nested quantifiers, alternation ambiguity under unbounded group
repetition) is refused; the shipped catalog is audited against the subset
by `patternSafety.test.ts` so a rule change can never silently reject a
working entry. Polynomial shapes are accepted deliberately - asset/tag
names are short, bounded strings (see below).

## Performance posture (measured, not assumed)

`npm run perf:catalog` (scripts/perf-catalog.ts) measures the exact
per-keystroke pipeline. Numbers from the reference run:

| Scenario | Cost per keystroke |
|---|---|
| Shipped catalog (75 apps), empty query | 0.008 ms |
| Shipped catalog, 8-char query | 0.035 ms |
| Stress: 1000 apps, 8-char query | 0.49 ms |
| Stress: 5000 apps, 8-char query | 2.42 ms |
| Per-card membership lookup (favorites/selection) | ~0.00005 ms |

Everything is at least an order of magnitude below the 16 ms frame budget,
including 13x/67x stress sizes, so **no memoization, virtualization, or
state library was added** - the pre-existing `useMemo` around the filter
pipeline was kept, and nothing else showed a measurable problem. The one
structural caveat recorded honestly: `favorites.includes` / id-list
lookups are linear per card; at 5000 apps x 5000 selections this would
start to matter, and the fix then is a `Set` in `useBatchSelection`, not a
rendering rewrite. Re-run the script after any catalog-scale change.
