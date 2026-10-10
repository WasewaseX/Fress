# src/features — feature modules

Each directory owns ONE product responsibility and may not reach into
another feature's internal state. Cross-feature coordination happens in
`src/App.tsx`, which is a composition layer only.

| Directory     | Responsibility                                                       | State it owns                                    |
|---------------|----------------------------------------------------------------------|--------------------------------------------------|
| `catalog/`    | The app list (built-in + user entries), favorites, filters, view prefs | apps, favorites, FilterState, viewMode, page     |
| `batch/`      | Batch selection + the real batch download flow + floating bar UI      | selected ids, resolving flag                     |
| `compare/`    | Compare-matrix selection + floating dock UI                           | compared ids                                     |
| `dialogs/`    | Which modal/panel is open (state only — no domain data)               | open flags, selected/edited app refs, add flow   |
| `shortcuts/`  | The global keyboard map (Cmd+K, `/`, Escape, single-letter toggles)   | none (actions injected per render)               |
| `selfUpdate/` | In-app update check, channel switch, update download                  | update state, channel, checking flag             |
| `whatsNew/`   | Once-per-version release summary                                      | visibility flag                                  |

Rules of the road:

1. **Typed interfaces only.** Hooks return typed objects (`AppCatalog`,
   `BatchSelection`, ...); components take a single props object. No feature
   reaches into another feature's state.
2. **Persistence adapters stay with the state that owns the key.** Every
   localStorage key has exactly one owner module (e.g. favorites keys live in
   `catalog/useAppCatalog.ts`, the platform filter in
   `catalog/useCatalogFilters.ts`). `whatsNew` reads favorites/custom keys
   read-only to detect returning users.
3. **Presentation is separate.** Floating bars and empty states are plain
   components in the same feature folder; they never call stores or toasts.
4. **No global state libraries.** React context that already exists
   (theme, i18n, downloads) is shared through hooks; features receive
   what they need via parameters.
