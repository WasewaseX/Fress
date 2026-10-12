# Quality gates: repeatable evidence for a Fress release

This document is the operator-facing runbook of what the CI and release
pipelines actually execute: which commands produce which evidence, which
workflow job proves what on which platform, what remains manual, and what
must be true before a release is marked ready. The rule of the whole
document: **a test passing on the developer's machine is not release
evidence** - only the per-platform CI jobs (or an explicitly recorded
manual device run) count.

## 1. Exact commands, local and CI

Run from the repository root after `npm ci`:

| Command | Where | What it proves |
|---|---|---|
| `npm run typecheck` | local + CI (`ci.yml` → `frontend`) | TypeScript compiles clean across `src/`, `tests/e2e/`, `scripts/perf/`, both Playwright configs. |
| `npm run validate:versions` | local + CI (`ci.yml` → `version-guard` AND `frontend`; `release.yml` → `version` with `--expect-tag`) | THE single authoritative version-coherence command (`scripts/validate-versions.mjs`): package.json, Cargo.toml, tauri.conf.json, package-lock.json (both positions) and the `fress` crate in Cargo.lock all agree. With `--expect-tag vX` it additionally proves a release tag binds to the build metadata. A development build deliberately does NOT have to match the currently published release. |
| `npm test` | local + CI (`ci.yml` → `frontend`) | Unit suite (Vitest + Testing Library, jsdom). Includes the dictionary parity test, resolver contracts, download-store and render-isolation unit tests, and the version-validator rejection tests. |
| `npm run validate:catalog` | local + CI (`ci.yml` → `frontend`) | The catalog is the product: duplicate ids, dead links, platform-command mismatches, missing icons/translations fail. |
| `npm run validate:security` | local + CI (`ci.yml` → `frontend`) | The documented security configuration matches the code (CSP, headers). |
| `npm run build` | local + CI (`ci.yml` → `frontend`) | Production bundle builds (also the artifact the E2E/perf gates run against). |
| `npm run test:e2e` | local + CI (`ci.yml` → `e2e`) | The full integration suite: workflows A-J plus the visual regression set, in headless Chromium against `vite preview` of the production build. Deterministic fixtures only - never live network. |
| `npm run test:perf` | local + CI (`ci.yml` → `perf`) | The integrated catalog benchmark (500+ entries, scripted download stream). Deterministic invariants are blocking; wall-clock numbers are informational. |
| `npm run test:visual` | local | The visual subset alone (`tests/e2e/z-visual.spec.ts`). |
| `npm run perf:catalog` | local | The Node-side filter-pipeline benchmark (pre-existing; complements `test:perf`, which measures the real UI). |
| `python3 -m unittest discover -s scripts/ci -p 'test_*.py'` | local + CI (`ci.yml` → `artifact-audit-tests`) | Rejection-behavior suite of the release-artifact audit: tampered checksums, missing/unlisted assets, wrong-version manifests, altered or foreign signatures, stray/orphan sidecars, malformed manifests, duplicated mappings all FAIL on synthetic temp-dir fixtures. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | local (with Rust) + CI (`ci.yml` → `rust`, ubuntu-22.04) | Rust formatting. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | local (with Rust) + CI (`ci.yml` → `rust`, ubuntu-22.04) | Rust lint-clean including test targets. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | local (with Rust) + CI (`ci.yml` → `rust` on ubuntu-22.04, `rust-native` on windows-latest + macos-latest) | The Rust suite (state machine, network policy, download finalize). |
| `npx playwright test --config=playwright.live.config.ts` | ONLY scheduled/manual (`network-smoke.yml`); never a PR gate | LIVE resolver smoke against real endpoints. Red here means "investigate", not "revert the PR" - see its workflow header. |
| `python3 scripts/ci/verify-release-artifacts.py <assets-dir> <tag> <version> <owner/repo>` | ONLY in CI (`release.yml` → `verify-release`) | The final published-artifact audit over the EXACT bytes just downloaded from the draft release (see section 2.1). Requires a real assembled release; not runnable locally by design. |

First-time local setup for the browser suite: `npx playwright install --with-deps chromium`.

## 2. Which CI job validates which platform

All workflows live in `.github/workflows/`, least-privilege
(`permissions: contents: read`), actions pinned to commit SHAs, and
`persist-credentials: false` so untrusted PR code never sees a token.

