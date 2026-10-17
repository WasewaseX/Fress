# Tauri security model

This document describes the desktop security configuration that ships in
`src-tauri/tauri.conf.json` and `src-tauri/capabilities/default.json`, why
every entry exists, and how to validate it locally. It reflects the
configuration as audited in October 2026 (Tauri 2.x, tauri-plugin-dialog
2.7.3, tauri-plugin-opener 2.5.5).

## Capabilities

The app defines exactly one capability (`default`) granted to the single
`main` window. Permissions are granted at the narrowest level that supports
the traced frontend call sites:

| Permission | Justified by | Frontend call site |
| --- | --- | --- |
| `core:event:allow-listen` | receiving download progress / completion / error events emitted by the Rust side | `listen()` in `src/lib/downloads.tsx` |
| `core:event:allow-unlisten` | the unlisten callback returned by `listen()` invokes `plugin:event\|unlisten` | same |
| `core:path:allow-dirname` | falling back to opening the parent folder when "reveal in folder" fails | `dirname()` in `src/lib/downloads.tsx` |
| `dialog:allow-open` | the "Choose download folder" picker (directory mode) | `openDialog()` in `src/lib/downloads.tsx` |
| `opener:allow-open-url` (scoped `https://**`) | opening official vendor websites | `openUrl()` in `src/lib/external.ts` |

Deliberately NOT granted (each verified unused by the frontend):

- **`opener:allow-open-path` / `opener:allow-reveal-item-in-dir`** — the
  opener plugin's JS bindings for local paths are unrestricted (no path
  scope exists), so a compromised frontend could open or execute ANY file
  with the system handler. Opening and revealing downloaded files instead
  runs through the native `open_downloaded_file` / `reveal_download_file`
  commands, which validate the EXACT completion-event path against the
  session's completed-artifact registry (canonical stability, regular
  file, committed size — the same discipline as the updater's signature
  verification) before the OS is asked from the Rust side; desktop
  dispatch is the opener plugin's RUST API, Android dispatch is the
  fress-open adapter (APK installer / viewer / share). Directory targets
  (`open_download_dir`) admit only the platform default download folder,
  a folder holding a completed artifact this session, or a folder the
  user picked in the native dialog this session
  (`record_download_directory`). The admission state is deliberately
  session-scoped and app-owned — a panel row restored after a restart is
  refused with the typed `not-registered` code, because persisted
  (webview-writable) state must never feed a native open.
  Residual risk, stated honestly: a frontend that can start downloads can
  direct the engine at a folder of its choosing (the URL policy constrains
  where downloads come FROM, not where they land), so the effective blast
  radius is "files the engine itself committed this session" — pre-existing
  local files outside those commits can no longer be touched from the
  webview at all.

- **`core:default`** expands to nine module defaults (`app`, `event`, `image`,
  `menu`, `path`, `resources`, `tray`, `webview`, `window`). Only `event`
  (listen/unlisten) and `path` (dirname) are used; the other seven modules'
  defaults are dropped, and the two used ones are narrowed to individual
  commands.
- **`dialog:default`** includes `allow-message` and `allow-save`; the app only
  ever calls the open dialog, so only `dialog:allow-open` is granted.
- **`opener:default`** includes an *unscoped* `allow-open-url` (any scheme,
  including `file://` and custom protocols) plus `allow-default-urls`
  (`mailto:`, `tel:`, `http://`). Both are dropped: external links go through
  the scoped `https://**` grant only, so the permission layer itself rejects
  every non-HTTPS scheme even if frontend validation were bypassed.
- No `core:window:*`, `core:webview:*`, `core:app:*`, `core:image:*`,
  `core:menu:*`, `core:resources:*`, `core:tray:*` permissions (no imports of
  the corresponding JS APIs anywhere in `src/`).

Notes on custom commands: Tauri capability permissions gate **plugin and core
commands only**. The app's own Rust IPC commands (`start_download`,
`cancel_download`, `default_download_dir`, `fetch_latest_release`,
`fetch_recent_releases`, `fetch_fdroid_package`, `fetch_text`,
`fetch_self_update_text`, `host_arch`, `launch_app_image_artifact`) are not
authorization-gated by capabilities; they must enforce their own input
validation in Rust (see the URL allowlist inside `fetch_text`, the
repo-pinned admission inside `fetch_self_update_text`, the native network
policy in `src-tauri/src/`, and the registry-bound gates inside
`artifact_open.rs` — staging names, traversal, symlinks, non-regular files
and paths without an engine completion record are all refused before the
one privileged operation it performs: chmod +x on THAT validated AppImage
followed by a direct argv exec, no shell; see
`docs/download-open-contract.md`). `app_version` was removed in the
October 2026 audit: no frontend call site ever existed (the UI reads its
version from `package.json`), and an uncallable command is surface without
a purpose.

