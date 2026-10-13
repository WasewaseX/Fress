# Fress release readiness — public-main integration audit (round 8)

Status: **public main is integration-ready at the evidence level reachable without physical devices;
`v1.0.11-beta` is published from release source `6cc1d62` and its exact published bytes independently
re-audited PASS on `2026-10-13T04:59:40Z`; the current default-branch tip is `e2bcdc4`, which differs
from the release source only by docs, CI tooling and tests (§3); PR inventory zero-open in the audit
window, one new open PR (#65, tests-only) at finalization re-fetch (§4). The known limits below
are named, not hidden.**

Audit time: **2026-10-13T05:00–05:10Z** — every "current" claim in §1–§7 was re-fetched or re-executed
inside that window. Anything older is explicitly labelled **historical**.
Auditor: integration auditor (round 8 mandate: keep the public-main readiness evidence true,
reproducible, current and traceable after the post-release integration rounds). This file is owned
exclusively by the integration auditor; application code, manifests, workflows, README and
CODE_SIGNING.md were not edited for this report.

**Fact classes used below** — *observed now* (re-fetched/re-executed during this audit window),
*historical* (true at a named past time, kept for context), *not observable* (the setting or evidence
exists outside this environment's reach), *not performed* (a verification this audit deliberately did
not or could not run).

---

## 1. Executive verdict

- **Default branch `main` tip = `e2bcdc4`** (`e2bcdc40ea0348f3dc90a205c26b1ed112c1eb16`, "Merge PR #64").
  The **release-producing source SHA for `v1.0.11-beta` is `6cc1d62`** — an ancestor of the tip. These
  are different commits and the report never conflates them (§3).
- **The `6cc1d62 → e2bcdc4` delta is exactly five files, +1610/−349**: two docs files, one CI-tooling
  file and two test files. **No file under `src/` production code and no file under `src-tauri/`
  changed** after the release merge — so the published v1.0.11-beta installers are behaviorally
  equivalent to what the tip builds (§3). No new release is cut for a docs/test/CI delta; the next
  development bump carries it.
- **`v1.0.11-beta` is published** (id 411086191, 2026-10-13T00:08:10Z, prerelease, 22 assets,
  353,098,545 bytes) and its release run 38324489730 completed **12/12 jobs SUCCESS**, ending in the
  final-artifact audit PASS over the exact bytes, which then flipped the draft to public (§7).
- **Independent reproduction**: this audit re-downloaded all 22 assets fresh from the release URLs and
  re-ran the repository's production verifier on those bytes: **PASS, exit 0** — 21/21 checksum
  entries match, 5/5 updater sidecars verify against the production key, latest.json's 8 platform
  entries resolve to this tag's assets (§7).
- **Verdict: integration-ready.** Every automated gate that exists is green on the current tip
  (11/11 check-runs on `e2bcdc4`, §6). What keeps this from an unconditional 10/10 is named in
  §8/§10/§11: physical-device validation of the open journey has **not performed** on any platform,
  the Android installer handoff is intentionally scoped to a future adapter round, branch-protection
  enforcement is **not observable** from here, and the VirusTotal overlay was **skipped** on this
  release (key not configured; labeled notice — §7).

## 2. Default-branch identity and latest release (observed now)

| Field | Value | Evidence |
| --- | --- | --- |
| Default branch | `main` — confirmed via API, not assumed | `GET /repos/WasewaseX/Fress` → `default_branch: main`; `git remote show origin` → "HEAD branch: main" |
| Current tip | `e2bcdc40ea0348f3dc90a205c26b1ed112c1eb16` — "Merge PR #64: docs - readiness round-7 close-out" | `git fetch origin && git rev-parse origin/main` in the audit window |
| Source version at tip | **1.0.11-beta** in all six authoritative surfaces (see §5) | `npm run validate:versions` on the tip |
| Newest published release | **v1.0.11-beta**, id 411086191, prerelease, not draft | `GET /releases/tags/v1.0.11-beta` |
| Published at | **2026-10-13T00:08:10Z** (draft created 2026-10-12T23:53:29Z — publication happened only after the final audit) | releases API |
| Asset URL base | `https://github.com/WasewaseX/Fress/releases/download/v1.0.11-beta/<asset>` (22 assets; total 353,098,545 bytes) | releases API |
| Release page | https://github.com/WasewaseX/Fress/releases/tag/v1.0.11-beta | releases API |
| Tag target | **`6cc1d62a1fb502fc445222f4a2c308b41027124e`** ("Merge PR #62: v1.0.11-beta - the open-contract release") — an **ancestor of the tip**, not the tip | `git rev-parse v1.0.11-beta^{commit}`; `git merge-base --is-ancestor v1.0.11-beta origin/main` → true |
| Prior releases | v1.0.10-beta (2026-10-12T20:09Z, tag → `a176e74`, ancestor) and older — **historical**, not re-audited this round | releases API, local ancestry |
| Release-vs-tip relationship | The tag IS the release source; the tip is 3 commits ahead, docs/tests/CI only (§3). `package.json` at the tip still equals the published version (no development bump has started). | this audit |

## 3. Release source versus integrated code and docs/tooling delta (observed now)

The five identities this report distinguishes:

| Identity | SHA | What it is |
| --- | --- | --- |
| 1. Release-producing source | `6cc1d62a1fb5…` | the commit the `v1.0.11-beta` tag points at; the source the 22 published artifacts were built from |
| 2. Integrated application-code state | `6cc1d62a1fb5…` (unchanged since) | the last commit to touch production `src/` or `src-tauri/` files — the path-filtered diff in this section is empty for production code after it |
| 3. Integrated tests/CI state | `bdd9885` ("Merge PR #61") | the last commit to touch tests or CI tooling (`tests/e2e/d-download-open.spec.ts`, `scripts/ci/validate-versions.ts`, coherence suite) |
| 4. Current default-branch tip | `e2bcdc40ea0348f3dc90a205c26b1ed112c1eb16` | adds only documentation (PR #64: this report's previous round + smoke-matrix doc) |
| 5. This report's publication commit | the merge of the PR carrying this file | a docs-only commit on top of the tip; distinguished from the audited SHAs by definition |

**The exact delta** (`git diff --stat v1.0.11-beta..origin/main`, observed now):

```
 docs/testing/download-open-smoke.md        |  23 +-
 scripts/ci/validate-versions.ts            | 236 ++++++++-
 src/lib/__tests__/versionCoherence.test.ts | 274 +++++++++-
 tests/e2e/d-download-open.spec.ts          | 823 +++++++++++++++++++++++++++++
 (docs/release-readiness.md                 | this report's round-7 file)
 5 files changed, 1610 insertions(+), 349 deletions(-)
```

Path-filtered diff (`git diff --name-only v1.0.11-beta..origin/main -- src/ src-tauri/ package.json
package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json`):
exactly **one** file — `src/lib/__tests__/versionCoherence.test.ts`, a **test** file. Zero
`src-tauri/` files, zero version manifests, zero production `src/` modules.

**Precise conclusion** (per the evidence rules — what was compared and what it means): the tip is
**not** byte-identical to the tag; it differs by docs, CI tooling and tests. What IS proven is that
no production application source changed between the release source and the tip, so the published
installers correspond to the application code the tip builds. Commits in the delta:
`a5c45f1`, `2164eb6` (PR #60, validator round-2), `b2b8e92` (PR #61 content), merges `fcd5def`
(#60), `bdd9885` (#61), `8ffe24d` (#63), `7d141a6` (#63 content), `36e7b63` (#64 content), `e2bcdc4`
(#64 merge).

Ancestry proofs (local `git merge-base --is-ancestor` against `origin/main`, observed now): the tag
`6cc1d62`, `bdd9885`, and every PR head in §4's table — **all ancestors**.

## 4. PR inventory (re-fetched in the audit window and again at finalization)

Open PRs during the audit window: **zero** (`GET /pulls?state=open` → empty). Closed PRs: **64**
(search API `total_count`). **At finalization re-fetch (2026-10-13T05:12Z) one PR had just opened**:
#65 "test(release): pin the publication-retry contract (verifier tamper case 11)" — head `3e9ece4`,
base `e2bcdc4`, tests-only (`scripts/ci/test_verify_release_artifacts.py`; no production behavior
change). It is **not part of the audited tip** and its own CI will speak for it; the verdicts in
this report describe `e2bcdc4` without it.

Scope note: "passed CI" below always means *that PR's head SHA* — the integration results for the
merged tree live in §6 (tip) and §7 (release source), never borrowed from a PR head.

| PR | Head SHA | Merged as | Content (one line) | CI on head |
| --- | --- | --- | --- | --- |
| #55 | `dc2d8a4` | `91c5e00` | user-facing docs truth pass (README + CODE_SIGNING) on real v1.0.9 release bytes | 9/9 green (historical, check-runs API on dc2d8a4) |
| #56 | `7ff0d20` | `6a3aa23` | `validate:versions` — one authoritative TS validator + 22-test suite | 9/9 green (historical) |
| #57 | `65d7214` | `1ccc96e` | validator wiring into both pipelines, verifier hardening + 20-test suite, quality-gates runbook | 10/10 green (historical) |
| #58 | `c5c4d11` | `4cffefa` | Workflow-K E2E suite: the download-to-open journey (22 tests) | 10/10 green (historical) |
| #59 | `03d7007` | `1f4cde0` | desktop open contract: uniform `open_path` boundary + typed failures + AppImage fallback | 10/10 green incl. Rust on 3 platforms (historical) |
| #60 | `2164eb6` | `fcd5def` | validator round-2: Android metadata surfaces, `--expect-tag` alias, `::error::` annotations, malformed-manifest hardening; coherence suite 22 → 37 tests | 10/10 green on fcd5def (historical) |
| #61 | `b2b8e92` | `bdd9885` | Workflow-D2 E2E round (13 state-gating/listener-hygiene tests) + smoke-matrix doc merge | 11/11 green on bdd9885 (historical) |
| #62 | `527e0d8` | `6cc1d62` | **the release PR**: version 1.0.11-beta on all six surfaces + CHANGELOG + What's-New | CI 38324485674 + Release 38324489730 (§6/§7) |
| #63 | `7d141a6` | `8ffe24d` | readiness report round 7 (previous generation of this file) | docs-only |
| #64 | `36e7b63` | `e2bcdc4` | readiness close-out addendum + smoke-matrix doc (the current tip) | **11/11 green on e2bcdc4 (§6, observed now)** |
| #65 (OPEN) | `3e9ece4` | — | verifier tamper-case-11 pin: a hard integrity verdict cannot retry itself into a pass (tests only) | open at finalization; not merged, not part of this audit's tip |

Every head SHA of the merged PRs (#55–#64) proven an ancestor of `origin/main` by local
`git merge-base --is-ancestor` (observed now) — no merged PR's content is missing from the
integrated tree; open PR #65 is intentionally not an ancestor yet. #56/#57 and #58/#59 required
parallel-collision reconciliations before merge; those resolutions are historical and recorded in
this file's git history (at `e2bcdc4^` and earlier).

## 5. Version manifest coherence (observed now)

`npm run validate:versions` on the tip tree (executed locally during the audit window; the same
command is CI's `Version consistency` job, green on the same SHA):

```
canonical build version: 1.0.11-beta  (package.json:version)

package.json               .version                               1.0.11-beta    source
package-lock.json          .version                               1.0.11-beta    ok
package-lock.json          .packages[""].version                  1.0.11-beta    ok
src-tauri/Cargo.toml       [package] version                      1.0.11-beta    ok
src-tauri/Cargo.lock       [[package] name="fress"] version       1.0.11-beta    ok
src-tauri/tauri.conf.json  .version                               1.0.11-beta    ok

validate:versions PASSED — 6 authoritative field(s) agree on 1.0.11-beta.
```

Release-mode binding ran in the pipeline itself: the Release run's `version` job executed
`npm run validate:versions -- --release-tag v1.0.11-beta` on the tag push and succeeded before any
platform build started (run 38324489730, job `version`). The validator's deliberate non-check (a
development version may run ahead of the *published* release) is currently vacuous on `main` because
no post-release development bump has begun (§2). Android version metadata: no checked-in Android
manifest exists in this checkout (`src-tauri/gen/` absent); the validator treats the two optional
Android surfaces (`tauri.conf.json .bundle.android.versionName`, generated Gradle `versionName`) as
authoritative-when-present — both absent here, nothing to check, by design.

## 6. CI results by workflow/job and exact tested SHA (observed now)

**On the current tip `e2bcdc4`** — 11/11 check-runs SUCCESS (check-runs API for that SHA):

| Check | Result | Run |
| --- | --- | --- |
| CI — Version consistency (`npm run validate:versions`) | success | 38330387114 |
| CI — Typecheck, tests, catalog, security, build | success — unit suite **620 passed / 2 skipped** (read from the job log; matches a local run on the same tree during this audit) | 38330387114 |
| CI — E2E + visual (linux) | success — **105 passed** (read from the job log) | 38330387114 |
| CI — Rust fmt, clippy, tests (linux) | success | 38330387114 |
| CI — Rust tests (windows-latest) | success | 38330387114 |
| CI — Rust tests (macos-latest) | success | 38330387114 |
| CI — Release-artifact verifier tests | success | 38330387114 |
| CI — Perf invariants (linux) | success | 38330387114 |
| Integration snapshot — **Artifact-integrity audit (newest release)** | success — re-downloaded every v1.0.11-beta asset and re-ran the production verifier: "FINAL ARTIFACT AUDIT PASSED at 2026-10-13T01:04:51Z" (verbatim from the job log) | 38330387106 |
| Integration snapshot (public evidence) | success | 38330387106 |
| Author guard | success | 38330387115 |

**On the release source `6cc1d62`** — the release train (all runs on that exact SHA):

| Workflow | Run | Result |
| --- | --- | --- |
| CI (all gates incl. unit 605/2skip and E2E 92/92 at that SHA — **historical**, superseded on the tip by the 620/105 numbers above) | 38324485674 | success |
| Security scan | 38324485632 | success |
| Author guard | 38324485705 | success |
| Integration snapshot | 38324485708 | success |
| **Release** — 12/12 jobs: version, create-release, build-windows, build-windows-arm64, build-linux, build-macos-arm, build-macos-intel, build-android, updater-manifest, checksums, verify-release, virustotal | **38324489730** | **success** |

Ordering facts relevant to trust (from release.yml as it ran): tag/version validation completed
before any platform build; publication (`--draft=false`) is the last step of `verify-release` and
happens only after the required-asset check, the bidirectional checksum re-hash and the final
artifact audit all pass on bytes freshly downloaded from the release; `updater-manifest` assembles
latest.json from the final `.sig` files and runs before the checksum pass so latest.json itself is
checksummed.

## 7. Published release asset audit — v1.0.11-beta (independently reproduced, observed now)

This audit did **not** copy the pipeline's numbers: it re-downloaded all 22 assets fresh from the
release URLs (2026-10-13T04:58–05:00Z), verified every file's byte size against the API manifest
(22/22 exact, zero missing, zero extra), and executed the repository's production verifier
(`python3 scripts/ci/verify-release-artifacts.py <assets-dir> v1.0.11-beta 1.0.11-beta
WasewaseX/Fress`) on those exact bytes. Result: **exit 0, PASS at 2026-10-13T04:59:40Z**:

- **SHA256SUMS.txt: 21 entries**, every asset re-hashed and compared — **zero mismatches**, no
  unlisted asset, no self-reference (the manifest correctly excludes itself), no duplicated mapping.
  Independent spot re-hash (`sha256sum`) of `Fress_1.0.11-beta_x64-setup.exe` and
  `Fress_1.0.11-beta_universal.apk` matched the manifest lines byte-for-byte.
- **latest.json**: `version='1.0.11-beta'`, `pub_date='2026-10-12T23:53:29Z'` (the release's
  `created_at` — deterministic by design, not a wall clock), **8 platform entries**
  (`windows-x86_64`, `windows-x86_64-nsis`, `windows-aarch64`, `windows-aarch64-nsis`,
  `linux-x86_64`, `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`) resolving to
  **5 distinct assets**; every URL is this tag's versioned download URL; every embedded signature
  equals its `<asset>.sig` sidecar bytes.
- **5/5 updater sidecars verify cryptographically** over the exact published bytes against the
  production minisign key embedded in `src-tauri/tauri.conf.json` (the verifier self-tests against
  RFC 8032 vectors and the app's own signer fixture first):
  `Fress_1.0.11-beta_x64-setup.exe`, `Fress_1.0.11-beta_arm64-setup.exe`,
  `Fress_1.0.11-beta_amd64.AppImage`, `Fress_1.0.11-beta_amd64.deb`,
  `Fress-1.0.11-beta-1.x86_64.rpm`.
- **Unsigned classes (10 assets), consistent with the honest matrix** — no sidecars, not advertised
  as in-app-updatable, official-Releases-page fallback only: both `.dmg` files, all five `.apk`
  files, the `.msi`, both `-portable.zip` files.
- **Asset inventory provenance**: all 22 assets are pipeline-uploaded artifacts; GitHub-generated
  source archives are NOT part of the release's asset inventory (the releases API `assets` list
  counts uploads only) — the 22/21/8/5 figures therefore refer to uploaded files exclusively.
- **The pipeline's own audits agree** (historical, verbatim from run 38324489730):
  `verify-release` job: "FINAL ARTIFACT AUDIT PASSED at 2026-10-13T00:08:09Z - manifests match the
  exact bytes about to be published" → "All required artifacts present, all hashes match, final
  audit passed. Publishing." And the Integration snapshot re-audit on the tip:
  "FINAL ARTIFACT AUDIT PASSED at 2026-10-13T01:04:51Z" (§6). Three independent executions of the
  same verifier (release gate, snapshot on tip, this audit's local run) produced the same verdict on
  the same bytes.
- **VirusTotal overlay: SKIPPED on this release** — verbatim from the `virustotal` job log:
  "::notice::VirusTotal scan skipped - VIRUSTOTAL_API_KEY is not configured. Informational only; the
  SHA256SUMS.txt + signature audit remains the integrity gate." (On v1.0.9 the key was configured —
  historical. The change of state is recorded, not hidden; see §11 item 5.)
- **No published artifact was overwritten or regenerated** by this audit: the reproduction was
  read-only (download + verify), and release.yml's design forbids re-upload of already-published
  artifacts outside the gated pipeline.

## 8. Download-to-open contract — mocked, native and device evidence kept apart

Implemented on `6cc1d62` and unchanged on the tip (§3: `src/lib/artifactOpen.ts`,
`src/lib/downloads.tsx`, `src/components/DownloadManager.tsx`, `src-tauri/src/artifact_open.rs`):

1. **Uniform boundary**: every completed artifact is handed to `plugin:opener|open_path` with the
   exact completed path and the OS-default handler first. The OS association stays the authority;
   Gatekeeper/UAC/package-manager checks are never bypassed.
2. **One fallback, below the boundary**: only when `open_path` rejects, only for a `.AppImage`
   target, and only where the launcher exists (Linux, non-Android), the frontend retries with
   `launch_app_image_artifact` — which natively re-validates against the engine's completion record
   (claimed id binding, exact committed path, canonical location, size; staging `.part`/`.sig`
   shapes, `..` traversal and symlinks refused by construction), sets the execute bit on that
   validated file only, and spawns it directly (argv, no shell), reaped in the background.
3. **Typed failures**: rejections are classified (not-found / not-a-file / symlink / not-registered /
   id-mismatch / replaced / unsupported / internal), surfaced with a localized reason and a
   retryable action; nothing launches automatically, and a refused open never mutates the row state.
4. **Single-launch guard**: a synchronous check-then-set busy store makes a repeat activation while
   one launch is pending a silent no-op; the row announces `aria-busy` while the control stays
   interactive.

Evidence classes — strictly separated:

- **Mocked E2E (CI, real browsers, tip `e2bcdc4`)**: part of the 105-passing suite — Workflow K
  (22 tests) on the unified bridge recording every `(boundary, id, path, with)` tuple, plus
  Workflow D2 (13 tests) for state-gating/listener hygiene. **These prove the frontend→native
  request contract, not OS behavior.**
- **Native unit tests (CI, real Rust on linux/windows/macOS)**: the launcher's validation gates
  (registry binding, staging shapes, traversal, canonical stability, size) are covered by in-crate
  Rust tests executed on all three CI platforms (§6).
- **Real OS handoff: NOT PERFORMED.** No Windows installer double-click, Linux desktop AppImage
  launch, macOS Gatekeeper flow, or Android device test was executed in this round. The manual
  smoke matrix (docs/testing/download-open-smoke.md) exists to record those results when run; its
  rows are **pending**, not passed.
- **Android APK opening**: intentionally NOT implemented (the private-storage FileProvider
  `content://` handoff to the system package installer belongs to the Android adapter's own round,
  below the same boundary). Until it lands, Android keeps the uniform pass-through and the typed
  "unsupported/refused" honesty — a named limit, not a regression.

## 9. Frontend accessibility / visual verification

- **Current, on the tip (CI, observed now)**: the `E2E + visual (linux)` job passed with 105 tests,
  which includes the visual-regression and theme specs alongside the journey suites (§6).
- **Pinned contrast/a11y gates** (historical, still enforced by the suite on every run): dark-theme
  primary controls hold WCAG AA, light-theme selection rows read on their own surface, label-in-name
  checks for the SHA copy control, focus-restore and keyboard-scrollability gates — introduced and
  measured in the v1.0.10-beta contrast round (46 harness tests / 67 screenshots across both themes
  at every supported width), merged during that cycle (PRs #51–#54; historical, in this file's git
  history and the changelog).
- **No new a11y/visual audit was performed this round** beyond the CI suite results above; the
  round-5/6 screenshot evidence remains historical and is not recomputed here.

## 10. Branch protection, manual testing and other externally controlled settings

- **Branch protection: NOT OBSERVABLE.** The repository Settings → Branch rules are outside this
  token's permission scope; whether the required checks are *enforced* on `main` cannot be proven
  from here and is deliberately not claimed. (What IS observable: all listed checks ran and passed
  on every SHA cited in §6 — including direct pushes to `main` — which is consistent with either
  enforcement-with-passing-checks or no enforcement; only a maintainer can distinguish.)
- **Physical smoke matrix: NOT PERFORMED** (§8). No manual platform test is claimed anywhere in
  this report.
- **Secrets hygiene**: no secret material appears in this report or in any repo file; this audit
  used a read-scoped token over the API and quoted only job-log *verdict lines*, never payloads.
  The historical secret-scrub rounds (round 26-b, PAT-rotation runbook) remain recorded in this
  file's git history; the rotation itself is still a pending owner action (§11).
- **VirusTotal key absence** on v1.0.11-beta is an observed configuration state (§7), not a verdict
  about the artifacts.
- **Signing configuration** (Windows Authenticode absent, Apple credentials absent, Android
  persistent keystore present and fingerprint-guarded): unchanged from the user-facing docs'
  claims; verified operationally by release run 38324489730 (unsigned-fallback steps for
  Windows/macOS ran as designed, Android's "Require the persistent signing keystore" gate passed,
  build-android 12/12 SUCCESS — historical, verbatim logs in the run).

## 11. Outstanding actions — owners and objective completion conditions

1. **Android installer handoff round** (Android adapter owner): implement the FileProvider
   `content://` handoff, `application/vnd.android.package-archive` MIME, temporary read grant —
   then the on-device rows of the smoke matrix. *Done when*: the handoff ships behind the same
   typed-failure boundary AND each Android row of `docs/testing/download-open-smoke.md` records a
   real device result with OS version, or is explicitly waived by the maintainer.
2. **Physical smoke-matrix execution** (platform owners): the Windows (exe/msi/portable), Linux
   (AppImage launch on stock GNOME/KDE, deb/rpm handlers) and macOS (dmg + Gatekeeper first launch)
   rows of `docs/testing/download-open-smoke.md`. *Done when*: each row records the OS version it
   was executed on, or the maintainer waives it in writing.
3. **Branch-protection verification** (maintainer, one minute): observe Settings → Branches for
   `main` and state the result here (or enable enforcement). *Done when*: this section cites
   observed settings instead of "not observable".
4. **User-facing docs currency vs v1.0.11-beta** (docs owner — Agent 4's file set, NOT this file):
   README.md carries 4 `v1.0.9-beta` strings and CODE_SIGNING.md 22 (its per-artifact matrix is
   explicitly scoped to the v1.0.9 audit). *Done when*: the docs owner re-anchors the per-artifact
   matrix to the newest release's bytes (this audit's §7 reproduction provides the numbers) or
   extends the explicit version-scoping statement to name v1.0.11-beta as the current release.
5. **VirusTotal decision** (maintainer): either configure `VIRUSTOTAL_API_KEY` so the overlay scans
   and attaches links to the release page, or record the decision that SHA256SUMS.txt + minisign
   signatures are the permanent integrity boundary. *Done when*: the release page shows VT links,
   or the decision is recorded here and in quality-gates.
6. **PAT rotation** (user browser step; runbook unchanged): `download/pat-rotation-steps.txt` +
   `scripts/apply_new_pat.sh` (verifies the new token before swapping; never prints it). *Done
   when*: the new token is active and this item is removed.
7. **Next development bump** (release owner, when work resumes): the tip is still at the published
   version with no unreleased-changes section in CHANGELOG.md — correct today. *Trigger*: the first
   post-release feature PR should add the explicit next-development heading per CHANGELOG.md's
   convention; until then, no pretend "Unreleased" heading is created.

## 12. Audit method (reproduce these results)

- **State capture** (2026-10-13T05:00–05:10Z): GitHub REST API v3 — `/repos/WasewaseX/Fress`,
  `/releases/tags/v1.0.11-beta`, `/pulls?state=open`, search `/search/issues?q=type:pr+state:closed`,
  `/actions/runs?head_sha=<sha>`, `/actions/runs/{id}/jobs`, `/commits/{sha}/check-runs`,
  `/actions/runs/{id}/logs` (job logs for count extraction and verbatim verdict lines).
- **Git forensics**: fresh `git fetch origin --prune --tags`; `git rev-parse origin/main` and
  `v1.0.11-beta^{commit}`; `git diff --stat` / `--name-only` (full and path-filtered) between the
  tag and the tip; `git merge-base --is-ancestor` for every SHA in §3/§4.
- **Independent byte audit** (§7): `curl` all 22 `browser_download_url`s fresh; byte-size compare
  against the API manifest; `python3 scripts/ci/verify-release-artifacts.py <dir> v1.0.11-beta
  1.0.11-beta WasewaseX/Fress` → exit 0; independent `sha256sum` spot re-hashes.
- **Local pipeline on the tip**: `npm run validate:versions` (§5 verbatim); `npm test` →
  620 passed / 2 skipped (matches CI on the same SHA); typecheck clean.
- **What this audit did NOT do**: execute any OS-level open/install on real hardware; observe
  branch-protection settings; re-audit releases older than v1.0.11-beta (historical records kept in
  git history); and it treats no CI result as evidence for a SHA other than the one it ran on.
