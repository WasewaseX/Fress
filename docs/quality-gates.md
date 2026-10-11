# Quality gates: repeatable evidence for a Fress release

This document is the operator-facing copy of what the integration-gates
branch added: which commands produce which evidence, which CI job proves
what on which platform, what remains manual, and what must be true before a
release is marked ready. The rule of the whole document: **a test passing on
the developer's machine is not release evidence** - only the per-platform CI
jobs (or an explicitly recorded manual device run) count.

## 1. Exact commands, local and CI

Run from the repository root after `npm ci`:

| Command | What it proves |
|---|---|
| `npm run typecheck` | TypeScript compiles clean across `src/`, `tests/e2e/`, `scripts/perf/`, both Playwright configs. |
| `npm test` | Unit suite (Vitest + Testing Library, jsdom). Includes the dictionary parity test, resolver contracts, download-store and render-isolation unit tests. |
| `npm run validate:catalog` | The catalog is the product: duplicate ids, dead links, platform-command mismatches, missing icons/translations fail. |
| `npm run validate:security` | The documented security configuration matches the code (CSP, headers). |
| `npm run build` | Production bundle builds (also the artifact the E2E/perf gates run against). |
| `npm run test:e2e` | The full integration suite: workflows A-J plus the visual regression set, in headless Chromium against `vite preview` of the production build. Deterministic fixtures only - never live network. |
| `npm run test:perf` | The integrated catalog benchmark (500+ entries, scripted download stream). Deterministic invariants are blocking; wall-clock numbers are informational. |
| `npm run test:visual` | The visual subset alone (`tests/e2e/z-visual.spec.ts`). |
| `npm run perf:catalog` | The Node-side filter-pipeline benchmark (pre-existing; complements `test:perf`, which measures the real UI). |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Rust formatting. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Rust lint-clean including test targets. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | The Rust suite (state machine, network policy, download finalize). |
| `npx playwright test --config=playwright.live.config.ts` | LIVE resolver smoke - scheduled/manual only, never a PR gate. |

First-time local setup for the browser suite: `npx playwright install --with-deps chromium`.

## 2. Which CI job validates which platform

All workflows live in `.github/workflows/`, least-privilege
(`permissions: contents: read`), actions pinned to commit SHAs, and
`persist-credentials: false` so untrusted PR code never sees a token.

| Gate | Workflow / job | OS | Blocking? |
|---|---|---|---|
| Version consistency (package.json / Cargo.toml / tauri.conf.json / package-lock.json) | `ci.yml` → `version-guard` | ubuntu | Yes |
| Typecheck, unit tests, catalog validator, security config validator, production build | `ci.yml` → `frontend` | ubuntu | Yes |
| Rust fmt, clippy, tests | `ci.yml` → `rust` | ubuntu-22.04 | Yes |
| Rust tests (native) | `ci.yml` → `rust-native` | windows-latest, macos-latest | Yes |
| **E2E workflows A-J + visual regression** | `ci.yml` → `e2e` | ubuntu (Chromium headless) | Yes |
| **Perf invariants (render isolation, persistence coalescing) + recorded wall-clock baseline** | `ci.yml` → `perf` | ubuntu (Chromium headless) | Yes (invariants); informational (timings) |
| Dependency/RustSec scanning | `security.yml` | ubuntu | npm prod deps blocking; dev deps and RustSec advisory |
| Commit author guard | `author-guard.yml` | ubuntu | Yes |
| Platform bundles (installers, Android) | `release.yml` | ubuntu / windows / macos, tag pushes only | Release path |

What that means per platform:

- **Linux**: frontend, Rust and the browser gates all run here. The E2E and
  visual baselines are Linux/Chromium artifacts, so Linux CI is the
  authoritative platform for them.
