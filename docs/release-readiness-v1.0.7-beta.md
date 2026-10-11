# Release readiness — v1.0.7-beta integration (Agent 6 final QA)

> **SUPERSEDED** by `release-readiness-v1.0.8-beta.md`, which covers the
> fully integrated candidate (all six quality PRs #27–#32 + the v1.0.8-beta
> version bump merged) and the completed Android signing-secret remediation.
> This document is kept as the v1.0.7-era record; its F1 finding
> (`pickOwnAsset` incompatible-asset leak) was FIXED by PR #29 and the
> `test.fail()` annotation was lifted.

Status of every required quality gate for the integrated commit at the head
of `quality/final-integration-qa` (integrated on top of the released
v1.0.7-beta, `5557065`). Dated 2026-10-12.

The core rule of docs/quality-gates.md applies verbatim: **a pass below is
only as good as the environment it ran in.** Sections separate what ran
locally (this environment: Linux x86_64, Node 20, Chromium headless, no Rust
toolchain) from what only CI can prove (Windows/macOS Rust suites, PR-gated
enforcement).

## Gate-by-gate status

| # | Required gate | Status | Where | Evidence |
|---|---|---|---|---|
| 1 | TypeScript checks | **PASS** | local | `npm run typecheck` — clean, no errors. |
| 2 | Unit tests | **PASS** | local | `npm test` — 397 passed, 2 skipped (31 files). The 2 skips are the live-probe tests that require network and are skipped by design. |
| 3 | Localization dictionary parity + translation coverage | **PASS** | local | `i18nDictParity.test.ts` runs inside `npm test`; `validate:catalog` additionally checks catalog translation coverage. |
| 4 | Catalog validator | **PASS** | local | `npm run validate:catalog` — 0 errors, 13 pre-existing warnings (advisory by the validator's own policy). |
| 5 | Security config validator | **PASS** | local, **NEW CI gate** | `npm run validate:security` — CSP/Tauri allowlist matches the audited baseline. Was NOT run by any workflow before this branch; `ci.yml` → `frontend` now runs it on every PR. |
| 6 | Production build | **PASS** | local | `npm run build` — clean; this artifact is what E2E/perf run against. |
| 7 | Rust fmt / Clippy / tests (Linux) | **PENDING CI** | CI only | No Rust toolchain in the QA environment. `ci.yml` → `rust` runs all three, unchanged, on the PR. |
| 8 | Rust tests (Windows + macOS) | **PENDING CI** | CI only | `ci.yml` → `rust-native`, unchanged, on the PR. |
| 9 | Version consistency (package, lockfiles, Cargo, Tauri config) | **PASS locally; NEW CI gate** | local + CI | All five version fields equal `1.0.7-beta` (package.json, package-lock.json root + `packages['']`, Cargo.toml, tauri.conf.json). `version-guard` now also checks BOTH lockfile fields. |
| 10 | E2E smoke — workflows A–J + visual | **PASS** | local; **NEW CI gate** | `npm run test:e2e` — **64 passed** on the integrated build (59 ported/adapted + 5 self-update). One of the 64 is an expected-failure pinning finding F1 below; CI treats it as green until the defect is fixed, then red until the annotation is lifted. |
| 11 | Deterministic performance invariants | **PASS** | local; **NEW CI gate** | `npm run test:perf` — 0 unrelated card mutations in a 1000-event burst (contract: 0); 0 persistence writes in a 100-event cadence (bound: 12). |
| 12 | SemVer + channel regression tests | **PASS** | local | `selfUpdate.test.ts` (compareVersions, channel matrix, prerelease-flagged stable tags) + E2E Workflow I (malformed tag, wrong-channel). |
| 13 | Light-theme contrast checks | **PASS** | local | `lightThemeContrast.test.ts` (7 assertions) inside `npm test` — the Agent-1 AA pass is enforced, not claimed. |
| 14 | Live resolver smoke (GitHub/F-Droid/Signal) | **SKIPPED by design** | opt-in | `network-smoke.yml` — weekly schedule + manual dispatch only; never a PR gate (deterministic fixtures + deny-all instead). Run it before a release tag: `npm run test:live`. |

## CI enforcement status (this branch)

New/changed in `.github/workflows/ci.yml` (all existing jobs preserved
verbatim):

- `version-guard`: now also pins `package-lock.json` root + `packages['']`
  versions.
- `frontend`: now runs `npm run validate:security` (was ungated anywhere).
- `e2e` (new, required): full Playwright suite against the production build,
  Linux only, fixture-backed deny-all network, no secrets,
  `persist-credentials: false`, actions pinned by SHA.
- `perf` (new, required): deterministic invariants block; wall-clock numbers
  are recorded as artifacts and compared informationally against
  `scripts/perf/baselines/catalog.json`.
- `network-smoke.yml` (new): the ONLY workflow that touches live endpoints;
  schedule/manual only, never `pull_request`.

CI has **not yet executed** for this branch — the gates above were validated
locally on the exact tree; the PR run is the authoritative pass. Nothing in
this branch downgrades an existing required check to advisory.

## Platform coverage truth table

| Platform | What is proven | What is NOT proven |
|---|---|---|
| Linux | Everything: frontend gates, Rust suite (CI), browser E2E + visual (authoritative platform for both) | Packaged-app smoke (installer, updater handoff) — manual |
| Windows | Rust engine tests in CI (`rust-native`) | Browser-level behavior (WebView2 ≠ Chromium) — manual smoke required; E2E/visual baselines do not run there |
| macOS | Rust engine tests in CI (`rust-native`) | Same as Windows (WKWebView) |
| Android | Release-time build in `release.yml` only | **No automated gate at all** — storage model, back gesture, RTL system settings, APK install flow are all manual device testing; nothing Android-specific should be described as verified |

Architecture coverage: the Rust native tests cover engine behavior per-host
(compile-target arch). The cross-arch artifact-selection behavior
(Windows-on-ARM, ARM64 Linux) is simulated through fixtures in unit tests
(`selfUpdate.test.ts`, `resolveStreams.test.ts`) and E2E Workflow J — no
real ARM/Android hardware ran anything in this QA round.

## Performance evidence (before/after, same machine)

Baseline: `scripts/perf/baselines/catalog.json` (recorded on v1.0.6-era
code, this machine). New run: `scripts/perf/results/latest.json` (integrated
v1.0.7 build, this machine, same day):

| Measurement | Baseline | Integrated | Note |
|---|---|---|---|
| Unrelated card mutations, 1000-event burst | 0 (contract 0) | **0** | Blocking invariant holds |
| Persistence writes, 100-event cadence | 0 (bound 12) | **0** | Blocking invariant holds |
| Initial render → usable catalog (575 entries) | 2070 ms | 2037 ms | informational |
| Search latency (3 queries) | 113/17/15 ms | 110/16/18 ms | informational |
| Grid→table / table→grid | ~927/969 ms | 927/969 ms | informational |
| Load with 200-item history | 1870 ms | 1822 ms | informational |

The code changes between the two measurements are structural (resolver
rework, dialog system, self-update chain) — the wall-clock deltas are within
machine noise and **no speed claim is made**. The claim that matters is the
two deterministic contracts, and they hold on the integrated build.
`npm run perf:catalog` (Node-side filter pipeline) reconfirms sub-millisecond
per-keystroke filtering at 1000 apps; no memoization/virtualization was added
to production components for any of this.

## Visual evidence

20 baselines regenerated/reviewed on the integrated build (Linux/Chromium,
`deviceScaleFactor: 1`, fonts awaited, animations disabled, threshold 2%):

- Catalog light + dark at 390/768/1366/1600/1920 px — dark captures are
  menu-free (an earlier baseline had the settings popover baked in; the
  capture flow now closes it and asserts the theme class before shooting).
- Privacy Pack light + dark (the redesigned tab with the AA-contrast
  "Add to selection" button).
- Detail modal, download manager (active + failed), command palette.
- Persian RTL: catalog, palette, detail dialog, download manager, privacy.
- 500-entry scale shot.

All reviewed by eye; the diffs that forced regeneration were (a) the
legitimate v1.0.7 privacy-tab redesign, (b) the version badge
(`v1.0.6-beta` → `v1.0.7-beta`), (c) the menu-free dark capture.

## Manual / not-yet-verified (must not be described as verified)

- Screen-reader pass (NVDA/VoiceOver) over catalog, palette, dialogs.
- Real-device Android validation of the produced APK.
- Windows/macOS packaged-app smoke (WebView2/WKWebView).
- Real-network download conditions (resume across drops, IPv6-only,
  captive portal).
- Publisher signing: `release.yml` produces **unsigned** artifacts for
  Linux/Windows and the macOS/Android signing story is documented in
  CODE_SIGNING.md as configured-via-secrets; no signature/notarization was
  produced or verified in this QA round.

## PR triage (#16, #17, #20, #26)

- **#16** (Agent 3, native download hardening): **merged** into main
  (`20dba2c`, 2026-10-11) before this QA round; its engine/policy tests run
  in the `rust` job and its IPv6 policy fix is part of v1.0.7. Nothing to
  do.
- **#17** (Agent 2, a11y dialogs/i18n): **closed unmerged** and superseded
  by **#21** (same author's reworked "five-language dialog system,
  single-layer Escape, recoverable resolver UX"), which IS in v1.0.7
  (`e74d933`). Verified by content, not by title: the E2E suite asserts the
  #21 deliverables (combobox palette, dialog names in five languages,
  stacked focus, privacy-pack focus return) against the integrated build.
