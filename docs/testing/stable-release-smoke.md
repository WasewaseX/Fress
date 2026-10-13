# Stable release qualification matrix (stable v1.0.0)

Scope: the reusable manual qualification record for a Fress **stable**
release. Every released user journey — install, first start, download,
open, update, channel migration, persistence, recovery — is a row here.
This document complements the automated suites; it does not replace them.

The companion document `docs/testing/download-open-smoke.md` covers the
download-to-open boundary in full depth (fixtures, per-handler notes).
This file is the release-level view: what a release owner must be able to
say honestly before calling a stable build qualified.

## Read this first: evidence classes

Every row names exactly ONE test method. A row is only satisfied by the
class it names — never by a weaker one.

| Class | Meaning | Where it lives |
|---|---|---|
| **mock** | Pure-frontend or unit-level proof. The production code is driven against test doubles; no OS and no installer participates. | `src/**/__tests__`, vitest |
| **unit** | Native/Rust-layer proof. Real engine logic, no UI. | `src-tauri` Rust suites (CI) |
| **mocked-e2e** | The production frontend in Chromium against the production bundle proves exact IPC requests and honest failure states. The OS call is a test double. | `tests/e2e/*.spec.ts` |
| **packaged-os** | A human runs a PACKAGED Fress build and the real operating system actually performs the action (installer executes, shell handler opens, Gatekeeper judges, updater manifest flows). | this file, filled rows |
| **physical-device** | A human runs the Android app on real hardware (or an emulator, noted) and the real system package installer / share sheet performs the handoff. | this file, filled rows |
| **not verified** | No evidence exists. The row stays visibly NOT RUN or UNAVAILABLE. | this file |

**Two rules that can never be waived:**

1. A green mocked `openPath` call proves the frontend asked correctly. It
   says nothing about a real shell handler, a real installer, or
   Gatekeeper. No mocked row may ever be reported as a platform result.
2. A successful Gradle build, an APK inspection, or a signing-config
   check is build evidence, not installer evidence. Android installer
   consent, unknown-source gating and the FileProvider handoff are only
   proven by a physical-device row.

## Row rules

1. **Fixtures only.** Never use an unknown production installer as a test
   fixture. Build or download a known, harmless fixture under controlled
   conditions and record its exact name and SHA-256 in the row.
2. **Run the automated suite first** on the same build
   (`npm run test:e2e`), so a UI regression is never confused with a
   platform finding.
3. **Fill every column** when executing: status, tester, UTC date, OS
   build, artifact filename + version, fixture hash, evidence reference.
   A row without a tester and date is NOT RUN by definition.
4. **Statuses:** `PASS`, `FAIL`, `NOT RUN` (nobody executed it),
   `UNAVAILABLE` (the environment cannot execute it — name the blocker).
5. Failures are reports to the owning agent with exact reproduction, not
   fix-it-yourself notes (see `docs/quality-gates.md`).
6. The evidence reference must be reproducible by a stranger: a CI run
   URL, a command + exit code, or a path to a stored log/screenshot.

## Column layout used by every table below

| Column | Meaning |
|---|---|
| Platform / device | OS, version, edition; for Android, device model + Android version |
| Arch | x86_64 / arm64 / armv7 / i686 |
| Artifact | exact release filename (with version) used for the row |
| Steps | what was performed, in order |
| Expected | the observable result the release contract promises |
| Actual | what really happened (empty = not executed) |
| Method | evidence class from the table above |
| Tester / date | who and UTC date (empty = not executed) |
| Evidence | reference reproducible by a stranger |
| Status | PASS / FAIL / NOT RUN / UNAVAILABLE |

For readability the tables below use short column heads.

## S0. Automated evidence already on record (candidate 93f87ce)

These rows are pre-filled by the qualification round itself. They are
class **mock / unit / mocked-e2e** evidence only. They never substitute
for S1–S15 packaged rows. Candidate: `main` @ `93f87ce` (source version
1.0.12-beta; the stable build ships from the release tag that carries the
1.0.0 version bump).

