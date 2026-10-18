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
| `npm run validate:versions` | local + CI (`ci.yml` → `version-guard` AND `frontend`; `release.yml` → `version` with `--release-tag`) | THE single authoritative version-coherence command (`scripts/ci/validate-versions.ts`): package.json, Cargo.toml, tauri.conf.json, package-lock.json (both positions) and the `fress` crate in Cargo.lock all agree. With `--release-tag vX` it additionally proves a release tag binds to the build metadata. A development build deliberately does NOT have to match the currently published release. |
| `npm test` | local + CI (`ci.yml` → `frontend`) | Unit suite (Vitest + Testing Library, jsdom). Includes the dictionary parity test, resolver contracts, download-store and render-isolation unit tests, and the version-validator rejection tests. |
| `npm run validate:catalog` | local + CI (`ci.yml` → `frontend`) | The catalog is the product: duplicate ids, dead links, platform-command mismatches, missing icons/translations fail. |
| `npm run validate:security` | local + CI (`ci.yml` → `frontend`) | The documented security configuration matches the code (CSP, headers). |
| `npm run build` | local + CI (`ci.yml` → `frontend`) | Production bundle builds (also the artifact the E2E/perf gates run against). |
| `npm run test:e2e` | local + CI (`ci.yml` → `e2e`) | The full integration suite: workflows A-J plus the visual regression set, in headless Chromium against `vite preview` of the production build. Deterministic fixtures only - never live network. |
| `npm run test:perf` | local + CI (`ci.yml` → `perf`) | The integrated catalog benchmark (500+ entries, scripted download stream). Deterministic invariants are blocking; wall-clock numbers are informational. |
| `npm run test:visual` | local | The visual subset alone (`tests/e2e/z-visual.spec.ts`). |
| `npm run perf:catalog` | local | The Node-side filter-pipeline benchmark (pre-existing; complements `test:perf`, which measures the real UI). |
| `python3 -m unittest discover -s scripts/ci -p 'test_*.py'` | local + CI (`ci.yml` → `artifact-audit-tests`) | Rejection-behavior suite of the release-artifact audit (tampered checksums, missing/unlisted assets, wrong-version manifests, altered or foreign signatures, stray/orphan sidecars, malformed manifests, duplicated mappings, manifest-laundering attempts - all FAIL on synthetic temp-dir fixtures) PLUS the workflow contract tests that pin the publication boundary itself: the version validator invocation, the `needs:` chain from `version` to `verify-release`, and that the draft flip can only happen after the artifact audit. A CLI test proves the verifier exits NON-ZERO on a corrupted set (exit status, not just an error log). |
| `node scripts/ci/integration-snapshot.mjs` | CI (`integration-snapshot.yml` → `snapshot`); runnable locally with `GH_TOKEN=<read token>` | Builds the current public integration-state snapshot (tested SHA vs live branch head, source version, newest release + provenance, paginated open-PR inventory, aggregate CI results on the tested SHA, artifact-integrity + version-coherence verdicts) as a step summary + JSON artifact (schema v2). Read-only; never commits. See section 2.2. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | local (with Rust) + CI (`ci.yml` → `rust`, ubuntu-24.04) | Rust formatting. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | local (with Rust) + CI (`ci.yml` → `rust`, ubuntu-24.04) | Rust lint-clean including test targets. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | local (with Rust) + CI (`ci.yml` → `rust` on ubuntu-24.04, `rust-native` on windows-latest + macos-latest) | The Rust suite (state machine, network policy, download finalize). |
| `npx playwright test --config=playwright.live.config.ts` | ONLY scheduled/manual (`network-smoke.yml`); never a PR gate | LIVE resolver smoke against real endpoints. Red here means "investigate", not "revert the PR" - see its workflow header. |
| `python3 scripts/ci/verify-release-artifacts.py <assets-dir> <tag> <version> <owner/repo>` | ONLY in CI (`release.yml` → `verify-release`) | The final published-artifact audit over the EXACT bytes just downloaded from the draft release (see section 2.1). Requires a real assembled release; not runnable locally by design. |

