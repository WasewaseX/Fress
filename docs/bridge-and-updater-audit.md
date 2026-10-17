# Bridge and updater audit — October 2026 (Agent 5, quality/platform-updater)

Reviewer-facing deliverable of the native-integration audit: the full
command-to-permission matrix, the self-update flow state table, the
platform-specific download-folder/open behavior, the test evidence and the
remaining platform limitations. The capability/CSP baseline lives in
[tauri-security.md](security/tauri-security.md); the download engine's
state machine lives in [download-lifecycle.md](download-lifecycle.md).

## 1. Command-to-permission matrix

Every native call the frontend can make, its Rust implementation, its
validation, and the capability permission (if any) it needs. Custom commands
are NOT gated by capabilities (Tauri gates plugin/core commands only), so
their row lists the Rust-side validation that plays the same role.

### 1.1 Custom Rust commands (`src-tauri/src/lib.rs`)

| Command | Frontend caller | Arguments (JS → Rust) | Result / error type | Native side effects | Events emitted | Validation (the command's own gate) | Desktop | Android | Web preview |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `start_download` | `startTauriDownload` in `src/lib/downloads.tsx` | `url`, `filename`, `directory`, `expectedSha256`, `expectedSha512`, `resume` (camelCase keys map to the snake_case params) | `u32` id / `String` | creates the target directory, writes `<name>.part` staging file + validator sidecar, commits the finished file (no-clobber), deletes rejected staging bytes | `download-progress`, `download-retrying`, `download-complete`, `download-error` | `network_policy::UrlPolicy::executable_download()` BEFORE any side effect: HTTPS-only, no embedded credentials, no private/loopback literals or localhost names, per-hop redirect re-check, public-address-only DNS; `sanitize_filename` on untrusted names | yes | yes (private app-data dir by default) | not registered (browser fallback opens a tab) |
| `cancel_download` | `cancel` in `src/lib/downloads.tsx` | `id` | `()` / `String` | signals the engine; the engine keeps the staging file and drives itself to `Cancelled` | (the resulting `download-error` with `Cancelled`) | signal-only; a cancel after completion is a no-op; only the download task mutates state | yes | yes | no |
| `default_download_dir` | `downloads.tsx` (provider init, start, reset) | — | `String` / `String` | creates the Android app-private `Download` dir when used | none | none needed (no input) | yes (FOLDERID_Downloads incl. OneDrive / `~/Downloads` / XDG) | yes (`app_data_dir/Download`) | no |
| `fetch_latest_release` | `getLatestRelease` in `src/lib/release/githubProvider.ts` | `repo` (slug, trimmed) | `GhRelease` / `String` | none (network read) | none | `UrlPolicy::api_github()`: host pinned to `api.github.com`, redirects pinned to origin, HTTPS, no credentials, private addrs refused, API timeout | yes | yes | no (browser `fetch` fallback, CORS-clean host) |
| `fetch_recent_releases` | `getRecentReleases` in `githubProvider.ts` | `repo`, `count`, `includeFlagged` | `GhRelease[]` / `String` | none | none | same as `fetch_latest_release`; `per_page` clamped to 1..30; prerelease filter unless `include_flagged` | yes | yes | no (browser fallback) |
| `fetch_fdroid_package` | `getFdroid` in `src/lib/release/fdroidProvider.ts` | `pkg` | `FdroidPackage` / `String` | none | none | `UrlPolicy::api_fdroid()`: host pinned to `f-droid.org`, redirects pinned, HTTPS, no credentials | yes | yes | no (browser fallback) |
| `fetch_text` | `fetchTextOnce` in `src/lib/officialResolvers.ts` | `url` | `TextFetch { status, final_url, content_length, body, truncated }` / `String` | none | none | `UrlPolicy::resolver_manifest()`: vendor host allowlist (see `RESOLVER_ALLOWED_HOSTS`), per-hop re-check, HTTPS, no credentials, 2 MiB body cap | yes | yes | no (browser fallback) |
| `fetch_self_update_text` | `fetchSelfUpdateText` in `src/lib/selfUpdate.ts` | `url` | `TextFetch` / `String` | none | none | `UrlPolicy::self_update_feed()` (added in this audit): hosts pinned to `github.com` + `release-assets`/`objects.githubusercontent.com`, per-hop re-check, HTTPS, no credentials, private addrs refused, 2 MiB cap, PLUS a repo pin: the `github.com` path must be `/WasewaseX/Fress/...` | yes | yes | no (browser fallback: plain `fetch`, CORS-limited, degrades to null) |
| `host_arch` | `getHostArch` in `src/lib/release/hostArch.ts` | — | `String` / — | none | none | none needed (no input); Windows reports the native machine arch via `GetNativeSystemInfo`, not the emulated process arch | yes | yes | no (UA heuristic fallback) |

Removed in this audit: `app_version` — registered but never called by any
frontend version (the UI reads its version from `package.json`). An
uncallable command is surface without a purpose.

### 1.2 Plugin/core calls gated by capabilities (`src-tauri/capabilities/default.json`)

| Permission | Allowed call | Consuming component / workflow | Why it is required | Can the scope be narrowed? |
| --- | --- | --- | --- | --- |
| `core:event:allow-listen` | `plugin:event\|listen` | `DownloadsProvider` (download progress/complete/error/retrying) | the only way the WebView receives engine events | no — already the narrowest form (per-command) |
| `core:event:allow-unlisten` | `plugin:event\|unlisten` | same (cleanup returned by `listen()`) | prevents leaked listeners on unmount | no |
| `core:path:allow-dirname` | `plugin:path\|dirname` | `openFolder` reveal fallback in `downloads.tsx` | derive the containing folder when `reveal_download_file` fails (Windows builds without the explorer integration) | no |
| `dialog:allow-open` | `plugin:dialog\|open` | "Choose download folder" (`chooseFolder`, desktop only) | the folder picker; `dialog:default`'s `allow-message`/`allow-save` are deliberately NOT granted | no — `directory: true, multiple: false` is passed at the call level; the plugin ACL has no finer scope for open |
| `opener:allow-open-url` scoped `https://**` | `plugin:opener\|open_url` | `openExternal()` in `src/lib/external.ts` (vendor sites, release pages) | every external link; the scope makes `http:`, `mailto:`, `tel:`, `file:` and custom schemes IPC-rejected even if the frontend check were bypassed | partially — a site allowlist is impossible (the catalog links to arbitrary official publisher sites); the scheme scope IS the boundary |

**Removed in the stable-hardening round (2026-10-15):** `opener:allow-open-path`
and `opener:allow-reveal-item-in-dir` are no longer granted. The opener
plugin's path bindings have no path scope, so the frontend previously held an
unrestricted open/execute primitive. Opening and revealing downloaded files
now runs through the native `open_download_file` / `reveal_download_file`
commands (src-tauri/src/download_open.rs), which admit only paths inside
download-engine folders — the platform default download dir plus the
app-owned ledger of folders a download actually ran in (or that the user
picked, recorded via `record_download_directory`). Residual risk is
documented in docs/security/tauri-security.md: a frontend that can start
downloads can aim the engine at a folder, so the blast radius is "files
inside download folders" — pre-existing local files outside those folders
are unreachable from the webview.

Deliberately not granted (unchanged from the audited baseline): the seven
unused `core:*` module defaults, `dialog:allow-message`/`allow-save`,
`opener:default`'s unscoped `allow-open-url` + `allow-default-urls`, and any
`core:window/webview/app/image/menu/resources/tray:*` — see
tauri-security.md for the full reasoning.

CSP note: `connect-src https://github.com` was removed in this audit — the
self-update's `releases.atom` and `SHA256SUMS.txt` reads moved to the native
`fetch_self_update_text` command; a WebView fetch of that host could never
succeed (no CORS headers), so the entry permitted only requests that always
failed. The permission-shaped outcome of the audit is therefore: same seven
capabilities, one fewer network origin, one fewer dead command, one new
tightly-pinned native command.

## 2. Self-update flow state table

The active path (the Tauri updater plugin is configured but NOT wired; its
`latest.json`/`.sig` artifacts are produced by CI for the future runtime):

| # | State / step | Guard | Success path | Failure path (fail closed) |
| --- | --- | --- | --- | --- |
| 1 | Check (`checkForUpdate`) | channel filter (stable/beta/alpha) + GitHub `prerelease` flag for stable | newest matching release | API + atom both fail → `{kind:'error'}` → quiet note, throttle stamp NOT written (next launch retries) |
| 2 | Version compare | `compareVersions` (SemVer, prerelease-aware); unparsable versions rank OLDER | `release.version > currentVersion` → continue | `cmp <= 0` → "latest" (no update offered) |
| 3 | Asset pick (`pickOwnAsset`) | per-platform scoring; host arch from the native `host_arch`, never the UA; Android unknown-ABI → universal-only; Linux refuses cross-arch outright | platform-matched asset | no usable asset → `asset: null` → delivery links to the releases page (`no-asset`) |
| 4 | Checksum fetch (`fetchExpectedSha256`) | SHA256SUMS.txt read via the native command (hosts + repo-path pinned, 2 MiB cap) | `expectedSha256` = the publisher's 64-hex entry for the asset | no sums file / no entry / unreachable → `null` → delivery links to the releases page (`unverifiable`); an UNVERIFIED INSTALLER IS NEVER DELIVERED |
| 5 | Delivery decision (`planUpdateDelivery`) | ONE shared function for the header pill AND the footer button | `download` + sha256 | `releases-page` + reason; toast explains; manual `sha256sum -c` instructions are one click away |
| 6 | Download | download manager passes `expectedSha256` to the engine | engine verifies the digest BEFORE commit | mismatch → staging bytes deleted, `download-error` kind `checksum`, no file ever appears "finished" |
| 7 | Install | user opens the finished installer (desktop) / APK (Android) | existing install is replaced by the OS installer; app data preserved | failed/never-started install leaves the current version untouched — the app itself is never mutated by the update check |

Integrity vs authenticity (kept separate on purpose): `SHA256SUMS.txt`
establishes that the file matches what CI built (integrity). The minisign
`.sig` + `latest.json` + embedded public key establish who authorized the
updater artifact (authenticity) and are consumed by the future updater plugin,
not by this flow. Neither is an Authenticode publisher identity — Windows
still shows "Unknown publisher" today because no signing secrets are
configured (see CODE_SIGNING.md for the evidence).

## 3. Platform-specific download-folder and file-open behavior

| Platform | Default folder | User-chosen folder | Open file | Reveal in folder | Notes |
| --- | --- | --- | --- | --- | --- |
| Windows | `FOLDERID_Downloads` (follows OneDrive redirection) via `dirs::download_dir` | dialog picker; persisted in localStorage | `open_download_file` (validated native boundary → ShellExecute) | `reveal_download_file`, fallback `open_download_file(dirname)` | reveal can fail on some Windows builds; the fallback opens the CONTAINING folder, never the file |
| macOS | `~/Downloads` | dialog picker | `open_download_file` | same fallback chain | host arch comes from the native command (WebKit UA lies on Apple Silicon) |
| Linux | XDG download dir | dialog picker | `open_download_file` | same fallback chain | resolver/download hosts unchanged; engine identically gated |
| Android | app-private `app_data_dir/Download` (created on demand) | picker intentionally hidden (`isAndroidWebview()` gates both Header and DownloadManager) | `open_download_file` → opener's mobile `open` (system default program) | hidden (no file-manager reveal in app-private storage; `reveal_item_in_dir` is runtime-unsupported on Android and surfaces as the honest error path) | the WebView cannot treat desktop paths as available; unavailable folders and rename failures surface as honest engine errors (kind absent → generic failed state with Resume where sound) |

Cross-platform invariants verified in code: a completed item's `path` is set
ONLY by the engine's terminal `download-complete` event (the file exists in
its final state at that point); open/reveal failures produce visible error
toasts, never silent success; persisted completed entries survive restarts
and fail honestly if the user deleted the file since.