| # | Scope | Command | Result | Evidence |
|---|---|---|---|---|
| S0.1 | Types | `npm run typecheck` | PASS, exit 0 | local run 2026-10-13 |
| S0.2 | Unit suite | `npm test` | 707 passed / 2 skipped (51 files), exit 0 | local run 2026-10-13 |
| S0.3 | Catalog validator | `npm run validate:catalog` | PASS, exit 0 | local run 2026-10-13 |
| S0.4 | Security config validator | `npm run validate:security` | PASS, exit 0 | local run 2026-10-13 |
| S0.5 | Version coherence | `npm run validate:versions` | PASS on `main` @ 93f87ce, exit 0 (development mode) | local run 2026-10-13 |
| S0.6 | Production build | `npm run build` | PASS, exit 0 | local run 2026-10-13 |
| S0.7 | Full E2E (Workflows A–K, D2, visual) | `npx playwright test` | 114 passed / 0 failed, exit 0, 13.4 min | local run 2026-10-13 |
| S0.8 | Visual baselines | `npm run test:visual` | 24 passed, exit 0 | local run 2026-10-13 |
| S0.9 | Perf invariants | `npm run test:perf` + `npm run perf:catalog` | both PASS, exit 0 | local run 2026-10-13 |
| S0.10 | Rust fmt / clippy / tests (linux) | CI job | PASS | run 38421837523 |
| S0.11 | Rust tests (windows-latest) | CI job | PASS | run 38421837523 |
| S0.12 | Rust tests (macos-latest) | CI job | PASS | run 38421837523 |
| S0.13 | npm audit (prod deps) | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities, exit 0 | local run 2026-10-13 |
| S0.14 | Secret scan | detect-secrets 1.5.0, all files | 24 findings, all triaged benign (secrets *references*, public keys, test fixtures, doc text); no committed secrets | local run 2026-10-13 |
| S0.15 | Published v1.0.12-beta bytes vs manifest | `sha256sum -c SHA256SUMS.txt` on all 22 downloaded assets | 21/21 entries OK, 0 failed | local run 2026-10-13 |
| S0.16 | Updater signatures on v1.0.12-beta bytes | `python3 scripts/ci/verify-release-artifacts.py <assets> v1.0.12-beta 1.0.12-beta WasewaseX/Fress` | FINAL ARTIFACT AUDIT PASSED, exit 0; 5/5 minisign sidecars verified; latest.json 8/8 URLs correct | local run 2026-10-13 |

Note on S0.5: after PR #74 (Android adapter) merges, its new plugin crate
`src-tauri/plugins/fress-open` must carry the canonical app version or
S0.5 fails by design — that is the validator doing its job (reported to
the PR owner; the fix is a one-line version bump in that crate).

