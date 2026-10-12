# Fress release readiness — final integration and release acceptance

Status: **candidate audit complete; two maintainer actions pending** (Android
signing-secret confirmation, release re-run under the new audit gate).
Date: 2026-10-12. Owner: integration/CI/release QA (Agent 6 round 4).
Supersedes `release-readiness-v1.0.8-beta.md` (kept for history).

This report is the acceptance record for ONE reproducible release candidate:
the integrated branch `quality/final-integration-qa`, which contains
`main` (0cb678b27) plus the content of open PR #38. Nothing here is inferred
from isolated branch runs: every gate below ran on the integrated commits.

---

## 1. Final integrated candidate

Branch: `quality/final-integration-qa` → `main` (this PR).

Candidate commit stack (bottom to top):

| Commit | Content |
| --- | --- |
| `0cb678b27` | `main` tip: v1.0.8 integration + PR #36 (i18n/focus) + PR #37 (resolver determinism) merged |
| #38 (merged) | PR #38 content — signature verification wired into the real delivery flow (`updateDelivery.ts`), merged from its own rewritten branch (the original commit is authored as `Z User <z@container>`, which fails the author-guard; the owner rewrote it to `WasewaseX <WasewaseX@users.noreply.github.com>` before merging). This branch carries #38's content via the cherry-pick and rebases onto the merge |
| (rebase fix) | E2E checksum-failure contract realigned with #38's FINAL semantic (`1fda705`): a terminal checksum failure stays a retryable download-manager failure — no releases-page redirect. The interim cherry-pick predated that fix (`da7b26bff` redirected); the rebase keeps the code and unit tests at the final semantic and restores the E2E assertion the merged PR #35 contract already pinned |
| `12b97e6` | release.yml: final published-artifact audit before publish + deterministic `latest.json` (see §3) |
| `cb94ac2` | E2E: unsigned-release and cancellation trust-boundary scenarios |
| (this commit) | this report + integration table + quality-gates update |

Integration table for `main` and PRs #27–#38 (head SHAs recorded 2026-10-12):

| PR | Branch | Head SHA | State | In candidate? | What it contributes |
| --- | --- | --- | --- | --- | --- |
| #27 | quality/final-catalog-resolver | `6215bfae3` | merged | yes (ancestor of main) | final resolver/catalog correctness pass |
| #28 | quality/final-accessibility | `5365f328c` | merged | yes | last data-driven i18n surfaces; single-source strings |
| #29 | quality/final-updater-trust | `3e2013a91` | merged | yes | strict self-update version policy, two-phase asset eligibility, arch fixtures |
| #30 | quality/final-visual-ux | `dec7adee5` | merged | yes | visual/contrast/page-transition pass |
| #31 | quality/final-native-hardening | `e20955cf7` | merged | yes | native disk-failure/network-policy test hardening |
| #32 | quality/final-integration-qa | `ec72de712` | merged | yes | E2E workflows A–J, visual baselines, CI e2e/perf gates |
| #33 | release/v1.0.8-beta | `33fb6d5f2` | merged | yes | v1.0.8-beta integration release |
| #34 | quality/native-reliability-acceptance | `d8d33a51c` | merged | yes | Agent 3 native verifier boundary acceptance audit |
| #35 | quality/v1.0.8-release-acceptance | `86fc2947d` | merged | yes | Android keystore password secret wiring, signature-contract E2E, theme-true captures |
| #36 | quality/final-i18n-a11y | `c9dc0e8d3` | merged | yes | last localization gaps, parent-dialog focus restore |
| #37 | quality/resolver-determinism | `4076b004a` | merged | yes | deterministic ties, fail-closed duplicate digests, honest Signal gate |
| #38 | quality/final-updater-trust | `da7b26bff` | **open** | **yes — content integrated as `a374907`** | real signature-delivery flow (Agent 5); independent release audit report |

Notes on the integration:

- Every merged PR tip was proven an ancestor of `main` (`git merge-base
  --is-ancestor`) — no branch content is missing; no old snapshot was merged
  over a newer fix.
- PR #38 conflicted with main (its `i-self-update.spec.ts` import block vs
  PR #35's delivery tests). Resolved as a union — both fixture sets are
  present and used. Its `src/lib/i18n.tsx` additions (19 updater strings ×
  5 languages) merged cleanly against PR #36's changes and the translation
  parity gate passes on the candidate.