| Gate | Workflow / job | OS | Blocking? |
|---|---|---|---|
| Version coherence (`npm run validate:versions`; one implementation in `scripts/validate-versions.mjs`) | `ci.yml` → `version-guard` (+ step inside `frontend`) | ubuntu | Yes |
| Typecheck, unit tests, version coherence, catalog validator, security config validator, production build | `ci.yml` → `frontend` | ubuntu | Yes |
| Release-artifact verifier rejection tests (`python3 -m unittest`) | `ci.yml` → `artifact-audit-tests` | ubuntu | Yes |
| Rust fmt, clippy, tests | `ci.yml` → `rust` | ubuntu-22.04 | Yes |
| Rust tests (native) | `ci.yml` → `rust-native` | windows-latest, macos-latest | Yes |
| **E2E workflows A-J + visual regression** | `ci.yml` → `e2e` | ubuntu (Chromium headless) | Yes |
| **Perf invariants (render isolation, persistence coalescing) + recorded wall-clock baseline** | `ci.yml` → `perf` | ubuntu (Chromium headless) | Yes (invariants); informational (timings) |
| Dependency/RustSec scanning | `security.yml` (weekly schedule + lockfile pushes + manual; never on PRs) | ubuntu | npm prod deps blocking; dev deps and RustSec advisory (`continue-on-error` on cargo-audit is DOCUMENTED policy until the RustSec baseline is triaged) |
| Commit author guard | `author-guard.yml` (all pushes + PRs) | ubuntu | Yes |
| LIVE resolver smoke | `network-smoke.yml` (weekly Monday 06:20 UTC + manual dispatch; NEVER on PRs) | ubuntu | Advisory by design - upstream outages/rate limits must not block code review; red runs are investigated, not auto-retried |
| Platform bundles (installers, Android) + version/tag binding | `release.yml` (tag pushes `v*` + manual) | ubuntu / windows / macos / android | Release path |
| **Final published-artifact audit** (checksums, updater manifest, signatures) | `release.yml` → `verify-release` | ubuntu | **Yes - hard blocker**: the release stays a private DRAFT until it passes |
| VirusTotal scan overlay | `release.yml` → `virustotal` | ubuntu | Informational only; skipped with a labeled notice when `VIRUSTOTAL_API_KEY` is unset - a green run is NOT "scanned and clean" |

**Event truth (what actually triggers what):** `ci.yml` runs on every PR
and on pushes to `main`. `author-guard.yml` runs on all pushes and PRs.
`security.yml` runs weekly (Mon 06:00 UTC), on manual dispatch, and on
main pushes that touch a lockfile. `network-smoke.yml` runs weekly (Mon
06:20 UTC) and on manual dispatch only. `release.yml` runs on `v*` tag
pushes and manual dispatch. Nothing live-network runs on pull requests.

**Required-check enforcement is a GitHub Settings action, not a workflow
property.** The jobs above are written to be blocking (they fail their
job, and `verify-release` blocks publication), but whether GitHub
REFUSES to merge a PR while a check is red depends on repository
Settings → Branches → branch protection - a maintainer must configure
required status checks there; no workflow file can do it.

### 2.1 What the release-artifact audit verifies, and on which bytes

`release.yml` publishes nothing until the `verify-release` job has
proven the release itself. The job downloads EVERY asset FRESH from the
draft release (`gh release download` with `--clobber`) - so the audit
runs on the exact bytes about to be published, never on a build folder,
an earlier upload or an unrelated artifact - and then, in order:

1. Required-asset presence (the full upload matrix, including
   `latest.json`, every in-app-update sidecar and `SHA256SUMS.txt`),
   implemented in the job itself; a missing or EMPTY file fails.
2. A checksum re-hash of every file against `SHA256SUMS.txt` (both
   directions).
