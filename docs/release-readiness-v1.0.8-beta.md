# Release readiness — v1.0.8-beta integrated candidate (Agent 6 final QA)

> **SUPERSEDED (2026-10-12, later the same day):** this record predates the
> final-integration round. The current acceptance record is
> `release-readiness.md`, which adds PR #38's signature-delivery flow to the
> candidate, the final published-artifact audit of both releases, the
> platform/signature matrix, and the Android rotation status. Sections that
> described the signature wiring as pending are resolved there.

Status of every required quality gate for the integrated release candidate.
Dated 2026-10-12. Supersedes `release-readiness-v1.0.7-beta.md` (kept as the
v1.0.7 record).

The core rule of docs/quality-gates.md applies verbatim: **a pass below is
only as good as the environment it ran in.** Local results come from this
QA environment (Linux x86_64, Node 20, Chromium headless, no Rust
toolchain); Windows/macOS Rust evidence is CI-only and is linked, not
claimed.

## 1. Branch synchronization (the six sources, one candidate)

All work that lived on open PRs is now contained in main. Recorded head
SHAs and their merge commits:

| PR | Branch | Head SHA | Merged as | Content |
|---|---|---|---|---|
| #27 | quality/final-catalog-resolver (Agent 4) | `6215bfae3e02` | `10fdef4` | catalog/resolver correctness pass |
| #28 | quality/final-accessibility (Agent 2) | `5365f328c9d5` | `4daba4a` | last data-driven i18n surfaces, shared mappings |
| #29 | quality/final-updater-trust (Agent 5) | `3e2013a91f56` | `aff87f7` | strict version policy, two-phase asset eligibility, artifact-authenticity command + tests |
| #30 | quality/final-visual-ux (Agent 1) | `dec7adee51c5` | `89f2363` | shared category labels, readable state inks |
| #31 | quality/final-native-hardening (Agent 3) | `e20955cf797b` | `e8a3a97` | native failure-injection evidence |
| #32 | quality/final-integration-qa (Agent 6) | `ec72de712ed1` | `cb59cac` | E2E A–J + visual + perf gates, CI security/version gates, corrected baselines |
| #33 | release/v1.0.8-beta | `33fb6d5f2986` | `0585c13` | version bump 1.0.7-beta → 1.0.8-beta, changelog |

`git merge-base --is-ancestor` was executed for every head SHA against
main: **all seven are ancestors** — no branch content is missing from the
candidate. The late updater-branch Clippy fixes (`d57346d`, plus the
artifact-stripping merge `ec72de7`) rode in through PR #32's branch before
its merge, so the Rust gate that was red earlier in the round is green on
the integrated tip. No stale branch was merged on top of a newer base; the
only conflict-prone path (updater fixes onto the QA branch) was resolved in
`ec72de7` with the artifacts it had picked up stripped.

## 2. Gate-by-gate status

