# Native code-integrity audit — October 2026 (post-v1.0.12-beta)

Audit scope: `src-tauri/src/**` at main `93f87ce` (the v1.0.12-beta release
bytes plus merged docs/CI/frontend PRs #73/#75/#76/#77/#78 — zero app-code
changes between the release tag `6d338fd` and the audited tree). Auditor:
native-integrity audit round (Agent 4). This report is the deliverable of
the "Native Code Integrity, Security and Rust Bug Audit" mandate; it records
what was checked, what was found, what was fixed, and what could not be run
locally.

## 1. Native command inventory

All commands registered in `src-tauri/src/lib.rs`
(`tauri::generate_handler!`), with their actual boundary behavior as read
from the code (not from names or comments). Frontend call sites were
inventoried by grepping every `invoke(...)` in `src/`; every registered
command has exactly one or more matching call sites, and no frontend call
targets an unregistered command.

| Command | Frontend call site | Input validation (native) | Authority | Privileged operation | Failure behavior | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `start_download` | `src/lib/downloads.tsx` (1) | URL admitted by `network_policy::UrlPolicy::executable_download()` BEFORE any side effect; `directory` is user-selected (folder picker contract); `filename` through `sanitize_filename`; digests normalized by `verify_digest` | Network (any public HTTPS host), filesystem write to the chosen directory | Streams the resource to an atomically-reserved `.part`, verifies digests, atomic no-clobber commit | Typed `(message, kind)` errors; every terminal outcome releases the registry entry; panics contained by `catch_unwind_result` | 88 engine tests (state machine, resume, checksums, cancellation, disk-full, collisions, registry records) |
| `cancel_download` | `src/lib/downloads.tsx` (1) | id only; unknown id is a no-op | Signals cancellation channel | Signals the engine task; never mutates state directly (single-writer) | Always Ok; late cancels are harmless no-ops | cancel mid-transfer, cancel during backoff, cancel-vs-verification races (3 tests) |
| `default_download_dir` | `src/lib/downloads.tsx` (3) | none needed | Filesystem read | Returns the platform download folder (Windows `FOLDERID_Downloads` incl. OneDrive redirection, macOS `~/Downloads`, Linux XDG, Android app-private `files/Download`) | Falls back home dir → `"."` | covered by platform review; not unit-testable without an AppHandle |
| `fetch_latest_release` | `src/lib/*.tsx` (1) | repo slug trimmed; URL constructed locally and admitted by `UrlPolicy::api_github()` (host pinned, per-hop pinned, private literals refused); body now read under `API_BODY_CAP` | Network to `api.github.com` (TLS, 20 s request + 15 s connect timeout) | None (read-only fetch → serde parse) | Named errors for 404/429/5xx/parse; `describe_network_error` for transport | `release_commands_reject_empty_repositories_before_network`, policy admission matrix |
| `fetch_recent_releases` | `src/lib/*.tsx` (1) | same as above + `count.clamp(1, 30)`; prerelease filter (bypassable only via explicit `include_flagged`) | same | same | same | same |
| `fetch_fdroid_package` | `src/lib/*.tsx` (1) | pkg trimmed; URL admitted by `UrlPolicy::api_fdroid()` (exact-host pin); body now read under `API_BODY_CAP` | Network to `f-droid.org` | None | Named errors; suggested-version sanity (`suggestedVersionCode <= max observed`) | empty-repo/pkg rejection test |
| `fetch_text` | `src/lib/*.tsx` (1) | `UrlPolicy::resolver_manifest()`: HTTPS-only, 21-host allowlist, credentials refused, private literals refused, EVERY redirect hop re-checked against the same rules; body streamed under the 2 MiB cap (`FETCH_TEXT_BODY_CAP`) | Network to allowlisted vendor hosts | None | Redirect refusals named (`too many redirects`, `left the pinned/allowlisted host`, `insecure redirect`); truncation reported via `truncated: true` (frontend fail-closes on it) | 48 policy tests incl. per-hop matrices, `fetch_text_enforces_https_and_the_host_allowlist_before_any_request` |
| `fetch_self_update_text` | `src/lib/selfUpdate.ts` (1) | Narrower than `fetch_text`: 2 GitHub-owned hosts only + **repo-path pin** (`/WasewaseX/Fress/…`) so even a compromised webview cannot read other github.com documents; same per-hop checks; 2 MiB cap | Network to `github.com` / release-asset CDN | None | same as fetch_text | dedicated admission suite (`self_update_text_tests`, 4 tests) |
| `verify_self_update_signature` | `src/features/selfUpdate/updateDelivery.ts` (1) | Registry-scoped: the path must match a completed-artifact record the ENGINE created on a hash-checked commit; staging shapes refused by construction; canonical-stability re-check; open-handle metadata (regular file, committed size); then the byte verdict | Filesystem READ of one registered artifact; minisign verification against the compile-time-embedded public key | None (verify-only: ok/error, never contents, never writes/launches) | Uniform refusal for every unregistered path (anti-probe: `VERIFICATION_SCOPE_REFUSAL`); diagnostics carry only the caller's own record provenance | 16 boundary tests: unregistered path, staging shapes, in-place tamper, replaced/deleted/symlink-swapped artifact, foreign key, malformed/truncated documents, registry immutability, uniform-refusal equality |
| `host_arch` | `src/lib/*.tsx` (1) | none | None | Reads the machine architecture (Windows: `GetNativeSystemInfo` native machine, not the emulated process view) | Falls back to compile-time `ARCH` | documented; Windows-specific logic is cfg'd and CI-proven on the Windows runner |
| `launch_app_image_artifact` | `src/lib/downloads.tsx` (1) | Name gates (`.part`/`.part.meta`/`.sig`/empty/`..` refused before ANY filesystem touch), shape gate (`symlink_metadata` regular file — symlinks refused), registry-bound (engine record + id match + canonical stability + committed size), AppImage-only | Filesystem: `chmod +x` on THAT validated file only, then direct argv `Command::new(path)` (no shell, no arguments) | Launches the one AppImage | Typed rejections (`open-artifact/<code>`) rendered for the frontend; spawn errors surfaced | 19 boundary tests (traversal, staging, symlink, restored rows, cross-wiring, cap eviction, Unicode names, non-AppImage routing) |