First-time local setup for the browser suite: `npx playwright install --with-deps chromium`.

## 2. Which CI job validates which platform

All workflows live in `.github/workflows/`, least-privilege
(`permissions: contents: read`), actions pinned to commit SHAs, and
`persist-credentials: false` so untrusted PR code never sees a token.

| Gate | Workflow / job | OS | Blocking? |
|---|---|---|---|
| Version coherence (`npm run validate:versions`; one implementation in `scripts/ci/validate-versions.ts`) | `ci.yml` → `version-guard` (+ step inside `frontend`) | ubuntu-latest | Yes |
| Ubuntu 26 canary (the SAME version toolchain on the explicit `ubuntu-26.04` image) | `ci.yml` → `ubuntu26-canary` | ubuntu-26.04 | Yes — red means pin the floating jobs to ubuntu-24.04 before the 2026-10-19 alias flip (section 2.4) |
| Typecheck, unit tests, version coherence, catalog validator, security config validator, production build | `ci.yml` → `frontend` | ubuntu-latest | Yes |
| **API wire contracts** (Playwright request-context gates + Bruno mock folder, both against the hermetic `scripts/api-mock/server.mjs` origin; pins response shapes, Retry-After/ETag semantics, failure statuses the resolvers/updater are built on) | `ci.yml` → `api-gates` | ubuntu-24.04 | Yes |
| Release-artifact verifier rejection tests + workflow publication-boundary contract (49 tests) | `ci.yml` → `artifact-audit-tests` | ubuntu-latest | Yes |
| **Integration snapshot (public evidence: newest-release re-audit + API/git facts)** | `integration-snapshot.yml` → `artifact-audit` (real release bytes through the real verifier), `snapshot` (API + git facts → step summary + JSON artifact) | ubuntu-24.04 (pinned; evidence determinism) | Evidence, not a merge gate - but a RED snapshot run is a real signal: the newest release failed its integrity re-audit, a gate failed, or a required observation was unavailable (never silently empty) |
| Rust fmt, clippy, tests | `ci.yml` → `rust` | ubuntu-24.04 (deliberate 22.04→24.04 migration, tested in CI) | Yes |
| Rust tests (native) | `ci.yml` → `rust-native` | windows-latest, macos-latest | Yes |
| **E2E workflows A-J + visual regression** | `ci.yml` → `e2e` | ubuntu-24.04 pinned (Chromium headless; visual baselines are green on this image) | Yes |
| **Perf invariants (render isolation, persistence coalescing) + recorded wall-clock baseline** | `ci.yml` → `perf` | ubuntu-24.04 pinned (Chromium headless) | Yes (invariants); informational (timings) |
| Dependency/RustSec scanning | `security.yml` (weekly schedule + lockfile pushes + manual; never on PRs) | ubuntu | npm prod deps blocking; dev deps and RustSec advisory (`continue-on-error` on cargo-audit is DOCUMENTED policy until the RustSec baseline is triaged) |
| Commit author guard | `author-guard.yml` (all pushes + PRs) | ubuntu | Yes |
| LIVE resolver smoke | `network-smoke.yml` (weekly Monday 06:20 UTC + manual dispatch; NEVER on PRs) | ubuntu | Advisory by design - upstream outages/rate limits must not block code review; red runs are investigated, not auto-retried |
| Platform bundles (installers, Android) + version/tag binding | `release.yml` (tag pushes `v*` + manual) | ubuntu / windows / macos / android | Release path |
| **Final published-artifact audit** (checksums, updater manifest, signatures) | `release.yml` → `verify-release` | ubuntu | **Yes - hard blocker**: the release stays a private DRAFT until it passes |
| VirusTotal scan overlay | `release.yml` → `virustotal` | ubuntu | Informational only; skipped with a labeled notice when `VIRUSTOTAL_API_KEY` is unset - a green run is NOT "scanned and clean". It is deliberately NOT in `verify-release`'s `needs:`: one transient VT API error must never leave a verified release stuck as a draft |

