# Android + Linux deep-test round — evidence (2026-10-12)

Scope: full app test matrix on Linux (x86_64, host) and Android (arm64 build
pipeline + device-behavior contract), against `main` @ `0cb678b` (v1.0.8-beta).
No auto-merge: this branch is for review.

## Linux (x86_64-unknown-linux-gnu)

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | PASS |
| `vitest run` | 483 passed / 2 skipped (34 files) |
| `cargo test` (webkit2gtk-4.1 sysroot, no sudo) | **166 passed / 0 failed** |
| `cargo fmt -- --check` | PASS |
| `vite build` (production) | PASS |
| Playwright E2E (production build, workflows A–J + visual) | **66/66 PASS** |
| `validate:catalog` | 0 errors / 13 warnings (pre-existing advisory warnings) |
| `validate:security` | PASS |

Notes:
- `cargo clippy -D warnings` could not complete in the sandbox (9.9 GB disk
  filled during the second full compile); CI runs it for this PR on ubuntu-22.04.
- Native GUI launch was not possible (headless sandbox, no X server); the E2E
  suite covers the frontend contract and `cargo test` covers the native backend
  logic end to end.

## Android (aarch64-linux-android)

| Gate | Result |
| --- | --- |
| `rustup target add aarch64-linux-android` + NDK r27 clang linkers | configured |
| `cargo check --target aarch64-linux-android --lib` | PASS (43s, zero warnings/errors) |
| `tauri android init` | PASS (gen/android, minSdk 24, com.fress.app) |
| `tauri android build --apk --debug --target aarch64` (Gradle 8.14.3, AGP, JDK 21, build-tools 35 / platform 36) | **PASS** |
| APK inspection (aapt) | package `com.fress.app`, versionName 1.0.8-beta, versionCode 1000008, minSdk 24, targetSdk 36, `INTERNET` only, `lib/arm64-v8a/libfress_lib.so` embedded |
| Emulator run | NOT POSSIBLE here (no KVM, 3.9 GB RAM) — build-pipeline + contract coverage only |

## Every catalog app, live, both platforms

`scripts/audit-downloads.ts` resolves a real download for **every app × every
declared platform** through the production resolver against live registries:

| Pass | Rows | Skips | Errors |
| --- | --- | --- | --- |
| Desktop (Linux/mac/Windows) | 145 | 3 | 0 |
| Android (Pixel 9 UA → aarch64 signal) | 35 | 0 | 0 |

- The 3 desktop skips (`inkscape` mac, `librewolf` windows/linux) are the
  by-design page-only state: the resolver finds no direct/package asset and the
  card falls back to the official download page — verified in
  `appDownloads.getDownloadOptions`.
- `scripts/audit-catalog-live.ts` (identity audit, 75 apps): GitHub 83/83,
  winget 46/46, Homebrew 40/40, Flathub 33/33, Scoop 21/21 OK. Three F-Droid
  lookups returned HTTP 0 (sandbox connection flake to f-droid.org); all three
  re-probed HTTP 200 immediately after — transient, not catalog data.

## Gap found and closed by this branch

The repo had zero coverage for the UI-level Android device contract:

- `deviceDefaultPlatform`: Android opens the catalog on the `android` filter,
  desktop on `all`; a stored user choice always wins.
- `isAndroidWebview()`: scoped-storage signal (true for Android WebView UA,
  false for desktop and iOS).
- `DownloadManager`: "Change folder" must be absent on Android (no arbitrary
  folder picker under scoped storage) and present on desktop.

`src/lib/__tests__/androidDeviceBehavior.test.tsx` pins all of the above
(9 tests). Verified locally: `vitest run` 492 passed / 2 skipped, `tsc` clean.

## Rust Android-surface review (no defects found)

- `host_arch()` returns `std::env::consts::ARCH` (`aarch64`) on Android — the
  resolver ABI signal is correct.
- `platform_download_dir()` has a dedicated `#[cfg(target_os = "android")]`
  path to `app_data_dir()` (scoped storage), matching the frontend's
  `settings.androidFolderNote` copy.
- Android linker config (`aarch64-linux-android24-clang`) matches minSdk 24.
