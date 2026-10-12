# Download-to-open smoke test matrix

Scope: the LAST mile of the Fress user journey — a completed download is
handed to the operating system and either opens, or fails with an honest,
understandable result. This document is the **manual, executable** platform
checklist that complements `tests/e2e/download-open.spec.ts` (Workflow K).

## Read this first: what a green mock does and does not prove

| Evidence class | Meaning | Where it lives |
|---|---|---|
| **UI-tested (mocked native boundary)** | The real frontend, driven in Chromium, is proven to send the exact path/operation to the native opener boundary at the right time and no earlier. The OS call itself is a test double. | `tests/e2e/download-open.spec.ts` (Workflow K), automated |
| **Native-unit-tested** | The Rust/engine layer's own tests prove its half of the contract (digest, commit path, verifier). | `src-tauri` Rust test suites, automated in CI |
| **Verified on a real desktop OS** | A human executed a row of this matrix on Windows/macOS/Linux and the OS actually opened (or honestly refused) the artifact. | This file, filled-in rows |
| **Verified on a real Android device** | A human executed the Android rows on physical hardware, including the system package-installer handoff. | This file, filled-in rows |
| **Not yet verified** | No evidence exists. Must stay visibly NOT RUN — never inferred from a mock. | This file |

**No green mock test substitutes for a missing platform test.** A mocked
`plugin:opener|open_path` resolving proves only that the frontend asked
correctly; it says nothing about a real shell handler, file manager,
quarantine gate or package installer.

## Rules for every row

1. **Fixtures only.** Never use an unknown production installer as a test
   fixture. Build or download a known, harmless fixture under controlled
   conditions (suggestions per platform below). Record the fixture's exact
   name/hash in the row when you run it.
2. **Run the automated suite first** on the same build
   (`npm run test:e2e`), so a UI-level regression is never confused with a
   platform-level finding.
3. **Fill every column** when executing: status (`PASS` / `FAIL` /
   `BLOCKED` / `NOT RUN`), tester, date, OS build, fixture hash. A row
   without a date and tester is NOT RUN.
4. **Failures are reports, not fix requests for the tester.** File them to
   the production owner with the exact journey, expected vs actual, and the
   native handler invoked (see `docs/quality-gates.md` for the standing
   defect-report format).
5. Mark `BLOCKED` (with the blocker named) when an environment
   prerequisite (handler, device, signing identity) is unavailable. Do not
   silently downgrade BLOCKED to NOT RUN or the reverse.

## Fixture sources (all harmless, known provenance)

- **Windows exe**: a "hello world" console executable you build yourself
  from a known C/Rust/Go source file; record the SHA-256.
- **Windows msi**: a minimal WiX Toolset package that installs one shortcut
  into the user's temp profile, or `msiexec`-extractable test MSI built
  locally.
- **macOS dmg/pkg**: `hdiutil create` from a folder containing one
  copy-able text file (dmg); a `pkgbuild` package with a single
  non-privileged postinstall that touches a file in `$TMPDIR` (pkg).
- **Linux deb/rpm**: `dpkg-deb --build` / `rpmbuild` of a package that
  installs one script into `/usr/local/bin` printing "fixture ok".
- **Linux AppImage**: the AppImage project's own `appimagetool` demo
  (dashboard of the reference `AppDir`), built locally.
- **zip**: any deterministic archive you created (e.g. one text file),
  SHA-256 recorded.
- **Android apk**: an APK you build from a one-activity "hello world"
  project with YOUR test keystore; record package id + signing cert
  SHA-256. Alternatively a published, known test app whose package
  identity and signing identity you verified before installing.

## Status legend

`PASS` = executed on the named OS/device with the named fixture and every
expected result observed. `FAIL` = executed, at least one expected result
not observed. `BLOCKED` = could not execute, reason named. `NOT RUN` = no
evidence yet.

---

## Automated coverage (already executed — for orientation only)

