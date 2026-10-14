# Testing round — Android download-to-install flow + in-app download coverage (2026-10-14)

Branch: `feat/android-open-path-install` · Base: main `6a3aa23` (v1.0.10-beta)

## What this round delivered

### 1. The Android download-to-open/install flow (previously missing)

The download engine already committed APKs into app-private storage, but the
"Open file" button routed through `@tauri-apps/plugin-opener`'s `openPath`,
whose Android implementation handles URLs only (`OpenerPlugin.kt` builds an
`ACTION_VIEW` on the raw string). On Android a completed download was a dead
end: the button failed and the only escape was re-opening the source page in
a browser. This round wires the full native flow:

- **Tracked native entry points** (what git actually carries):
  - `src-tauri/src/lib.rs` — `run()` behind `#[cfg_attr(mobile,
    tauri::mobile_entry_point)]` (the Rust entry the generated Kotlin glue
    calls) plus the Tauri command surface; `src-tauri/build.rs`.
  - `src-tauri/gen/` is NOT tracked: CI regenerates the Android Studio
    project with `tauri android init` on every release build
    (`.github/workflows/release.yml`, build-android job). Everything
    Android-native this app needs is therefore injected by
    `scripts/patch-android-fileprovider.mjs`, which runs from
    `build.beforeBuildCommand` on every Android build pass (idempotent; a
    no-op on desktop, where `gen/` does not exist). `/src-tauri/gen/` is now
    git-ignored so the generated project can never leak into a commit.
- **Shared `open_path` boundary** (`open_path` command in `lib.rs`):
  - Desktop: delegates to the opener plugin exactly as the frontend's old
    direct plugin call did (behavior unchanged).
  - Android: validates the path against the download engine's
    completed-artifact registry BEFORE anything touches Java
    (`classify_completed_open` in `download_finalize.rs`: registry scope →
    no `.part` staging names → canonical stability re-check → regular file
    of the committed size), then routes through the Kotlin plugin.
  - The validation half is cross-platform pure Rust and unit-tested on the
    desktop CI leg; the platform half is exercised by compile-checks for
    `aarch64-linux-android` and the APK build below.
- **Scoped FileProvider**: the Tauri template ships
  `androidx.core.content.FileProvider` (authority
  `${applicationId}.fileprovider`); the patch script extends its
  `file_paths.xml` with exactly one new scope —
  `<files-path name="fress_downloads" path="Download/" />` — the folder the
  engine commits into. On Android the download dir is deliberately
  `<dataDir>/files/Download` (via `app_data_dir()` + `files`), because
  Tauri's `app_data_dir()` resolves to the BASE private dir one level above
  `files/`, which `<files-path>` can never reach. The APK MIME is
  `application/vnd.android.package-archive`, with
  `FLAG_GRANT_READ_URI_PERMISSION` (+ `FLAG_ACTIVITY_NEW_TASK`); the
  manifest gains `REQUEST_INSTALL_PACKAGES`, which only makes the app
  ELIGIBLE to ask — Android's unknown-sources consent UI runs untouched,
  and no install is ever started without the user pressing the button on a
  completed row.
- **Non-APK fallback**: `ACTION_VIEW` with the extension-mapped MIME type;
  when no activity can display the file, the share sheet
  (`ACTION_SEND` + `EXTRA_STREAM`, the grant carried into the chooser via
  `ClipData`) hands the file to an app that can.
- **Restart survival**: the engine mirrors its completed-artifact records
  (cap 32, engine-written only — no frontend command can insert records) to
  `app_data_dir/completed-downloads.json`, atomically (tmp+rename), and
  reloads them at startup on Android, so an APK can be installed the day
  after it was downloaded. Desktop keeps the historical session-scoped
  registry; the updater's verify boundary semantics are untouched.
- **Interface contract with the UI work stream**: `docs/android-open-path-interface.md`
  pins the command signature, URI format, registry rules and the UI labels
  (`downloads.installApk` "Install" on Android `.apk` rows, all five
  locales).

### 2. In-app download coverage across all OSes and all catalog apps

The click path for every app × platform was audited live with the repo's
own resolver chain (`scripts/audit-downloads.ts`, GITHUB_TOKEN-authenticated;
desktop mode + `AUDIT_ANDROID=1`):

