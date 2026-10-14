# Android open_path boundary - interface contract

Status: proposed implementation (PR: `feat/android-open-path-install`)
Owner: download/platform work stream (this document) · Consumer: Agent 6 (frontend/UI work stream)

This document pins every observable edge of the Android "open a completed
download" flow so the frontend and the native sides can evolve without
re-reading each other's code. If ANY of the signatures, formats or semantics
below change, this file changes in the same commit.

## 1. The command

```
invoke('open_path', { path: string }) -> void        # app command, all platforms
```

- `path` is the exact `path` string the `download-complete` event carried
  (`CompletePayload.path`). The frontend never constructs paths itself.
- Resolves (empty payload) when the hand-off to the OS succeeded.
- Rejects with a short English diagnostic on refusal/failure. The UI shows
  its own localized failure toast and must NOT parse the message: every
  "not a completed download" refusal uses the SAME generic text
  ("Open refused: this path is not a completed Fress download artifact"),
  so there is nothing to parse by design.

## 2. Validation (native, before any OS interaction)

`classify_completed_open` (src-tauri/src/download_finalize.rs) gates the
whole flow. A path is admitted only when ALL hold:

1. Registry scope - the path (exact, then canonicalized) matches a record
   the download ENGINE wrote on a successful commit. The frontend cannot
   insert records; there is no command that can.
2. Not a staging name (`*.part`, `*.part.meta`).
3. Canonical stability - the file re-canonicalizes to the path recorded at
   completion (no symlink swap / move / re-home).
4. Regular file of the recorded committed size.

Refusals happen BEFORE any Java/FileProvider call: an unregistered path is
indistinguishable from a missing one.

## 3. Android platform half (Kotlin plugin, generated file)

The Rust side routes admitted paths to `FressFileOpenerPlugin` (written by
`scripts/patch-android-fileprovider.mjs` into the generated Android
project; src-tauri/gen is NOT tracked in git):

```
run_mobile_plugin('open', { path: string, isApk: boolean })
  -> { status: 'ok' | 'ok-shared' | 'error', message?: string }
```

- `isApk` is decided by the validated file's (lowercased) extension.
- APK: `ACTION_VIEW` + `content://` + MIME
  `application/vnd.android.package-archive` +
  `FLAG_GRANT_READ_URI_PERMISSION` + `FLAG_ACTIVITY_NEW_TASK`.
- Other files: `ACTION_VIEW` with the extension-mapped MIME
  (`application/octet-stream` fallback); on `ActivityNotFoundException`
  the share sheet (`ACTION_SEND`, `EXTRA_STREAM`, ClipData carries the
  grant) is the fallback and the response says `ok-shared`.

## 4. FileProvider contract

- Authority: `${applicationId}.fress.fileprovider` (declared by the patch
  script in the generated `AndroidManifest.xml`; derived at runtime from
  `context.packageName`, never hardcoded).
- Scope (`res/xml/fress_file_paths.xml`): ONLY
  `files-path path="Download/"` (the download engine's commit folder -
  `platform_download_dir()` on Android is `app_data_dir()/Download`) plus
  the cache dir for share hand-offs. Nothing else is reachable through the
  provider, which is `exported="false"` with
  `grantUriPermissions="true"` - readers get one-time read grants via the
  intent flag.
- Permission added by the same patch: `REQUEST_INSTALL_PACKAGES`. This
  declaration is what makes the app ELIGIBLE to trigger the installer; the
  OS keeps the full unknown-sources consent UI. Nothing here suppresses,
  pre-grants or works around user consent, and no install is ever started
  without the user pressing the Install/Install-button on a completed
  row.

## 5. Restart survival (Android only)

The engine mirrors its completed-artifact records to
`app_data_dir()/completed-downloads.json` (written by the commit path
only, atomically, capped at the registry's 32-record FIFO). At startup the
registry reloads records whose file still exists, re-deriving canonical
paths. A user can therefore install a downloaded APK the day after
downloading it. Desktop keeps the historical session-scoped registry
(the updater's verify boundary semantics are unchanged).

## 6. UI contract (what Agent 6's surface must keep)

- The completed row's primary action calls `openFile(path)` from
  `useDownloadActions()` - which invokes `open_path`. It MUST NOT call
  `@tauri-apps/plugin-opener`'s `openPath` directly: that call skips the
  registry validation and, on Android, cannot work at all (the opener
  plugin's Android side handles URLs only).
- Label: `t('downloads.installApk')` ("Install") when
  `isAndroidApkArtifact(item.name)` is true (Android UA + `.apk`,
  case-insensitive); `t('downloads.openFile')` ("Open file") otherwise.
  The key exists in all five locales (en/fa/es/fr/de) and is covered by
  the i18n parity gate.
- On Android the "Show in folder" secondary action stays hidden (app
 -private storage is not browsable) - existing behavior, restated here
  because it bounds this flow too.

## 7. Tests that pin this contract

- Rust: `download_finalize.rs` tests `open_boundary_*` and
  `the_persistence_mirror_*` (registry scope, staging refusal, apk/non-apk
  classification, swap/move/refusal, persistence roundtrip, vanished and
  corrupt mirror files).
- Frontend: `src/lib/__tests__/androidInstallFlow.test.tsx` (install
  label matrix, `open_path` routing from the panel, opener plugin not
  reachable from this path).
- E2E: the Tauri bridge (`tests/e2e/tauri-bridge.ts`) records every
  `open_path` call in `bridge.openedPaths` for UI-level assertions.