3. `python3 scripts/ci/verify-release-artifacts.py . "$TAG" "$VERSION"
   "$REPOSITORY"` - the deep audit over those same bytes:
   - `SHA256SUMS.txt` covers every asset and every entry resolves
     (self-listing, duplicates, wrong hashes, unlisted and missing
     assets all fail);
   - `latest.json` is valid, unambiguous JSON whose version matches the
     release, whose platform URLs are THIS tag's versioned download
     URLs, whose referenced assets exist, whose platform classes match
     the artifact shapes (windows → nsis exe, linux →
     AppImage/deb/rpm, darwin → app.tar.gz), and whose embedded
     signatures equal the `<asset>.sig` sidecar bytes;
   - every sidecar cryptographically verifies over the artifact's exact
     bytes against the production minisign public key from
     `tauri.conf.json` (the embedded pure-Python verifier self-tests
     against RFC 8032 vectors and the app's own `tauri signer sign`
     fixture first); orphan sidecars fail;
   - the required platform matrix (windows-x86_64, windows-aarch64,
     linux-x86_64) must be present; unsigned classes (dmg, msi, apk,
     portable zips) must NOT carry sidecars - in-app delivery is never
     offered for them (expected-absence is REPORTED, not failed).
Only after all of that passes does the job run `gh release edit
--draft=false`. Its rejection behavior is pinned by
`scripts/ci/test_verify_release_artifacts.py` (blocking in
`ci.yml` → `artifact-audit-tests`).

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

### Android signing secrets: maintainer procedure (new requirement)

The Android release job signs with the PERSISTENT keystore - the identity
every installed device from the 1.0.6-beta baseline on verifies updates
against. Two repository Actions secrets carry it:

| Secret | Content |
|---|---|
| `ANDROID_KEYSTORE_B64` | base64 of `fress.keystore` (alias `fress`) - unchanged |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore's store AND key password - **required since the hardcoded-password removal; the release job fails closed without it** |

The release job validates, in order, before anything is signed: the
password secret is present (explicit error if absent), the keystore opens
with that password under alias `fress`, and the certificate SHA-256
fingerprint equals the pinned permanent key
(`b0fd578d669171af2830dcc91707d92267eea44f2a79651e2614d975e4cbdf27`). A
fresh keystore with the right alias and password still cannot sign: the
fingerprint pin rejects it, preserving update-over-install for every
existing install.

**One-time rotation required** (the pre-secret workflow ran the old short
password through shell command lines, so it must be treated as exposed):

1. On a trusted machine, with the ORIGINAL `fress.keystore`:
   `keytool -storepasswd -keystore fress.keystore -alias fress`
   (old password → new strong password), then
   `keytool -keypasswd -keystore fress.keystore -alias fress`
   (same new password for the key). This preserves the key and certificate
   - do NOT generate a new keystore.
2. Verify the identity survived:
   `keytool -list -v -keystore fress.keystore -alias fress` must print the
   SAME SHA-256 fingerprint as above.
3. Update `ANDROID_KEYSTORE_B64` with `base64 -w0 fress.keystore` of the
   rotated file, and create `ANDROID_KEYSTORE_PASSWORD` with the new
   password.
4. Run a release (or a dry run of the Android job) and confirm the restore
   step passes. Until step 3 lands, every Android release job fails at the
   restore step BY DESIGN - the failure names the missing secret.

The secret is only ever exposed to steps through step-level `env:`; it is
never interpolated into shell source text, never echoed, and never part of
an artifact. Debug/PR workflows have no keystore references at all.


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
  with focus returned to the trigger, the cap and Clear. The focus-return
  contract is asserted directly (an earlier `test.fail()` pin from the
  pre-a11y era is lifted and gone).
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
  page ('no-asset'). A usable asset whose checksum cannot be established
  is ALSO refused in-app, at BOTH failure levels: the manifest missing
  entirely (404) and the manifest present but with no line for the chosen
  asset ('unverifiable' → releases page). The delivery-layer integrity
  contract is exercised end to end: with a PUBLISHED-BUT-WRONG digest the
  transfer starts, fails with kind=checksum, never reports verified in the
  UI or the persisted history, never opens anything externally, and the
  only offered recovery is a fresh Retry of the same update asset.
  The incompatible-asset half is asserted directly: the self-update
  picker applies two-phase eligibility (compatibility gate first), so an
  ARM-only release yields no direct download - no `test.fail()` pin
  remains.
- **Visual regression** (`z-visual.spec.ts`): main catalog light+dark;
  catalog at 390/768/1366/1600/1920 CSS px; Privacy Pack light+dark;
  detail modal; download manager with active+failed items; command palette
  with highlighted result; Persian RTL versions of the key screens; a
  500-entry scale shot. Thresholds (`maxDiffPixelRatio: 0.02`, animations
  disabled, fonts awaited) make one antialiasing pixel between OSes a
  non-event while real layout regressions fail.