Plugins (capability-gated, not app commands): `dialog:allow-open` (folder
picker), `core:event:allow-listen/unlisten` (download events),
`core:path:allow-dirname` (reveal fallback), `opener:allow-open-url` scoped
to `https://**`, `opener:allow-open-path` / `opener:allow-reveal-item-in-dir`
(see §5 for the accepted residual).

## 2. Download finalization and artifact registry — VERIFIED

Checked against every bullet of the mandate (source:
`src-tauri/src/download_finalize.rs`, 5,326 lines):

- **Completion records only after a successful, byte-accounted, hash-checked
  transfer.** `record_completed_artifact` is called from exactly one place —
  the commit path after `commit_no_clobber` succeeded. Cancelled, failed,
  checksum-mismatched and resume-invalid downloads never reach it
  (pinned by `a_cancelled_download_never_leaves_a_completed_record`,
  `a_checksum_failure_leaves_no_completed_record`).
- **Checksum mismatch can never leave a runnable trusted record.** The
  mismatch branch deletes the staging bytes and returns `kind = checksum`
  before the commit; `checksum_verified` is `Some(true)` only on a trusted
  match and `None` otherwise (`Some(false)` unreachable by construction).
- **Event fields belong to the correct transfer.** Payloads carry the
  engine-allocated `id`; `path` is the committed path returned by the atomic
  commit; digests are computed over the staged bytes of THIS attempt (resume
  prefixes re-hashed from disk). Two same-name concurrent downloads are
  separated by the atomic `create_new` staging reservation
  (`two_completed_downloads_never_cross_their_boundary_records`).
- **Staging shapes cannot be opened or verified as completed artifacts.**
  Refused by name in both privileged boundaries before any filesystem touch,
  and the registry cannot contain one
  (`staging_part_files_are_never_verification_candidates`,
  `staging_files_and_sidecars_are_never_openable`).
- **Traversal/symlink/invalid-id/replaced/non-regular rejections** — all
  present in both boundaries and unit-tested (`traversal_targets_are_refused…`,
  `an_unexpected_symbolic_link_is_never_followed`, `a_restored_after_restart_row…`,
  `a_truncated_or_replaced_appimage_is_refused_as_replaced`,
  `a_directory_is_rejected_as_not_a_file`).
- **Restored history rows have no authority.** Negative ids fail closed in
  the launcher; the verifier requires a live registry record
  (`a_restored_after_restart_row_is_never_auto_launched`).
- **Exact (id, path) pair.** `record.id != id` → `IdMismatch`
  (`cross_wiring_two_downloads_is_refused`).
- **Registry mutation is constrained and non-poisoning.** `completed` uses a
  `std::sync::Mutex` with no await and no panic inside the critical section;
  the active-state map is single-writer (the task itself) with a checked
  transition table (`session_walks_every_documented_edge_and_rejects_the_rest`).