- **Windows / macOS**: covered by the Rust test suite (`rust-native`) at PR
  time and by the full bundle build at tag time. The **browser-level**
  behaviors (E2E, visual) are NOT executed on Windows/macOS CI - WebView2 /
  WKWebView differ from Chromium, and the visual baselines are
  rasterizer-specific.
- **Android**: built by `release.yml` at tag time. There is **no** Android
  emulator/browser gate in CI; everything Android-specific (storage model,
  back gesture, the app-private downloads folder, RTL system settings) is
  manual device testing.

## 3. What is automated end to end

The Playwright suite (`tests/e2e/`) drives the production build through real
user paths, using only stable ids, documented `data-testid` attributes and
accessible roles/labels - never styling classes. The selector contract is
centralized in `tests/e2e/selectors.ts`; any new hook must be agreed with
the component owners and added there.

- **A - Catalog discovery** (`a-catalog-discovery.spec.ts`): search, count
  agreement, category/platform filter states, grid/table switch, view
  persistence across reload.
- **B - Command palette** (`b-command-palette.spec.ts`): Ctrl+K open,
  English action terms matching localized action titles, keyboard
  navigation and activation, localized no-match path, Escape + focus return
  to the opener. Note: palette ACTION KEYWORDS are English-only by
  documented intent (comment in CommandPalette.tsx); the suite pins that
  contract.
- **C - Resolver failure and retry** (`c-resolver-failure.spec.ts`): route
  level GitHub 403 (browser mode) and command-level rejection (Tauri
  bridge mode); the specific rate-limit message in browser mode; platform
  switch as the retry action; recovery to a confident pick; official-page
  fallback availability; no stuck "checking" state.
- **D - Download state integration** (`d-download-states.spec.ts`): the
  full observable state surface through a deterministic fake engine -
  active/progress values matching native payloads, the verifying window
  (100% but NOT completed), verified vs unverified completion labels,
  cancellation (engine receives `cancel_download`; Resume offered),
  network failure with Resume, **checksum mismatch** (asserted by contract,
  not label: no completed event, no completed row, persisted history shows
  error and never `"verified":true` - the trusted digest flows from the
  Signal official-resolver fixture), the 3-slot queue (queued labels,
  FIFO promotion, queued cancel without an engine call).
- **E - Privacy Pack** (`e-privacy-pack.spec.ts`): keyboard-only pick (the
  listbox moves focus to the options itself - ArrowDown walks, Enter
  toggles), the counter asserted BOTH as painted (`n/3`) and as the
  screen-reader line, batch state reached, multi-select popup dismissal
  with focus returned to the trigger, the cap and Clear. (The focus-return
  contract was pinned `test.fail()` against v1.0.6; the a11y integration
  fixed it, the annotation is lifted and the contract is asserted
  directly.)
- **F - Import/export and recovery** (`f-import-export.spec.ts`): valid
  backup import (apps + bookmark restoration), six malformed/corrupt
  shapes (specific reasons, no crash, sanctioned catalog delta), export
  download, `start_download` permission failure (no stuck active row),
  denied folder picker (manager stays usable, path falls back).
- **G - Themes, languages, RTL** (`g-themes-languages.spec.ts`): dark and
  light theme application + persistence; all five languages (en, fa, es,
  fr, de) across catalog, command palette, detail dialog, download manager
  and Privacy Pack with dictionary-exact labels and `lang`/`dir`; RTL
  horizontal-overflow probes at desktop and 390 px phone width.
- **H - Navigation** (`h-navigation.spec.ts`): deep scroll → Privacy →
  heading unobscured (elementFromPoint probe) → back with filter state
  retained; page persistence across reload (`fress.page`); scroll
  anchoring sanity.
- **I - Self-update release fixtures** (`i-self-update.spec.ts`): a valid
  newer tag surfaces the header pill and delivers a checksummed in-app
  download (the published SHA-256 travels with the `start_download`
  request; the row appears in the download manager); a malformed tag
  (`not-a-version`) is never offered as an update and does not crash the
  check ("latest" toast, no pill, no download); wrong-channel tags stay
  invisible (Stable never sees the prerelease-flagged build even though
  its tag is newer - and switching the channel in the menu surfaces it,
  with `fress.updateChannel` persisted).
