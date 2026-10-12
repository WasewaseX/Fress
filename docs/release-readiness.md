# Fress release readiness — public-main coherence and release acceptance (round 5)

Status: **public main is coherent; v1.0.9-beta published bytes independently audited PASS;
Android signing gate CONFIRMED; one open PR (#47) awaits owner merge.**
Date: 2026-10-13 (evidence gathered 2026-10-12/13 UTC). Owner: integration/CI/release QA (Agent 6 round 5).
Supersedes the round-4 report previously in this file (its release-conditional
verdict items (a) Android secret, (b) protected Android run, (c) first release
under the new audit gate — have all since been satisfied and are re-proven here).

This round's mandate: make the public default branch coherent, testable and
honestly ready for the next release — synchronize the latest implementations,
close the remaining integration gaps, validate one immutable candidate SHA,
and leave an unambiguous public merge/release state. Nothing in this report is
inferred from PR descriptions: every PR head was compared against `main` by
commit ancestry, and every published release byte was re-downloaded and
re-verified during this round.

---

## 1. Exact public-default-branch state (Task 1)

Recorded 2026-10-13 UTC, via the GitHub API and local `git merge-base
--is-ancestor` proofs:

- **`main` = `7ff5601` (`7ff56013daa65764b47dcaef221e1bbfcac5d944`)** —
  "Merge PR #46: docs - stop quoting the historical keystore store-password
  literal". Author-guard compliant.
- **Tag `v1.0.9-beta` → `20c2259`** (merge of PR #45), proven an **ancestor of
  `main`**. The tag→main delta is docs-only
  (`docs/release-readiness.md`, +3/−1, PR #46): no binary-relevant source
  changed after the release was cut.

### 1.1 PR disposition table (#38–#47)

Head SHAs recorded from the API; "in main" proven by commit ancestry of the
exact head SHA, not by PR title.

| PR | Branch | Head SHA | State | In `main`? | Unique content |
| --- | --- | --- | --- | --- | --- |
| #38 | quality/final-updater-trust | `2caa0e6` | merged 2026-10-12T12:47Z | **yes (ancestor)** | signature verification wired into the real delivery flow; checksum failures stay retryable |
| #39 | test/android-linux-round-2026-10-12 | `f3c2021` | merged 2026-10-12T12:48Z | **yes** | Android device contract pinned at the UI seam (Linux+Android round evidence) |
| #40 | quality/catalog-final-acceptance | `36ae0ff` | merged 2026-10-12T12:47Z | **yes** | catalog final acceptance: fresh live audit, honest failure classification |
| #41 | quality/native-security-acceptance | `9d0ed1c` | merged 2026-10-12T12:48Z | **yes** | native signature verifier scoped to completed download artifacts |
| #42 | quality/final-acceptance | `dace7da` | merged 2026-10-12T12:48Z | **yes** | i18n+a11y final acceptance (listbox ownership, landmarks, last untranslated surfaces) |
| #43 | quality/final-integration-qa | `9188d13` | merged 2026-10-12T12:59Z | **yes** | round-4 release acceptance: final-artifact audit in the pipeline, platform/signature matrix, honest report |
| #44 | quality/visual-acceptance-26 | `9aa5081` | merged 2026-10-12T13:28Z | **yes** | visual acceptance round 26 (header at 200% zoom, AA warning inks) |
| #45 | release/v1.0.9-beta | `ca9128d` | merged 2026-10-12T13:50Z | **yes** | v1.0.9-beta verified-delivery release (version bump + E2E fixture derivation fix) |
| #46 | docs/scrub-keystore-literal | `632f674` | merged 2026-10-12T14:50Z | **yes** | stopped quoting the historical keystore password literal; **maintainer rotation confirmation recorded (see §5)** |
| #47 | quality/native-security-continuation | `7130a74` | **open** | **no — content exists only on the PR branch** | native verifier record contract completion: checksum status, cross-download isolation, registry immutability (`src-tauri/src/download_finalize.rs` +216/−10, `src-tauri/src/lib.rs` +113/−13; single commit authored `WasewaseX`) |

No unique change of any merged PR #38–#46 is missing from `main`: every head
SHA is an ancestor. **PR #47 is the only content in the repository that lives
only on a PR branch.** It is native test/record-contract work owned by Agent
3; this bot does not merge or approve PRs — it is left open for owner review
with green CI and a clean mergeable state (see §6). Nothing in it changes
release bytes: the published v1.0.9-beta is not invalidated by it, and the
next release should include it.

Notes:

- **PR #38 author-guard provenance** (raised in the round-4 report): the
  commits that actually merged (#38 head `2caa0e6` and its parent `662c55a`)
  are authored `WasewaseX <WasewaseX@users.noreply.github.com>` — the owner
  rewrote the offending `Z User <z@container>` commit before merging, the
  push-time and PR-time author guards passed, and no falsified authorship
  exists in `main`'s history.
- **The round-4 candidate SHA `298a659` no longer exists in the repository**
  (absent from every ref, the commit list, and all reachable objects). It was
  cited in the PR #43 body as the re-authored tip of that PR's branch; the PR
  merged from head `9188d13`, and the orphaned commit was later garbage
  collected. Its cited check results are therefore **not re-verifiable** and
  are treated here as historical claims. The equivalent — and stronger —
  evidence is fresh: full CI green on `main` `7ff5601` (§6) and the audited
  published release (§4). No current claim in this report rests on
  `298a659`.
- **Required status checks**: the branch-protection API returns 404 for this
  token (fine-grained token without administration read, or no rules
  configured). What is observable and reported instead: every push to `main`
  and every PR runs the full CI matrix + Author guard, and all runs on
  `main`/PR heads referenced in §6 are green. Whether GitHub *enforces* these
  as protected-branch requirements is not provable from here and is listed as
  a standing verification item for the owner.

## 2. Version metadata reconciliation (Task 2)

`1.0.9-beta` is the current released version — the "planned unreleased
candidate" framing from the task snapshot is outdated: **tag `v1.0.9-beta`
and its release were published 2026-10-12T14:21:05Z** (22 assets, §4). The
metadata question is therefore settled by coherence between source, tag and
published manifest:

| Location | Recorded version | Consistent? |
| --- | --- | --- |
| `package.json` | `1.0.9-beta` | ✅ |
| `package-lock.json` (`.version` and `.packages[""].version`) | `1.0.9-beta` ×2 | ✅ |
| `src-tauri/Cargo.toml` | `1.0.9-beta` | ✅ |
| `src-tauri/Cargo.lock` (`fress` crate) | `1.0.9-beta` | ✅ (now also CI-gated, below) |
| `src-tauri/tauri.conf.json` | `1.0.9-beta` | ✅ |
| `CHANGELOG.md` | `1.0.9-beta (2026-10-12): the verified-delivery release` | ✅ |
| `README.md` current-version example | was `v1.0.8-beta` → **fixed to `v1.0.9-beta`** this round (`fb08a91`) | ✅ |
| Tag `v1.0.9-beta` / release object | `v1.0.9-beta` | ✅ |
| Updater manifest on the release (`latest.json` `version`) | `1.0.9-beta` | ✅ (§4.1) |

Deterministic consistency check: the `version-guard` CI job pinned
package.json / Cargo.toml / tauri.conf.json / both package-lock fields. This
round **extends it to `src-tauri/Cargo.lock`** (the `fress` crate block) —
a release built from a stale lockfile would embed the old version in binary
metadata (`6ec5fb3`). The check runs on every push and PR; no tag was cut or
re-published to "make pages match".

## 3. Release-pipeline audit gates (Task 3 — mechanism)

The authoritative audit is `scripts/ci/verify-release-artifacts.py`, run by
the release workflow's `verify-release` job **after the last asset upload,
on the exact bytes about to be published**. Its contract (unchanged this
round, re-verified by behavior in §4):

1. `SHA256SUMS.txt` ↔ every asset, both directions; manifest never lists
   itself; no asset unlisted.
2. `latest.json` version field, versioned URLs of this tag, no nonexistent
   assets, embedded signature == sidecar bytes for every platform entry.
3. Every `.sig` sidecar cryptographically verified over the artifact's exact
   bytes against the production minisign public key (pure-Python RFC 8032
   Ed25519 + BLAKE2b-prehash, self-tested against RFC vectors and the app's
   own signer fixture before every audit).
4. Required platform matrix present; unsigned classes (dmg/msi/apk/portable)
   must carry **no** sidecars; orphan sidecars are hard failures.

Byte-stable regeneration: `latest.json`'s `pub_date` derives from the release
object's `created_at` (round-4 fix), so re-running the manifest job cannot
drift the published `SHA256SUMS.txt` entry. Behavioral proof this round: the
release pipeline ran **twice** for v1.0.9-beta (push run `38258545023`, then
the full re-run `38263495368` after the audit gate landed) — the second run
re-uploaded assets and regenerated both manifests, and the final published
bytes still pass the full two-direction audit (§4.1).

Tamper invalidation, demonstrated locally this round against the published
bytes (each tamper in a throwaway copy, pristine set untouched):

| Tamper | Audit result |
| --- | --- |
| Flip 1 byte in `Fress_1.0.9-beta_x64.dmg` | HARD FAIL — checksum mismatch vs `SHA256SUMS.txt` |
| Edit an embedded `signature` in `latest.json` | HARD FAIL — embedded signature ≠ sidecar bytes |
| Edit the sidecar's non-cryptographic comment region | HARD FAIL ×2 — `SHA256SUMS.txt` mismatch **and** `latest.json` byte-equality |
| Edit inside the sidecar's signature box | HARD FAIL ×3 — checksum, byte-equality, **and minisign verifier rejection** ("bad signature box") |

Editing any asset or manifest invalidates the gate; nothing about the audit
trusts a label.

## 4. Independent audit of the published releases (Task 3 — fresh bytes)

Both releases were re-downloaded **in full from GitHub during this round**
(2026-10-12T18:30–18:32Z; sizes verified against the release objects) and the
unmodified `scripts/ci/verify-release-artifacts.py` was run against the
downloaded directories. Historical numbers were **not** reused.

### 4.1 v1.0.9-beta — the current published release

Published (not a draft) 2026-10-12T14:21:05Z · 22 assets · built by Release
run `38263495368` on tag commit `20c2259` · **FINAL ARTIFACT AUDIT PASSED**.

| Check | Result |
| --- | --- |
| `SHA256SUMS.txt` entries ↔ bytes, both directions | **21/21 match**; 0 listed-but-absent, 0 unlisted, manifest not self-listed |
| `latest.json` `version` | `1.0.9-beta` (this release) |
| `latest.json` platform entries ↔ assets | 8 entries; every URL is this tag's versioned download URL and resolves to a real asset; every embedded signature equals its `<asset>.sig` sidecar bytes |
| Sidecars verified over exact published bytes (production key `5638C68123FB633B` from `tauri.conf.json`) | **5/5 PASS** — rpm, AppImage, deb, arm64-setup.exe, x64-setup.exe |
| Orphan/stray sidecars | none |
| Unsigned classes (2 dmgs, msi, 2 portable zips, 5 apks) carry sidecars | none — in-app delivery correctly NOT advertised for them |
| Verifier selftest before audit | RFC 8032 vector + app signer fixture verify; tampered payloads rejected |

### 4.2 v1.0.8-beta — re-audit of the prior release (same method)

**FINAL ARTIFACT AUDIT PASSED**: 22 assets, 21/21 checksum entries both
directions, `latest.json` version `1.0.8-beta` with 8 consistent platform
entries, 5/5 sidecars verified, no stray sidecars. The round-4 conclusion
stands on fresh bytes: the October-12 "manifest drift" and "draft missing
assets" findings described mid-run states, not final published bytes.

### 4.3 What this proves

The published v1.0.9-beta bytes satisfy every acceptance property: the
manifest matches the exact published bytes; sidecar associations are correct
and cryptographically verified; no asset is advertised that does not exist;
platforms without signed artifacts are honestly described as official-page
fallbacks. In-app verified updates are offered **only** where §7 says they
are.

## 5. Android signing gate (Task 4) — CONFIRMED

Round-4 status was "secret not configured; rotation pending". **That state is
closed**, with evidence from the actual protected run and the owner's
explicit confirmation:

- **The secret is configured.** Release run `38263495368`'s `build-android`
  job succeeded end-to-end; its log shows `FRESS_KEYSTORE_CONFIGURED: true`
  and the password only ever appears masked (`ANDROID_KEYSTORE_PASSWORD:
  ***`). The workflow fails closed without it (guards before decode, before
  build, before sign) — it cannot succeed with a missing secret.
- **The certificate-fingerprint guard ran and passed.** The job compares the
  keystore's SHA-256 fingerprint against the pinned permanent identity
  (`b0fd578d…cbdf27`) and exits nonzero on mismatch; it succeeded, so the
  published v1.0.9 APKs carry the **same signing identity** as the
  1.0.6-beta baseline — installed devices update in place.
- **Rotation is confirmed by the owner, in the record** (PR #46 body, merged
  2026-10-12): the previously exposed store-password was **rotated
  out-of-band, preserving the same signing certificate and pinned
  fingerprint, with both Actions secrets replaced via client-side-encrypted
  API calls** — "the historical value is dead". The literal was also scrubbed
  from this document (its last remaining disclosure).
- **Repo-wide sweep (re-run this round on `main`)**: zero `fressandroid`
  literals; the only remaining `-storepass` text in `release.yml` is the
  generic rotation-procedure comment with a `<strong-password>` placeholder;
  no `set -x`, no keystore bytes in logs or artifact paths; debug/PR
  workflows reference no signing secrets. Secrets are referenced only via
  `secrets.ANDROID_KEYSTORE_PASSWORD` at step level.
- **Android assets in v1.0.9-beta**: 5 signed APKs published (arm, arm64,
  x64, x86, universal) via the protected signing job.

Remaining honest caveat (unchanged): no physical Android device exists in
this environment — the on-device install/upgrade path (including the
same-identity upgrade) is contract-tested at the UI seam (PR #39) and
fingerprint-proven in CI, but not executed on hardware (§8).

## 6. Every gate on one immutable commit (Task 5)

### 6.1 `main` `7ff5601` — the full required suite, one commit

| Run (URL) | Jobs | Result |
| --- | --- | --- |
| [CI (push) 38265888769](https://github.com/WasewaseX/Fress/actions/runs/38265888769) | Typecheck, tests, catalog, security, build · Rust fmt/Clippy/tests (linux) · Rust tests (macos-latest) · Rust tests (windows-latest) · E2E + visual (linux) · Perf invariants (linux) · Version consistency | **7/7 success** |
| [Author guard (push) 38265888781](https://github.com/WasewaseX/Fress/actions/runs/38265888781) | authors | **success** |

The Rust suites (Linux fmt/Clippy `-D warnings`/tests, macOS tests, Windows
tests) ran in CI on this exact SHA — the local environment has no Rust
toolchain and no Rust gate is claimed locally.

### 6.2 The release candidate the bytes came from

| Run | SHA | Result |
| --- | --- | --- |
| [Release (push) 38258545023](https://github.com/WasewaseX/Fress/actions/runs/38258545023) | `20c2259` (tag) | success (initial publish path) |
| [Release (dispatch) 38263495368](https://github.com/WasewaseX/Fress/actions/runs/38263495368) | `20c2259` (tag) | **all 12 jobs success** — version · create-release · build-android (signed, fingerprint-guarded) · build-windows · build-windows-arm64 · build-linux · build-macos-intel · build-macos-arm · updater-manifest · checksums · virustotal · **verify-release (final artifact audit on the exact published bytes)** |

Tag→`main` delta is docs-only (§1), so `main`'s green CI covers the released
source; the release audit covered the released bytes.

### 6.3 This round's branch `quality/public-main-coherence`

| Run | Commit | Result |
| --- | --- | --- |
| [CI (PR) 38292601594](https://github.com/WasewaseX/Fress/actions/runs/38292601594) | `267b54b` (this branch's head) | **7/7 success** — incl. the extended version-guard (Cargo.lock) |
| [Author guard (PR) 38292601754](https://github.com/WasewaseX/Fress/actions/runs/38292601754) | `267b54b` | success |
| [Author guard (push) 38292494047](https://github.com/WasewaseX/Fress/actions/runs/38292494047) | `267b54b` | success |
| [Live network smoke (dispatch) 38292160847](https://github.com/WasewaseX/Fress/actions/runs/38292160847) | `e96c24c` | **success — all 4 live probes ran and passed** (the fix proven end-to-end) |

### 6.4 Suppression audit (re-verified this round)

`ci.yml` contains zero `continue-on-error`; no blanket retries (Playwright
`retries: 1` in CI, 0 locally); visual thresholds unchanged
(`maxDiffPixelRatio: 0.02`); no active `test.fail`/`skip`/`fixme` outside the
2 opt-in `FRESS_LIVE_PROBE`-gated live probes; live catalog probes stay in
`network-smoke.yml` (schedule + manual dispatch), never in PR CI.

### 6.5 The one red run found — root-caused and fixed

The **Live network smoke** scheduled run [38271362011](https://github.com/WasewaseX/Fress/actions/runs/38271362011)
on `main` `7ff5601` (2026-10-12T15:35Z, its first-ever scheduled execution)
failed **during test collection**: the spec read
`new URL('../package.json', import.meta.url)` → `tests/package.json`
(nonexistent) → ENOENT → "No tests found". No live endpoint was ever
probed; this was an E2E-infrastructure path bug, not a resolver/catalog
regression. Fixed at root cause in `e96c24c` (`../../package.json`), proven
by test collection listing all 4 probes and by the dispatch run in §6.3.

## 7. Platform / signature matrix (v1.0.9-beta actual bytes)

Rule: in-app **verified** update delivery is advertised only where the
pipeline produces the `.sig` sidecar and the audit verifies it (§4.1).
Everything else is the official-Releases-page fallback with the reason
spelled out in the UI.

| Platform / arch | Asset (exact, published) | Sidecar | In-app verified update |
| --- | --- | --- | --- |
| Windows x86_64 | `Fress_1.0.9-beta_x64-setup.exe` | ✅ verified | **yes** |
| Windows x86_64 | `Fress_1.0.9-beta_x64_en-US.msi`, `Fress_1.0.9-beta_x64-portable.zip` | none (by design) | no — official page fallback |
| Windows aarch64 | `Fress_1.0.9-beta_arm64-setup.exe` | ✅ verified | **yes** |
| Windows aarch64 | `Fress_1.0.9-beta_arm64-portable.zip` | none (by design) | no — official page fallback |
| Linux x86_64 | `Fress_1.0.9-beta_amd64.AppImage`, `Fress_1.0.9-beta_amd64.deb`, `Fress-1.0.9-beta-1.x86_64.rpm` | ✅ verified ×3 | **yes** |
| macOS x86_64 | `Fress_1.0.9-beta_x64.dmg` | none (by design) | no — official page fallback |
| macOS aarch64 | `Fress_1.0.9-beta_aarch64.dmg` | none (by design) | no — official page fallback |
| Android arm64-v8a / armeabi-v7a / x86_64 / x86 / universal | `Fress_1.0.9-beta_{arm64,arm,x64,x86,universal}.apk` (apksigner-signed with the pinned identity) | no minisign sidecar (by design) | no — official page fallback; APK integrity via Android package signature |
| Manifests | `latest.json` (deterministic), `SHA256SUMS.txt` | — | audited §4.1 |

`latest.json` advertises exactly the three required platform families
(windows-x86_64, windows-aarch64, linux-x86_64 incl. rpm entry) — matching
the sidecar set, no more, no less.

## 8. Skipped, simulated, and physically untested — full inventory

- **Opt-in skips (2, by design)**: live-network catalog probe unit tests,
  gated behind `FRESS_LIVE_PROBE=1`; never run in PR CI. The scheduled live
  probe is the separate `network-smoke.yml` (§6.5).
- **CI-simulated (by design)**: browser E2E runs against loopback fixtures
  and the Tauri bridge mock; native behavior is covered by the Rust suites on
  three OSes; real-release-byte verification is covered out-of-band by the
  §4 audit with an independent pure-Python verifier.
- **Physically untested (no hardware/OS access here — must stay labeled
  unverified)**: in-place install/launch on Windows x64/arm64; macOS dmg
  mount, Gatekeeper/notarization behavior on Intel and Apple silicon; Android
  on-device install and same-identity upgrade (incl. after password
  rotation); RPM/DEB package-manager flows; real screen-reader passes
  (NVDA/VoiceOver) — accessibility is asserted structurally (roles, focus,
  labels, landmarks) but not with assistive technology; Windows Authenticode
  signing remains unconfigured ("Unknown publisher" documented in
  CODE_SIGNING.md).
- **Not provable from a public repo**: branch-protection enforcement of the
  required checks (§1 notes); the current Actions secret *values* (only
  their observable effects are proven — §5).

## 9. Verdict and outstanding items

**The public default branch is coherent**: every merged PR #38–#46 is fully
contained in `main` (ancestry-proven), version metadata agrees everywhere
(now including `Cargo.lock`, CI-enforced), the full required suite is green
on the single immutable commit `7ff5601`, and the published v1.0.9-beta bytes
pass the independent final-artifact audit with the Android signing gate
confirmed. **No hard release blocker remains for the current published
release.**

Outstanding items, exact and honest:

1. **PR #47 (open)** — Agent 3's native verifier record-contract work exists
   only on its branch; CI and Author guard are green and the tree is clean.
   It needs owner review and merge (this bot does not merge). It does not
   affect the published v1.0.9 bytes; it SHOULD ride into the next release.
2. **Branch protection visibility** — required-check *enforcement* on `main`
   could not be read via the API with this token (404). Owner should confirm
   the CI + Author-guard contexts are set as required status checks.
3. **The round-4 candidate SHA `298a659` is orphaned** — its cited green
   checks are historical claims that cannot be re-verified; superseded by the
   fresh evidence in §6 (recorded here so no future report cites it).
4. **Physical-device inventory of §8** — unchanged; any release note or
   document must keep those items labeled unverified.
5. **Live network smoke** — root-caused fix on this branch; the scheduled
   Monday probe is expected green hereafter (dispatch proof in §6.3).
