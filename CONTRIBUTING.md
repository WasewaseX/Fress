# Contributing to Fress

Thank you for helping keep Fress clean and trustworthy.

## Ground rules

1. **Every app must be genuinely free and open source.** Freeware with a closed license does not qualify. The license badge must match reality.
2. **Popular and tested.** At least one of: 1,000+ GitHub stars, a major distro package, or years of established community use.
3. **Official links only.** Website, repository, and download URLs must point to the project's own domain or its official GitHub/GitLab. No mirrors, no affiliate links.
4. **Honest descriptions.** No marketing fluff. Say what the app does and what it replaces.
5. **Check links before submitting.** A broken or moved link is the most common defect.

## Adding an app

1. Edit `src/data/appsDataExtra.ts` (or `appsData.ts` for the original set).
2. Follow the existing `AppItem` shape in `src/types.ts`.
3. Include: id (lowercase, unique), tagline (one line), description (2-3 sentences), beginner guide, platform list, license, official URLs, and package-manager commands when they exist.
4. Set `lastChecked`-style honesty: only submit links you personally opened today.
5. One pull request per app keeps review fast.

## The Pick

There is exactly **one** Owner Pick in the catalog (currently VLC). Please do not add more; it is meant to be a single, hard-earned recommendation.

## Code changes

- `npm run lint` must pass.
- Keep components dependency-light; new npm packages need a justification.
- Test in **both light and dark themes** before submitting UI changes.
- If you add UI text, add the string to `src/lib/i18n.tsx` for all five languages (English plus at least one other is acceptable; translators will follow).

## Reporting a broken link

Open an issue titled `link rot: <app name>` with the app id and what changed (dead URL, new official domain, abandoned project). Issues are triaged by last-checked date.

## Testing and CI

### What must pass before merge

Every pull request (and push to `main`) runs `.github/workflows/ci.yml`:

| Gate | Where | What it proves |
| --- | --- | --- |
| Version consistency | `version-guard` | `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` declare the same version, so no tag can drift into a confusing release. |
| Typecheck | `frontend` | `tsc --noEmit` passes. |
| Frontend unit tests | `frontend` | `vitest run` covers resolvers, release-asset matching, import sanitization, download persistence and the queue. |
| Catalog validator | `frontend` | `npm run validate:catalog` — the catalog is the product; duplicate ids, dead links and missing icons fail here. |
| Production build | `frontend` | `vite build` succeeds from the lockfile-installed tree (`npm ci`). |
| Rust formatting | `rust` | `cargo fmt --check` against the toolchain pinned in `rust-toolchain.toml`. |
| Rust linting | `rust` | `cargo clippy --all-targets -- -D warnings` — lint-clean test code included. |
| Rust tests (Linux) | `rust` | `cargo test --manifest-path src-tauri/Cargo.toml` — the suite **runs**, not merely compiles. |
| Rust tests (Windows, macOS) | `rust-native` | The same suite on the other desktop platforms Fress ships installers for. |

Release packaging (installers, APKs, updater manifest, checksums, VirusTotal links, draft-then-verify gate) stays exclusive to tag pushes in `release.yml` and is exercised when a `v*` tag is cut.

### Reproducing the checks locally

```bash
# Frontend gates
npm ci                      # installs strictly from package-lock.json
npm run typecheck           # tsc --noEmit
npm test                    # vitest run
npm run validate:catalog    # catalog validator
npm run build               # production frontend build (also required for the Rust jobs:
                            #  tauri::generate_context! embeds ../dist at compile time)

# Rust gates (needs the rustup toolchain from rust-toolchain.toml; on Linux the
# webkit/gtk dev packages listed in ci.yml are required to compile)
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm test` and `cargo test` must both be green before pushing. The Rust tests are deterministic: they use only in-process fixtures and loopback HTTP, never the network.

### Test coverage map

| Area | Kind | Covered by |
| --- | --- | --- |
| Frontend resolvers, release-asset matching, unsupported assets, override/weak-pick rules | unit | `src/lib/__tests__/releaseFetch.test.ts`, `resolveStreams.test.ts`, `officialResolvers.test.ts` |
| Imported-catalog sanitization (trust boundary) | unit | `appValidation.test.ts`, `resolveStreams.test.ts` |
| Download-panel persistence across restarts (incl. 60-entry cap, hostile fields) | unit | `downloadItemsStore.test.ts`, `downloadStore.integration.test.ts` |
| Download queue concurrency | unit | `downloadQueue.test.ts` |
| Filename sanitization, path traversal, reserved Windows names, RFC 5987 decoding | Rust unit/integration | `src-tauri/src/download_integration.rs` |
| Staging (`.part`) files, `.meta` validator sidecars, collision numbering | Rust unit/integration | `src-tauri/src/download_integration.rs` |
| GitHub release JSON parsing (trust boundary) | Rust unit | `src-tauri/src/download_integration.rs` |
| `fetch_text` SSRF rails (https-only, host allowlist) and command input validation | Rust integration | `src-tauri/src/download_integration.rs` |
| Redirect policy and request identity (`api_client`) | Rust integration (loopback server) | `src-tauri/src/download_integration.rs` |
| Resume `Content-Range` validation (RFC 9110) | Rust unit | `src-tauri/src/lib.rs` tests module |
| Known gap: the full `run_download` engine loop (mid-stream cancel, automatic retry, live Range negotiation) | — | Not unit-testable today: it is coupled to a live Tauri `AppHandle`. Changes here should be exercised manually (start a big download, cancel, resume, pull the plug) and reviewed carefully. |
| Known gap: Android packaging | — | The toolchain is only exercised on tag builds (`release.yml`). Host-platform Rust tests compile the shared engine code on three OSes as a substitute. |

### Supply-chain posture

- All third-party and first-party actions in every workflow are **pinned to commit SHAs**; dependabot-style floating tags are not used. Update pins deliberately, one PR per bump.
- `ci.yml` and `release.yml` run with `persist-credentials: false` and least-privilege permissions (`contents: read` overall; `contents: write` only on the release jobs that upload assets). Untrusted PR code never holds a repository token.
- `security.yml` scans dependencies on a weekly schedule and on lockfile changes: npm production advisories are **blocking** (the baseline is clean — `source-map-js` is pinned to the patched 1.2.2 via `package.json` overrides); dev-dependency and RustSec findings start as **advisory** so untriaged debt cannot fail every run. Flip them to blocking once their reports are clean.
- No workflow grants pull-request code access to release secrets: release jobs only run on tag pushes, and PR jobs run tokenless.

Note: automated bot PRs (Dependabot and friends) are incompatible with the author guard below unless its allowlist is consciously widened first.