- **J - Updater asset truth, fail closed** (`i-self-update.spec.ts`): a
  release whose only files are incompatible (ARM64 AppImage/exe on an
  x86_64 host) must yield NO direct download - the pill opens the releases
  page. A usable asset whose checksum cannot be established (no
  SHA256SUMS.txt) must ALSO be refused in-app ('unverifiable' → releases
  page). See section 8 finding 1: the incompatible-asset half is currently
  pinned `test.fail()` because `pickOwnAsset` leaks a cross-platform file.
- **Visual regression** (`z-visual.spec.ts`): main catalog light+dark;
  catalog at 390/768/1366/1600/1920 CSS px; Privacy Pack light+dark;
  detail modal; download manager with active+failed items; command palette
  with highlighted result; Persian RTL versions of the key screens; a
  500-entry scale shot. Thresholds (`maxDiffPixelRatio: 0.02`, animations
  disabled, fonts awaited) make one antialiasing pixel between OSes a
  non-event while real layout regressions fail.

**Screenshot authenticity rules** (learned the hard way this round): the
  theme is asserted in the DOM before capture (`html` carries the `dark`
  class / the stored preference), fonts and fixture data are awaited, and
  the settings popover is explicitly closed after a theme switch - an
  earlier baseline accidentally baked the open menu into the "dark
  catalog" shot and the diff could not tell theme truth from popover
  placement. Baselines are reviewed BY EYE when regenerated (the diff
  images live in the Playwright report); a baseline update is a reviewed
  artifact, not a chore. Note: baselines contain the version badge
  (`v1.0.7-beta`), so a version bump legitimately requires a scoped
  `--update-snapshots` pass in the same PR.

The Tauri-mode tests inject a faithful `window.__TAURI_INTERNALS__` mock
(`tests/e2e/tauri-bridge.ts`) mirroring the @tauri-apps/api 2.x contract
including the event plugin internals; the download engine mock is passive
by design - the tests emit exact native payloads (`download-progress`,
`download-complete`, `download-retrying`, `download-error`) and assert the
UI label/state agreement, the queue effects and the persistence writes.

The network layer is deny-all by default (`tests/e2e/netpolicy.ts`): every
resolver/vendor endpoint is answered from fixtures, everything else
external is aborted. No PR test ever touches live GitHub, F-Droid or
vendor endpoints.

## 4. What still requires manual device testing

- **Android (all of it)**: no emulator gate exists. Manual pass required on
  a real device before a release: install from the produced APK/AAB,
  downloads into app-private storage (Open/Show-in-folder adaptations),
  back-gesture behavior, RTL system-language rendering, storage-permission
  prompts, and the WebView version matrix the release targets.
- **Windows / macOS browser-level behavior**: the desktop apps run in
  WebView2 / WKWebView, not Chromium. A manual smoke of catalog → detail →
  download (progress, verify, open file) on one Windows and one macOS
  machine is required before marking a release ready; the Rust suites only
  prove the engine, and Chromium E2E only proves the web layer.
- **Real download environments**: slow/flaky networks (resume across a
  dropped connection, retry backoff), IPv6-only and captive-portal
  networks, proxies. The engine has unit coverage; the end-to-end resume
  path against a real server is manual.
- **Packaged-app smoke on each OS**: run the actual installer from
  `release.yml` (Windows .msi/.exe, macOS .dmg/.app, Linux .AppImage/deb,
  Android APK) - auto-update handoff, deep links/protocol handlers,
  window state, and code-signing/notarization verification.
- **Screen readers / assistive tech**: the a11y contract is enforced at the
  DOM level (roles, labels, focus), but a real NVDA/VoiceOver pass over
  the catalog, palette and download manager is manual.