Executed 2026-10-13, Chromium (Linux CI container), production build via
`vite preview`, native boundary mocked by `tests/e2e/tauri-bridge.ts`;
`npx playwright test tests/e2e/download-open.spec.ts` → 21 passed, exit 0.

| Workflow K test | Journey contract proven (UI level) |
|---|---|
| K-A | Completed file opens: Open exists only after completion (not during queued/active/verifying), opener receives the exact path with the OS-default operation, no failure feedback while the call is pending |
| K-B | Show in folder reveals the exact completed file (not the directory, not another download); reveal refusal falls back to opening the containing folder; total refusal shows an honest error |
| K-C | No open-shaped action exists (or is keyboard-reachable) on queued/active/verifying/retrying rows; zero opener traffic before completion |
| K-D1 | Network failure, user cancellation, checksum mismatch: no open action, no hash advertised on a corrupt artifact, zero opener traffic |
| K-D2 | File missing at open time surfaces an error; empty completion path renders no open action |
| K-E1 | Out-of-order concurrent completions stay wired per row (no last-event/selection keying) |
| K-E2 | Duplicate filenames with collision-safe `(1)` destinations stay wired per row; duplicate completion events create no duplicate UI state |
| K-F | Open rejection is surfaced, the action is not stuck busy, retry works, no unhandled promise rejection |
| K-G1 (pinned `test.fail`) | Repeated activation while one open is pending must not stack native launches — **currently fails: one invoke per click** (defect routed to the production owner) |
| K-G2 | Keyboard reachability (Tab), visible focus indicator, Enter/Space activation, truthful accessible names, correct enabled state |
| K-H | Spaces/Unicode/parentheses/shell-like filenames pass through as ONE exact value, never split or interpolated |
| K-I ×9 | exe/msi/zip, dmg/pkg, deb/rpm/AppImage, apk: each class hands the completed path to the opener with the intended operation (desktop classes also verify Show in folder) |
| K-Android | Android UA: Open remains, Show in folder is absent, app-private path passes through, footer adapts honestly |

---

## Windows

Prerequisites common to all Windows rows: Fress desktop build installed
(`Fress_*_x64-setup.exe` from the release under test, or a local build);
Explorer running normally; no antivirus policy blocking the fixture folder;
download directory left at its default.

| # | Platform / OS version | Artifact & arch | Prerequisites | Exact user actions | Expected visible result | Expected native / OS result | Failure fallback to test | Status / tester / date |
|---|---|---|---|---|---|---|---|---|
| W1 | Windows 11 (23H2 or later), x64 | `.exe` — self-built hello-world console fixture, x64 | Fixture present locally; SmartScreen may warn for unsigned binaries — accept honestly or sign the fixture with the team test cert | 1. Open Fress 2. Open a card whose GitHub release resolves on Windows 3. Download the fixture 4. Wait for "Done" chip 5. Click **Open file** | Row shows Done (or Verified when a trusted digest exists); Open appears only after completion; no error toast after the launch is accepted | The fixture's console window/process starts; Task Manager shows the process; exit code 0 | If nothing launches: run the fixture directly from Explorer to isolate OS vs Fress; capture which happens | NOT RUN / — / — |
| W2 | Windows 11, x64 | `.msi` — minimal WiX test package, x64 | WiX-built fixture; no admin needed for per-user install | Same as W1 with the msi fixture | Same as W1 | `msiexec` UI appears (or per-user install completes); the package is listed in "Installed apps" and is uninstallable | If msiexec errors, capture the Windows Installer event-log entry | NOT RUN / — / — |
| W3 | Windows 11, x64 | `.zip` — deterministic one-file archive | Explorer or the configured archive handler present | Download, click **Open file** | Open appears after Done; opening works | The archive handler (Explorer zip or 7-Zip etc.) lists the archive contents | If no handler is associated, the OS refuses — Fress must show "Could not open the file"; verify that toast appears | NOT RUN / — / — |
| W4 | Windows 11, x64 | Any completed download | Normal desktop session | After Done, click **Show in folder** | No error toast | Explorer opens the download folder with the completed file SELECTED (not just the folder) | If Explorer integration is broken: Fress falls back to opening the containing folder — verify the folder (not the file) opens, and that a total failure shows "Could not open the folder" | NOT RUN / — / — |
| W5 | Windows 11, x64 | Fixture renamed to `lokaler versand 1.17 (offiziell) — Änderungen [x64].exe` before the journey (place file in the download dir via a completed download with that destination) | Same as W1 | Download to a path with spaces + Unicode + parentheses (use "Change folder" to pick such a directory), then **Open file** | Open works | The exact file launches; no tokenization/split-path errors | If the OS refuses the path, verify Fress passed the full string (the failure is at the OS boundary, not a truncated path) — capture the actual path used | NOT RUN / — / — |