**Event truth (what actually triggers what):** `ci.yml` runs on every PR
and on pushes to `main`. `author-guard.yml` runs on all pushes and PRs.
`security.yml` runs weekly (Mon 06:00 UTC), on manual dispatch, and on
main pushes that touch a lockfile. `network-smoke.yml` runs weekly (Mon
06:20 UTC) and on manual dispatch only. `integration-snapshot.yml` runs
on pushes to `main`, weekly (Mon 06:40 UTC), and on manual dispatch
(any ref that contains the workflow). `release.yml` runs on `v*` tag
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

**Counting rule (release page vs checksum entries):** `gh release
download` fetches exactly the UPLOADED assets. GitHub's auto-generated
source archives ("Source code (zip)", "Source code (tar.gz)") are page
dressing, not release assets, and are deliberately OUTSIDE the checksum
contract. A release page showing 24 files can therefore be perfectly
correct with 21 `SHA256SUMS.txt` entries: observed on the real
v1.0.10-beta release (2026-10-12 exact-bytes re-audit: 22 uploaded
assets, 21 checksum entries, all re-hashed both directions, 5 in-app
sidecars verified against the production key, 8 platform entries
consistent, verdict PASSED / exit 0).

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
`ci.yml` → `artifact-audit-tests`), which also proves the CLI exits
NON-ZERO on a corrupted set - the exit status is what fails the job, not
a log line.

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

### 2.2 The public integration snapshot

Static evidence documents (this file included) describe the state at the
moment they were written; main keeps moving and releases keep shipping.
`integration-snapshot.yml` exists so that anyone can read the CURRENT
state from an Actions run instead of trusting a stale file:

| | |
|---|---|
| Workflow | `.github/workflows/integration-snapshot.yml` ("Integration snapshot") |
| Triggers | push to `main`, schedule (Mon 06:40 UTC), `workflow_dispatch` |
| Job `artifact-audit` | finds the newest published release, downloads every uploaded asset (one documented retry for transient download failures; integrity verdicts are never retried into green) and runs `scripts/ci/verify-release-artifacts.py` on those exact bytes with the production key |
| Job `snapshot` | runs `npm run validate:versions` (verdict RECORDED, never swallowed), then `node scripts/ci/integration-snapshot.mjs`: API + git facts + both gate verdicts → `$GITHUB_STEP_SUMMARY` (human summary) + the `integration-snapshot` artifact (JSON, schema `fress/integration-snapshot@v2`) |
| Token | the workflow's own `GITHUB_TOKEN` with `contents: read`, `pull-requests: read`, `actions: read` - read-only, nothing is committed, pushed or released |
| Exit semantics | `0` complete and green; `3` a required observation was unavailable - including a LOST or unparsable gate verdict, which is never an implicit pass (the run is red and the summary says which field); `4` a reported gate FAILED; `2` the snapshot could not be produced at all. The summary and artifact are still attached on red runs |

What each snapshot reports, and where to look (schema
`fress/integration-snapshot@v2`; every externally-sourced section carries
`status: "ok" | "unavailable"` plus a `reason` when unavailable — a
successful-looking default is never substituted for a fact that could not
be observed):

- **`tested.sha` — the commit ACTUALLY checked out** (`git rev-parse HEAD`
  of the run), with `tested.event_sha` recorded separately when the
  workflow event's `GITHUB_SHA` differs from it (a checkout override can
  never silently mislabel the observation). **`tested.is_default_branch_head`**
  states whether the tested SHA equaled the live default-branch head at
  observation time - a snapshot produced on an older commit (a queued
  push, a scheduled run) can never be mistaken for current main, and
  `default_branch.head_sha` records that head explicitly with a compare
  link in the summary.
- **`source_version`** from `package.json` (the authoritative manifest);
  a missing, unparsable or non-string version is a required-unavailable
  observation, not a blank field.