## 5. How to capture screenshots

Visual snapshots are Playwright's own mechanism - there is no separate
screenshot tooling to babysit:

- Regenerate a baseline after an INTENTIONAL visual change:
  `npx playwright test tests/e2e/z-visual.spec.ts --update-snapshots`
  (or `-u` scoped with `-g "catalog"` for one screen). Review the diff in
  the HTML report (`npx playwright show-report`) before committing: a
  baseline update is a code-review artifact, not a chore.
- Capture one-off screenshots for bug reports:
  `npx playwright test -g "<test name>" --trace on`, then
  `npx playwright show-trace test-results/<...>/trace.zip` - the trace
  contains every screenshot, DOM snapshot and network entry.
- CI keeps the full report and per-failure screenshots as workflow
  artifacts (`playwright-report/`, `test-results/`, 14 days).

Normalization rules (already in the config, do not bypass them): explicit
viewport per shot, `deviceScaleFactor: 1`, `document.fonts.ready` awaited,
animations disabled via `expect.toHaveScreenshot.animations: 'disabled'`,
caret hidden, and a 2% pixel-difference threshold.

## 6. How to interpret performance results

Run `npm run test:perf` (writes `scripts/perf/results/latest.json` and
prints the table). The committed baseline lives in
`scripts/perf/baselines/catalog.json`.

Read it in two columns:

1. **Deterministic invariants - blocking, machine-independent:**
   - *Unrelated card mutations during a 1000-event progress burst* must be
     `0`. This is the React render-isolation contract (memoized cards +
     per-app selector subscriptions) verified in the real UI, not just in
     jsdom. Any non-zero value means a progress event stream now repaints
     unrelated cards - fail the change.
   - *localStorage writes for 100 progress events (50 ms cadence)* must
     stay inside the coalescing bound (12; the scheduler flushes terminal
     changes immediately and coalesces progress snapshots at 750 ms).
     Writes >= events means coalescing is broken and every user's storage
     is being hammered per frame.
2. **Wall-clock numbers - informational, machine-sensitive:** usable-catalog
   time, search latency, grid/table switch, load with a 200-item completed
   history, JS heap. The harness prints deltas against the baseline; treat
   them as review input, not pass/fail. A machine delta of ±20% is normal
   between a CI runner and a laptop. Only a catastrophic regression (the
   harness fails the run above a 15 s usable-catalog guard) is blocking.
   To refresh the baseline after hardware or intentional trade-off changes,
   copy `scripts/perf/results/latest.json` over
   `scripts/perf/baselines/catalog.json` and say why in the commit message.

`npm run perf:catalog` (Node-side) measures the per-keystroke filter
pipeline in isolation; its numbers are microseconds and its reading lives
in docs/ARCHITECTURE-frontend.md.

## 7. Evidence required before a release is marked ready

A release candidate tag may be marked ready only when ALL of the following
hold on the integrated commit:

1. **CI green on main for the release commit**: `version-guard`,
   `frontend`, `rust`, `rust-native` (Windows + macOS), `e2e`, `perf`,
   `authors` - each green as a REQUIRED job, not warnings. A skipped job is
   not a pass; a job that cannot run must be an explicit, recorded decision.
2. **`release.yml` completes** for the tag: bundles produced for Windows,
   macOS and Linux, Android build produced, version consistency re-verified
   at tag time.
3. **Platform evidence recorded in the release notes**, each explicitly:
   - "Windows/macOS Rust suites passed in CI" (link the runs) - and the
     manual packaged-app smoke per OS from section 4 with the OS version
     tested.
   - "Android: no automated gate - manual device run" with device model,
     Android version and the installer that was run.
4. **Manual device checklist from section 4 executed** and linked (one
   entry per OS that ships in this release).
5. **The live network smoke** (`network-smoke.yml`) run manually against
   the release commit (or its latest scheduled run linked) - green, or its
   redness explained by upstream/rate-limit annotations.