## Content Security Policy

The production CSP (`app.security.csp`):

```
default-src 'self'; script-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.github.com https://github.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'
```

Directive rationale:

- **`script-src 'self'`** — the build output has no inline scripts
  (`theme.js` is an external file for exactly this reason) and the app never
  uses `eval`/`new Function`. Tauri's own initialization scripts are allowed
  automatically via the nonce Tauri injects at serve time.
- **`style-src-elem 'self' 'unsafe-inline'`** — required because `sonner` (the
  toast library) injects a `<style>` element at runtime. The Vite production
  build ships all other CSS as external files, so `'self'` covers the app.
- **`style-src-attr 'self'`** — style *attributes* stay blocked. React 19
  applies `style={{...}}` props through CSSOM (`node.style.setProperty`),
  which CSP does not restrict, so the app needs no inline style attributes.
  This removes the `style="..."` attribute injection vector while keeping
  dynamic styles working (verified against the production bundle: zero
  `setAttribute("style")` / `cssText` usages).
- **`img-src 'self' data:`** — local assets plus the small data-URL icons the
  UI uses. No remote image hosts are allowed.
- **`font-src 'self' data:`** — self-hosted Fontsource files.
- **`connect-src`** — `'self'` plus the one host the WebView itself fetches:
  - `https://api.github.com` — self-update check, star counts, live search,
    add-app repo validation. The only WebView-fetched host that answers CORS
    (`access-control-allow-origin: *`).
  - `https://github.com` was REMOVED in the October 2026 audit. It used to
    cover the `releases.atom` fallback and the `SHA256SUMS.txt` asset fetch in
    `src/lib/selfUpdate.ts`, but github.com does not answer CORS, so those
    WebView fetches failed regardless of CSP — the entry permitted a request
    that could never succeed. Both reads now go through the native
    `fetch_self_update_text` command (GitHub-host allowlist, Fress repo path
    pin, per-hop re-check, 2 MiB cap), and the CSP entry is gone with them.
  - `https://f-droid.org` was removed earlier: inside the desktop app the only
    F-Droid WebView fetch (`getFdroid` in `src/lib/releaseFetch.ts`) is gated
    behind `!isTauri()` and the desktop path uses the native
    `fetch_fdroid_package` command instead, so the Tauri WebView never
    requests that host.
- **`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-src 'none'`** — plugins, base-URI hijacking, form exfiltration and
  framing stay fully denied.

There is deliberately **no `devCsp` override**: development falls back to the
same hardened policy, so no dev-only relaxation can leak into production.

## WebView requests vs native requests

CSP `connect-src` governs **WebView (`fetch`) traffic only**. It does not
restrict:

- the native Rust HTTP client (`reqwest`) used by the download manager and
  the `fetch_latest_release` / `fetch_recent_releases` / `fetch_fdroid_package`
  / `fetch_text` commands — governed by the Rust-side URL policy in
  `src-tauri/src/` (see the native network policy module);
- files opened or revealed through the native open/reveal boundary
  (`open_downloaded_file` / `reveal_download_file` — validated against the
  session completed-artifact registry; `open_download_dir` for folder
  targets, see the capability matrix above);
- the updater plugin, when it gets wired (governed by its own endpoint
  configuration).

## External URL-opening policy

All external links go through `openExternal()` in `src/lib/external.ts`,
which requires an `http(s):` URL and calls the opener plugin's `openUrl`.
The capability scope narrows this to `https://**` at the permission layer:
`http:`, `mailto:`, `tel:`, `file:` and custom schemes are rejected by the
IPC layer even if the frontend check were bypassed. The catalog intentionally
links to arbitrary official publisher websites, so there is no site
allowlist; the security boundary is the scheme scope plus the fact that
opening a URL grants the target no native capabilities.

## Self-update mechanism

Two paths exist by design (documented in `CODE_SIGNING.md`):

1. **Active:** the custom self-updater in `src/lib/selfUpdate.ts` — checks
   GitHub releases over the WebView (`api.github.com` primary,
   `releases.atom` fallback through the native `fetch_self_update_text`
   command), hands the platform-matched installer to the native download
   manager and verifies SHA-256 against `SHA256SUMS.txt` — the checksum
   document is read through `fetch_self_update_text` as well, so the
   verification runs inside the app instead of silently degrading. When the
   checksum cannot be established (missing file, missing entry, unreachable),
   the update is NOT delivered: both update buttons open the releases page
   instead (fail closed, `planUpdateDelivery` in `src/lib/selfUpdate.ts`).