## 4. Test evidence

- `npm run lint` (tsc): PASS.
- `npm test` (vitest): 294 passed, 2 skipped (pre-existing skips) — includes
  the new `planUpdateDelivery` fail-closed tests and the checksum plumbing
  tests in `src/lib/__tests__/selfUpdate.test.ts` (56 tests in that file).
- `npm run validate:security`: PASS (capability matrix, narrowed CSP, version
  consistency, updater key consistency).
- Rust: the environment has no webkit2gtk/gtk3 system libraries and no
  privilege to install them, so a full `cargo check` of the Tauri crate could
  not run locally. The new/changed logic was verified in a standalone harness
  (`network_policy.rs` compiled verbatim + the `fetch_self_update_text`
  admission and body-cap code copied verbatim): 36 tests pass — 29 pre-existing
  network_policy tests (no behavior change to existing policies) plus 7 new
  admission tests (atom/checksum documents admitted; foreign repos, foreign
  hosts, look-alike hosts, credentials, cleartext refused; URL normalization).
  CI MUST run `cargo test` (Agent 6's gate) as the authoritative compile check
  for the tauri glue.
- Desktop smoke test: NOT run locally (no display/toolchain here); the CSP and
  capability changes are validated statically. macOS/Windows/Android runtime
  behavior was not exercised locally at all — CI is the gate for those.

## 5. Remaining platform limitations (honest list)

1. **Android file-open** relies on the opener plugin's `ACTION_VIEW` intent;
   whether an APK opens the package installer directly can vary by Android
   version/OEM. Not verified on a device. The failure path is a visible
   "Could not open the file" toast, never a false success.
2. **macOS updater artifacts** are absent from real releases (no darwin
   entries in `latest.json`); macOS updates flow only through the
   checksum-verified manual path until CI produces the `.app.tar.gz`+`.sig`
   pair (CI workstream).
3. **Windows installers are unsigned** (no Authenticode secrets configured):
   SmartScreen/Defender reputation is the documented trade-off; the integrity
   chain (SHA256SUMS.txt + in-app verification) is the actual guarantee today.
4. **The Tauri updater plugin remains unwired**; `plugins.updater` and the
   published `.sig`/`latest.json` artifacts are a prepared migration state,
   and its endpoint 404s while only prereleases are published.
5. **Web preview self-updates** cannot read the checksum document (browser
   CORS, no native bridge); delivery fails closed to the releases page there —
   by design, not an oversight.