## macOS

Prerequisites common to all macOS rows: Fress desktop build running;
quarantine attribute handling left at OS defaults (do NOT `xattr -cr` system
components); Gatekeeper active.

| # | Platform / OS version | Artifact & arch | Prerequisites | Exact user actions | Expected visible result | Expected native / OS result | Failure fallback to test | Status / tester / date |
|---|---|---|---|---|---|---|---|---|
| M1 | macOS 14 (Sonoma) or 15, Apple Silicon | `.dmg` — `hdiutil`-built fixture, arm64 (or universal) | Fixture built locally | 1. Download via Fress 2. Wait for Done 3. Click **Open file** | Row Done; no error toast if the mount succeeds | Finder mounts the dmg and opens its window; `hdiutil info` lists the image | If Gatekeeper blocks: the OS dialog appears — Fress must NOT claim success (verify "Could not open the file" only when the OS actually refused). Record the exact Gatekeeper wording | NOT RUN / — / — |
| M2 | macOS 14/15, Apple Silicon | `.pkg` — `pkgbuild` fixture, arm64 | Fixture built locally | Same as M1 | Same as M1 | Installer.app opens the package | If installer refuses (unsigned), capture the dialog; Fress side must show the honest error toast | NOT RUN / — / — |
| M3 | macOS 14/15 | `.zip` — one-file archive | Archive Utility default | Download, **Open file** | Open works | Archive Utility expands the zip in place | If blocked, verify quarantine explanation honesty (Fress shows the open-failed toast, never a fake success) | NOT RUN / — / — |
| M4 | macOS 14/15 | Any completed download | Finder running | Click **Show in folder** | No error toast | Finder reveals the completed file selected in its folder | If reveal fails, the containing-folder fallback opens; total failure shows "Could not open the folder" | NOT RUN / — / — |
| M5 | macOS 14/15 | Downloaded fixture, then delete the file in Finder BEFORE clicking Open | Terminal for the delete | Download, Done, delete file in Finder, click **Open file** | "Could not open the file" toast; row stays honestly Done | LaunchServices fails with file-not-found; nothing launches | If Fress claims success with the file gone, that is a UI-truth defect — file it | NOT RUN / — / — |

## Linux

Prerequisites common to all Linux rows: Fress desktop build (AppImage,
deb or rpm) running on a desktop session with a file manager installed;
the corresponding package handlers present where the row says so.