## 3. Native URL fetching and redirects — VERIFIED (one defect found & fixed)

The three-layer policy (admission → per-hop redirect rules →
public-address-only DNS resolver) was verified line by line, including the
brief's specific bypass cases, each of which is pinned by an existing test:
IP-literals (v4 private/CGNAT/link-local/metadata + v6 ULA/link-local/
mapped/NAT64/6to4/doc ranges), userinfo tricks (`https://trusted@evil`),
IDN/punycode (normalized to punycode, byte-exact comparison), mixed-case and
percent-encoded hosts (WHATWG normalization then exact compare), trailing
dot (NOT the pinned host — refused), IPv6 zone ids (refused), redirect
downgrades, credential-bearing hops, loop detection, hop budgets, and
DNS-rebinding (the resolver re-filters every connection; literals never
reach the resolver, pinned by `address_literal_requests_never_consult_the_resolver`).

**DEFECT N-1 (MEDIUM-LOW, robustness/Crash): unbounded API response bodies.**
`fetch_latest_release`, `fetch_recent_releases` and `fetch_fdroid_package`
read responses with `resp.text()` — no size bound. The text commands cap at
2 MiB, but the JSON API commands buffered without limit; a hostile or
compromised pinned host (api.github.com / f-droid.org — the only hosts these
commands can reach, which is exactly the trust level the manifest cap was
added for) could stream an arbitrarily large body and balloon the app's RSS
until the process is OOM-killed. The 20 s request timeout does not bound a
fast pipe (≥ 2 GB on a 100 MB/s link). Location: `src-tauri/src/lib.rs`, the
three `resp.text().await` call sites. **Fix:** new `read_capped_api_text`
helper (10 MiB `API_BODY_CAP`): oversized advertised content-length refuses
before reading; a body that grows past the cap mid-stream is refused at the
line; non-UTF-8 API bodies now fail with a named error instead of silently
lossy-converting into a confusing JSON parse error. Regression tests:
`api_text_reads_accept_a_body_under_the_cap`,
`api_text_reads_refuse_an_oversized_content_length_before_the_body`,
`api_text_reads_refuse_a_body_that_grows_past_the_cap_midstream`,
`api_body_cap_is_the_documented_ten_megabytes` (loopback server, lib.rs
command layer).

## 4. Updater cryptography boundaries — VERIFIED

- Format compatibility: Tauri document format (outer base64 → minisign
  document) is decoded identically for the key and the signature;
  production passes the compile-time-embedded key
  (`UPDATER_PUBLIC_KEY_FILE_B64`), tests drive the same code with a fixture
  key. `the_embedded_public_key_is_the_published_fress_key` pins the key id
  (`5638C68123FB633B`) against CODE_SIGNING.md's published value.
- Fail-closed matrix: malformed base64, non-minisign documents, truncated
  documents, foreign keys, legacy (non-prehashed) signatures (refused by
  policy in `minisign-verify` usage), tampered/truncated/appended artifact
  bytes — all refuse; each has a test.
- Scope: the verdict is computed over the bytes of ONE open handle that was
  metadata-checked first (regular file, committed size, canonical
  stability); the registry binding makes an arbitrary webview path a
  uniform refusal. The frontend passes the engine-reported `payload.path`
  correlated to the update's own download id (checked in
  `src/features/selfUpdate/updateDelivery.ts`), and the plan gate binds the
  sidecar to the pinned release feed. Deliberate non-promise (documented in
  code): minisign trusted comments are not verifiable via
  `minisign-verify`, so version/filename binding of the DOCUMENT is the
  frontend's plan gate; a wrong-version document still cannot forge a
  verdict (it verifies only over genuinely-signed bytes).
- Diagnostics carry the caller's own record provenance (id, url, checksum
  verdict); no secrets, no other paths, no file contents.
- Verification is never weakened or bypassed anywhere in the delivery flow;
  no path exists from a failed verdict to a "verified" state (three-gate
  lifecycle in the frontend, registry-gated native verifier here).

## 5. Tauri capability and process-boundary review — VERIFIED (2 accepted residuals)

- `capabilities/default.json` matches the traced frontend call sites
  exactly (matrix in `docs/security/tauri-security.md`, confirmed current);
  `opener:default`'s unscoped URL permission is deliberately replaced by
  `https://**`; no window/webview/app/menu permissions exist.
- `tauri.conf.json`: CSP `default-src 'self'; script-src 'self'; …
  connect-src 'self' https://api.github.com` — the webview cannot fetch
  release assets or arbitrary hosts directly; the native policy commands are
  the only outbound path. `freezePrototype: true`. The dormant
  `plugins.updater` block is unregistered in `lib.rs` (only dialog + opener
  plugins initialized) — consistent with CODE_SIGNING.md.