2. **Configured but not wired:** `plugins.updater` in `tauri.conf.json`
   (public key + endpoint) exists for the future Tauri updater plugin.
   `tauri-plugin-updater` is intentionally **not** a Cargo dependency yet and
   the plugin is not registered in `Builder`, so this config block has no
   runtime effect today; `release.yml` already produces the signed
   `latest.json` / `.sig` artifacts for it via `updater-overrides.json`
   (`bundle.createUpdaterArtifacts`). Do not treat the block as an active
   defense, and do not rotate or edit the embedded key in a configuration
   change.

Which mechanism establishes what: `SHA256SUMS.txt` provides the INTEGRITY
checksum (file matches what CI built); the minisign `.sig` + `latest.json` +
embedded public key provide AUTHENTICITY for the future updater plugin (who
authorized the artifact). They are separate guarantees and the docs keep them
separate.

### Former known limitation (resolved October 2026)

The self-updater's WebView fetches to `github.com` (`releases.atom`, and the
`SHA256SUMS.txt` release asset and its redirect to
`release-assets.githubusercontent.com`) failed on **CORS**, not on CSP: GitHub
does not send `access-control-allow-origin` on those responses, so a
cors-mode `fetch()` from the WebView could not read them regardless of CSP.
Every shipped release therefore degraded to "unverified" self-updates and a
dead atom fallback. Resolved by routing both reads through the native
`fetch_self_update_text` command, whose admission is narrower than any
WebView fetch could be: HTTPS only, hosts pinned to `github.com` + the two
GitHub asset CDNs (`network_policy::UrlPolicy::self_update_feed`, every
redirect hop re-checked), the `github.com` path pinned to the `WasewaseX/Fress`
repository, private addresses refused, and the response body capped at 2 MiB.
With no WebView fetch of `github.com` left, its `connect-src` entry was
removed. The browser (web preview) keeps the plain-`fetch` fallback, where
the same CORS failure degrades to null and the update links out to the
releases page — unchanged behavior for a context without a native bridge.

## Local validation

```bash
npm run build             # production frontend build
npm run lint              # typecheck
npm test                  # vitest suite
npm run validate:security # capability + CSP + version consistency checks
```

`scripts/validate-security-config.mjs` asserts the exact permission matrix
above, the CSP directives, version consistency across `package.json`,
`tauri.conf.json` and `src-tauri/Cargo.toml`, and that the embedded updater
public key still matches `fress-updater.key.pub`. It fails on any unexplained
additional grant, so new permissions must be added there (with evidence and a
docs update) rather than silently.

`scripts/csp-test-server.mjs` is a small harness that serves `dist/` with the
CSP injected as a meta tag (mimicking Tauri's injection) and runs page-context
probes (inline `<style>`, style attributes, eval, per-host fetches) for
manual verification in a browser.

Rust-side validation (`cargo check` / a real `tauri build`) and runtime
testing of the packaged desktop app require the platform toolchains
(webkit2gtk on Linux, WebView2 on Windows); the configuration-level checks
above are what can run without them.

## Known limitations and future review items

- The `plugins.updater` block is a staged migration state, not an active
  mechanism (see above). Wiring the plugin is a deliberate future task that
  must re-check the endpoint, the key and the capability additions the plugin
  requires. The endpoint points at `releases/latest/download/latest.json`,
  which only resolves for STABLE releases — while Fress publishes
  prereleases, wiring the plugin also needs a per-channel manifest decision
  (see CODE_SIGNING.md).
- macOS updater artifacts: releases v1.0.4–v1.0.6-beta shipped dmgs without
  the `.app.tar.gz`/`.sig` pair, so `latest.json` has no darwin entries. The
  active self-update path is unaffected (it verifies checksums, not
  signatures), but wiring the plugin for macOS needs a CI fix first.
- Live star counts for GitLab-hosted projects (fetched from
  `gitlab.com`/self-hosted instances by `src/lib/starFetch.ts`) are blocked by
  `connect-src` and degrade to cached/absent counts. Allowing those hosts
  would widen the WebView network surface for a cosmetic feature; the
  catalogs' GitHub-hosted projects are unaffected.
- `freezePrototype` is enabled (`app.security.freezePrototype: true`):
  `Object.freeze(Object.prototype)` runs as an initialization script on every
  webview to harden against prototype pollution. The full production bundle
  was verified to boot and render with a frozen prototype; if a future
  dependency extends built-in prototypes, this setting is the first thing to
  check.