| # | Platform / OS version | Artifact & arch | Prerequisites | Exact user actions | Expected visible result | Expected native / OS result | Failure fallback to test | Status / tester / date |
|---|---|---|---|---|---|---|---|---|
| L1 | Ubuntu 24.04 LTS (or Debian 12), x64 | `.deb` — `dpkg-deb` fixture, amd64 | `dpkg` present; no sudo needed if the fixture installs to user space — otherwise run once with sudo OUTSIDE Fress to pre-approve the handler | Download via Fress, Done, **Open file** | Open appears after Done; no error toast | The configured .deb handler opens (GNOME Software / `apt` install prompt), or an already-installed fixture launches | If no handler exists, the OS refuses — Fress must show "Could not open the file"; verify the toast | NOT RUN / — / — |
| L2 | Fedora 40 (or openSUSE), x64 | `.rpm` — `rpmbuild` fixture, x86_64 | `rpm`/`dnf` handler present | Same as L1 | Same as L1 | The RPM handler opens (Software install prompt or package installer) | Same honest-refusal check as L1 | NOT RUN / — / — |
| L3 | Ubuntu 24.04, x64 | `.AppImage` — appimagetool reference demo, x86_64 | FUSE or `--appimage-extract` fallback available; executable bit PRESERVED by the download engine (verify `ls -l` shows `x`) | Download, Done, **Open file** | Open works | The AppImage launches its window; if the exec bit was stripped, the OS refuses | With the exec bit deliberately removed: Fress/OS must fail honestly (no fake success). Record whether the engine preserves the bit on this filesystem | NOT RUN / — / — |
| L4 | Ubuntu 24.04, x64 | `.AppImage` with a deliberately missing dependency (fixture links a nonexistent .so via its AppRun) | The fixture from L3 with a broken AppRun | Download, Done, **Open file** | Open accepted, then the launcher's own error (or nothing) appears — Fress must NOT invent success or failure beyond the OS answer | The launcher fails with a loader error in a dialog/log | Document actual behavior; if Fress shows "Could not open the file" for a slow-failing launcher, evaluate whether that is honest at the boundary | NOT RUN / — / — |
| L5 | Ubuntu 24.04, x64 | `.zip` — one-file archive | `file-roller`/`unzip` handler or GNOME Files zip support | Download, Done, **Open file** | Archive manager lists contents | Same as handler | Missing-handler case: remove the association, verify the honest error toast | NOT RUN / — / — |
| L6 | Ubuntu 24.04, x64 | Any completed download | GNOME Files / Dolphin running | Click **Show in folder** | No error toast | File manager opens with the file selected (DBus `org.freedesktop.FileManager1` or the FM's reveal mechanism) | If no file manager is installed: Fress falls back to opening the containing folder; total failure shows "Could not open the folder" | NOT RUN / — / — |
| L7 | Ubuntu 24.04, x64 | Fixture at `/home/<user>/Downloads/Lokaler Versand 1.17 (offiziell) — Änderungen [x64].exe`-style path | "Change folder" used to select a directory whose name has spaces/Unicode | Download into it, Done, **Open file** AND **Show in folder** | Both work | Exact-path handling end to end; shell fragments (`;`, `$(`, backticks) in the name must be inert | Any tokenization symptom = frontend/boundary defect (compare with the automated K-H result) | NOT RUN / — / — |

## Android

Prerequisites common to all Android rows: the Fress Android build
(`Fress_*_universal.apk` or the ABI split for the device) installed;
the test APK fixture's signing identity RECORDED before installation;
"Install unknown apps" permission state known before each row (the row
that varies it says so). Prefer a physical device; emulators are acceptable
but note it in the row.

| # | Platform / device | Artifact & arch | Prerequisites | Exact user actions | Expected visible result | Expected native / OS result | Failure fallback to test | Status / tester / date |
|---|---|---|---|---|---|---|---|---|
| A1 | Android 14, physical Pixel-class device, arm64 | Test `.apk` — one-activity hello-world, YOUR keystore, package id recorded, universal or arm64 split matching the device | "Install unknown apps" granted for Fress' app-private context per the OS flow; device screen unlocked | 1. Download the fixture apk via Fress 2. Wait for Done 3. Tap **Open** | Row shows Done; Open is the only open action (no "Show in folder" on Android); no error toast when the installer accepts | The system package installer opens showing the fixture's package name and the requested permissions; after user confirmation the app installs and its icon appears in the launcher | If the installer refuses the signature, capture the dialog; Fress must show the open-failure toast, not a fake success | NOT RUN / — / — |
| A2 | Android 14, same device | Same apk as A1 | "Install unknown apps" NOT granted for Fress (revoke before the run) | Download, Done, tap **Open** | The OS explains the missing permission (or the installer refuses); Fress surfaces the failure honestly if the handoff is refused | The installer handoff is blocked by the OS permission gate | Verify Fress does NOT claim success. Then grant the permission and retry — the retry (same button, same file) must work | NOT RUN / — / — |
| A3 | Android 14, same device | Any completed download (the fixture apk or a zip) | App-private storage default (no folder picker on Android by design) | After Done, inspect the panel footer | Footer shows the Android-appropriate note ("Android saves in its own folder"); NO "Change folder" button; NO "Show in folder" action on the row | The file lives in app-private storage; a file manager CANNOT browse it — this is expected, not a bug | If a "Show in folder" action appears on Android, that is a platform-contract defect | NOT RUN / — / — |
| A4 | Android 14, same device | `.zip` (or any non-APK the device has a viewer for — e.g. a text file) | A viewer app for the type present (e.g. the Files app) | Download, Done, tap **Open** | Honest completion state; open hands the file to the OS | The Android chooser or the default viewer opens the content via the app's shared URI (FileProvider/SAF); the URI must be readable by the target app | If the chooser opens but the target app cannot read the content (permission/URI bug), capture which app and the failure; also record the app-private-location behavior the OS shows | NOT RUN / — / — |
| A5 | Android 14, same device | Test `.apk` as A1 | Installer open (mid-handoff) | Download, Done, tap **Open**, then press BACK on the system installer screen | Fress shows no false completion about the INSTALL; the download row's own "Done" refers to the FILE, which is true and stays true | The installer is cancelled; nothing is installed; Fress' row state is unchanged (Done for the file — the app must never claim the INSTALL happened) | If any UI claims installation occurred after back-navigation, that is a truth defect — file it | NOT RUN / — / — |
| A6 | Android 14, same device | Same apk as A1 | Same as A1 | Repeat A1 but with the device in a locale different from Fress' current language | Installer language follows the SYSTEM locale; Fress' own strings follow Fress' language; both honest | Same as A1 | Record any mismatch between the two | NOT RUN / — / — |

## Device coverage honesty ledger (fill before release sign-off)

| Surface | UI-tested (mock) | Native-unit-tested | Real OS verified | Real Android device verified |
|---|---|---|---|---|
| Open a completed file (desktop) | YES — Workflow K | partial (engine commit/verifier suites) | ______ | n/a |
| Show in folder / reveal (desktop) | YES — Workflow K | partial | ______ | n/a |
| Open-failure honesty (desktop) | YES — Workflow K | n/a | ______ | n/a |
| Path/filename fidelity (desktop) | YES — Workflow K | partial | ______ | n/a |
| Artifact-class open requests (exe/msi/zip/dmg/pkg/deb/rpm/AppImage/apk) | YES — Workflow K | n/a | ______ | ______ |
| System package-installer handoff (Android) | n/a (out of webview reach) | n/a | n/a | ______ |
| App-private storage / URI read-access (Android) | partial — path-pass-through only | n/a | n/a | ______ |
| Installer permission not granted (Android) | n/a | n/a | n/a | ______ |
| Cancel/back from system installer (Android) | n/a | n/a | n/a | ______ |

A blank cell keeps the release claim honest: it is NOT verified. Do not
fill it from the mock suite.

## Maintenance

- When `src/lib/downloads.tsx` (openFile/openFolder), `DownloadManager.tsx`
  (the row actions), or the opener capability configuration changes, rerun
  `npm run test:e2e` and re-execute the affected rows of this matrix before
  the next release.
- The automated Workflow K contract is the reference for what "honest"
  means at the boundary; if the UI contract changes deliberately, update
  Workflow K AND the corresponding rows together in the same change.