- **`release`**: the newest published release with `tag`, **`tag_sha`**
  (the tag's target commit), published date and the provenance facts
  determined from Git: **`is_ancestor_of_tested`**,
  `commits_tested_ahead_of_release` / `commits_release_ahead_of_tested`.
  A release commit missing from the checkout is reported as
  `is_ancestor_of_tested: null` with a `provenance_note` - unproven, not
  fabricated.
- **`open_pull_requests`**: the observed inventory fetched across ALL API
  pages (`count`, `pages_fetched`, `truncated`, linked `items`). If the
  API call fails or returns a malformed body, the section says
  `status: "unavailable"` with the reason, `count` stays `null` and the
  run goes red - an empty list is never displayed for an unfetchable list.
- **`ci`**: workflow runs whose `head_sha` is exactly `ci.tested_sha_filter`
  (the tested commit), each with workflow name, id, event, status,
  conclusion and run URL; `aggregated_conclusion`
  (`pass` / `failing` / `pending` / `none`) plus `failing_workflows` make
  a red workflow impossible to miss, and a failing aggregate is announced
  as a warning annotation on the run. Pagination facts are recorded here
  as well. Every API-returned run is additionally re-checked against the
  tested SHA locally: runs from other commits are EXCLUDED and counted in
  `excluded_head_sha_mismatch` (with the reason in `note`) — a passing
  historical run can never stand in for the tested commit.
- **`artifact_integrity_audit`** (from the `artifact-audit` job) and
  **`version_coherence`** (from `npm run validate:versions`) - gate
  verdicts measured by the authoritative implementations, never
  re-implemented in the snapshot script. A verdict that is missing, lost
  or unparsable is a required-unavailable observation (the run goes red
  with a diagnostic) - never an implicit pass.
- **`unavailable_observations`** (this run's failures, each with its
  reason) and **`known_limitations`**: branch-protection enforcement (an
  admin-only Settings fact - the snapshot can neither confirm nor deny
  it), and the standing device/assistive-tech limitations from section 4.

Schema example (values are PLACEHOLDERS, not observations - the live
facts live in each run's `integration-snapshot` artifact; historical
numbers must never be copied into prose as if they were current):

```json
{
  "schema": "fress/integration-snapshot@v2",
  "generated_at": "<RFC-3339 timestamp of the run>",
  "repository": "<owner>/<repo>",
  "snapshot_run": { "url": "<https://github.com/<owner>/<repo>/actions/runs/<run-id>>" },
  "tested": {
    "ref": "<observed-current-branch-name>",
    "sha": "<observed-current-branch-sha>",
    "event_sha": "<event-declared-sha, or null>",
    "is_default_branch_head": true,
    "note": "the workflow code producing this snapshot comes from the same checkout as the tested SHA"
  },
  "default_branch": {
    "status": "ok",
    "name": "<default-branch-name>",
    "head_sha": "<observed-default-branch-head-sha>",
    "html_url": "<commit-url>"
  },
  "source_version": "<observed-source-version>",
  "release": {
    "status": "ok",
    "tag": "<observed-release-tag>",
    "tag_sha": "<observed-release-tag-commit-sha>",
    "html_url": "<release-url>",
    "published_at": "<RFC-3339 timestamp>",
    "prerelease": true,
    "draft": false,
    "is_ancestor_of_tested": true,
    "commits_tested_ahead_of_release": 0,
    "commits_release_ahead_of_tested": 0
  },
  "open_pull_requests": {
    "status": "ok",
    "count": "<observed-open-pr-count>",
    "truncated": false,
    "pages_fetched": 1,
    "items": [{ "number": "<pr-number>", "title": "<pr-title>", "html_url": "<pr-url>", "head_ref": "<branch>", "head_sha": "<sha>", "draft": false, "created_at": "<RFC-3339 timestamp>" }]
  },
  "ci": {
    "status": "ok",
    "tested_sha_filter": "<same as tested.sha>",
    "aggregated_conclusion": "pass",
    "failing_workflows": [],
    "runs": [{ "workflow": "<workflow-name>", "workflow_id": "<id>", "event": "push", "status": "completed", "conclusion": "success", "run_url": "<run-url>", "head_sha": "<same as tested.sha>", "created_at": "<RFC-3339 timestamp>" }],
    "pages_fetched": 1,
    "truncated": false,
    "excluded_head_sha_mismatch": 0
  },
  "artifact_integrity_audit": { "verdict": "pass|fail|unavailable", "release_tag": "<tag-or-null>", "verifier_exit_code": "<int-or-null>", "hard_failures": "<int-or-null>" },
  "version_coherence": { "implementation": "npm run validate:versions (scripts/ci/validate-versions.ts — the one authoritative validator)", "result": "pass|fail|unavailable", "exit_code": "<int-or-null>" },
  "branch_protection": { "enforced": "unavailable", "reason": "GitHub API 403/404 — admin-only Settings fact, not observable with a repository-scoped read token" },
  "unavailable_observations": [{ "field": "<field-name>", "reason": "<why it could not be observed>" }],
  "known_limitations": ["…"]
}
```

To run the snapshot locally against the real repository (read-only; the
same command the workflow executes):

```sh
GH_TOKEN=<read-only token> node scripts/ci/integration-snapshot.mjs \
  --out snapshot.json \
  --version-coherence pass --version-coherence-rc 0 \
  --artifact-audit '{"verdict":"pass","verifier_exit_code":0,"hard_failures":0,"release_tag":"<observed-release-tag>"}'
```

Without the two verdict flags the corresponding gates are reported
`unavailable` and the command exits `3` - that is the honest local-dev
mode (the verdicts are CI measurements this run did not make), and the
markdown summary goes to stdout when `GITHUB_STEP_SUMMARY` is unset.

**How to inspect a run's output** (the whole point of the workflow): open
the run on github.com (from the Actions tab, workflow "Integration
snapshot"). The human-readable snapshot IS the run's **Summary tab**
(the workflow wrote it to `$GITHUB_STEP_SUMMARY`; it needs no artifact
download). The machine-readable copy is the run's **`integration-snapshot`
artifact** (JSON, schema `fress/integration-snapshot@v2`, retained 90
days): open the run page → Artifacts → download and read the JSON. Each
section's `status: "unavailable"` + reason, `generated_at` and
`tested.sha` are the fields that keep an old artifact from being read as
current state. A failed artifact audit additionally keeps a raw
`artifact-audit-log` artifact (30 days) with the verifier's full output.

### 2.3 Gate taxonomy: what blocks, what publishes, what only observes

The flat table in section 2 answers "which job runs where"; this
subsection answers "what KIND of gate is this". Five categories, each
naming the actual workflow file, job, command, trigger, tested code scope
and blocking status. `continue-on-error` appears nowhere in any workflow
(except the one documented `cargo-audit` advisory in `security.yml`).

**1. Required blocking CI checks (every PR and every push to `main`)**

| Gate | Workflow file → job | Command | Tested code scope | Blocking? |
|---|---|---|---|---|
| Version coherence (dev mode) | `ci.yml` → `version-guard` | `npm run validate:versions` | whole checkout (six authoritative version fields) | Yes |
| Typecheck + unit suite + catalog/security validators + production build | `ci.yml` → `frontend` | `npm run typecheck`, `npm test`, `npm run validate:catalog`, `npm run validate:security`, `npm run build` | frontend + config (whole tree) | Yes |
| Verifier rejection suite + workflow publication-boundary contract | `ci.yml` → `artifact-audit-tests` | `python3 -m unittest discover -s scripts/ci -p 'test_*.py'` | `scripts/ci/` (verifier + workflow contracts) | Yes |
| Rust fmt / clippy / tests | `ci.yml` → `rust` (ubuntu-24.04) | `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` | `src-tauri/` (engine) | Yes |
| Rust tests on native OSes | `ci.yml` → `rust-native` (windows-latest, macos-latest) | `cargo test` | `src-tauri/` (engine) | Yes |
| E2E workflows A-J + visual regression | `ci.yml` → `e2e` (ubuntu-24.04, Chromium headless) | `npm run test:e2e` | production build via `vite preview` | Yes |
| Perf invariants (render isolation, persistence coalescing) | `ci.yml` → `perf` | `npm run test:perf` | production build | Yes (invariants); timings informational |
| Commit author guard | `author-guard.yml` → `authors` (pushes + PRs) | repo-configured author check | commit metadata | Yes |

What each gate's environment actually is - **mocked, native-OS, or
physical** - and why that matters for what it can prove:

- **Mocked / deterministic**: the E2E + perf suites answer every
  network, vendor and self-update endpoint from fixtures
  (`tests/e2e/netpolicy.ts` aborts all non-loopback requests), so shared
  GitHub quota can never flake a PR and no live service is contacted.
  The verifier rejection suite and both contract-test suites run on
  synthetic temp-dir fixtures with no real release, tag or token.
- **Native OS, no device**: the Rust suites execute real OS process,
  filesystem and networking behavior on the three desktop platforms
  (linux / windows-latest / macos-latest) - but headless, without a GUI
  session, an installer, or a device.
- **Physical device / real network**: everything in section 4 - Android
  on hardware, packaged-app smoke per OS, screen readers, real-network
  resume - is UNVERIFIED by automation by design.
- **Admin-only Settings**: branch-protection enforcement (category 5
  below; exact owner action spelled out there).

**2. Release-publication gates (`release.yml`, tag pushes `v*` + manual)**

| Gate | Job | Command | Tested code scope | Blocking? |
|---|---|---|---|---|
| Version/tag binding | `version` | `npm run validate:versions -- --release-tag` (tag pushes only) | the tagged commit's six authoritative fields vs the pushed tag | Yes - a disagreeing tag starts no build |
| Platform bundles | `build-*` matrix | `tauri build` per OS + Android | the tagged commit | Yes (a missing bundle fails the release) |
| Final published-artifact audit | `verify-release` | `python3 scripts/ci/verify-release-artifacts.py` on the freshly downloaded draft assets | the EXACT release bytes | **Yes - the release stays a private draft until this passes**; the draft flip (`--draft=false`) is the only publication switch |
| VirusTotal overlay | `virustotal` | external scan API | the release artifacts | Informational only - skipped with a labeled notice when the key is unset; deliberately NOT in `verify-release`'s `needs:` |

**3. Scheduled / manual smoke and evidence workflows (never on PRs)**

| Gate | Workflow file | Trigger | Tested code scope | Blocking? |
|---|---|---|---|---|
| LIVE resolver smoke | `network-smoke.yml` | schedule Mon 06:20 UTC + manual dispatch | real endpoints (GitHub, F-Droid, vendor) | Advisory by design - red means "investigate", not "revert" |
| Dependency/RustSec scanning | `security.yml` → `npm-audit`, `cargo-audit` | schedule Mon 06:00 UTC + manual + lockfile pushes to `main` | manifests | npm prod deps blocking (`npm-audit`); dev deps / `cargo-audit` advisory by DOCUMENTED policy |
| Integration snapshot | `integration-snapshot.yml` | push to `main` + schedule Mon 06:40 UTC + manual dispatch | repo state + newest release bytes | Evidence, not a merge gate - but a RED run is a real signal (see 2.2) |

**4. Current-state observation tooling**

- `integration-snapshot.yml` (above) is the designated current-state
  instrument: tested SHA vs live branch head, release provenance, open-PR
  inventory, CI-on-tested-SHA aggregate, both gate verdicts - published
  per run as a step summary + JSON artifact, never as an editable file
  (see 2.2 for the schema).
- The `integration-snapshot` artifacts are retained 90 days; older
  artifacts describe older states and must be read together with their
  `generated_at` and `tested.sha`.

**5. Checks that require physical devices or repository-admin settings**
(UNVERIFIED by automation; see section 4 for the manual checklist, and
section 2's note for the Settings actions)

- Android on a real device (no emulator gate exists); Windows/macOS
  packaged-app smoke; screen-reader (NVDA/VoiceOver) passes; real-network
  resume behavior.
- Branch-protection enforcement itself: making the section-1 checks
  REQUIRED for merge is a maintainer Settings action - no workflow can do
  it, and the snapshot honestly reports this fact as unobservable with a
  read token. The exact owner action: repository **Settings → Branches →
  Branch protection rules for `main`** → enable *Require status checks to
  pass before merging* and add the section-1 jobs as required checks
  (`Version consistency`, `Typecheck, tests, catalog, security, build`,
  `Release-artifact verifier tests`, `Rust fmt, clippy, tests (linux)`,
  `Rust tests (windows-latest)`, `Rust tests (macos-latest)`,
  `E2E + visual (linux)`, `Perf invariants (linux)`), plus *Require a pull
  request before merging* if direct pushes to `main` should be refused.
  Until that is observed as configured, the snapshot's
  `branch_protection.enforced` stays `"unavailable"` by design.

### 2.4 Runner images, action runtimes, and maintenance policy

CI must not rot silently: runner images migrate and action runtimes get
deprecated, and both arrive as surprise reds unless the runbook pins who
depends on what. State verified against real logs of run 38353143300
(2026-10-13) and the maintained releases of each action:

**Observed signals that triggered maintenance** (real annotations on every
`ci.yml` job):

- `Node.js 20 is deprecated. The following actions target Node.js 20 but
  are being forced to run on Node.js 24: actions/checkout@11d5960a…,
  actions/setup-node@49933ea…, actions/upload-artifact@ea165f8…` - the
  v4-era pins target Node 20 while the hosted runner now runs node24
  actions under force-upgrade. Fixed by moving to maintained majors that
  run Node 24 natively (below), NOT by removing the SHA pins.
- `The ubuntu-latest label will migrate to Ubuntu 26 beginning October
  19, 2026` (runner-images#14748) - a floating-label platform change six
  days out at the time of the audit, directly relevant to the
  pixel-comparing E2E/visual and perf jobs.

**Pins in the owned workflows (`ci.yml`, `integration-snapshot.yml`) and
the reason for each** (every pin remains a full 40-char commit SHA):

| Action | Was | Now | Reason |
|---|---|---|---|
| `actions/checkout` | v4.4.0 (node20) | **v7.0.1** (`3d3c42e5…`) | node24 native - clears the real deprecation warning; inputs Fress uses (`persist-credentials`, `fetch-depth`) unchanged; v6's creds-file change is moot with `persist-credentials: false`; v7's fork-PR guard only affects `pull_request_target`/`workflow_run`, which Fress never uses |
| `actions/setup-node` | v4.4.0 (node20) | **v7.1.0** (`949feb24…`) | node24 native; the ACTION's runtime is independent of the toolchain it installs - `node-version: 20` and explicit `cache: npm` are kept, so the project's Node toolchain does not move |
| `actions/upload-artifact` | v4.6.2 (node20) | **v7.0.2** (`cf430e03…`) | node24 native since v6; Fress uses only `name`/`path`/`retention-days`/`if-no-files-found`, all unchanged; v7's `archive: false` direct-upload mode is opt-in and unused |
| `swatinem/rust-cache` | v2 (2024-era SHA) | **v2.9.2** (`6323deb1…`) | same major, cache-key/cleanup fixes; not part of the node20 warning but kept current while the pin format stays identical |
| `dtolnay/rust-toolchain` | `686976e…` (2026-10-09) | unchanged | already the freshest master commit (4 days old at audit); the action has no stable versioned releases, is composite (no Node runtime, not flagged by the warning), and its SHA pin IS its integrity guarantee |

**Runner-image decisions** (who is pinned and why):

- `e2e` + `perf` → **ubuntu-24.04 pinned**: visual baselines are pixel
  comparisons (`*-chromium-linux.png`) and font rasterization changes with
  distro upgrades; a floating label migrating to Ubuntu 26 must never
  arrive as an unexplained red. 24.04 is the image the baselines are green
  on today (verified: run 38353143300 provisioned ubuntu-24.04 for these
  jobs via ubuntu-latest).
- `integration-snapshot.yml` jobs → **ubuntu-24.04 pinned**: the workflow
  is the public-evidence instrument; its observations must not drift with
  image migrations.
- `rust` → **ubuntu-24.04** (deliberate migration from ubuntu-22.04,
  tested by the introducing PR's own CI run): 22.04 is an aging image,
  and the release path builds the Linux bundle on ubuntu-latest (=24.04 at
  audit time), so CI now compiles/tests on the same Linux the installers
  ship from.
- `version-guard`, `frontend`, `artifact-audit-tests` → **ubuntu-latest
  kept**: their measurements are distro-insensitive (toolchains pinned by
  `setup-node` + lockfiles); float deliberately so routine image refreshes
  get exercised somewhere cheap.
- `ubuntu26-canary` → **ubuntu-26.04 explicit**: the floating migration is
  TESTED, not just accepted. The canary runs the same deterministic
  toolchain as `version-guard` on the new image, so the 2026-10-19 alias
  flip is proven before it happens; a red canary is the instruction to
  pin the floaters to ubuntu-24.04 first. Image availability verified
  against `actions/runner-images` (release `ubuntu26/20261012.163`) and
  the canary's own green CI run.
- `rust-native` (windows-latest, macos-latest) unchanged: tests only, no
  artifacts, and the release bundles are built on release.yml's own
  runners.

**Maintenance policy going forward:**

1. Action updates land as reviewed PRs whose own CI run is the test; a
   version bump that turns red is not merged. Pins are never loosened to
   tags or removed to silence a warning - the warning is silenced by the
   maintained release, the pin stays.
2. A newer runner image (e.g. Ubuntu 26) is adopted for the
   rendering-sensitive jobs only by a deliberate PR that regenerates the
   E2E visual baselines ON that image and proves the whole suite green.
   For the distro-insensitive jobs the alias flip is de-risked in advance
   by the `ubuntu26-canary` job (explicit ubuntu-26.04, same deterministic
   toolchain); if that canary is red, the floaters are pinned to 24.04
   first.
3. Required commands never gain `continue-on-error`, catch-all retries or
   shell wrappers that swallow failures; the only advisory step in the
   fleet remains `security.yml`'s `cargo-audit` (documented policy, see
   section 2), and the snapshot's single asset-download retry is bounded
   and can never retry an integrity VERDICT into green.
4. Branch-protection enforcement is claimed nowhere: it is a Settings
   fact, reported by the snapshot as `"unavailable"` with the owner action
   spelled out (section 2.3, category 5).

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
   proven by `npm run validate:versions -- --release-tag` in the `version`
   job (a tag that disagrees with the manifests cannot start any build).
3. **The final published-artifact audit passed** (`release.yml` →
   `verify-release`): every uploaded asset re-hashed against
   `SHA256SUMS.txt`, `latest.json` consistent with the exact published
   bytes, every in-app-update sidecar cryptographically verified against
   the production key, and only then the draft published. A release whose
   audit failed (or never ran) is not a release. After publication, the
   `integration-snapshot.yml` → `artifact-audit` job re-audits the newest
   release on every main push / weekly / on demand and publishes the
   verdict publicly - a red snapshot run on a shipped release is a
   release-integrity incident, not a documentation issue.
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
4. **Workflows outside the CI owner's scope still pin the Node-20-era
   action versions** (OPEN; owner: release/workflow owners for
   `release.yml`, `network-smoke.yml`, `security.yml`,
   `author-guard.yml`). The same `Node.js 20 is deprecated` warning that
   `ci.yml` and `integration-snapshot.yml` fixed (section 2.4) fires for
   their `checkout@v4.4.0` / `setup-node@v4.4.0` / `upload-artifact@v4.6.2`
   pins too. The fix is mechanical - the same pinned SHAs documented in
   section 2.4 - but each owner must run their own green CI before
   adopting; nothing here forces it from the outside.

## 9. A developer-machine run is not release evidence

The section title is the point: the commands in section 1 are reproducible
locally, and running them locally is how you iterate - but a green laptop
run proves nothing about the platforms Fress ships for. The evidence model
is: the per-platform CI jobs (Linux browser gates, Windows/macOS Rust
suites, tag-time bundles) plus the recorded manual device runs from
section 4. If a gate cannot run for a release, the release is not ready -
the failure to run IS the finding.