- **Android: 35/35 rows resolve to an in-app download** (F-Droid APK via
  the fdroid resolver, or a GitHub release APK asset). 0 browser fallbacks.
  A transient F-Droid probe failure during one run showed the only weak
  pick (ente-auth falling back to the GitHub APK while the F-Droid fetch
  hiccuped); it resolves confidently on retry and the normal resolver order
  prefers F-Droid for every fdroidId app.
- **Desktop: 145 rows** — every row resolves a real file in-app except:
  - `inkscape/mac` — an honest page case: Inkscape's macOS DMG URLs carry
    per-build hashes and their release page renders links in JS (documented
    in the curated table since the first audit round); the button opens the
    official installer page.
  - 6 `package`-channel rows (Flatpak-first apps: VLC/GIMP/Inkscape/Krita/
    HandBrake/Element on Linux) — the official distribution channel; the
    batch installer and detail modal surface the exact `flatpak install`
    command.
- Several audit-time skips (kdenlive/windows, librewolf/*, libreoffice/*)
  were reproduced, diagnosed and dismissed as sandbox network flakiness:
  the same resolvers succeed on retry against the live infrastructure
  (e.g. `libreoffice → LibreOffice_26.8.1_Win_x86-64.msi`,
  `kdenlive → kdenlive-26.08.0.exe`, `librewolf → librewolf-146.0.1-1-windows-x86_64-setup.exe`).
  The resolvers read vendor manifests/mirror indexes natively via the
  `fetch_text` command in the real app, which is not subject to the
  sandbox's node-fetch IPv6/egress quirks.

### 3. Real runs, separated honestly (mock vs emulator vs device)

| Layer | What ran | Result |
|---|---|---|
| Mocked unit/UI (jsdom) | vitest full suite incl. the new `androidInstallFlow.test.tsx` | 592 passed, 2 skipped (live-probe) |
| Mocked E2E (browser harness with the Tauri bridge mock) | Playwright, 70 specs incl. download-manager visuals, RTL, 500-app scale | 70/70 passed |
| Rust engine (host) | `cargo test` full suite incl. 9 new open-boundary/persistence tests | 192 passed, 0 failed |
| Rust clippy/fmt | CI parity: `clippy --all-targets -- -D warnings`, `fmt --check` | clean |
| Android cross-compile | `cargo check --target aarch64-linux-android` (full android cfg: JNI-free mobile plugin, registry persistence, open_path android branch) | clean |
| **Real APK build** | `tauri android build --apk --target x86_64` (release), SDK 35/platform 36/NDK r27c, then `apksigner` | **built + signed + verified** |
| APK structural verification | aapt dump of the signed APK | `REQUEST_INSTALL_PACKAGES` present; exactly one `androidx.core.content.FileProvider` (authority `${applicationId}.fileprovider`); `libfress_lib.so` present |
| **Emulator boot** | API 30 default x86_64 image, emulator 37.2.12, `-accel off` (no KVM in sandbox) | **BLOCKED by the sandbox, not by the app** — see below |
| Physical device | none available in this sandbox | **not run; nothing is claimed** |

**Emulator blockage, precisely:** the sandbox has no KVM and a 9.9 GB
rootfs. Emulator 37.2.12 refuses to create the userdata partition unless
7,372.8 MB (6 GB default data partition × 1.2) are free at the AVD
location — the value is taken from the DEFAULT data partition size and
ignores every override attempted (`disk.dataPartition.size` in bytes and
`M` form, `-partition-size`, generic AVD without a device profile, AVD
cache-file resets). The largest free space reachable in this sandbox was
~2.8 GB, so the boot is physically impossible here, independent of Fress.
(An older emulator zip from the official manifest turned out to be a
37.1.1-alpha that cannot run API 30 images at all — it requires
`kernel_cmdline.txt`, which only v37-era images ship.)

**What the emulator WOULD have added** is the runtime trace of the install
intent (PackageInstaller UI, unknown-sources consent). Everything short of
that was verified for real: the signed x86_64 release APK contains the
permission, the single template FileProvider with the download scope, and
the Kotlin plugin; the Rust side compiled for `aarch64-linux-android`; the
boundary logic is unit-tested; and the frontend contract is pinned by the
new vitest + E2E bridge assertions (`bridge.openedPaths`).

## Known follow-ups

- A real device / CI emulator (linux runner with KVM) should run one
  install end-to-end; the interface doc lists the exact observable steps.
- `verify_self_update_signature`'s docs still describe a session-scoped
  registry (unchanged, deliberately); if restart-survival is ever wanted
  for updater verification, the Android mirror can be promoted to all
  platforms in a dedicated change.