## S1. Clean installation of stable v1.0.0

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S1.1 | Windows 11 | x86_64 | `Fress_1.0.0_x64-setup.exe` | Download from Releases, verify SHA-256, run installer, accept per-user install | Installer completes; app launches from Start menu | — | packaged-os | — | — | NOT RUN |
| S1.2 | Windows 11 | arm64 | `Fress_1.0.0_arm64-setup.exe` | same as S1.1 | Installer completes; app launches natively (arm64 binary) | — | packaged-os | — | — | NOT RUN |
| S1.3 | Windows 10/11 | x86_64 | `Fress_1.0.0_x64_en-US.msi` | `msiexec /i Fress_1.0.0_x64_en-US.msi` | MSI completes; app present | — | packaged-os | — | — | NOT RUN |
| S1.4 | Windows 10/11 | x86_64 | `Fress_1.0.0_x64-portable.zip` | Extract zip, run exe | App runs without installation | — | packaged-os | — | — | NOT RUN |
| S1.5 | macOS 14+ (Apple Silicon) | arm64 | `Fress_1.0.0_aarch64.dmg` | Mount dmg, drag to Applications, launch | App launches; see S6.1 for Gatekeeper | — | packaged-os | — | — | NOT RUN |
| S1.6 | macOS 14+ (Intel) | x86_64 | `Fress_1.0.0_x64.dmg` | same as S1.5 | App launches | — | packaged-os | — | — | NOT RUN |
| S1.7 | Ubuntu 24.04 LTS | x86_64 | `Fress_1.0.0_amd64.AppImage` | chmod +x, run | App launches | — | packaged-os | — | — | NOT RUN |
| S1.8 | Ubuntu 24.04 LTS | x86_64 | `Fress_1.0.0_amd64.deb` | `sudo apt install ./Fress_1.0.0_amd64.deb` | Package installs; app in menu | — | packaged-os | — | — | NOT RUN |
| S1.9 | Fedora 40 | x86_64 | `Fress-1.0.0-1.x86_64.rpm` | `sudo dnf install ./Fress-1.0.0-1.x86_64.rpm` | Package installs; app in menu | — | packaged-os | — | — | NOT RUN |
| S1.10 | Android 14 device | arm64 | `Fress_1.0.0_arm64.apk` | Sideload via system installer | Install completes; app launches | — | physical-device | — | — | NOT RUN |
| S1.11 | Android 14 device | arm64 | `Fress_1.0.0_universal.apk` | same as S1.10 | Install completes | — | physical-device | — | — | NOT RUN |

## S2. Fresh start and version badge

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S2.1 | any (first packaged launch) | any | the S1 artifact | Launch the freshly installed app | Header shows the exact released version, e.g. `v1.0.0`; no stale prerelease label | — | packaged-os | — | — | NOT RUN |
| S2.2 | mocked frontend | any | n/a | Read the rendered header badge against the bundled version | Badge text equals the built package version | Badge equals bundle version on the 93f87ce build | mocked-e2e | Agent 6, 2026-10-13 | z-visual suite within S0.7 | PASS (mocked only) |

## S3. Download, cancellation, retry and checksum failure

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S3.1 | any desktop | any | packaged build | Download a fixture; cancel mid-transfer; retry | Cancel stops quietly; retry is a fresh request, no duplicate row corruption | — | packaged-os | — | — | NOT RUN |
| S3.2 | mocked frontend | any | n/a | Drive cancel/retry against the bridge | Same contract as S3.1 at IPC level; row states honest | 6/6 d-download-states + D2 suite green | mocked-e2e | Agent 6, 2026-10-13 | S0.7 (suites d-*) | PASS (mocked only) |
| S3.3 | mocked frontend | any | n/a | Publish a wrong SHA-256 entry; download completes | kind=checksum failure; file never counted verified; retry is a fresh request | pinned in E2E + unit layers | mocked-e2e | Agent 6, 2026-10-13 | i-self-update "wrong published hash" | PASS (mocked only) |
| S3.4 | native engine | any | n/a | Checksum-mismatch completion against the registry | No trusted completed-artifact record is created for the mismatched file | pinned by Rust engine tests | unit | CI, run 38421837523 | S0.10–S0.12 | PASS (unit only) |

## S4. Open / reveal for completed desktop downloads

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S4.1 | Windows 11 | x86_64 | packaged build | Complete a fixture download; click Open; click Show in folder | The OS opens the exact file / reveals the exact path in Explorer | — | packaged-os | — | — | NOT RUN |
| S4.2 | macOS 14+ | arm64 | packaged build | same as S4.1 | Finder reveals/opens the exact file | — | packaged-os | — | — | NOT RUN |
| S4.3 | Ubuntu 24.04 | x86_64 | packaged build (AppImage) | same as S4.1, plus a missing-handler case | File manager opens; missing-handler failure is an honest typed message, no crash | — | packaged-os | — | — | NOT RUN |
| S4.4 | mocked frontend | any | n/a | Workflow K + D2 open journeys | Exact-path open, reveal fallback, refusal taxonomy, single-flight, AppImage-only fallback | 30 open-journey E2E tests green | mocked-e2e | Agent 6, 2026-10-13 | S0.7 (download-open + d-download-open) | PASS (mocked only) |