| # | Required gate | Status | Where | Evidence |
|---|---|---|---|---|
| 1 | TypeScript checks | **PASS** | local | `npm run typecheck` — clean. |
| 2 | Unit tests | **PASS** | local | `npm test` — 451 passed, 2 skipped (33 files; skips are the by-design live probes). Includes Agent 3's native failure-injection unit coverage and Agent 5's selfUpdate matrix (487 new lines in `selfUpdate.test.ts`). |
| 3 | Localization dictionary parity + translation coverage | **PASS** | local | `i18nDictParity.test.ts` (extended by PR #29's localization gates) inside `npm test`; `validate:catalog` enforces catalog translation coverage. |
| 4 | Catalog validator | **PASS** | local | `npm run validate:catalog` — 0 errors, 13 pre-existing warnings (advisory by the validator's policy). Carries Agent 4's resolver/catalog fixtures. |
| 5 | Security config validator | **PASS** | local + CI | `npm run validate:security` — CSP/Tauri allowlist matches the audited baseline; embedded updater pubkey matches `fress-updater.key.pub`; endpoints https-only. Gated in `ci.yml` → `frontend` since PR #32. |
| 6 | Production build | **PASS** | local | `npm run build` — the artifact E2E/perf run against. |
| 7 | Rust fmt / Clippy (warnings denied) / tests (Linux) | **PASS (CI)** | CI | `ci.yml` → `rust`: run 38179639156 on main `0585c134` — green. The earlier red Clippy run of this round was fixed at root (`d57346d`: cfg(test) the in-memory verifier; doc-list prefix) and re-verified; no lint was disabled. |
| 8 | Rust tests (Windows + macOS) | **PASS (CI)** | CI | `ci.yml` → `rust-native` matrix: green in the same run on `windows-latest` and `macos-latest`. |
| 9 | Version consistency | **PASS** | local + CI | All five fields equal `1.0.8-beta` (package.json, both package-lock.json fields, Cargo.toml, tauri.conf.json); `version-guard` is green on main `0585c134`. Changelog entry dated 2026-10-12; README examples carry the current version. |
| 10 | E2E — workflows A–J + visual regression | **PASS** | local + CI | `npm run test:e2e` — **66 passed** (was 64; +2 new update-integrity tests, see §4). Visual set includes both themes with the strengthened theme assertions (§5). |
| 11 | Deterministic performance invariants | **PASS** | local + CI | `npm run test:perf` — 0 unrelated card mutations in a 1000-event burst (contract 0); 0 persistence writes in a 100-event cadence (bound 12); wall-clock informational only (§6). |
| 12 | Self-update version/architecture fixtures | **PASS** | local | E2E Workflows I + J (7 tests): valid checksummed update, malformed feed, channel filter, incompatible-arch-only, missing manifest, partial manifest, wrong published digest. |
| 13 | Signature-verification integration tests | **PASS (Rust layer); delivery-UI wiring pending** | CI (Rust) + local (E2E) | See §4 for the scenario matrix and the honest split between what the browser E2E can observe and what the Rust suite enforces. |
| 14 | Live resolver smoke | **SKIPPED by design** | opt-in | `network-smoke.yml` — weekly/manual only; never a PR gate. Run before tagging: `npm run test:live`. |

CI enforcement on main is green for the integration commit `0585c134`
(run 38179639156: version-guard, frontend, rust, rust-native ×2, e2e, perf
— all success, no skipped required job) and for the release PR head
`33fb6d5` (run 38179342264). Nothing was downgraded to warning-only; the
only `continue-on-error` in the tree is `cargo audit` in `security.yml`,
advisory by documented policy (RustSec baseline triage), not a code gate.

## 3. Android signing: hardcoded password removed (operator coordination required)

`release.yml` no longer contains any keystore-password literal. Every
`keytool`/gradle/apksigner invocation in the Android job reads
`ANDROID_KEYSTORE_PASSWORD` from step-level
`env: ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}`:

- keystore restore validation (`keytool -list ... -storepass "$ANDROID_KEYSTORE_PASSWORD"`),
- certificate SHA-256 fingerprint guard (unchanged pin
  `b0fd578d…cbdf27`, alias `fress` validation preserved),
- the Tauri gradle build (`TAURI_ANDROID_KEYSTORE_PASSWORD` /
  `TAURI_ANDROID_KEY_PASSWORD` exported from the same env var inside the
  script, never baked into its text),
- `apksigner sign` (`--ks-pass "pass:$ANDROID_KEYSTORE_PASSWORD"`).

Fail-closed behavior: the job errors immediately when the secret is
absent, when it cannot open the keystore, or when the fingerprint does not
match the permanent key. No secret is echoed into diagnostics, and
`ANDROID_KEYSTORE_B64`'s decoded contents are never printed or uploaded.
Other workflows (`ci.yml`, `security.yml`, `author-guard.yml`,
`network-smoke.yml`) contain no keystore references at all — debug/PR runs
never see signing material.

**COORDINATION — required before the NEXT Android release** (the in-flight
v1.0.8-beta tag push predates this change and completes with the old
workflow): the repository must set `ANDROID_KEYSTORE_PASSWORD` to a NEW
STRONG password, rotating it on the existing keystore with
`keytool -storepasswd` + `keytool -keypasswd` (identity and certificate
preserved; never mint a new keystore), and update `ANDROID_KEYSTORE_B64`
with the rotated file. The full four-step procedure is in
docs/quality-gates.md §2 ("Android signing secrets"). The old short
password appeared in past CI command lines and must be treated as exposed;
until the rotation lands, the Android job fails closed by design (the
error names the missing secret).

## 4. Artifact-signature contract: scenario matrix

The delivery-layer integrity contract (checksum gate) is enforced and
E2E-proven; the minisign signature layer is implemented and tested natively
but NOT yet wired into the delivery UI (documented limitation,
CODE_SIGNING.md — routed to the self-update owner, docs/quality-gates.md
§8 finding 1). Per scenario:

| # | Scenario | Proven where | Result |
|---|---|---|---|
| 1 | Valid compatible update, valid checksum, valid signature | E2E `i-self-update.spec.ts` (valid tag) + Rust genuine-signature test | pill → checksummed download with published digest → manager row; native verification passes over exact artifact bytes |
| 2 | Missing checksum manifest | E2E (missing SHA256SUMS.txt → 404) | releases page + unverifiable hint; registry empty; nothing downloaded |
| 3 | Missing signature document | **Rust layer** (malformed/empty signature documents rejected, not panicked) | no UI path fetches `.sig` yet — wiring pending (finding 1) |
| 4 | Correct checksum, invalid signature | **Rust layer** (flipped bit, truncated artifact, wrong-key signature all refuse) + E2E checksum-mismatch analog (wrong published digest → transfer fails kind=checksum, never verified, history shows error, no external open, Retry is fresh) | no failed verification can leave "verified" or execute |
| 5 | Signature attached to a different artifact/version | **Rust layer** (streaming verifier over the real file refuses tampered/mismatched bytes; the command contract requires the sidecar from the SAME release) | wiring pending at UI level (finding 1) |
| 6 | Incompatible architecture-only release | E2E (ARM-only release) | pill shows, click opens releases page, registry empty, no download |
| 7 | Malformed version feed | E2E (unparsable tag feed) | "check unavailable" fail-closed contract, no pill, no download, no crash |
| 8 | Network failure → successful Retry | E2E workflow D (fresh Retry re-dispatch, resume=false) + new update-flow test (fresh retry targets the same update asset) | recovery path proven on the shared download pipeline |

Every E2E assertion in this matrix checks observable results — UI labels,
persisted history JSON, bridge download registry, opener log — never "the
mock was called". A failed verification cannot produce a "verified" status:
the only `verified:true` path is a successful engine-verified completion,
and both mismatch tests assert the negative in UI, registry and history.

## 5. Visual authenticity

21 baselines (Linux/Chromium, `deviceScaleFactor: 1`, fonts awaited,
animations disabled, threshold `maxDiffPixelRatio: 0.02`): catalog light +
dark at 390/768/1366/1600/1920 px, Privacy Pack light + dark, detail modal,
download manager (active + failed), command palette, five Persian RTL
screens, 500-entry scale.

STRENGTHENED this round: every capture now asserts its claimed theme
immediately before the screenshot through two independent signals — the
app's theme class on `<html>` AND the computed `colorScheme` token
(light: class absent + `colorScheme: light`; dark: both present). The
settings popover is closed and waited hidden after a theme switch. The
suite passes unchanged with these assertions, which proves the existing
baselines depict the themes their names claim.

## 6. Performance evidence

Same-machine, same-day run on the integrated build
(`scripts/perf/results/latest.json`) vs baseline
(`scripts/perf/baselines/catalog.json`):

| Measurement | Baseline | Integrated | Note |
|---|---|---|---|
| Unrelated card mutations, 1000-event burst | 0 (contract 0) | **0** | blocking invariant holds |
| Persistence writes, 100-event cadence | 0 (bound 12) | **0** | blocking invariant holds |
| Initial render → usable catalog (575 entries) | 2070 ms | 1946 ms | informational |
| Search latency (3 queries) | 113/17/15 ms | 116/35/58 ms | informational |
| Grid→table / table→grid | ~927/969 ms | 970/993 ms | informational |
| Load with 200-item history | 1870 ms | 1804 ms | informational |

The deterministic invariants are the gates and they hold; wall-clock deltas
are within machine noise and **no speed claim is made** — the changes since
the baseline are structural (resolver rework, i18n, updater trust chain),
not a performance pass.

## 7. Platform coverage truth table

| Platform | What is proven | What is NOT proven |
|---|---|---|
| Linux | Frontend gates, Rust suite, browser E2E + visual (authoritative platform), perf invariants — all CI-green on `0585c134` | Packaged-app smoke (installer handoff) — manual |
| Windows | Rust engine tests CI-green (`rust-native`) | Browser-level behavior (WebView2 ≠ Chromium) — manual smoke required |
| macOS | Rust engine tests CI-green (`rust-native`) | Same as Windows (WKWebView) |
| Android | Release-time build + signing identity guard in `release.yml`; signing identity preserved via fingerprint pin | **No automated Android gate** — device install, storage, back gesture, RTL system settings are manual; nothing Android-specific is claimed verified. Windows ARM64 and physical Android devices did NOT run any test in this round — fixture-simulated selection logic is the only cross-arch evidence |

## 8. Manual / not-yet-verified (must not be described as verified)

- Screen-reader pass (NVDA/VoiceOver) over catalog, palette, dialogs.
- Real-device Android validation of a produced APK (including the
  update-over-install path the signing identity protects).
- Windows/macOS packaged-app smoke (WebView2/WKWebView rendering).
- Real-network download conditions (resume across drops, IPv6-only,
  captive portal) — the live smoke is opt-in and was not run against this
  candidate.
- Publisher signing: Windows Authenticode remains unconfigured (known
  "Unknown publisher" state, documented); macOS notarization not exercised
  in QA; Android signing exercised only through CI with secrets configured
  in the protected environment — verify once with the rotated password.
- The minisign signature layer end-to-end through the UPDATE UI (blocked
  on finding 1's wiring; native verification is tested in Rust).

## 9. Verdict

All gates that can run in this environment pass on the integrated
candidate; Linux/Windows/macOS CI is green on the integration commit; the
remaining platform claims are honestly scoped in §7/§8. The candidate is
release-ready **conditional on**: (a) the maintainer completing the
Android password rotation + `ANDROID_KEYSTORE_PASSWORD` secret before the
next Android release (the current job fails closed until then, by design),
(b) the manual items above getting recorded runs before being described
anywhere as verified, and (c) finding 1 (signature-verification wiring)
progressing per the self-update owner's plan — the SHA-256 gate remains
the enforced in-app integrity contract until it lands.