- One real integration conflict surfaced during the interim cherry-pick
  (`1e6e3d2`): the pre-#38 test asserted that a checksum failure stays
  inside the download manager, while the cherry-picked delivery flow still
  had the older releases-page redirect. Resolved at root cause in favor of
  PR #38's FINAL commit (`1fda705`, "checksum failures stay retryable in
  the manager"), which is also the contract PR #35's merged E2E pins
  (`openedUrls` stays empty): a corrupted TRANSFER is retryable — a fresh
  request re-downloads and re-checks — so the manager row with the
  fresh-request Retry is the recovery path and nothing is opened
  automatically. The artifact itself is never launched, no verified state
  is ever rendered, and the explained checksum toast still fires. The
  official Releases page remains the manual escape hatch named by the
  failure hint, not an automatic redirect.

## 2. Local gate results on the integrated commits

All commands from `docs/quality-gates.md` §1, run on the candidate stack:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 510 passed, 2 skipped (opt-in live-network probes, `FRESS_LIVE_PROBE`-gated; not CI) |
| `npm run build` (production) | PASS |
| `npm run validate:catalog` | PASS — 0 errors, 13 pre-existing warnings |
| `npm run validate:security` | PASS — Tauri config matches audited baseline |
| `npm run test:e2e` | PASS — 70/70 (68 prior + 2 new trust-boundary scenarios) |
| `npm run test:perf` | PASS — deterministic invariants: 0 unrelated card mutations in the 1000-event burst, 0 persisted writes in the 100-event cadence (bound 12). Wall-clock informational only: usable 1798 ms (baseline 2070), search 114/33/39 ms, view switches 1090/993 ms — within noise, no speed claim |
| Rust fmt / Clippy (`-D warnings`) / tests, Linux + Windows + macOS | NOT runnable in this environment (no Rust toolchain) — they run unchanged in CI on this PR; see §6 |

## 3. Release-pipeline audit: manifests must match the final bytes

### 3.1 What changed in the pipeline (commit `12b97e6`)

The October 12 audit (PR #38 body) reported two release issues: the
v1.0.7-beta `latest.json` drifting from its `SHA256SUMS.txt` entry, and the
v1.0.8-beta draft missing Windows/Android artifacts and its checksum
manifest. Neither describes the final published bytes (§3.2), but both
point at real pipeline hazards, which this round removes at the root:

1. **`latest.json` is now byte-stable across re-runs.** Its `pub_date` was
   the wall clock, so re-running the `updater-manifest` job alone produced
   different manifest bytes and silently invalidated the `SHA256SUMS.txt`
   entry the checksums job had already published — the exact drift
   mechanism the audit caught mid-run. `pub_date` now comes from the
   release object's `created_at`.
2. **The last gate before publish is now a full artifact audit** (new
   `scripts/ci/verify-release-artifacts.py`, run by `verify-release` on the
   exact bytes about to be published): SHA256SUMS.txt ↔ every asset both
   ways (manifest excluded from itself); `latest.json` version field,
   versioned URLs of this tag, no nonexistent assets, embedded signatures
   equal to the sidecar bytes, required platform matrix; every sidecar
   cryptographically verified over the artifact's exact bytes against the
   production minisign key; unsigned classes (dmg/msi/apk/portable) must
   carry no sidecars. Any late asset mutation fails the audit and the
   release stays a private draft.
3. **The required-asset list now blocks on `latest.json` and the signature
   sidecars** of the in-app-update matrix (x64/arm64 setup exes, AppImage,
   deb, rpm-by-glob) in addition to the binaries.

The audit's embedded minisign verifier is a pure-Python RFC 8032 Ed25519
implementation plus BLAKE2b-prehashed minisign Ed verification. Before any
release byte is touched it self-checks against RFC 8032 test vectors AND the
app's own `tauri signer sign` fixture (mirrored from
`src-tauri/src/lib.rs`; the selftest refuses to run if the fixture stops
verifying, so the two copies cannot drift). The same verifier was validated
out-of-band: `scripts/minisign_verify.py` (RFC vectors + fixture + tamper
rejection) reproduced the audit against the live release downloads.

### 3.2 Independent audit of the published releases (2026-10-12)

