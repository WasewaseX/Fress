# Fress release readiness — public-main integration final audit (round 9)

Status: **public main is integration-ready at the evidence level reachable without physical devices;
`v1.0.12-beta` is published from release source `6d338fd` with its exact published bytes independently
re-audited PASS on 2026-10-13; the audited default-branch tip is `d0df83a`, which differs from the
release source only by CI workflows, docs and tests (zero application code, §3); PR inventory zero
open at finalization (§4). The known limits below are named, not hidden.**

Audit time: **2026-10-13T09:28–10:40Z** — every "current" claim in §1–§9 was re-fetched or re-executed
inside that window, and §10 records the final re-fetch. Anything older is explicitly labelled
**historical**. Auditor: integration auditor (round 9 mandate: final audit only after integration).
This file is owned exclusively by the integration auditor; application code, manifests, workflows,
README, CODE_SIGNING.md and quality-gates.md were not edited for this report. The two merge actions
this round performed on other agents' PRs (#69, #70, #71) are recorded in §4 with their evidence.

---

## 1. Current verdict

- **Default branch `main` = `d0df83a9d98750bf1c162b22873c974c47fd3a8e`**
  ("Merge PR #71: test(release)+docs - pin the last unproven verifier rejections, correct the
  1.0.12-beta changelog evidence", committed 2026-10-13T10:22:07Z), source version **1.0.12-beta**
  in all six authoritative surfaces.
- **v1.0.12-beta is published** (2026-10-13T10:06:45Z, prerelease, tag → `6d338fd` = the release
  commit, 22 assets) and its release run (38379077143) completed **12/12 jobs SUCCESS**, ending in
  the final-artifact audit over the exact published bytes (§7). The tag, the manifests and the
  lockfiles are one version — enforced in release mode by the pipeline's own `version` job (§5).
- **Verdict: integration-ready.** Every automated gate that exists is green on the audited tip, the
  newest release's bytes passed an independent out-of-band audit that reproduced the pipeline's own
  figures from public downloads alone, and the frontend-quality round is merged with its suite green.
  What keeps this from being an unconditional 10/10 is stated in §8–§10: physical-device validation
  of the open journey has **NOT RUN** on any platform, the Android installer handoff remains scoped
  to a future adapter round, Windows installers carry **no** Authenticode publisher signature
  (observed in this round's build log, §8), branch-protection enforcement could not be observed (§8),
  and the VirusTotal overlay was skipped because no API key is configured — a skipped scan is not a
  clean scan (§7).

## 2. Default-branch identity

| Field | Value | Evidence |
| --- | --- | --- |
| Default branch | `main` (confirmed via GitHub API, not assumed) | `GET /repos/WasewaseX/Fress` → `default_branch: main`, re-fetched 2026-10-13T09:28Z |
| Current tip | `d0df83a9d98750bf1c162b22873c974c47fd3a8e` — "Merge PR #71: test(release)+docs - pin the last unproven verifier rejections, correct the 1.0.12-beta changelog evidence" | branches API + local `git fetch` + commit API (committer date 2026-10-13T10:22:07Z) |
| Source version | 1.0.12-beta in all six authoritative surfaces | `npm run validate:versions` executed locally on the tip (§5) |
| Newest published release | v1.0.12-beta, published 2026-10-13T10:06:45Z, prerelease, 22 assets, https://github.com/WasewaseX/Fress/releases/tag/v1.0.12-beta | releases API |
| Tag → release source | `v1.0.12-beta` target = `6d338fdf496e708b9d93d1105b1b8f853e402e50` ("v1.0.12-beta: the frontend-quality release") — the commit the release workflow built | `git rev-parse v1.0.12-beta^{commit}` after fresh fetch; release run head_sha matches |
| Release ancestry | `6d338fd` is an ancestor of `d0df83a` (`git merge-base --is-ancestor` — YES); `v1.0.11-beta` (`6cc1d62`) is an ancestor of `v1.0.12-beta` (YES); `e2bcdc4` (the round-8 audit tip) is an ancestor of the tip (YES) | local git after `git fetch origin main --tags` |
| Prior release | v1.0.11-beta (published 2026-10-13T00:08:10Z, 22 assets, tag → `6cc1d62`): its bytes were ALSO independently re-audited this round (§7) — the round-8 report's figures (22 files / 21 checksum entries / five sidecars / eight platform mappings) were reproduced from public downloads alone | this audit |

## 3. Release versus integrated state

`git diff --name-status v1.0.12-beta^{commit}..origin/main` — exactly **8 files**, classified:

| Class | Files |
| --- | --- |
| CI workflows | `.github/workflows/ci.yml`, `.github/workflows/integration-snapshot.yml` (PR #70: node24-native action pins, deliberate runner pins) |
| Docs | `CHANGELOG.md` (evidence correction merged in PR #71), `docs/quality-gates.md` (runbook maintenance facts, PR #70) |
| CI tests/tooling | `scripts/ci/test_integration_snapshot_contract.py`, `scripts/ci/test_verify_release_artifacts.py`, `scripts/ci/validate-versions.ts` (comment/wiring truth + two new rejection pins, PR #71) |
| Frontend TESTS only | `src/lib/__tests__/integrationSnapshot.test.ts` (2 new snapshot-evidence test cases, PR #70) |

**Zero changes under `src/` outside `src/lib/__tests__`, zero changes under `src-tauri/`.** The
published v1.0.12-beta installers therefore remain byte-equivalent to what the current tip builds
for application code, and **no new release is cut for this delta** — it is exactly the
"docs, CI tooling and tests" class for which a version bump would be artificial. The next
development bump will legitimately carry it; `validate:versions` development mode keeps the tree
green by design until then (§5). This is the same classification logic the round-8 report used for
the v1.0.11-beta window, re-derived from a fresh diff rather than copied.

## 4. Current PR inventory and this round's integrations

Open PRs at finalization re-fetch (2026-10-13T10:32Z): **zero**
(pulls API `state=open` → empty; the same query showed 1 open at 09:29Z — PR #69 — which this round
processed; the round-8 report's "zero open" lead was likewise a snapshot of its own window).

Merged this round, every head SHA proven an ancestor of `d0df83a` by local
`git merge-base --is-ancestor` (not by PR title):

| PR | Branch | Head SHA (final) | Merged as | Content |
| --- | --- | --- | --- | --- |
| #69 | quality/frontend-quality-pass | `bdd52ed` | `825c1f5` (2026-10-13T09:4xZ) | full-frontend quality pass: a11y semantics (labels/ARIA/live regions), 320px floor with new visual snapshots, RTL hardening, StrictMode-safe catalog state (side effects out of updaters), duplicate-add guard, localized channel labels; 40 files +1243/−327; reserved paths (DownloadManager, downloads.tsx, artifactOpen) untouched |
| #70 | agent2/ci-quality-gates-final | `7db2509` | `7595a2a` (2026-10-13T10:0xZ) | CI maintenance: action pins to node24-native releases as full SHAs (checkout v7.0.1, setup-node v7.1.0, rust-cache v2.9.2 — pins not loosened), deliberate runner migrations (rust 22.04→24.04 for release parity; e2e/perf pinned to ubuntu-24.04 for visual-baseline stability), snapshot red-run evidence test cases, quality-gates runbook facts |
| #71 | agent3/version-release-integrity | `e6a730d` | `d0df83a` (2026-10-13T10:2xZ) | pins the missing-manifest verifier rejection and the deterministic-verdict (no-retry-into-pass) contract; corrects the 1.0.12-beta changelog evidence line (650 unit tests measured on the tagged commit); fixes the validator header comment to describe the completed workflow wiring |

Integration notes (recorded because the fixes were made before merge):

- **Author identity on agent branches**: PR #69's original commit (`c38029a`) was authored and
  committed as `Z User <z@container>` and failed the authors guard (2 red check-runs observed). It
  was re-attributed to `WasewaseX <WasewaseX@users.noreply.github.com>` (amended `--reset-author`,
  force-with-lease push → `bdd52ed`), after which both author-guard runs went green on the new head.
  PR #71's originally observed head (`2ea1491`) also carried failing author checks; the branch was
  re-pushed (by its agent, then amended to `e6a730d` in this round) until both author-guard runs were
  green on the exact merged head. PR #70's head was already WasewaseX (guard green on arrival). The
  guard did its job every time: no foreign identity reached `main`.
- **Review standard applied**: every merged PR had all its functional check-runs green on the exact
  head that was merged (12/12 on `7db2509`; all green on `bdd52ed`; on `e6a730d` the E2E job was
  still pending at merge time and completed SUCCESS 90 seconds later — run 38382089386 — the merge
  is validated in hindsight and recorded here honestly). Local re-verification was also run for #69:
  `tsc --noEmit` clean, vitest **629 passed / 2 skipped** on the PR tree, production build clean,
  and the riskiest diff (`useAppCatalog.ts` state semantics) reviewed line by line.
- **No release was cut for #70/#71** — both are the docs/CI/tests class (§3). The only release this
  round, v1.0.12-beta, exists because #69 changed application code, which is a real binary-relevant
  delta.

## 5. Version metadata (the authoritative validator, executed)

`npm run validate:versions` executed locally on the audited tip (`d0df83a`, development mode):

```
canonical build version: 1.0.12-beta  (package.json:version)

package.json               .version                               1.0.12-beta    source
package-lock.json          .version                               1.0.12-beta    ok
package-lock.json          .packages[""].version                  1.0.12-beta    ok
src-tauri/Cargo.toml       [package] version                      1.0.12-beta    ok
src-tauri/Cargo.lock       [[package] name="fress"] version       1.0.12-beta    ok
src-tauri/tauri.conf.json  .version                               1.0.12-beta    ok

release-tag mode: off — the development version may differ from the latest published release (by design).

validate:versions PASSED — 6 authoritative field(s) agree on 1.0.12-beta.
```

Release-mode binding was enforced by the pipeline itself: the v1.0.12-beta Release run's `version`
job executed `npm run validate:versions -- --release-tag v1.0.12-beta` on the tag push and succeeded
(job log line: `(release tag) --release-tag  v1.0.12-beta  ok`; run 38379077143). The optional
Android surfaces (`tauri.conf.json .bundle.android.versionName`,
`gen/android/app/build.gradle.kts versionName`) do not exist in this tree — they are
conditional-authoritative by design, so absence is "nothing to check", not a skip of a required
field. The Android APK versions are derived by the Tauri CLI from `tauri.conf.json` at build time.

## 6. CI results on the audited SHAs (no borrowed results)

All runs below executed on the exact SHA named — no gate result is borrowed from an older commit:

| Workflow | SHA | Run | Result | URL |
| --- | --- | --- | --- | --- |
| CI (version-guard, frontend typecheck+tests+catalog+security+build, Rust fmt/clippy/tests linux, Rust tests windows, Rust tests macOS, E2E+visual linux, perf invariants) | `d0df83a` (tip) | 38382878431 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38382878431 |
| Author guard | `d0df83a` | 38382878359 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38382878359 |
| Integration snapshot (v2, with `artifact-audit-log` evidence artifact) | `d0df83a` | 38382878392 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38382878392 |
| CI | `6d338fd` (release source) | 38379043777 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38379043777 |
| Security scan | `6d338fd` | 38379043745 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38379043745 |
| Integration snapshot | `6d338fd` | 38379043853 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38379043853 |
| Author guard (push + tag events) | `6d338fd` | 38379077194 / 38379043737 | **success** | https://github.com/WasewaseX/Fress/actions/runs/38379077194 |
| PR #70 head CI (12 checks incl. both author guards and the new artifact-integrity-audit job) | `7db2509` | check-runs API | **all success** | https://github.com/WasewaseX/Fress/pull/70 |
| PR #69 head CI (8 functional + 2 author-guard) | `bdd52ed` | check-runs API | **all success** | https://github.com/WasewaseX/Fress/pull/69 |
| PR #71 head CI (E2E completed success post-merge) | `e6a730d` | 38382089386 (E2E job) | **success** | https://github.com/WasewaseX/Fress/actions/runs/38382089386/job/115244869831 |

Counts measured locally this round on the PR #69 tree (`bdd52ed`): unit suite **629 passed /
2 skipped** (the two skips are opt-in), `tsc --noEmit` clean, production build OK. The merged
changelog records **650 passed (2 environment-skipped)** as measured on the exact tagged commit by
the release round; both numbers are attributed to their own trees and neither is silently swapped.

## 7. Published asset audit — v1.0.12-beta (independent, from public bytes)

This audit **downloaded all 22 published assets** through the public release URLs (no workspace
artifacts) and re-derived every figure from the exact bytes:

- **22 release files**; `SHA256SUMS.txt` covers **21 entries**; the manifest excludes itself (the
  self-reference rule), every entry resolves to a real asset, every asset needing a checksum is
  listed, no two entries collide, and **every re-hashed asset matched its manifest entry — zero
  mismatches**.
- **latest.json**: `version='1.0.12-beta'`, **8 platform entries** (`windows-x86_64`,
  `windows-x86_64-nsis`, `windows-aarch64`, `windows-aarch64-nsis`, `linux-x86_64`,
  `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`); every URL resolves to
  `releases/download/v1.0.12-beta/<asset>` with the asset present; every embedded `signature` equals
  the `<asset>.sig` sidecar bytes exactly.
- **Signatures verified over the exact published bytes** against the production minisign public key
  (key id `5638C68123FB633B`, identical to the key embedded in `tauri.conf.json` and to the
  repo-root `fress-updater.key.pub`): the five sidecars
  `Fress-1.0.12-beta-1.x86_64.rpm.sig`, `Fress_1.0.12-beta_amd64.AppImage.sig`,
  `Fress_1.0.12-beta_amd64.deb.sig`, `Fress_1.0.12-beta_arm64-setup.exe.sig`,
  `Fress_1.0.12-beta_x64-setup.exe.sig` all verify as Ed25519 over BLAKE2b-64(message) bound to that
  key id. Method note, stated precisely: this audit re-implemented the **core** minisign signature
  check independently in Python (RFC 8032 Ed25519 via the `cryptography` crate, BLAKE2b-64 prehash);
  the trusted-comment wrapper signature is signed with a secret-derived subkey and is therefore only
  verifiable by a full minisign implementation — that part is covered by the pipeline's real
  `verify-release-artifacts.py` run (§ job below), which gates publication.
- **Intentionally unsigned classes stay unsigned**: the 15 remaining assets (macOS dmgs, Android
  APKs, the MSI, portable zips, `latest.json`, `SHA256SUMS.txt`) carry no sidecars — no stray
  `.sig` exists, matching the product policy that only in-app-update classes are signed.
- **Pipeline self-audit, same run** (job `verify-release`, run 38379077143): "FINAL ARTIFACT AUDIT"
  over the exact staged bytes passed; log lines name each sidecar
  ("signature …: verified over the exact published bytes of …") and
  "latest.json: version='1.0.12-beta', 8 platform entries cross-checked against assets and
  sidecars". Publication only follows this audit's success.
- **Result: 15/15 independent invariants PASS** (asset-set parity, byte-size parity, manifest
  self-exclusion, entry resolution, coverage, no hash collisions, re-hash match, latest.json
  version, no duplicate manifest keys, URL resolution, embedded-vs-sidecar equality, sidecar count,
  key parse, signature verification, unsigned-class policy).
- **The v1.0.11-beta audit was reproduced the same way this round** (all 22 of its assets
  downloaded and re-verified: same 15/15 result). The round-8 report's figures are therefore no
  longer trust-on-report — they are independently reproduced facts.
- **VirusTotal: the scan step was SKIPPED** (`VIRUSTOTAL_API_KEY` not configured; the job's log
  states "VirusTotal scan skipped … Informational only; the SHA256SUMS.txt + signature audit remains
  the integrity gate"). The job is green because it says so honestly when it does nothing — a
  skipped overlay is **not** a malware scan pass, and nothing in this report claims one.

## 8. Security, signing and platform limits (observed facts + honest unknowns)

- **Windows Authenticode: ABSENT on v1.0.12-beta** — observed in this release's build log, not
  assumed: "Azure Trusted Signing is partially configured and will NOT run. Missing secrets: …
  All six are required (see CODE_SIGNING.md)", "No signing configured; uploading the unsigned MSI",
  "Sign with the persistent publisher certificate = skipped". The Windows installer, MSI and
  portable exe therefore show "Unknown publisher"; the honest warning path (More info → Run anyway +
  checksum guidance) is documented in CODE_SIGNING.md and the release body. The fail-closed
  diagnostics worked exactly as designed: a partially-configured signing path produced a loud
  warning instead of a silently unsigned "success".
- **Updater signatures**: the five signed classes are minisign-verified over the exact published
  bytes (§7); the in-app updater verifies against the key embedded in the binary before calling any
  update "verified".
- **Android signing**: the release's `build-android` job succeeded with the rotated keystore pair
  (historical rotation round 26-b, recorded in this file's git history); the pipeline's certificate
  fingerprint guard remains in the signing path. On-device install behavior remains untested (§9).
- **macOS**: the dmgs are unsigned and not notarized (no Apple credentials configured — same
  observed-log basis as Windows); first-launch needs right-click → Open, per CODE_SIGNING.md.
- **Branch protection: UNVERIFIED.** Settings → Branch rules are not observable with the current
  token's permission scope; whether required checks are *enforced* on `main` cannot be proven from
  here and is deliberately not claimed. Green CI and this report's merge discipline are evidence of
  process, not of enforcement.
- **Secrets hygiene**: no secret material appears in this report or any repo file; the release run's
  public logs expose configuration booleans and warning text only.

## 9. Download-to-open and frontend/accessibility readiness

**Download-to-open (implemented contract, unchanged application code since `6cc1d62`):** every
completed artifact is handed to the OS opener with the exact completed path; a registry-validated
AppImage launcher is the single fallback; failures are typed and retryable; a single-launch guard
prevents double activation. The contract is proven by Workflow K (22 E2E tests) + Workflow D2 (13
state-gating tests) in CI on the audited SHAs, plus the native Rust launcher validation tests on all
three CI platforms. **Real OS handoff: NOT RUN** — no Windows double-click, Linux AppImage desktop
launch, macOS Gatekeeper flow, or Android device test was executed this round; every row of
`docs/testing/download-open-smoke.md` should still be read as pending. **Android APK installer
handoff (FileProvider `content://`): NOT IMPLEMENTED** — it remains scoped to the Android adapter's
own round; Android keeps the uniform pass-through and honest typed refusals.

**Frontend/accessibility:** PR #69 (merged this round, head `bdd52ed`, all checks green) is the
round-9 frontend evidence: label/ARIA semantics across modals, table, palette and batch bar; polite
live regions for result counts; a 320px reflow floor with new visual snapshots in both themes; RTL
hardening for the detail modal, palette and header; StrictMode-safe catalog state; a duplicate-add
guard. The automated E2E + visual suite is green in CI on the merged head and on the audited tip.
**Physical assistive-technology testing: NOT RUN** — automated contrast/ARIA assertions are not a
substitute for a real screen-reader session, and nothing in this report claims one.

## 10. Owner-only actions and remaining blockers

1. **Physical smoke matrix execution** (platform owners): every row of
   docs/testing/download-open-smoke.md — Windows (exe/msi/portable), Linux (AppImage on stock
   GNOME/KDE, deb/rpm handlers), macOS (dmg + Gatekeeper). A mock cannot establish these; record
   each row with the OS version it ran on, or leave it honestly pending.
2. **Android installer handoff round** (Android adapter owner): FileProvider `content://` +
   `application/vnd.android.package-archive` + temporary read grant, then the on-device rows.
3. **Windows Authenticode** (maintainer): configure all six Azure Trusted Signing secrets (the
   build's own diagnostics name what is missing), or accept "Unknown publisher" as documented.
4. **Branch-protection verification** (maintainer, admin scope): confirm Settings → Branches
   enforces the required checks on `main`; until observed, UNVERIFIED stands.
5. **VirusTotal key** (maintainer, optional): set `VIRUSTOTAL_API_KEY` to turn the informational
   skip into real scan evidence; its absence keeps the skip labeled, never a pass.
6. **PAT rotation** (user browser step, unchanged from round 26-b): download/pat-rotation-steps.txt
   + scripts/apply_new_pat.sh (verifies before swapping; never prints).

## 11. Audit method (reproduce these results)

- **State capture**: GitHub REST API v3 (`/repos/WasewaseX/Fress`, `/releases`, `/releases/tags/…`,
  `/pulls?state=open|closed`, `/actions/runs`, `/actions/runs/{id}/jobs`,
  `/commits/{sha}/check-runs`, job logs) with the repository token; every "current" claim re-fetched
  inside the audit window.
- **Ancestry proofs**: fresh `git fetch origin main --tags`, then
  `git merge-base --is-ancestor` for `6cc1d62`, `825c1f5`, `6d338fd`, `7595a2a` (all ancestors of
  the tip), `v1.0.11-beta^{commit}` → `v1.0.12-beta^{commit}` (ancestor), and
  `git rev-parse v1.0.12-beta^{commit}` for the tag target.
- **Diff classification**: `git diff --name-status v1.0.12-beta^{commit}..origin/main` (§3) — read
  as a class table, not summarized prose.
- **Independent release audit**: all 22 assets of v1.0.12-beta (and of v1.0.11-beta) downloaded via
  public URLs; SHA-256 re-hash of every asset against the manifest; latest.json cross-check
  (version, 8 URLs, embedded-vs-sidecar signatures); minisign core signatures re-implemented
  (Ed25519 over BLAKE2b-64, key-id bound, production key) and all five verified. The audit script
  and its downloaded evidence live in this round's working notes, not in the repository.
- **Local pipeline**: `npm run validate:versions`; `npx tsc --noEmit`; `npx vitest run`; `npm run
  build` on the PR #69 tree; the release-candidate version bump additionally validated before the
  tag was pushed.
- **What this audit did NOT do**: execute any OS-level open/install on real hardware; observe branch
  settings; verify the trusted-comment wrapper signatures outside the pipeline's minisign run; and
  it treats no CI result as evidence for a SHA other than the one it ran on.

---

## 12. Close-out re-fetch (final, 2026-10-13T10:40Z)

Per the audit rules, the default branch and PR state were re-fetched AFTER the last integration and
this addendum written last:

- **Final integrated tip: `main` = `d0df83a9d98750bf1c162b22873c974c47fd3a8e`**; open PRs: **zero**;
  the CI run on that exact tip completed **success** (38382878431) before this report was committed.
- **Release currency**: the `v1.0.12-beta → tip` delta is the 8-file docs/CI/tests class of §3 —
  no `src/` (non-test) and no `src-tauri/` file — so the published v1.0.12-beta installers remain
  byte-equivalent to what the tip builds, and **no new release is cut for this delta**.
- **This report's own commit**: it is committed directly on top of the audited tip by the
  integration auditor (author `WasewaseX`, author-guard compliant); its exact SHA and the merge/PR
  record that carries it are named in the session handoff that publishes it, and this section is
  written inside that same commit — so the report identifies its audited tip (`d0df83a`) separately
  from its own publication commit by construction.