- **#20** (cross-platform truth audit): **merged** into main (`81b96cf`).
  Nothing to do.
- **#26** (this QA suite's first round, branch `quality/integration-gates`):
  open, based on v1.0.6-era main. Superseded by this branch, which carries
  the same work ported onto the integrated v1.0.7 code plus Workflows I/J,
  the CI security/version gates and the corrected visual baselines. Close
  #26 when this PR opens.

## Findings routed to owners

1. **F1 (Workflow J) — `pickOwnAsset` leaks an incompatible installer**
   when the release has no compatible asset (ARM64-only release on x64
   Windows resolves to the arm64 exe, score 8; Linux leaks a .exe at
   score -1). With a published digest the update is even delivered as a
   "verified" download of an unrunnable file. Pinned `test.fail()` with
   full reproduction in `tests/e2e/i-self-update.spec.ts`; fix + lift the
   annotation. Owner: self-update/release engineering.
2. **F2 — in-app rate-limit message is generic** (Tauri string errors vs
   `(e as Error).message`); browser-mode shows the specific message.
   Pinned as actual behavior. Owner: resolver.
3. **F3 — card category badge untranslated** on non-English UI. Flagged;
   not asserted (would need new baselines). Owner: i18n.

## Verdict

Every gate that can run in this environment **passes on the integrated
commit**; the two Rust platform suites and the PR-level enforcement are
honestly marked PENDING CI and run unchanged on the PR. The release can be
marked ready only after: CI is green on this PR (including `rust` +
`rust-native`), the manual items above get recorded runs, and finding F1 is
either fixed or accepted with the annotation documented in the release
notes.