Fresh bytes downloaded from GitHub for **both** releases; every asset
re-hashed; every signature verified against the embedded production key
(minisign key id `5638C68123FB633B`, from `tauri.conf.json`):

| Check | v1.0.7-beta | v1.0.8-beta |
| --- | --- | --- |
| Release state | published 2026-10-11T18:49:30Z | published 2026-10-11T22:27:20Z (not a draft) |
| Assets | 22 | 22 |
| `SHA256SUMS.txt` entries ↔ bytes | 21/21 match; 0 mismatches, 0 listed-but-absent, 0 unlisted, manifest not self-listed | 21/21 match; same |
| `latest.json` version field | `1.0.7-beta` (this release) | `1.0.8-beta` (this release) |
| `latest.json` platform entries ↔ real assets | 8 entries, all URLs resolve to THIS release's assets, all embedded signatures equal the sidecar bytes | 8 entries, same |
| `latest.json` cross-version drift | **none** | **none** |
| Sidecars verified over exact artifact bytes | rpm, AppImage, deb, arm64-setup.exe, x64-setup.exe — 5/5 PASS | 5/5 PASS |
| Orphan/stray sidecars | none | none |
| Verdict | **PASS** | **PASS** |

Conclusion: the drift the audit reported on v1.0.7-beta was a mid-run state
(a re-run of `updater-manifest` after `checksums`), not the final published
bytes — today `sha256sum -c SHA256SUMS.txt` passes on both releases, and the
pipeline change in §3.1 makes that state unreachable. The v1.0.8-beta draft
findings (missing Windows/Android artifacts, no checksum manifest) were
likewise pre-completion: the published release has the full asset set
including `SHA256SUMS.txt`. The draft-as-ready risk is closed structurally:
`verify-release` now refuses to publish anything the audit cannot fully
verify.

## 4. Platform / signature matrix (the honest matrix)

Rule: an asset class is advertised as an in-app verified update ONLY if the
pipeline produces its `<asset>.sig` sidecar and the audit verifies it.
Everything else is official-Releases-page fallback with checksum
verification by the user. `latest.json` never references a nonexistent
asset, and `verify-release` fails the release when the matrix and the bytes
disagree.

| Platform / arch | Package expected | Signed for in-app updates | Exact artifacts (+ sidecar) | Absence |
| --- | --- | --- | --- | --- |
| Windows x86_64 | yes | **yes** | `Fress_<v>_x64-setup.exe` + `.sig`; `Fress_<v>_x64_en-US.msi` (no sidecar); `Fress_<v>_x64-portable.zip` (no sidecar) | setup exe or sidecar missing → release fails; msi/portable missing → release fails (current REQUIRED list) |
| Windows aarch64 | yes | **yes** | `Fress_<v>_arm64-setup.exe` + `.sig`; `Fress_<v>_arm64-portable.zip` (no sidecar) | setup exe or sidecar missing → release fails; portable missing → release fails |
| Linux x86_64 | yes | **yes** | `Fress_<v>_amd64.AppImage` + `.sig`; `Fress_<v>_amd64.deb` + `.sig`; `Fress-<v>-N.x86_64.rpm` + `.sig` | any missing → release fails |
| macOS x86_64 | yes | **no — honest fallback** | `Fress_<v>_x64.dmg` (no sidecar) | missing → release fails; in-app update NOT offered (no sidecar ⇒ 'unsigned' fallback) |
| macOS aarch64 | yes | **no — honest fallback** | `Fress_<v>_aarch64.dmg` (no sidecar) | missing → release fails; in-app update NOT offered |
| Android arm64-v8a | yes | **no — honest fallback** | `Fress_<v>_arm64.apk` | missing → release fails |
| Android armeabi-v7a / x86_64 / x86 | best-effort split | **no — honest fallback** | `Fress_<v>_arm.apk`, `Fress_<v>_x64.apk`, `Fress_<v>_x86.apk` | best-effort: absence is an explicitly supported fallback (the `universal.apk` covers these ABIs and its absence fails the release) |
| Android universal | yes | **no — honest fallback** | `Fress_<v>_universal.apk` | missing → release fails |
| Updater manifest | yes | — | `latest.json` (deterministic; references only existing signed assets) | missing → release fails |
| Checksum manifest | yes | — | `SHA256SUMS.txt` (all assets except itself) | missing → release fails |