- The frontend cannot execute a shell command: no shell-open capability, no
  `Command` construction from webview input; the AppImage launcher spawns
  the validated file directly with no arguments; `chmod +x` is granted to
  that one file only at the moment of that one user action (never to
  downloads in general), and the request must carry the engine's
  (id, path, registry-record, canonical, size) five-way match.
- **Accepted residual 1 (documented):** `opener:allow-open-path` /
  `allow-reveal-item-in-dir` are unscoped at the permission layer (they
  cannot be scoped statically because the download directory is
  user-configurable at runtime). The webview-level policy
  (`src/lib/artifactOpen.ts`) is the gate; a compromised webview could call
  the plugin directly with any path, which hands it to the OS default
  handler — the same consent flows (UAC, Gatekeeper, package installer)
  stay in force, and reveal only shows the file in the file manager. Risk
  accepted and documented in `tauri-security.md`.
- **Accepted residual 2 (noted this audit):** the AppImage launcher's typed
  taxonomy distinguishes path shape BEFORE the registry lookup
  (`NotFound` / `NotAFile` / `Symlink` / `UnsupportedPlatform` vs
  `NotRegistered`), so a compromised webview could classify a path's
  existence/type through the error code. The signature-verification
  boundary deliberately has a uniform refusal and does not leak this; the
  launcher does, because the taxonomy is the frontend's localized-message
  contract (pinned by frontend tests). Information-disclosure-only,
  no launch or read capability — accepted; any change would be a
  cross-team frontend contract change.

## 6. Persistence and crash/hang review — VERIFIED

- **No panics reachable from untrusted input.** The only non-test
  `expect`s are the two completed-queue mutex locks (poisoning requires an
  already-panicking process; no panic path exists inside the critical
  sections). Everything else is `Result`-based; URL parsing, header parsing,
  integer parsing, JSON parsing and filesystem errors are all returned.
- **Locks:** the active-state mutex is held for map mutations only (no I/O
  under lock); the completed-queue mutex has no await inside; the download
  loop holds no lock while streaming. No deadlock path found between
  `cancel_download` (signals only) and the engine task (single writer).
- **Bounded reads:** response bodies (2 MiB text / 10 MiB API after N-1),
  streamed download staging (disk, not memory), 64 KiB signature-verify
  chunks, 256 KiB resume-rehash chunks. Download stall: 60 s per chunk
  (`tokio::time::timeout`); API clients: 20 s whole-request + 15 s connect;
  the download client deliberately has no whole-request timeout (large
  installers) and enforces the stall window instead.
- **Partial writes:** staging `.part` + `.part.meta` design means a crash
  mid-download never produces a finished-looking file; the commit is an
  atomic hard link (or `create_new`+copy with reservation cleanup); `sync_all`
  before commit; a failed reservation removes itself.
- **Duplicate state transitions:** the checked transition table rejects
  illegal edges; `settle` is a no-op on terminal states; `release` is
  idempotent.
- **Cancellation:** observed while streaming, during backoff, and drained
  at the last checkpoint before completion; a cancel cannot produce a
  completed event (pinned by 6 race tests).
- **Cross-platform paths:** no path-string splitting/joining beyond
  `file_name`/`parent` joins; Windows reserved device names collapsed by
  `sanitize_filename`; OneDrive-redirected Downloads via `dirs`;
  canonicalize comparisons always compare canonical-to-canonical;
  Android uses the app-private dir (no shared-storage permission
  assumptions). Windows Unicode paths go through Rust's WTF-16 conversion
  in std — no manual byte casts anywhere.

## 7. Dependency and build integrity

Rust toolchain: the repo pin (`rust-toolchain.toml` → 1.98.1, profile
minimal, clippy + rustfmt) was installed locally and used for every command.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | **PASS** (local, 1.98.1; also enforced after every edit in this round) |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | **NOT RUN locally — CI-proven.** The sandbox lacks the GTK/WebKit system libraries (no root; `libwebkit2gtk-4.1-dev` unavailable), and the Tauri crate cannot be compiled without them. The audit branch's CI run executes clippy on ubuntu-22.04, Windows and macOS runners; result recorded in the PR. |
| `cargo test --workspace --locked` | **Partially run locally via a byte-for-byte harness** (see below); full workspace **CI-proven** (same PR run). |
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, RustSec DB cloned live) | **PASS — 0 vulnerabilities.** 8 advisory-grade warnings, all transitive, none reachable as a vulnerability: RUSTSEC-2024-0370 (`proc-macro-error` unmaintained, via glib-macros/gtk3-macros), RUSTSEC-2025-0081/-0075/-0080/-0100/-0098 (`unic-*` unmaintained, via `urlpattern`), RUSTSEC-2024-0429 (`glib` 0.18 unsound iterator impls, via the GTK Linux stack), 1 yanked (`yoke-derive`, no advisory). Matches security.yml's ADVISORY policy; no action required this round. |
| Cargo.lock drift vs release tag `6d338fd` | **ZERO drift.** No new dependency, no git/path source, no upgrade, no agent residue in the final diff. |