## S5. Windows specifics

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S5.1 | Windows 11 | x86_64 | `Fress_1.0.0_x64-setup.exe` | Run the setup installer | Blue "Unknown publisher" / "Windows protected your PC" warning appears (installer is NOT Authenticode-signed — README and CODE_SIGNING.md say this); after More info → Run anyway the install completes | — | packaged-os | — | — | NOT RUN |
| S5.2 | Windows 11 | x86_64 | `Fress_1.0.0_x64_en-US.msi` | Run the MSI | MSI installs; publisher warning reflects the same unsigned state | — | packaged-os | — | — | NOT RUN |
| S5.3 | Windows 11 | x86_64 | `Fress_1.0.0_x64-portable.zip` | Extract and run | Runs without install; SmartScreen may prompt on first run | — | packaged-os | — | — | NOT RUN |
| S5.4 | published v1.0.12-beta bytes | n/a | `Fress_1.0.12-beta_x64-setup.exe` + `_arm64-setup.exe` | Inspect PE certificate table | No certificate table (no Authenticode) — matches the documented claim | verified byte-for-byte during the round-2 release audit | unit | Agent 6, 2026-10-13 | CODE_SIGNING.md current audit + S0.16 | PASS (byte inspection only) |

## S6. macOS specifics

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S6.1 | macOS 14 (Apple Silicon) | arm64 | `Fress_1.0.0_aarch64.dmg` | Mount, copy to Applications, first launch | Unsigned/unnotarized dmg: right-click → Open confirmation required (newer macOS may refuse from Finder); app then runs | — | packaged-os | — | — | NOT RUN |
| S6.2 | macOS 14 (Intel) | x86_64 | `Fress_1.0.0_x64.dmg` | same as S6.1 | same as S6.1 | — | packaged-os | — | — | NOT RUN |
| S6.3 | published v1.0.12-beta bytes | n/a | both dmg files | Check signature state | dmgs are unsigned and unnotarized (Apple credentials not configured; the workflow ran its unsigned fallback) — matches README/CODE_SIGNING claims | verified in the round-2 release audit | unit | Agent 6, 2026-10-13 | CODE_SIGNING.md current audit | PASS (byte inspection only) |
| S6.4 | macOS 14 | any | packaged build | Open a completed fixture download from the manager | Open/reveal works; dmg/pkg/archive classes pass through to the opener unmodified | — | packaged-os | — | — | NOT RUN |

