# Stable-release hardening round — evidence (2026-10-15)

Status: **all deep-review findings fixed; the webview's last unrestricted
primitive removed; TypeScript strict enforced; 199 Rust + 596 unit + 70 E2E
green; live per-app audits 0 errors.** One PR (`fix/stable-release-hardening`)
awaits owner merge. Nothing here is inferred from earlier rounds: every gate
below was re-run against this branch during this round.

Mandate: ready the app for a stable/public release — leave no flaw or hole.
The deep code review (recorded 2026-10-14) had reported six defects with the
explicit note "reported, NOT fixed"; this round fixes every one of them, adds
regression tests, removes one architectural hole the review had flagged as a
hardening gap, and re-proves the full validation chain.

---

## 1. Defects fixed (each with a focused regression test)

| # | Finding (was: reported only) | Fix | Test |
| --- | --- | --- | --- |
| 1 | Windows all-dots filename finalize failure: `sanitize_filename("...")` survived (only `.`/`..` collapsed) and reached `CreateFile`, which refuses or mangles dot-runs; trailing dots/spaces are dropped by Windows at file creation, so the recorded path could lie about the disk | trailing dots/spaces stripped, every dot-run collapses to `download.bin` (`.gitignore` and version strings untouched; `NUL.` still reserved) | `all_dot_runs_collapse_to_the_safe_default`, `trailing_dots_and_spaces_strip_to_the_name_windows_will_create`, `content_disposition_dot_run_filename_collapses` |
| 2 | F-Droid package id interpolated into two pinned-host URLs without validation | `valid_fdroid_pkg` admits exactly the store grammar (ASCII alnum + `.` + `_`); `../../repo`, spaces, percent-escapes, non-ASCII refused at the command boundary | `fdroid_pkg_gate::admits_real_fdroid_package_ids`, `refuses_empty_and_path_rewriting_ids` |
| 3 | `evictFailedLookups` deleted by key after awaiting — a replacement lookup stored mid-await got evicted instead of the stale failure (comment promised otherwise) | the doom list carries the inspected promise; the delete fires only if the map still holds exactly it | `evictFailedLookups.test.ts` (4 cases incl. the replacement-mid-await race) |
| 4 | Queued-cancel orphan: cancel/promote matched by URL, so the same file queued for two folders made one cancel evict the sibling's queue entry (its row stuck "queued" forever) and one promotion remove two rows | `QueuedDownload.localId` (required) binds queue entry to panel row; `removeById` + identity-based promotion | `downloadQueue.test.ts` "cancels by panel identity…" + all prior cases updated to the required-contract shape |
| 5 | opener open-path/reveal unscoped (medium hardening gap): capability granted `opener:allow-open-path` / `opener:allow-reveal-item-in-dir` with no path scope — an unrestricted open/execute primitive for the webview | replaced by native `open_download_file` / `reveal_download_file` backed by `download_open.rs`: admission = canonical platform default download dir ∪ persisted LRU ledger (cap 32) of dirs a download actually used or the user picked (`record_download_directory`); grants removed from the capability file; the security validator now FAILS if either grant reappears and requires frontend evidence for the three new commands | Rust `download_open::tests` (8 cases: file/dir admission, ledger LRU round-trip, corrupt-ledger recovery, default-dir skip, symlink resolution, sibling-prefix refusal); `openRevealBoundary.test.tsx` (5 cases: wiring, reveal→parent fallback, browser-mode no-op); E2E bridge records `openedPaths` |
| 6 | TS strict mode disabled (medium quality) | `strict`, `noUnusedLocals`, `noImplicitReturns` ON in tsconfig; 54 findings fixed (incl. `AddAppModal` assigning `undefined` to the required `githubUrl: string` — `''` now, matching the documented falsy-means-absent convention; export preview's unreachable `anchor`; persisted-cache `null` cast) | `npx tsc --noEmit` clean at strict — now a CI gate, not an aspiration |

Also fixed en passant: the persisted resolver-failure read path
(`resolveCache.loadPersisted`) returned a `null` hit through an `as` cast
into the digest revalidator; it now returns `null` explicitly with the
contract spelled out.

## 2. Validation chain (re-run on this branch)

| Gate | Result |
| --- | --- |
| `cargo test --lib` (host) | **199 passed / 0 failed** |
| `cargo fmt --check` | clean |
| `cargo clippy --lib --tests` | 0 warnings |
| `npx tsc --noEmit` (strict + noUnusedLocals + noImplicitReturns) | clean |
| `npx vitest run` | **596 passed / 2 skipped** (live probes) |
| `npm run build` (production) | ok |
| `npm run validate:security` | PASSED — now also enforces the absence of the two opener grants |
| `npm run validate:catalog` | 0 errors / 13 warnings (pre-existing advisory set) |
| `npx playwright test` (real Chromium against the production build) | **70 / 70 passed** |
| `scripts/audit-downloads.ts` desktop | 145 rows, 1 skip, 6 honest package-channel rows, 0 failures |
| `AUDIT_ANDROID=1 scripts/audit-downloads.ts` | **35 rows, 0 skips, 0 package-channel — every Android-capable catalog app resolves a direct APK** |
| `scripts/audit-catalog-live.ts` (every app × every claimed registry) | **0 errors / 0 warnings**; 8 INFO notes are sandbox network blocks (VLC, Inkscape, OBS, qBittorrent 403 etc.), each previously verified reachable with a browser UA |

## 3. Emulator / simulator — honest scope statement

This sandbox has **no KVM** (`/dev/kvm` absent), 2 CPUs, 3.9 GB RAM and
~1.3 GB free disk, and it runs **Linux only** (no macOS/Xcode). An Android
emulator needs KVM plus an SDK/NDK install (~2.2 GB) that cannot fit; an iOS
simulator needs macOS. **No emulator or simulator run happened in this
round, and none is claimed.** The closest real executions actually performed
here are:

1. the production build served to a real Chromium browser: 70/70 E2E
   scenarios, including the download manager, queue/cancel, self-update
   trust boundaries, RTL and 500-entry scale;
2. the real Rust engine exercised directly: 199 native tests with real
   loopback HTTP mock servers;
3. live network audits: every catalog app's real upstream release endpoints
   re-verified (desktop + Android rows above).

Android-target compile assurance for this branch's changes: the new
boundary module is cfg-free `std` code; the mobile call surface was verified
against `tauri-plugin-opener 2.5.5` source — `open_path` ships a
`#[cfg(mobile)]` variant with the identical signature, and
`reveal_item_in_dir` compiles for all targets (runtime-unsupported on
Android, which lands in the existing honest error/fallback path). The full
`cargo check --target aarch64-linux-android` was attempted and stops at
`ring`'s build script requiring the NDK C toolchain (absent here); CI runs
the Rust matrix on the PR, and the Android Gradle pipeline itself was proven
end-to-end in the 2026-10-12 round (debug APK built and aapt-verified).

## 4. Real-device results vs mocked tests

Unchanged from the standing record, restated for honesty: the 2026-10-12
round's results came from a **real physical Android device and real Linux
desktop runs**; everything in this round's §2 is **sandbox-real execution
(host tests, real browser, live network)** — not device runs, and clearly
labeled as such. No mock result is presented as a device result anywhere in
this document.

## 5. Interaction with open PRs

- **#92** (Agent 5, frontend correctness) also touches
  `src/lib/selfUpdate.ts` / `officialResolvers.ts` / `useSelfUpdate.ts`.
  This branch's changes to those files are minimal (sumatra guard,
  F-Droid-adjacent resolver typing, the reveal-command swap in
  `useSelfUpdate.ts`) and textually independent; expect trivial conflicts at
  most in `useSelfUpdate.ts`.
- **#94** (Agent 6, native round-3) appends tests at the end of
  `download_finalize.rs`; this branch edits `sanitize_filename`
  (mid-file, ~30 lines) — no textual overlap.
- **#93** is docs-only (CODE_SIGNING/README) — no overlap.
