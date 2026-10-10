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
| `opener:allow-open-path` | "Open file" / "Open folder" on completed downloads | `openPath()` in `src/lib/downloads.tsx` |
| `opener:allow-reveal-item-in-dir` | "Show in folder" reveals a download in the platform file manager | `revealItemInDir()` in `src/lib/downloads.tsx` |

Deliberately NOT granted (each verified unused by the frontend):

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
`cancel_download`, `default_download_dir`, `app_version`,
`fetch_latest_release`, `fetch_recent_releases`, `fetch_fdroid_package`,
`fetch_text`, `host_arch`) are not authorization-gated by capabilities; they
must enforce their own input validation in Rust (see the URL allowlist inside
`fetch_text` and the native network policy in `src-tauri/src/`).

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
- **`connect-src`** — `'self'` plus the two hosts the WebView itself fetches:
  - `https://api.github.com` — self-update check, star counts, live search,
    add-app repo validation. The only WebView-fetched host that answers CORS
    (`access-control-allow-origin: *`).
  - `https://github.com` — the `releases.atom` fallback and the
    `SHA256SUMS.txt` asset fetch in `src/lib/selfUpdate.ts` (see the CORS
    limitation below). This entry exists so the CSP is never the reason such
    an attempt fails.
  - `https://f-droid.org` was removed: inside the desktop app the only
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
- files opened or revealed through the opener plugin (governed by the
  capability scopes above);
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
   GitHub releases over the WebView (`api.github.com` primary, `github.com`
   `releases.atom` fallback), hands the platform-matched installer to the
   native download manager and verifies SHA-256 against `SHA256SUMS.txt`.
2. **Configured but not wired:** `plugins.updater` in `tauri.conf.json`
   (public key + endpoint) exists for the future Tauri updater plugin.
   `tauri-plugin-updater` is intentionally **not** a Cargo dependency yet and
   the plugin is not registered in `Builder`, so this config block has no
   runtime effect today; `release.yml` already produces the signed
   `latest.json` / `.sig` artifacts for it via `updater-overrides.json`
   (`bundle.createUpdaterArtifacts`). Do not treat the block as an active
   defense, and do not rotate or edit the embedded key in a configuration
   change.

### Known limitation (needs a future, coordinated fix)

The self-updater's WebView fetches to `github.com` (`releases.atom`, and the
`SHA256SUMS.txt` release asset and its redirect to
`release-assets.githubusercontent.com`) fail on **CORS**, not on CSP: GitHub
does not send `access-control-allow-origin` on those responses, so a
cors-mode `fetch()` from the WebView cannot read them regardless of CSP. The
primary `api.github.com` path is unaffected (it sends `ACAO: *`), so update
*checks* work; the checksum-verification step silently degrades to
"unverified". The proper fix is routing those reads through a native command
(they are outside this configuration workstream — `src/lib/selfUpdate.ts` and
`src-tauri/src/lib.rs` have separate owners), after which the `github.com`
connect-src entry can be re-evaluated.

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
  requires.
- The self-updater's `github.com` WebView fetches fail on CORS today
  (checksum verification degrades to "unverified"); fix belongs to the
  native/networking workstream.
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