6. **Performance record attached**: the `perf` job's `perf-results`
   artifact (or a local `latest.json`) for the release commit, with any
   wall-clock movement vs the baseline acknowledged.
7. **No open `test.fail()` annotations** without a linked, accepted issue
   (see below) - a known-broken contract cannot ride into a release
   silently.

## 8. Open findings routed to owners (as of v1.0.7 integration)

These are recorded by the suite itself and are the reason for its current
annotations:

1. **Self-update offers an incompatible installer when no compatible asset
   exists (`pickOwnAsset`, `src/lib/selfUpdate.ts`)** - pinned as
   `test.fail()` in `i-self-update.spec.ts` (Workflow J).
   CONTRACT: a release containing only unusable files (wrong arch, wrong
   platform) must yield NO direct download - `planUpdateDelivery` should
   see `asset: null` and open the releases page ('no-asset').
   ACTUAL: the best-candidate loop accepts any score above `-Infinity`;
   "not a Linux format" scores -1 and "wrong Windows arch" scores 3 (5
   more if the name contains "setup"), so an ARM64-only release hands an
   x64 Windows machine its own arm64 installer (score 8) - and with the
   digest published in SHA256SUMS.txt the download is even delivered as
   "verified". Unit tests cover "x64 PREFERS x64" but not "only
   incompatible → null". Unit-level repro:
   `pickOwnAsset(release(['Fress_1.0.8_arm64-setup.exe']), 'x86_64')`
   with a Windows UA returns the arm64 installer; expected `null`.
   FIX DIRECTION (owner's call): refuse best-candidates whose score came
   from a format the host platform cannot run (the -Infinity refusal
   pattern already exists for the Linux ARM case). Owner: self-update /
   release engineering. The moment this is fixed the test passes
   unexpectedly, CI turns red, and the annotation must be lifted.
2. **In-app rate-limit messaging** - Tauri v2 rejects command errors as
   plain strings (`Result<T, String>` serializes `Err` verbatim), and the
   resolver reads `(e as Error).message`, which is `undefined` for a
   string. The specific "GitHub is rate-limiting this network" message is
   therefore browser-mode only; in-app the same failure degrades to the
   generic "No ready-made file..." text. Pinned as actual behavior by the
   Tauri-mode test in `c-resolver-failure.spec.ts`; a small normalization
   in the resolver's error path would restore the specific message in-app.
   Owner: resolver (`src/lib/release/`).
3. **Category label on cards is untranslated** - `#app-cat-badge-{id}`
   renders the raw English `app.category` while the filter chips use
   translated labels; non-English users see mixed languages on cards.
   Not asserted by the suite (fixing it would be a visual change needing
   new baselines); flagged for the i18n owner.

### Fixed this round (annotations lifted)

- **Privacy Pack focus return** (v1.0.6 finding): the alternatives
  dropdown now returns focus to the trigger on EVERY close path (pick,
  Escape, Tab, outside click) and moves focus into the list on open - the
  `test.fail()` annotation was lifted and the contract is asserted
  directly in `e-privacy-pack.spec.ts`.
- **Command palette focus/ARIA**: the input is a proper ARIA combobox
  (`role="combobox"` + `aria-activedescendant` + listbox options) and the
  stacked-focus contract holds across palette → modal stacks; the suite
  was ported onto the new contract (combobox role, `palette-item-*`
  options) and asserts Escape-focus restoration through it.

## 9. A developer-machine run is not release evidence

The section title is the point: the commands in section 1 are reproducible
locally, and running them locally is how you iterate - but a green laptop
run proves nothing about the platforms Fress ships for. The evidence model
is: the per-platform CI jobs (Linux browser gates, Windows/macOS Rust
suites, tag-time bundles) plus the recorded manual device runs from
section 4. If a gate cannot run for a release, the release is not ready -
the failure to run IS the finding.