**Screenshot authenticity rules** (learned the hard way this round): EVERY
  capture asserts its theme immediately before the screenshot through two
  independent signals - the app's own theme class on `html` AND the
  computed `colorScheme` the browser resolves from it (light captures
  assert the absence of the dark class and `colorScheme: light`; dark
  captures assert both present). A filename alone proved nothing once: an
  earlier dark baseline accidentally baked the open settings menu into the
  "dark catalog" shot and the diff could not tell theme truth from popover
  placement, so the menu is also explicitly closed after a theme switch.
  Fonts and fixture data are awaited. Baselines are reviewed BY EYE when
  regenerated (the diff images live in the Playwright report); a baseline
  update is a reviewed artifact, not a chore. Note: baselines contain the
  version badge, so a version bump legitimately requires a scoped
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

Everything in this section is UNVERIFIED by automation: no in-repo
evidence record (screenshots, run logs, device/OS versions) exists for
these items unless one is explicitly linked in the current release's
evidence table. Absence of a failure report is not a pass.

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
   `frontend`, `artifact-audit-tests`, `rust`, `rust-native` (Windows +
   macOS), `e2e`, `perf`, `authors` - each green as a REQUIRED job, not
   warnings. A skipped job is not a pass; a job that cannot run must be
   an explicit, recorded decision.
2. **`release.yml` completes** for the tag: bundles produced for Windows,
   macOS and Linux, Android build produced, and version/tag coherence
   proven by `npm run validate:versions -- --expect-tag` in the `version`
   job (a tag that disagrees with the manifests cannot start any build).
3. **The final published-artifact audit passed** (`release.yml` →
   `verify-release`): every uploaded asset re-hashed against
   `SHA256SUMS.txt`, `latest.json` consistent with the exact published
   bytes, every in-app-update sidecar cryptographically verified against
   the production key, and only then the draft published. A release whose
   audit failed (or never ran) is not a release.
4. **Platform evidence recorded in the release notes**, each explicitly:
   - "Windows/macOS Rust suites passed in CI" (link the runs) - and the
     manual packaged-app smoke per OS from section 4 with the OS version
     tested.
   - "Android: no automated gate - manual device run" with device model,
     Android version and the installer that was run.
5. **Manual device checklist from section 4 executed** and linked (one
   entry per OS that ships in this release) - until such a record exists,
   physical-device and assistive-technology behavior is UNVERIFIED.
6. **The live network smoke** (`network-smoke.yml`) run manually against
   the release commit (or its latest scheduled run linked) - green, or its
   redness explained by upstream/rate-limit annotations.
7. **Performance record attached**: the `perf` job's `perf-results`
   artifact (or a local `latest.json`) for the release commit, with any
   wall-clock movement vs the baseline acknowledged.
8. **No open `test.fail()` annotations** without a linked, accepted issue
   (see below) - a known-broken contract cannot ride into a release
   silently.

## 8. Open findings routed to owners

Findings are routed by code ownership; the time-sensitive per-release
status lives in `docs/release-readiness*.md` (release-process owner),
not here. State verified against the code as of this runbook's update:

1. **In-app rate-limit messaging is degraded in Tauri mode** (OPEN;
   owner: resolver, `src/lib/release/`). Tauri v2 rejects command errors
   as plain strings, and the resolver reads `(e as Error).message`, which
   is `undefined` for a string - the specific "GitHub is rate-limiting
   this network" message is browser-mode only; in-app the same failure
   degrades to generic text. Pinned as actual behavior by the Tauri-mode
   test in `c-resolver-failure.spec.ts`; a small normalization in the
   resolver's error path would restore the specific message in-app.
2. **Update pill label after a plan-level delivery refusal** (FIXED,
   verified in code: the `fallback` phase now maps to the
   see-releases label, and the WHY travels through the refusal toast).
3. **Category label on cards untranslated** (FIXED, verified in code:
   the card badge renders through the same shared category mapping the
   filters, table and detail modal use).

## 9. A developer-machine run is not release evidence

The section title is the point: the commands in section 1 are reproducible
locally, and running them locally is how you iterate - but a green laptop
run proves nothing about the platforms Fress ships for. The evidence model
is: the per-platform CI jobs (Linux browser gates, Windows/macOS Rust
suites, tag-time bundles) plus the recorded manual device runs from
section 4. If a gate cannot run for a release, the release is not ready -
the failure to run IS the finding.
