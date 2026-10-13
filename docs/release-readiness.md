# Fress release readiness — public-main integration audit (round 7)

Status: **public main is integration-ready at the evidence level reachable without physical devices;
v1.0.11-beta published from the exact default-branch tip and its bytes independently audited PASS;
zero open PRs; the known limits below are named, not hidden.**
Audit time: **2026-10-13T00:11:00Z** (all evidence gathered fresh at execution time, 2026-10-13 00:00–00:11 UTC).
Auditor: integration lead (round 7 mandate: "bring the public-main integration-readiness report to an
evidence-backed 10/10 standard"). This file is owned exclusively by the integration auditor; application
code, manifests, workflows and other docs were not edited for this report.

**Commits under audit vs. publishing commit:** every code claim below is anchored to
`main = 6cc1d62` (`6cc1d62a1fb5…`, the merge of PR #62 — the v1.0.11-beta release commit).
This report itself is published by a later docs-only commit on top of it; the two are named in
the PR that carries this file.

---

## 1. Current verdict

- **Default branch `main` = `6cc1d62a1fb5`**, source version **1.0.11-beta**, tag **`v1.0.11-beta`
  → the same commit** — the published release was cut from the exact audited tip, with no
  post-release source delta.
- **v1.0.11-beta is published** (2026-10-13T00:08:10Z, prerelease, id 411086191, 22 assets) and its
  release run (38324489730) completed **12/12 jobs SUCCESS**, ending in the final-artifact audit
  PASS over the exact published bytes (§6).
- **Verdict: integration-ready.** Every automated gate that exists is green on the audited SHA, the
  release chain is self-auditing, and the newest functional round (download → open) is proven at the
  frontend/native boundary by 22 new E2E tests. What keeps this from being an unconditional 10/10 is
  stated in §8/§9: physical-device validation of the open journey has **NOT RUN** on any platform,
  the Android installer handoff is intentionally scoped to a future adapter round, and
  branch-protection enforcement could not be observed (§8).

## 2. Default-branch identity

| Field | Value | Evidence |
| --- | --- | --- |
| Default branch | `main` (confirmed via GitHub API, not assumed) | `GET /repos/WasewaseX/Fress` → `default_branch: main` |
| Current tip | `6cc1d62a1fb5` — "Merge PR #62: v1.0.11-beta - the open-contract release" | branch API + local `git fetch` |
| Source version | 1.0.11-beta in all five authoritative surfaces | `npm run validate:versions` → "6 authoritative field(s) agree on 1.0.11-beta" (run locally on `6cc1d62` and in CI) |
| Newest published release | v1.0.11-beta, id 411086191, published 2026-10-13T00:08:10Z, prerelease | releases API |
| Tag → tip relationship | `v1.0.11-beta` target SHA **equals** the tip SHA (`git rev-parse` of both → one object; `merge-base --is-ancestor` trivially true) | local git after fetch |
| Prior releases | v1.0.10-beta (id 410951185, 2026-10-12T20:09Z, 22 assets, tag → `a176e74`, an ancestor of the tip), v1.0.9-beta (id 410656481, tag → `20c2259`, ancestor) | releases + tags API, ancestry proven locally |
| Development vs published | The tag `v1.0.11-beta` IS the tip, so there is currently **no unreleased version delta**: `package.json` = published version. This is the normal post-release instant; the next development bump will legitimately run ahead (the validator's documented non-check). | this audit |

## 3. PR reconciliation (actual state: zero open)

Open PRs at audit time: **none** (pulls API `state=open` → empty). Recent-round dispositions, every
head SHA proven an ancestor of `6cc1d62` by local `git merge-base --is-ancestor` (not by PR title):

| PR | Branch | Head SHA | Merged (merge commit) | Content |
| --- | --- | --- | --- | --- |
| #55 | docs/release-download-truth | `dc2d8a4` | `91c5e00` | docs truth pass on real release bytes (README + CODE_SIGNING): per-artifact signing matrix, Gatekeeper/Android install notes, honest "Unknown publisher" explanation |
| #56 | agent2/version-coherence | `7ff0d20` | `6a3aa23` | `validate:versions` — one authoritative version-coherence validator (TS, 698 lines) + 22-test suite; anchored grammar mirrors the updater's parser; `--release-tag` binding mode; documented deliberate non-checks |
| #57 | quality/ci-release-gates | `65d7214` | `1ccc96e` | pipeline wiring of the validator into `ci.yml` + `release.yml` (flag adapted to `--release-tag`), release-artifact verifier hardening (duplicate-JSON-key refusal, platform→asset shape contract, named-error manifest loading) + 20-test verifier suite, VirusTotal skip labeling, quality-gates runbook rewrite; follow-up commit added the Integration snapshot workflow and publication-boundary contract |
| #58 | quality/download-open-verification | `c5c4d11` | `4cffefa` | Workflow K: 22 E2E tests proving the download-to-open journey; unified test bridge recording every `(boundary, id, path, with)` tuple; opener-level fault/hold gates; platform smoke matrix doc (`docs/testing/download-open-smoke.md`) |
| #59 | quality/download-open-flow | `03d7007` | `1f4cde0` | the desktop open contract (rewritten round): uniform `open_path` pass-through with the exact completed path, registry-validated AppImage launcher (`launch_app_image_artifact`), typed failure classification, synchronous single-launch guard |
| #62 | release/1.0.11-beta | `527e0d8` | `6cc1d62` | version bump (5 surfaces) + CHANGELOG + What's-New entry |

Integration notes (recorded because they changed PR content before merge):

- **#56/#57 parallel collision**: both rounds shipped a `validate:versions` implementation ~30 minutes
  apart. Reconciliation kept Agent 2's TS validator (anchored SemVer with leading-zero rejection,
  table-aware TOML parsing, 22-test suite) as the single rules file and reduced #57 to its genuine
  contribution — the wiring, the verifier hardening and the runbook. The duplicate `.mjs`
  implementation and its test were deleted; `--expect-tag` was renamed to the kept implementation's
  `--release-tag`; `npm ci` was added to the two workflow jobs that invoke the tsx-based validator.
- **#58/#59 parallel collision, resolved twice**: Agent 6's E2E suite was first aligned to Agent 5's
  original contract (confirm-dialog two-step), then Agent 5 rewrote their PR to the refined ownership
  split (Android native adaptation moves to the Android adapter owner; the desktop contract is a
  uniform `open_path` pass-through with one AppImage fallback). The second reconciliation restored the
  single-click contract, unpinned K-G1 (the single-launch guard it pinned shipped in the rewrite),
  reverted the confirm-step flows, and added K-I2 — the AppImage fallback proven end to end. Every
  resolution is a named commit on the PR branches; nothing was silently rewritten.
- **#59 Rust CI failures** (fmt drift on linux; `E0283` type-annotation failure in the then-included
  Tauri plugin crate on win/mac) were fixed on the branch during the first integration pass
  (`cargo fmt` + explicit `Artifacts::<R>`); the subsequent rewrite deleted that crate entirely and
  the fmt-canonical layout was re-established and CI-proven (`Rust fmt, clippy, tests` green on
  linux, windows, macOS for head `03d7007`).
- **Author identity**: several agent-produced commits originally carried `Z User <z@container>`;
  the authors-guard workflow failed them until every commit on every merged branch was re-attributed
  to `WasewaseX <WasewaseX@users.noreply.github.com>` (verified by the green Author guard runs on
  each merged head).

Historical rounds (round 5's full disposition table for #38–#47, the round-6/27 visual-acceptance
rounds, and the v1.0.9/v1.0.10 release audits) remain available, clearly dated, in this file's git
history (e.g. at `a176e74` for the round-5/6 text) — they are intentionally not duplicated here and
are not used to compute this verdict.

## 4. Version/manifest consistency (the authoritative matrix, executed)

`npm run validate:versions` on the audited tree (also green in CI's `version-guard` job on the same SHA):

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

Release-mode binding was enforced by the pipeline itself: the Release run's `version` job executed
`npm run validate:versions -- --release-tag v1.0.11-beta` on the tag push and succeeded — the tag,
the manifests and the lockfiles are one version. The validator's documented non-check (a development
version may legitimately run ahead of the *published* release) is currently vacuous on `main`
because the tag and tip coincide (§2).

## 5. Required CI gates on the audited SHA

All runs below executed on `6cc1d62a1fb5` (the release merge) — no gate result is borrowed from an
older SHA:

| Workflow | Run | Result | URL |
| --- | --- | --- | --- |
| CI (version-guard, frontend: typecheck+tests+catalog+security+build, Rust fmt/clippy/tests linux, Rust tests windows, Rust tests macOS, E2E+visual linux, perf invariants) | 38324485674 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38324485674 |
| Author guard | 38324485705 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38324485705 |
| Security scan | 38324485632 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38324485632 |
| Integration snapshot | 38324485708 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38324485708 |

Counts behind the green CI (executed locally on the same tree during this round, matching CI):
unit suite **605 passed / 2 skipped** (the two skips are opt-in), full E2E **92/92** across 11 spec
files, `tsc --noEmit` clean, production build OK, `cargo fmt --check` clean.

## 6. Latest published asset audit (v1.0.11-beta)

From release run **38324489730** (completed success, 12/12 jobs — the run URL is the evidence):

- **22 release files**; `SHA256SUMS.txt` covers **21 entries**; the audit re-hashed **every asset**
  and compared against the manifest — zero mismatches.
- **latest.json**: `version='1.0.11-beta'`, **8 platform entries** (`windows-x86_64`,
  `windows-x86_64-nsis`, `windows-aarch64`, `windows-aarch64-nsis`, `linux-x86_64`,
  `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`), each URL cross-checked against
  this tag's assets and each embedded signature compared byte-for-byte against the `<asset>.sig`
  sidecar on the release.
- **Signatures verified over the exact published bytes** (5 sidecars):
  `Fress-1.0.11-beta-1.x86_64.rpm`, `Fress_1.0.11-beta_amd64.AppImage`,
  `Fress_1.0.11-beta_amd64.deb`, `Fress_1.0.11-beta_arm64-setup.exe`,
  `Fress_1.0.11-beta_x64-setup.exe`.
- Audit line, verbatim from the job log: **"FINAL ARTIFACT AUDIT PASSED at 2026-10-13T00:08:09Z -
  manifests match the exact bytes about to be published"** — followed by "Publishing." (the release
  is built as a private draft and only the audit's success publishes it).
- Unsigned classes (not advertised as in-app updates, so the audit requires their absence from the
  manifest): macOS dmgs, Android APKs, the MSI and portable zips. The honest-matrix refusal in the
  verifier now also rejects a platform key whose asset does not match the key's OS shape, and treats
  duplicate JSON keys in latest.json as a hard error.
- build-android succeeded again with the rotated keystore pair; the Android signing certificate
  fingerprint guard passed (in-place update compatibility preserved — see the rotation record in this
  file's history at `a176e74`).

## 7. Download-to-open functionality — implemented contract and evidence classes

Implemented on `6cc1d62` (src/lib/artifactOpen.ts, src/lib/downloads.tsx, src/components/DownloadManager.tsx,
src-tauri/src/artifact_open.rs):

1. **Uniform boundary**: every completed artifact is handed to `plugin:opener|open_path` with the
   exact completed path and the OS-default handler first. The OS association stays the authority;
   Gatekeeper/UAC/package-manager checks are never bypassed.
2. **One fallback, below the boundary**: only when `open_path` rejects, only for a `.AppImage` target,
   and only where the launcher exists (Linux, non-Android), the frontend retries with
   `launch_app_image_artifact` — which natively re-validates against the engine's completion record
   (claimed id binding, exact committed path, canonical location, size; staging `.part`/`.sig` shapes,
   `..` traversal and symlinks refused by construction), sets the execute bit on that validated file
   only, and spawns it directly (argv, no shell), reaped in the background.
3. **Typed failures**: rejections are classified (not-found / not-a-file / symlink / not-registered /
   id-mismatch / replaced / unsupported / internal), surfaced with a localized reason and a
   retryable action; nothing launches automatically, and a refused open never mutates the row state.
4. **Single-launch guard**: a synchronous check-then-set busy store makes a repeat activation while
   one launch is pending a silent no-op (no second native call, no toast); the row announces
   `aria-busy` while the control stays interactive.

Evidence classes — kept strictly apart per the audit rules:

- **Mocked E2E (CI, real browsers)**: 22 Workflow-K tests on the unified bridge record every
  `(boundary, id, path, with)` tuple — per-row exactness across two concurrent downloads, keyboard
  activation counts, hostile filenames as single values, reveal + containing-folder fallback, honest
  rejection paths, the AppImage fallback's `(id, path)` fidelity, and the no-stack guard. **These
  prove the frontend→native request contract, not OS behavior.**
- **Native unit tests (CI, real Rust on linux/windows/macOS)**: the launcher's validation gates
  (registry binding, staging shapes, traversal, canonical stability, size) are covered by the in-crate
  Rust tests executed on all three CI platforms.
- **Real OS handoff: NOT RUN.** No Windows installer double-click, Linux desktop AppImage launch,
  macOS Gatekeeper flow, or Android device test was executed in this round. The manual smoke matrix
  (docs/testing/download-open-smoke.md) exists precisely to record those results when they are run;
  every row of it should currently be read as "pending".
- **Android APK opening**: intentionally NOT implemented in this round (the private-storage
  FileProvider content-URI handoff to the system package installer belongs to the Android adapter's
  own round, below the same boundary). Until it lands, Android keeps the uniform pass-through and the
  typed "unsupported/refused" honesty. This is a named limit, not a regression: the previous
  plugin-based Android attempt was deliberately removed with the rewrite.

## 8. Security, signing and platform limits (observable facts + honest unknowns)

- **Updater signatures**: the five signed classes listed in §6 are minisign-verified over the exact
  published bytes by the release audit, and the in-app updater verifies against the key embedded in
  the binary before calling any update "verified".
- **Windows Authenticode: still absent** (documented in CODE_SIGNING.md with the free routes);
  Windows shows "Unknown publisher" — the README now says so explicitly instead of hedging.
- **Android signing**: all releases are signed with the same project key (certificate fingerprint
  guarded in CI); the keystore-password rotation of round 26-b is historical fact recorded in this
  file's history — the current run is further CI proof the rotated pair works (12/12).
- **Branch protection: UNVERIFIED.** The repository's Settings → Branch rules are not observable with
  the integration token's permission scope; whether the required checks are *enforced* (as opposed to
  merely existing and passing) cannot be proven from here and is deliberately not claimed.
- **Signing secrets**: no secret material is quoted in this report or in any repo file (the round-5
  literal-scrub remains in force; PR #55's docs pass re-verified the user-facing docs against bytes).
- **Known unknowns**: physical execution of the smoke matrix (§7); VirusTotal scanning (the job runs
  only when a key is configured; its skip is labeled informational on the release page).

## 9. Owner-only actions and remaining blockers

1. **Android installer handoff round** (Android adapter owner): FileProvider `content://` handoff,
   `application/vnd.android.package-archive` MIME to the system installer, temporary read grant —
   then the on-device rows of the smoke matrix. Until then the Android "Open" story is the uniform
   boundary + honest typed refusal.
2. **Physical smoke matrix execution** (platform owners): the rows in docs/testing/download-open-smoke.md
   for Windows (exe/msi/portable), Linux (AppImage launch on stock GNOME/KDE, deb/rpm handlers),
   macOS (dmg + Gatekeeper first launch). A mock cannot establish these; record each row with the
   OS version it was run on, or leave it honestly pending.
3. **Branch-protection verification** (maintainer, one minute): confirm Settings → Branches enforces
   the required checks on `main`; until observed, this report records it as unverified rather than
   claiming it.
4. **PAT rotation** (user browser step, unchanged from round 26-b): download/pat-rotation-steps.txt +
   scripts/apply_new_pat.sh (verifies the new token before swapping; never prints it).
5. Nothing else is blocking the next development cycle: the version guard, the artifact audit and the
   journey suite all gate it automatically.

## 10. Audit method (reproduce these results)

- **State capture**: GitHub REST API v3 (`/repos/WasewaseX/Fress`, `/branches/main`, `/releases`,
  `/pulls?state=open`, `/pulls?state=closed`, `/actions/runs`, `/actions/runs/{id}/jobs`,
  `/commits/{sha}/check-runs`) with a read-scoped token; job logs fetched per failing-or-relevant job.
- **Ancestry proofs**: fresh `git fetch --all --prune --tags`, then
  `git merge-base --is-ancestor <pr-head-sha> origin/main` per PR (§3 table), and
  `git rev-parse v1.0.11-beta origin/main` for the tag→tip identity (§2).
- **Version matrix**: `npm run validate:versions` (and `-- --release-tag v1.0.11-beta` semantics as
  executed by the Release run's `version` job).
- **Local pipeline on the audited tree**: `npm run typecheck`; `npm test`; `npm run build`;
  `npx playwright test` (92/92); `cargo fmt --check` in src-tauri.
- **Release evidence**: Release run 38324489730 jobs/log (verbatim audit lines in §6) and the
  releases API for asset counts and timestamps.
- **What this audit did NOT do**: execute any OS-level open/install on real hardware; observe branch
  settings; and it treats no CI result as evidence for a SHA other than the one it ran on.