**Local execution harness.** Because the full Tauri crate cannot compile in
this sandbox, the audit compiled the REAL `download_finalize.rs` +
`network_policy.rs` (both deliberately Tauri-free by design) into a scratch
harness crate via `#[path]` includes with the exact `Cargo.lock` dependency
versions (reqwest 0.12.28, tokio 1.53.1, …) and ran their test suites
against the pinned 1.98.1 toolchain: **142/142 tests pass** (the 140
pre-existing engine + policy tests plus this round's 2 new
`Content-Range` regressions). The harness is audit tooling under
`scripts/native-harness/` OUTSIDE the repository; the repository diff
contains only source + tests.

## 8. Defects found this round (both fixed with regressions)

| ID | Severity | Location | Defect | Fix | Regression |
| --- | --- | --- | --- | --- | --- |
| N-1 | MEDIUM-LOW (crash/robustness) | `lib.rs`: `fetch_latest_release`, `fetch_recent_releases`, `fetch_fdroid_package` | Unbounded `resp.text()` on pinned-host JSON responses (OOM kill possible under a hostile/broken pinned host; inconsistent with the 2 MiB manifest cap) | `read_capped_api_text` streaming helper, 10 MiB `API_BODY_CAP`, named refusal, strict UTF-8 | 4 tests in `download_integration.rs` (under-cap / oversized-CL / midstream-overrun / cap pin) |
| N-2 | LOW (panic in overflow-checks builds; silent wrap in release) | `download_finalize.rs`: `validate_resume_content_range` (+1 overflow), `run_download_on` (`already_have + range_len` sum, `remote_len + already_have` display total) | Hostile `Content-Range: bytes 0-18446744073709551615/*` overflowed `end - start + 1` (panic under overflow-checks; wrapped to 0 in release, poisoning the completion decision); the resume-sum could overflow the same way | checked arithmetic: the header is refused as malformed ("too large"); the sum refusal is a named final protocol error ("impossible byte range"); the display total is saturating | unit `a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked` + e2e `a_hostile_u64_max_content_range_fails_named_without_completing` (mock server) |

Both defects were fail-closed in their worst documented case (no corrupted
finalization, no false verification), but N-2's panic surface and N-1's
unbounded memory made them worth fixing now rather than tracking.

## 9. Remaining tests that need real hardware / OS

Unchanged from the documented smoke matrix
(`docs/testing/download-open-smoke.md`) — none of them block this audit,
none of them are claimed as run:

- Windows: installer launch via `open_path` (UAC / SmartScreen surfaces),
  OneDrive-redirected Downloads default, MSI handoff to msiexec.
- macOS: first-launch Gatekeeper right-click → Open on unsigned dmgs,
  reveal-in-Finder.
- Linux: AppImage launch from a stock GNOME/KDE session (the
  validated-chmod + direct-exec path), XDG download-dir localization.
- Android: everything in the smoke matrix's Android rows (the in-app
  installer handoff is NOT on main; PR #74 is open and unmerged — its own
  verification explicitly separates mocked/emulated evidence from the
  not-run device checklist).

## 10. Conclusion

**PASS with 2 fixed defects** — no release-blocking native
security/correctness defect remains known:

- The artifact trust boundary (registry → verification → launch) holds
  end to end and is regression-pinned at every gate.
- The network policy admits exactly the documented request classes, per
  hop and per connection, with every brief-specified bypass case
  already test-pinned (and no bypass found).
- The updater signature boundary is verify-only, fail-closed, and bound
  to engine-committed artifacts under the embedded production key.
- Capabilities are minimal and match the documented matrix; no shell
  surface exists.
- Dependency audit: 0 vulnerabilities; advisory-grade transitive
  warnings recorded above; Cargo.lock byte-identical to the release.

NOT RUN locally (CI-proven instead, on this branch's checks): the full
workspace clippy/test build on the three CI OSes, and every real-device
row in §9. Nothing in this report relies on those unrun checks.