## S7. Linux specifics

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S7.1 | Ubuntu 24.04 | x86_64 | `Fress_1.0.0_amd64.AppImage` | Run without pre-chmod | AppImage runs (Fress' validated launcher may set the exec bit on its own registered artifact); or an honest refusal if the environment forbids it | — | packaged-os | — | — | NOT RUN |
| S7.2 | Ubuntu 24.04 | x86_64 | `Fress_1.0.0_amd64.deb` | Install, launch, open a completed fixture | deb handler opens the file | — | packaged-os | — | — | NOT RUN |
| S7.3 | Fedora 40 | x86_64 | `Fress-1.0.0-1.x86_64.rpm` | Install, launch, open a completed fixture | rpm handler opens the file | — | packaged-os | — | — | NOT RUN |
| S7.4 | Ubuntu 24.04 | x86_64 | `Fress_1.0.0_x64-portable.zip` (archive shape) | Extract, run, open a completed fixture | Archive use works; no install integration required | — | packaged-os | — | — | NOT RUN |
| S7.5 | Ubuntu 24.04 (minimal, no file manager handler) | x86_64 | packaged build | Open a completed file whose MIME has no handler | Typed, honest failure message; row stays retryable; no crash, no retry loop | — | packaged-os | — | — | NOT RUN |

## S8. Android specifics

The Android open boundary: `Open` hands the exact final path to the
registry-validated adapter command below the shared boundary; `.apk`
artifacts route to the system package installer, everything else to a
viewer/share handoff. The in-app updater never delivers Android APKs
(no updater sidecar) — the releases page is the honest path.

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S8.1 | Android 14 (physical) | arm64 | `Fress_1.0.0_arm64.apk` | Download a fixture APK in-app; tap Open | System package-installer consent screen appears for the exact downloaded file | — | physical-device | — | — | NOT RUN |
| S8.2 | Android 14 (physical) | arm64 | fixture APK | Confirm install on the consent screen | Install completes; launcher shows the fixture app | — | physical-device | — | — | NOT RUN |
| S8.3 | Android 14 (physical) | arm64 | fixture APK | Tap Open with "install unknown apps" permission OFF for Fress | The OS unknown-source gate explains the block; the app surfaces the refusal honestly; no retry loop | — | physical-device | — | — | NOT RUN |
| S8.4 | Android 14 (physical) | arm64 | fixture APK | Cancel on the installer consent screen | Quiet cancel; row stays completed and openable | — | physical-device | — | — | NOT RUN |
| S8.5 | Android 14 (physical) | arm64 | fixture non-APK (pdf/png/zip) | Download fixture; tap Open; try share/viewer | Viewer or share sheet receives the exact file (no Show-in-folder action on Android) | — | physical-device | — | — | NOT RUN |
| S8.6 | mocked frontend | any | n/a | D2 Android journeys: Open offered, Show hidden, exact path to the adapter command; launcher never fires on Android | pinned; adapter command recorded with the exact final path | green in S0.7 | mocked-e2e | Agent 6, 2026-10-13 | d-download-open (Android describe block), download-open K-Android | PASS (mocked only) |
| S8.7 | unit (frontend) | any | n/a | Adapter binding tests: desktop keeps the opener plugin; Android routes through the validated command; typed refusals preserved | pinned | 8 flow tests green in S0.2 | mock | Agent 6, 2026-10-13 | src/lib/__tests__/downloadOpenFlow.test.tsx (PR #74) | PASS (mock only; NOT installer evidence) |

**Never mark S8.1–S8.5 PASS because a Gradle task, an APK inspection, or a
unit test succeeded.** Build success is not installer evidence; only the
physical rows count for installer behavior.

## S9. Catalog actions and Add-app custom entries

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S9.1 | any desktop | any | packaged build | Resolve a catalog app, open details, favorite it | Actions work on the packaged build | — | packaged-os | — | — | NOT RUN |
| S9.2 | any desktop | any | packaged build | Add a custom app entry (valid + invalid URL); restart | Valid entry persists; invalid URL shows the translated inline error; no crash, no undefined-URL persistence bug | — | packaged-os | — | — | NOT RUN |
| S9.3 | mocked frontend | any | n/a | Add App crash/persistence regressions: URL strings (possibly empty, never undefined), inline error not native bubble, star clamping, duplicate-add guard | pinned | green in S0.2 (uiRegressionsRound8) + S0.7 | mocked-e2e | Agent 6, 2026-10-13 | uiRegressionsRound8.test.tsx, S0.7 | PASS (mocked only) |
| S9.4 | mocked frontend | any | n/a | Table deletion: inline confirm instead of immediate delete; cancel keeps the app and restores focus; confirm deletes exactly once | pinned | green in S0.2 | mock | Agent 6, 2026-10-13 | uiRegressionsRound8.test.tsx | PASS (mocked only) |

## S10. Stable / Beta / Alpha channel selection

Channel semantics (pinned by unit + E2E tests): Stable sees only
non-prerelease releases; Beta adds beta/rc; Alpha (pre-stable default)
sees everything published. A release flagged prerelease on GitHub is
excluded from the Stable channel even if its tag looks stable. Unparsable
tags match no channel.

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S10.1 | mocked frontend | any | n/a | Stable channel with a newer prerelease published | Prerelease hidden; switching channels surfaces it | pinned | mocked-e2e | Agent 6, 2026-10-13 | i-self-update "Stable hides the prerelease" | PASS (mocked only) |
| S10.2 | any desktop | any | packaged build | Switch channels in Settings on the packaged build | Toast confirms the channel; re-check applies it | — | packaged-os | — | — | NOT RUN |
| S10.3 | unit | any | n/a | releaseMatchesChannel stage matrix + malformed-tag rejection | pinned | green in S0.2 | mock | Agent 6, 2026-10-13 | selfUpdate.test.ts | PASS (mock only) |

## S11. Updater flows

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S11.1 | any desktop | any | packaged build | Online update check against a real newer release | Pill appears; delivery passes checksum + signature gates; "verified" only after the native signature check; never auto-launched | — | packaged-os | — | — | NOT RUN |
| S11.2 | any desktop | any | packaged build | Offline check | Quiet "unavailable" note, no red error; no crash | — | packaged-os | — | — | NOT RUN |
| S11.3 | mocked frontend | any | n/a | Missing sidecar / partial manifest / wrong hash / ARM-only / malformed tag | Each routes honestly (releases page with reason, or no offer), never a fake verified state | pinned | mocked-e2e | Agent 6, 2026-10-13 | i-self-update suite (11 tests) | PASS (mocked only) |
| S11.4 | unit | any | n/a | planUpdateDelivery fail-closed matrix; sidecar byte-exactness; signature document shape gates | pinned | green in S0.2 | mock | Agent 6, 2026-10-13 | selfUpdate.test.ts + selfUpdateDelivery.test.ts | PASS (mock only) |
| S11.5 | native | any | n/a | verify_self_update_signature accept/refuse matrix (genuine / flipped bit / truncated / wrong key / malformed) | pinned | green in CI Rust suite | unit | CI run 38421837523 | S0.10–S0.12 | PASS (unit only) |

## S12. Stable installed version checks for the correct update

The stable channel surfaces only non-prerelease releases, so a stable
v1.0.0 install must see v1.0.0-or-later stable tags only — never the
v1.0.12-beta line.

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S12.1 | mocked frontend | any | n/a | checkForUpdate('1.0.0') on the stable channel with both v1.0.0 and a newer beta published | Only stable tags are candidates; v1.0.0 reports "latest" (nothing newer on the channel) | channel filter pinned; see S13.2 for the exact-fixture run | mocked-e2e | Agent 6, 2026-10-13 | i-self-update stable test | PASS (mocked only) |
| S12.2 | any desktop | any | packaged stable build | Manual check on the packaged stable build with only v1.0.0 published | "Up to date" for a 1.0.0 install; no beta offered | — | packaged-os | — | — | NOT RUN |
| S12.3 | release pipeline | any | n/a | Tag `v1.0.0` triggers `validate:versions --release-tag v1.0.0` | Tag equals package version; release marked non-prerelease (no beta/rc/alpha suffix) | pipeline-enforced | unit | release.yml `version` job | workflow source | PASS (pipeline design; execution pending the real tag) |

## S13. Beta-to-stable migration

Fact base (verified in source this round, `src/lib/selfUpdate.ts`):
- v1.0.0 (stable) is SemVer-OLDER than v1.0.12-beta (patch 0 < 12), so a
  beta client's newest-matching release is still v1.0.12-beta — the
  updater reports "latest" and can never offer the downgrade.
- Channel switch is manual and explicit (Settings), confirmed by a toast;
  it changes which releases are CANDIDATES, never what is installed.
- The pre-stable default channel is `alpha` (widest). The source comment
  records the intent that the default flips to `stable` when stable 1.0
  lands. **Coordination item (Agent 5):** the flip must ship with the
  stable version bump, otherwise a NEW stable install (no stored channel)
  would see v1.0.12-beta as an alpha-channel candidate and be offered a
  prerelease on day one. Reported this round; not fixable from test/docs
  scope.
- The Atom-feed fallback cannot verify stable-channel candidates and
  refuses them by design (an API outage costs one session without an
  update notice, never a wrong-channel install).

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S13.1 | mocked frontend | any | n/a | Beta client (1.0.12-beta), stable release v1.0.0 published | No update offered (v1.0.0 is SemVer-older on every channel); no silent downgrade | pinned by channel + compare tests | mock | Agent 6, 2026-10-13 | selfUpdate.test.ts (compareVersions + channel matrix) | PASS (mock only) |
| S13.2 | mocked frontend | any | n/a | checkForUpdate('1.0.12-beta') with v1.0.0 stable + v1.0.12-beta both published, beta channel | Newest beta-channel candidate is v1.0.12-beta → kind=latest | verified this round against the real implementation | mock | Agent 6, 2026-10-13 | fixture run recorded in the qualification report | PASS (mock only) |
| S13.3 | any desktop | any | packaged beta build → stable installer | User opts into stable; installs `Fress_1.0.0_*` manually | The UI explains re-checking applies the channel; the stable track begins at v1.0.0; user installs the official stable installer from the Releases page. **Current UI hint says only "Re-check for updates to apply the new channel"** — the fuller explanation is a UX follow-up for the updater owner, documented here honestly | — | packaged-os | — | — | NOT RUN |
| S13.4 | Windows 11 | x86_64 | beta `*-setup.exe` then `Fress_1.0.0_x64-setup.exe` | Install stable over the beta install | NSIS per-user install: observe whether the installer permits same-or-lower product-version replacement; record exactly what happens | — | packaged-os | — | — | NOT RUN |
| S13.5 | Windows 11 | x86_64 | beta MSI then `Fress_1.0.0_x64_en-US.msi` | Install stable MSI over beta MSI | MSI engines typically REFUSE a lower package version ("newer version already installed"); if refused, document the exact dialog and use the S13.7 procedure | — | packaged-os | — | — | NOT RUN |
| S13.6 | macOS / Linux | any | stable dmg/deb/rpm/AppImage | Install stable alongside/over beta | Record whether the package manager or bundle layout permits the transition; dmgs are drag-copy so both versions can coexist | — | packaged-os | — | — | NOT RUN |
| S13.7 | any | any | n/a | Uninstall beta, install stable (the documented fallback when an installer blocks the downgrade) | Uninstaller does NOT remove user app data (`com.fress.app` profile); favorites, custom entries, settings and download history survive into the stable install | — | packaged-os | — | — | NOT RUN |
| S13.8 | any | any | n/a | No automatic data removal for a track change | No installer or updater code path deletes user data to complete a channel switch; data deletion is only ever an explicit user action | verified by source review this round (no destructive cleanup in updater/installer wiring) | mock | Agent 6, 2026-10-13 | source review, recorded in the qualification report | PASS (review only) |

## S14. Data persistence across the install/update path

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S14.1 | Windows 11 | x86_64 | packaged build | Set favorites, custom entries, language, theme; update via installer; restart | Everything survives (profile under `%APPDATA%\com.fress.app`; installers do not touch it) | — | packaged-os | — | — | NOT RUN |
| S14.2 | macOS 14 | any | packaged build | same as S14.1 | Survives (`~/Library/Application Support/com.fress.app`) | — | packaged-os | — | — | NOT RUN |
| S14.3 | Ubuntu 24.04 | x86_64 | packaged build | same as S14.1 | Survives (`~/.config/com.fress.app` or XDG equivalent) | — | packaged-os | — | — | NOT RUN |
| S14.4 | Android 14 | arm64 | packaged build | same as S14.1; app update-over-install | Survives (app-private storage) | — | physical-device | — | — | NOT RUN |
| S14.5 | mocked frontend | any | n/a | persistence suite: serialize/deserialize round-trip, legacy-data tolerance (githubUrl undefined), queue persistence | pinned | green in S0.2 | mock | Agent 6, 2026-10-13 | downloadPersistence.test.ts, downloadItemsStore.test.ts, uiRegressionsRound8.test.tsx | PASS (mock only) |

## S15. Start/exit, restart, crash recovery

| # | Platform / device | Arch | Artifact | Steps | Expected | Actual | Method | Tester / date | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| S15.1 | Windows 11 | x86_64 | packaged build | Start; exit from the menu; relaunch; force-kill mid-download; relaunch | Clean exits; interrupted download resumes or is honestly marked failed; no zombie processes; catalog state intact | — | packaged-os | — | — | NOT RUN |
| S15.2 | macOS 14 | any | packaged build | same as S15.1 | same | — | packaged-os | — | — | NOT RUN |
| S15.3 | Ubuntu 24.04 | x86_64 | packaged build | same as S15.1 | same | — | packaged-os | — | — | NOT RUN |
| S15.4 | Android 14 | arm64 | packaged build | same as S15.1 (system kills app mid-download) | Background download state recovers honestly | — | physical-device | — | — | NOT RUN |
| S15.5 | mocked frontend | any | n/a | restore-after-restart journeys | Restored completed rows never claim trusted engine identity (negative IDs fail closed); reveal + open preserved; state honest | pinned | mocked-e2e | Agent 6, 2026-10-13 | d-download-open test J | PASS (mocked only) |

## Current qualification record for stable v1.0.0 (honest summary)

| Area | Automated evidence | Packaged/physical evidence |
|---|---|---|
| Frontend journeys (catalog, palette, downloads, open, update, privacy, import/export, themes, navigation) | 114 E2E + 707 unit + 24 visual: PASS on 93f87ce | NOT RUN (no packaged stable build exists yet) |
| Native engine + verifier | Rust fmt/clippy/test green on 3 OSes (CI 38421837523) | NOT RUN |
| Released bytes vs manifest vs signatures | 21/21 checksums + 5/5 minisign verified on v1.0.12-beta; latest.json correct | n/a (v1.0.0 bytes do not exist yet — must re-run S0.15/S0.16 against the real stable assets) |
| Windows installer UX (warning, MSI, portable) | none possible | NOT RUN |
| macOS Gatekeeper | none possible | NOT RUN |
| Linux handlers (AppImage/deb/rpm/archive/missing-handler) | none possible | NOT RUN |
| Android installer consent, unknown-sources, cancel, non-APK share | mocked adapter + bridge recording only | NOT RUN (build evidence is not installer evidence) |
| Beta→stable migration (installer behavior, data retention) | SemVer + channel + data-retention design pinned in tests / source review | NOT RUN |
| Updater end-to-end on real bytes | verified for the in-app delivery path's gates (unit + E2E) | NOT RUN |

**Blocking prerequisites before this record can be completed:**
1. Agent 5's version bump to 1.0.0 + the stable default-channel flip
   (`DEFAULT_UPDATE_CHANNEL` → `stable`) landing together — otherwise a
   new stable install would be offered the older-numbered v1.0.12-beta
   prerelease on the alpha default (reported this round).
2. The stable tag build producing `Fress_1.0.0_*` artifacts on the
   Releases page (release workflow, tag `v1.0.0`).
3. S0.15/S0.16 re-executed against the actual stable bytes.
4. A Windows, a macOS, a Linux and an Android environment for the
   packaged rows (currently UNAVAILABLE in the qualification environment:
   no physical devices and no desktop OS VMs are attached; every physical
   row stays honestly NOT RUN until a human executes it).
5. README follow-ups that can only land with the stable publication:
   (a) re-anchor the "re-verified against release `v1.0.12-beta`"
   statements to the stable release after S0.15/S0.16 pass on its real
   bytes, and (b) the version badge
   (`img.shields.io/...?include_prereleases&sort=semver`) keeps showing
   `v1.0.12-beta` after stable ships because SemVer ranks 1.0.12-beta
   above 1.0.0 — drop `include_prereleases` in the same docs pass so the
   badge names the newest STABLE release.

Any green row in this file that is not backed by the named evidence class
is a documentation bug: fix the row, not the rule.