This matrix is enforced twice: statically by the `REQUIRED` list in
`verify-release`, and semantically by `verify-release-artifacts.py`
(required `latest.json` platforms windows-x86_64/windows-aarch64/
linux-x86_64; darwin `.app.tar.gz` bundles must carry sidecars to be
advertised; unsigned classes must NOT carry sidecars).

## 5. Android signing-secret remediation

State of the workflow (kept from PR #35, verified on the candidate):

- Every `fressandroid` literal is gone; all keystore commands use
  step-level `ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}`.
- Fail-closed guards: absent secret → error before the keystore is decoded;
  keystore that cannot be opened (alias `fress`) with the secret → error;
  certificate SHA-256 fingerprint guard (`b0fd578d…cbdf27`) preserved — the
  released APKs must keep the SAME signing identity so installed devices
  can update in place. No new keystore may be minted without an explicit
  migration plan.
- No other hardcoded signing material anywhere in `.github/workflows/`
  (the Windows PFX path references `WINDOWS_PFX_B64`/`WINDOWS_PFX_PASSWORD`
  secrets by name and warns+skips when unset). No `set -x`, no keystore
  bytes in logs (keytool output discarded except the fingerprint), no
  keystore in any upload-artifact path. Debug/PR workflows
  (`ci.yml`, `security.yml`, `network-smoke.yml`, `author-guard.yml`)
  reference no signing secrets.
- `ANDROID_KEYSTORE_B64` remains a secret; its decoded content never
  becomes an artifact or log output.

**Maintainer action still PENDING (cannot be proven from a public repo):**

1. The repository secrets list currently contains `ANDROID_KEYSTORE_B64`,
   `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` —
   **`ANDROID_KEYSTORE_PASSWORD` is NOT set yet**. Until it is, the Android
   release job fails closed before packaging (by design). Set it to the
   store/key password of the permanent keystore.
2. The previously exposed literal password must be considered burned.
   Rotation that PRESERVES the signing identity (run locally, where the
   real keystore lives):
   `keytool -storepasswd -keystore fress.keystore -alias fress` then
   `keytool -keypasswd -keystore fress.keystore -alias fress`, re-encode the
   keystore as the existing `ANDROID_KEYSTORE_B64`, and store the NEW
   password as `ANDROID_KEYSTORE_PASSWORD`. Re-run the Android release job
   once in the protected environment and confirm the fingerprint guard
   passes unchanged.
3. Note: the v1.0.7/v1.0.8-beta releases were produced by runs that
   predate the secret wiring (run IDs in §6), so their APKs are signed with
   the pre-rotation password. That does not block rotation — the identity
   is the certificate, not the password.

## 6. CI evidence

| Run | SHA | Result |
| --- | --- | --- |
| main CI (push) `38183183794` | `0cb678b27` | success (all jobs) |
| main Author guard `38183183732` | `0cb678b27` | success |
| this PR | candidate HEAD | required checks run on the exact integrated SHA; links in the PR description (Rust suites: CI-only, see §2) |
| Release v1.0.8-beta `38179648897` | `0585c1342` (pre-#35 main) | success — produced the published release audited in §3.2; next release runs under the new audit gate |

Single-gate enforcement on the integrated commit: version-guard
(package/Cargo/tauri/lockfile agreement), frontend (typecheck, unit incl.
translation parity + self-update SemVer/arch regressions + the 18-case
signature-delivery matrix, catalog validator, security validator, production
build), Rust fmt/Clippy(-D warnings)/tests on Linux, Rust tests on
Windows/macOS, E2E + visual regression on the production build with
deny-all deterministic fixtures, deterministic perf invariants. No
`continue-on-error`, no blanket retries (Playwright `retries: 1` in CI,
0 locally), no weakened snapshot thresholds (`maxDiffPixelRatio: 0.02`,
unchanged), no active `test.fail`/`skip`/`fixme` (the only skips are the
explicitly opt-in live probes). Live catalog probes remain separate
(`network-smoke.yml`, opt-in env), never in PR CI.

## 7. E2E trust-boundary proof (real updater flow, fixtures only)

Browser-level, `i-self-update.spec.ts`, deterministic loopback fixtures:

1. Valid signed artifact + expected checksum → pill, checksummed download,
   verifier invoked on the engine-reported path with the exact sidecar
   document, verified toast + ready pill, zero auto-launch. ✅
2. Bad signature despite correct checksum → engine-complete with good
   digest, verifier rejects: explained failure toast, see-releases pill,
   releases page opened, never verified. ✅
3. Missing signature (release ships no `<asset>.sig`) → third plan gate
   refuses: releases page with the localized 'unsigned' reason, download
   registry empty, pill never claims verified/progress. ✅ (new)
4. Wrong version/filename signature → plan-time sidecar binding refuses
   (18-case unit matrix, `selfUpdateDelivery.test.ts`); tampered/foreign-key
   documents refuse at the Rust verifier (accept/refuse matrix). ✅
5. Incorrect digest, plan time (`SHA256SUMS` line hash is wrong) → ✅
   (wrong-hash fixture); transfer time (published digest vs actual bytes)
   → kind=checksum failure that stays retryable in the download manager
   (no redirect), explained toast, fresh Retry to the same asset. ✅
6. Unsigned platform artifact → same gate as 3 (dmg/apk-shaped release). ✅
7. Incompatible-only architecture release → update detected, releases page,
   no download (two-phase picker; the published digest for the incompatible
   file cannot make it downloadable). ✅
8. Missing/malformed `latest.json` + checksum manifest → malformed tag
   never offered, missing `SHA256SUMS.txt` → releases page unverifiable,
   partial manifest → same. ✅
9. Retry (fresh request, no resume, same asset) and cancellation (quiet:
   idle pill, no fallback, no failure toast, cancelled row, never verified)
   → ✅ (cancellation browser-level is new)

Unit-level delivery matrix: 18 cases (`selfUpdateDelivery.test.ts`) cover
the full plan/fetch/verify lifecycle including cross-download correlation
races and subscriber ordering.

## 8. Skipped, simulated, and physically untested — full inventory

- **Skipped in the suite (2)**: live-network catalog probe tests, gated
  behind `FRESS_LIVE_PROBE=1`; they never run in CI (deterministic fixtures
  only). Not a suppression — the live path is a separate opt-in workflow
  (`network-smoke.yml`).
- **CI-simulated (by design)**: E2E runs against loopback fixtures and the
  Tauri bridge mock; the native verifier, verified download engine and
  update-check chain are exercised through the bridge contract, and the
  real native code is covered by the Rust suite (Linux/Windows/macOS) in
  CI. The REAL minisign verification of REAL release bytes is covered
  out-of-band by the §3.2 audit (independent implementation, validated
  against RFC 8032 vectors and the app's own signer fixture).
- **Physically untested (no hardware/OS access in this environment)**:
  in-place install/launch on Windows x64/arm64, macOS Intel/Apple-silicon
  (dmg mount, notarization/gatekeeper behavior), Android device install and
  upgrade (including same-identity upgrade after password rotation), RPM/DEB
  package-manager flows, and the Windows Authenticode path (certificate
  still unconfigured — "Unknown publisher" state documented in
  CODE_SIGNING.md). These must not be described as verified anywhere.
- **Pending maintainer confirmation**: Android keystore password rotation
  (§5.2) and the `ANDROID_KEYSTORE_PASSWORD` secret (§5.1).
- **Routed to owners (not blockers for this candidate)**: pill label after
  plan-level refusal (`useSelfUpdate.ts`), rate-limit message normalization
  (resolver), untranslated category badge (i18n) — see
  `docs/quality-gates.md` §8.

## 9. Verdict

- The integrated candidate (§1) contains every merged PR #27–#37 and the
  full content of open PR #38; every gate that can run here passes on it
  (§2), and the one integration-level contract change was resolved at its
  root cause.
- Both published releases pass the independent final-bytes audit (§3.2);
  the pipeline hazard class that produced the mid-run drift is removed
  (§3.1), and no release can publish without the full audit passing on the
  exact bytes (§3.1.2/§4).
- The release is an honest release candidate **conditional on**: (a) the
  maintainer setting `ANDROID_KEYSTORE_PASSWORD` after rotating the keystore
  password in place (§5), (b) one Android release-job run in the protected
  environment to observe the fail-closed → pass transition and the unchanged
  fingerprint, and (c) the next tagged release completing under the new
  `verify-release` audit. Platform behaviors not physically exercised are
  listed in §8 and must remain labeled unverified until recorded otherwise.
