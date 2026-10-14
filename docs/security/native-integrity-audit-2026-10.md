# Native code-integrity audit — October 2026 (round 2, reconciled onto the stable candidate)

Audit scope: `src-tauri/src/**` on the integrated stable candidate — branch
`integrate/stable-candidate` (PR #85 head `a9c38f02`, which integrates PRs
#74, #79, #81, #80, #82, #83 on top of main `93f87ce`) plus this PR's commits
(branch `audit/native-integrity-r2`, retargeted to stack on the candidate per
the round-3 mandate "start from the latest candidate branch, reconcile #84's
commits onto it"). This PR's delta on the candidate is exactly the eight
audit-owned files: `lib.rs`, `http_body.rs` (new), `download_finalize.rs`,
`download_integration.rs`, `artifact_open.rs`, `network_policy.rs`,
`network_policy/tests.rs`, and this report. Reconciliation history: the
round-2 work was authored against PR #81's tree; it is now replayed on the
candidate (first onto `a9c38f02`, then re-rebased onto the moved candidate
head `ff64643` after the candidate integrated the corrected PR #81 head and
the plugin-version fix). The three-content-commit history shared with #81 is
retained through the candidate's own merges of `e4280e4` and `7c3f8b6`, so
the branch carries ALL of PR #81 with no duplicate (the zero-CJK-gate kana
fixture arrives via the candidate's merge; the checker reports zero CJK
warnings), the CI-clippy gate the round-2 head tripped is closed (`9c8b2f4`),
and the A-4 regression fixture was strengthened after the kill-test review
found it could pass without its guard (`6b6b047`).

The app-code delta between the v1.0.12-beta release tag
(`6d338fd`) and the audited tree is zero outside these audit-owned files plus
the other integrated PRs' own scopes (Android plugin, release candidate
version/docs, channel policy, smoke docs). Auditor: native-integrity round 2
(Agent 4). This round VERIFIED PR #81's two fixes on the integrated tree
(code-level, not from its descriptions), completed the proofs its report
could only assert, and fixed every new defect found. Method: five independent
audit passes (arithmetic, command/URL surface, registry/signature boundary,
toolchain/dependencies, capability/crash surface), a two-reviewer adversarial
critique loop over the final diff, local execution of every test that
compiles without the Tauri system libraries (158/158 on the reconciled tree,
log preserved), and executed kill-tests on the new guards (§8).

## 1. Native command inventory

All 11 commands registered in `src-tauri/src/lib.rs`
(`tauri::generate_handler!`, lib.rs ~:1009), re-verified against the code and
the frontend's `invoke(...)` call sites this round (no command unregistered,
no invoke of an unregistered command; the only extra name seen,
`open_downloaded_artifact` in `tests/e2e/tauri-bridge.ts:410`, is a test-only
mock hook):

| Command | Frontend call site | Input validation (native) | Authority | Privileged operation | Failure behavior | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `start_download` | `src/lib/downloads.tsx:607` | URL admitted by `network_policy::UrlPolicy::executable_download()` BEFORE any side effect; `directory` user-selected (folder-picker contract — see §5 residual 3); `filename` through `sanitize_filename`; digests normalized by `verify_digest` | Network (any public HTTPS host, ≤8 re-checked hops, public-address-only DNS), filesystem write to the chosen directory | Streams to an atomically-reserved `.part`, verifies digests, atomic no-clobber commit | Typed `(message, kind)` errors; terminal outcome always releases the registry entry; `catch_unwind_result` contains panics in non-abort builds (release builds abort by profile — fail-stop, see §6) | 90 engine tests + 26 integration tests (state machine, resume, checksums, cancellation, disk-full, collisions, registry records, hostile ranges) |
| `cancel_download` | `downloads.tsx:738` | id only; unknown id no-op | Signals the engine's cancellation channel; never mutates state | — | Always Ok; late cancels harmless | 7 cancel-race tests (mid-transfer, backoff, tail-in-flight, verification race, retry request, neighbor isolation) |
| `default_download_dir` | `downloads.tsx:445,601,907` | none | Read-only path lookup | Returns the platform download folder | home → `"."` fallback | platform review; AppHandle-bound |
| `fetch_latest_release` | `src/lib/release/githubProvider.ts:26` | repo trimmed; URL constructed locally and admitted by `UrlPolicy::api_github()` before any client exists; body read under `API_BODY_CAP` | Network to `api.github.com` (TLS, 20 s request + 15 s connect) | None | Named errors for 404/429/5xx/parse/cap/UTF-8 | `release_commands_reject_empty_repositories_before_network` + policy admission matrix |
| `fetch_recent_releases` | `githubProvider.ts:76` | same + `count.clamp(1, 30)`; prerelease filter unless `include_flagged` | same | same | same | same |
| `fetch_fdroid_package` | `src/lib/release/fdroidProvider.ts:17` | pkg trimmed; `api_fdroid()` exact-host pin; `suggestedVersionCode > 0` (when no packages array exists any positive value passes the filter — harmless: pinned host → 404; the old report's parenthetical overstated this) | Network to `f-droid.org` | None | Named errors | empty-input test + `fdroid_api_is_pinned_with_exact_match` |
| `fetch_text` | `src/lib/officialResolvers.ts:54` | `resolver_manifest()`: HTTPS-only, 21-host allowlist, credentials refused, private literals refused, EVERY hop re-checked; 2 MiB cap, truncate-and-report (`truncated: true`) | Network to allowlisted vendor hosts | None | Named redirect refusals; truncation reported as data | `fetch_text_enforces_https_and_the_host_allowlist_before_any_request` + 52 policy tests |
| `fetch_self_update_text` | `src/lib/selfUpdate.ts:48` | Narrower: 3 GitHub-owned hosts + repo-path pin at admission (`check_self_update_repo_path`, now a shared fn the tests drive) AND on every redirect hop (new `PathPin`, §3/N-3); 2 MiB cap | Network to `github.com` + 2 asset-CDN hosts | None | same as fetch_text | 5 command-layer admission tests (incl. normalization matrix) + policy tests |
| `verify_self_update_signature` | `src/features/selfUpdate/updateDelivery.ts:271` | Registry-scoped: staging-name gate → live engine record → canonical stability → open-handle metadata (regular file, committed size) → streamed minisign verdict against the compile-time-embedded key | Filesystem READ of one registered artifact; verify-only | None | Uniform `VERIFICATION_SCOPE_REFUSAL` for every unregistered path (anti-probe) | 12 boundary + 7 fixture + 8 legacy/staging tests (incl. new legacy-algorithm refusals on both verifier paths) |
| `host_arch` | `src/lib/release/hostArch.ts:32` | none | Reads CPU arch (Windows: `GetNativeSystemInfo`) | Fallback to compile-time `ARCH` | Infallible | cfg'd; CI-proven on Windows |
| `launch_app_image_artifact` | `downloads.tsx:812` | Name gates (`.part`/`.part.meta`/`.sig`/empty/`..`) before ANY fs touch; `symlink_metadata` regular-file; AppImage-only; registry + id (now `u32::try_from`-gated) + canonical + committed-size match; plan-time AND launch-time re-checks (new, §5) | `chmod +x` on THAT validated file only, then argv-only `Command::new(path)` (no shell, no args) | Launches the one AppImage | Typed `open-artifact/<code>` rejections | 22 boundary tests (traversal, staging, symlink, restored rows, cross-wiring, cap eviction, Unicode, non-AppImage, out-of-range id, plan/launch drift) |

Plugins (capability-gated, not app commands) — every permission maps to a
traced call site, none dead, none missing (verified this round):
`dialog:allow-open` (folder picker), `core:event:allow-listen/unlisten`
(download events), `core:path:allow-dirname` (reveal fallback),
`opener:allow-open-url` scoped `https://**`, `opener:allow-open-path` /
`opener:allow-reveal-item-in-dir` (unscoped; §5 residual 1). The dormant
`plugins.updater` block in `tauri.conf.json` has no Cargo dependency and is
not initialized in `lib.rs` (dialog + opener only).

## 2. Download finalization and artifact registry — VERIFIED

Re-verified against every bullet of the mandate (source:
`src-tauri/src/download_finalize.rs`, ~5,470 lines; `artifact_open.rs`):

- **Completion records only after a successful, byte-accounted, hash-checked
  transfer.** `record_completed_artifact` is called from exactly one non-test
  place — the commit path after `commit_no_clobber` succeeded
  (`download_finalize.rs` ~:1897). Cancelled, failed, checksum-mismatched and
  resume-invalid downloads never reach it
  (`a_cancelled_download_never_leaves_a_completed_record`,
  `a_checksum_failure_leaves_no_completed_record`).
- **Checksum mismatch can never leave a runnable trusted record.** The
  mismatch branch deletes the staging bytes and returns `kind = checksum`
  before the commit; `checksum_verified` is `Some(true)` only on a trusted
  match and `None` otherwise (`Some(false)` unreachable by construction).
- **Event fields belong to the correct transfer.** Payloads carry the
  engine-allocated `id`; `path` is the committed path returned by the atomic
  commit; digests are computed over the staged bytes of THIS attempt (resume
  prefixes re-hashed from disk, 256 KiB chunks). Concurrent same-name
  downloads are separated by the atomic `create_new` staging reservation
  (`two_completed_downloads_never_cross_their_boundary_records`,
  `two_concurrent_same_name_downloads_both_survive`).
- **Staging shapes cannot be opened or verified as completed artifacts.**
  Refused by name in both privileged boundaries before any filesystem touch
  (the verifier's registry scope refuses `.sig` too — now test-pinned,
  `staging_part_files_are_never_verification_candidates` extended), and the
  registry cannot contain one (records are written only for committed dests).
- **Traversal/symlink/invalid-id/replaced/non-regular rejections** — present
  in both boundaries and unit-tested; the launcher's id binding no longer
  truncates (OBS-3 fix, §8): an id above `u32::MAX` used to alias to its low
  32 bits and PASS the id check; it is now refused
  (`an_id_above_u32_max_does_not_alias_to_a_real_record`).
- **Restored history rows have no authority.** Negative ids fail closed in
  the launcher; the verifier takes no id at all and requires a live registry
  record (`a_restored_after_restart_row_is_never_auto_launched`).
- **Exact (id, path) pair.** `record.id != id` → `IdMismatch`
  (`cross_wiring_two_downloads_is_refused`).
- **Registry mutation is constrained and non-poisoning.** `completed` uses a
  `std::sync::Mutex` with no await and no panic inside the critical section;
  the active-state map is single-writer with a checked transition table
  (`session_walks_every_documented_edge_and_rejects_the_rest`). The only
  lock-held-I/O deviation found (a `canonicalize` under the completed lock in
  the lookup path) is latency-only, off the async runtime, and not a deadlock
  (the lock graph is acyclic; no function takes both locks).
- **Launch-time re-check (new this round, OBS-4).** The AppImage launcher
  previously validated canonical location and size at plan time and exec'd by
  path; the plan's expected canonical path and committed size now travel with
  the route and are re-checked inside `launch_app_image` immediately before
  chmod/spawn (`a_size_drift_between_plan_and_launch_is_refused`,
  `a_canonical_drift_between_plan_and_launch_is_refused`). The residual
  µs-window between that re-check and the kernel's spawn is documented in the
  code: a same-user actor who can win it could exec the file directly anyway,
  so no privilege boundary is crossed.

## 3. Native URL fetching and redirects — VERIFIED (N-3 found & fixed this round)

The three-layer policy (admission → per-hop redirect rules →
public-address-only DNS resolver) was re-verified line by line, including
every brief-specified bypass case, each pinned by a named test: IP literals
(v4 private/CGNAT/link-local/metadata + v6 ULA/link-local/mapped/NAT64/6to4/
doc ranges), userinfo tricks, IDN/punycode (now including an explicit Unicode
homoglyph admission case), mixed-case and percent-encoded hosts, trailing
dot, IPv6 zone ids, redirect downgrades, credential-bearing hops, loop
detection, hop budgets, and DNS-rebinding (the resolver re-filters every
connection; literals never reach it,
`address_literal_requests_never_consult_the_resolver`).

**N-1 (PR #81) — VERIFIED REAL, not accepted from its description.** The
helper `read_capped_api_text_with_cap` (now in the Tauri-free
`src-tauri/src/http_body.rs`) refuses an oversized advertised Content-Length
before reading, refuses a body that crosses the cap mid-stream at the line,
and fails non-UTF-8 API bodies with a named error; it is used by all three
JSON call sites (`fetch_latest_release`, `fetch_recent_releases`,
`fetch_fdroid_package`), and an exhaustive grep shows no remaining
`.text()`/`read_to_end`/remote-length preallocation anywhere in `src-tauri`
(the only unbounded read left is the local `.part.meta` sidecar, now bounded
— A-4 below). reqwest is built without gzip/brotli/deflate, so
`content_length()`/`chunk()` see raw wire bytes. Tests (real loopback TCP +
real reqwest): under-cap accepted, oversized advertised refused, mid-stream
overrun refused, **non-UTF-8 named refusal (new)**, **exactly-cap accepted at
both boundary checks (new)**, constant pins. The text commands'
truncate-and-report rail (`read_capped_text`, 2 MiB) got its first behavior
tests this round (under-cap intact, oversized advertised not read, mid-stream
truncated at exactly the cap) plus a check-before-extend rewrite so the
buffer never even transiently exceeds the cap (A-3).

**Timeout vs cap — both rails proven independently enforced (new).** A
loopback slow-drip test shows a far-under-cap body being killed by the
client's request timeout (typed `is_timeout` error, fired promptly, cap never
firing), while the fast-oversized tests show the cap firing in milliseconds —
neither substitutes for the other. The constants (15 s connect / 20 s
whole-request) are pinned, as is the wiring (every short-lived policy carries
the timeout; the download policy deliberately carries none and relies on the
engine's 60 s per-chunk stall window, test-pinned).

**DEFECT N-3 (LOW, defense-in-depth — found & fixed this round):** the
self-update repo-path pin existed only at admission (`lib.rs`), while the
per-hop rules re-checked host/scheme/credentials/loop/budget but NOT the
path — a redirect chain that re-entered `github.com` outside
`/WasewaseX/Fress/` passed the host allowlist and its body was returned.
Fix: a `PathPin` on the `self_update_feed` policy's redirect rules binds
every `github.com` hop to the repository prefix (asset-CDN hops keep their
opaque paths); admission and hops now mirror each other. Tests: a pure
hop-decision matrix (in-path followed; off-path, sibling-repo and
dot-segment hops refused with the named error; CDN hop unaffected) and a
client-level loopback test proving a github.com-outside-the-pin 302 is
refused before any connection. The admission-side normalization cases
(dot-segments, `%2F`, `//`-prefix, case-variant, query positive-control) are
now test-pinned too, driven through the production gate (extracted into
`check_self_update_repo_path` so the tests cannot drift from the command).

## 4. Updater cryptography boundaries — VERIFIED

- Format compatibility: Tauri document format (outer base64 → minisign
  document) decoded identically for key and signature; production uses the
  compile-time-embedded key (`UPDATER_PUBLIC_KEY_FILE_B64` from
  `fress-updater.key.pub`); `the_embedded_public_key_is_the_published_fress_key`
  pins key id `5638C68123FB633B` (published in `docs/release-readiness.md:168`
  — this round's DOC-1 fix corrects the comment that cited CODE_SIGNING.md).
- Fail-closed matrix: malformed base64, non-minisign/truncated documents,
  foreign keys, tampered/truncated/appended artifact bytes — all refuse, each
  test-pinned. **Legacy (non-prehashed) signatures are now pinned on BOTH
  verifier paths (GAP-1, new):** the byte-slice path refuses the legacy "Ed"
  algorithm tag ("Unexpected signature algorithm") and the PRODUCTION
  streaming path refuses it before hashing a byte ("Cannot start updater
  signature verification"; `minisign-verify` 0.3.0 `verify_stream` returns
  `UnsupportedLegacyMode`), each proven by flipping the genuine fixture's
  "ED" tag to "Ed" — structurally valid, key-id-correct, refused.
- Scope: the verdict is computed over the bytes of ONE open handle that was
  metadata-checked first (regular file, committed size, canonical
  stability); the registry binding makes an arbitrary webview path a uniform
  refusal (`VERIFICATION_SCOPE_REFUSAL`, equality test-pinned).
- Checksum manifests can never substitute for the signature: the native
  `verified` flag is checksum-only and documented as never merging verdicts;
  the only "verified" transition follows a successful
  `verify_self_update_signature` (frontend three-gate lifecycle,
  test-pinned).
- Diagnostics carry the caller's own record provenance only; no secrets, no
  other paths, no file contents.
- Deliberate non-promise (unchanged): minisign trusted comments are not
  semantically verified; version/filename binding is the frontend's plan
  gate.

## 5. Tauri capability and process-boundary review — VERIFIED (accepted residuals)

- `capabilities/default.json` matches the traced frontend call sites exactly
  (verified permission-by-permission this round; no dead capability, no
  missing permission); `opener:allow-open-url` is scoped `https://**`; no
  window/webview/app/menu permissions; `freezePrototype: true`;
  `withGlobalTauri` absent; no remote-domain IPC.
- The only process spawn in the crate is `artifact_open.rs`
  `Command::new(path)` — argv-only, no shell, no arguments, stdio nulled,
  reached only after the name gates, shape gate, registry binding, canonical
  stability, size match and the new launch-time re-check. No shell plugin, no
  tokio::process, no test-host `std::process::id()` outside tests.
- CSP (verified against `tauri.conf.json`): `default-src 'self'; script-src
  'self'; … connect-src 'self' https://api.github.com` — the webview cannot
  fetch release assets or arbitrary hosts directly; the native policy
  commands are the only outbound path.
- **Accepted residual 1 (documented):** `opener:allow-open-path` /
  `allow-reveal-item-in-dir` are unscoped at the permission layer (the
  download directory is user-configurable at runtime). The webview-level
  policy is the gate; a compromised webview could hand any path to the OS
  default handler — the OS consent flows stay in force. Risk accepted and
  documented in `tauri-security.md`.
- **Accepted residual 2:** the launcher's typed taxonomy distinguishes path
  shape before the registry lookup (existence/type oracle; information
  disclosure only, no launch or read capability; the signature boundary has
  no such leak).
- **Accepted residual 3 (recorded this round, N-4):** `start_download`
  accepts any caller-supplied `directory` string; native code does not (and
  cannot, without a Tauri dialog-provenance API) verify picker provenance.
  Impact is bounded by the sanitize/no-clobber design (only NEW files can be
  created, single sanitized component each) and equals what a compromised
  webview could do through the unscoped opener permissions anyway.

## 6. Persistence and crash/hang review — VERIFIED

- **No panics reachable from untrusted input.** Non-test `expect`s: the two
  completed-queue mutex locks (poisoning requires an already-panicking
  process; no panic path exists inside the critical sections) and the
  one-time `run()` startup expect — startup-only, unreachable from input
  (the previous report's "only two" sentence was wrong as stated; corrected
  here). Release builds additionally set `panic = "abort"` (fail-stop, not
  containment — the old report's `catch_unwind` row overstated this for
  release).
- **Arithmetic:** every server-reachable sum on the download path is now
  checked or saturating (PR #81's N-2 set, plus this round's A-2: the
  streaming byte counter). The full 20-site table was re-audited this round;
  no unchecked server-reachable arithmetic remains outside physically
  unreachable cases.
- **Bounded reads:** 2 MiB text / 10 MiB API caps (buffer never transiently
  above cap after A-3), disk-streamed download staging, 64 KiB signature
  chunks, 256 KiB resume-rehash chunks, 64 KiB `.part.meta` bound (A-4).
  Transient per-chunk memory is bounded by hyper's read buffer (~408 KiB
  max, not attacker-controllable; h2 stricter still).
- **Partial writes:** staging `.part` + `.part.meta`; crash between them
  fail-closes (no meta → no validators → discard unless checksum); the
  commit is an atomic hard-link/create_new; `sync_all` before commit; a
  tampered `.meta` can only cause an If-Range miss (fail-safe direction) and
  an oversized/torn sidecar now reads as no-validators (A-4, test-pinned).
- **Cancellation:** observed while streaming, during backoff, and drained at
  the last checkpoint before completion; `cancel_download` is signal-only
  (never blocks on the engine).
- **Cross-platform paths:** no manual byte casts; Windows Unicode paths go
  through std's WTF-16 conversion; reserved names collapsed by
  `sanitize_filename`.

## 7. Dependency and build integrity

Toolchain: repo pin `rust-toolchain.toml` → 1.98.1 (profile minimal, clippy +
rustfmt), installed locally and used for every command.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` (via `--manifest-path src-tauri/Cargo.toml`, same as CI) | **PASS** locally, exit 0, re-run on the reconciled tree after every edit (pinned toolchain 1.98.1: rustfmt 1.9.0, clippy 0.1.98). |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | **NOT RUN as the full workspace locally — system libs unavailable** (no sudo, no webkit2gtk-4.1/gtk3; the Tauri crate cannot compile). **Honest CI history: the round-2 head `6ef838b` FAILED this exact job** (linux, `-D warnings`): one `unused_mut` (`download_finalize.rs:740`, the A-4 fix's file binding) and two `clippy::err_expect` in the new drift tests — none semantic. Fixed in `9c8b2f4`; the local Tauri-free harness (the three production modules, unmodified) passes `cargo clippy --all-targets -- -D warnings` on the reconciled tree. Full-workspace clippy remains CI-proven; run ID for the final head is cited in the PR report comment. |
| `cargo test --workspace --locked` | **NOT RUN as the full workspace locally** (same system-lib constraint; CI runs it, without `--locked`, on linux+windows+macos — lockfile enforcement lives in release.yml/security.yml). **Run locally via the Tauri-free harness**: the real `download_finalize.rs` (94 tests), `network_policy.rs`+`tests.rs` (52), `http_body.rs` (12) compiled unmodified into a scratch crate (symlinked module layout, lock-exact dependency versions, reqwest built with the production feature set `rustls-tls+stream+http2` and no gzip/brotli/deflate) — **158/158 pass** on the reconciled tree (log preserved). `lib.rs`, `artifact_open.rs`, `download_integration.rs` tests are CI-proven; the two clippy errors CI found there are fixed and the patterns re-scanned (no remaining `.err().expect`). |
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, RustSec DB fetched live 2026-10-14, 528 deps) | **First live run against the reconciled candidate: FAIL — 4 vulnerabilities, all `rustls 0.23.45`** (transitive of reqwest, no in-repo code path needed): RUSTSEC-2026-0346 (Debug impls expose TLS secrets), -0347 (ECH-rejection buffered data sent to outer server), -0348 (Brotli cert decompression ≤1 GiB pre-auth alloc), -0349 (unauthenticated ServerHello downgrade) — all patched in ≥0.23.46. **Fix applied on this branch:** compatible-range lockfile bump `rustls 0.23.45 → 0.23.46` (crates.io source unchanged; the yanked `yoke-derive 0.8.3 → 0.8.4` rides along in-range). **Re-run on the final tree: PASS — 0 vulnerabilities, exit 0.** 7 advisory-grade warnings remain, all transitive, none counted as vulnerabilities: RUSTSEC-2024-0370 (`proc-macro-error` unmaintained), RUSTSEC-2025-0081/-0075/-0080/-0100/-0098 (`unic-*` unmaintained, via `urlpattern`), RUSTSEC-2024-0429 (`glib` unsound iterator impls, GTK Linux stack). A zero-vulnerability scanner result is NOT proof of zero dependency risk — the unmaintained/unsound advisories are accepted, documented residuals, and the scanner's advisory lag is exactly why the earlier "0 vulnerabilities expected to persist" phrasing was replaced by this live-verified record. Note: security.yml's audit job is advisory-only (`continue-on-error`) and does not run on PRs. |
| Cargo.lock / Cargo.toml drift vs release tag `6d338fd` | **Exactly three intentional changes, zero unexplained third-party drift:** (1) `fress` package version `1.0.12-beta → 1.0.0` (PR #80's release candidate bump); (2) the in-repo path dependency `tauri-plugin-fress-open` (PR #74's Android open boundary; adds only packages already present in the lock); (3) the advisory bump `rustls 0.23.46` + `yoke-derive 0.8.4` (row above; the only third-party version changes, both compatible-range, registry source unchanged). The plugin crate's version — the one `validate:versions` defect recorded earlier on this integration — is **fixed on the current candidate** (Agent 3's `9133655`/`639ecfb`); the gate now reports **PASSED — 8 authoritative fields agree on 1.0.0** (re-run locally on the reconciled tree). No new external dependency, no git source, no upgrade outside the compatible range. |
| Independent cross-check of the same DB (this audit's second pass) | A from-scratch scanner reproducing cargo-audit's data source and matching semantics (RustSec DB cloned 2026-10-14, 1294 files, `unaffected`/`patched` ranges honored) independently reproduces the live result: the PRE-fix lock yields exactly the same 4 rustls findings and nothing else; the POST-fix tree yields 0. Honesty note: the scanner's FIRST draft flagged hashbrown 0.12.3 because it ignored the advisory's explicit `unaffected: < 0.15.0` range — corrected, the finding disappears; the false positive is recorded because the kill-test discipline applies to audit tooling too. The cross-check also adds a full yanked-pins sweep (all 526 registry versions via the crates.io API, 0 lookup errors): the pre-fix lock has exactly 1 yanked pin (yoke-derive 0.8.3), the final tree has 0. Graph reachability notes: the lock's rustls carries NO brotli/zlib/ECH feature dependencies, so the paths flagged by -0346/-0347/-0348 are feature-gated OFF in this build; -0349 (ServerHello downgrade) applies to the protocol proper, and the production stack (reqwest 0.12.28 → hyper-rustls → rustls) IS reachable — the bump, not the feature gate, is the fix. The scanner's informational-class count is broader than the tool's 7 warnings (it matches unsound/unmaintained advisories without default tool filtering); the live tool's count is the authoritative one. |
| Final-diff scan (secrets / debug leftovers / unsafe / spawn / dep-source changes) | **0 hits** across the audit-owned src-tauri diff (patterns: token prefixes, private keys, `dbg!`/`todo!`/`unimplemented!`, `println!`/`eprintln!` — zero logging statements exist in src-tauri at all — `unsafe`, `Command::new` outside the launcher). Zero Chinese/CJK-script content: the repo's `check-no-chinese` gate passes on the reconciled tree, and the last kana warning class (the `sanitize_filename` fixture) is closed by the candidate's merged `7c3f8b6` fixture (Unicode-escapes, no CJK glyph in committed source). |

## 8. Defects and fixes (PR #81's two verified + this round's)

| ID | Severity | Location | Defect | Fix | Regression |
| --- | --- | --- | --- | --- | --- |
| N-1 (PR #81, verified real) | MEDIUM-LOW (crash/robustness) | `lib.rs` ×3 JSON commands | Unbounded `resp.text()` on pinned-host JSON responses | `read_capped_api_text` helper, 10 MiB `API_BODY_CAP`, named refusal, strict UTF-8 (now in `http_body.rs`) | 4 tests (PR #81) + 3 new (UTF-8 refusal, exactly-cap ×2) + text-rail behavior tests + cap pins |
| N-2 (PR #81, verified real) | LOW (panic in overflow-checks builds; silent wrap in release) | `download_finalize.rs`: range length, resume sum, display total | Hostile `Content-Range` arithmetic overflow | checked arithmetic; named final protocol error; saturating display total | unit `a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked` + e2e `a_hostile_u64_max_content_range_fails_named_without_completing` (now extended with staging-state assertions) |
| A-1 (this round) | MEDIUM (robustness: poisoned resumable staging) | `run_download_on` impossible-range refusal | The refusal fired AFTER the hostile tail was appended and the response's validators recorded — the `.part` survived as honest-prefix + unaccountable-tail, resumable under the hostile response's own ETag | the refusal now discards the staging files entirely (same taxonomy as the 416 path); the error stays final | e2e extended: `.part` and `.part.meta` must be gone (`a_hostile_u64_max_content_range_fails_named_without_completing`) |
| A-2 (this round) | INFO (uniformity) | streaming loop byte counter | last unchecked server-reachable addition (`downloaded +=`) | `checked_add`, named final error on overflow (physically unreachable; fails safe) | harness compile + suite green; table re-audit |
| A-3 (this round) | INFO | `read_capped_text` | extend-then-truncate could transiently hold cap + one chunk | check-before-extend: buffer never exceeds the cap; observable semantics unchanged | new behavior tests pin truncate-at-exactly-cap, oversized-CL refusal, under-cap intactness |
| A-4 (this round) | INFO (defense-in-depth) | `read_part_meta` | unbounded `read_to_string` of the local sidecar | 64 KiB `take()` bound; oversized/torn sidecar → parse fail → no validators (fail-closed) | `an_oversized_part_meta_sidecar_reads_as_no_validators` |
| N-3 (this round) | LOW (defense-in-depth) | `network_policy.rs` redirect rules | self-update repo-path pin was admission-only; a re-entering github.com hop outside the repo passed the allowlist | `PathPin` binds every github.com hop to `/WasewaseX/Fress/` (+ bare root); named `OffPinnedPath` refusal | `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` + client-level `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin` |
| OBS-3 (this round) | LOW (id binding) | `artifact_open.rs` plan_open | `record.id != id as u32` truncated i64→u32: an id ≥ 2³² aliased to its low 32 bits and PASSED the binding check | `u32::try_from(id)` gate; out-of-range → uniform `NotRegistered` | `an_id_above_u32_max_does_not_alias_to_a_real_record` |
| OBS-4 (this round) | LOW (TOCTOU hardening) | `launch_app_image` | plan-time canonical/size checks were not re-checked at spawn time | expected canonical + size travel with the route and are re-checked immediately before chmod/spawn | `a_size_drift_between_plan_and_launch_is_refused`, `a_canonical_drift_between_plan_and_launch_is_refused` |
| GAP-1 (this round) | INFO (test gap) | verifier | legacy-signature refusal was only inside the dependency; unpinned | fixture "ED"→"Ed" tag-flip documents refused on BOTH the byte-slice and production streaming paths | `a_legacy_algorithm_tagged_signature_is_refused_not_accepted`, `a_legacy_algorithm_signature_fails_the_production_streaming_path` |
| GAP-2 (this round) | INFO (test gap) | verifier | `.sig` sidecar refusal via registry scope unpinned | registry-scope refusal test-pinned | `staging_part_files_are_never_verification_candidates` extended |
| N-7/N-8 (this round) | INFO (test gaps) | admission tests | repo-pin normalization cases and unicode-IDN case unpinned | normalization matrix (dot-segments, `%2F`, `//`, case, query control) through the extracted production gate; Cyrillic-homoglyph case | `refuses_github_paths_that_normalize_outside_the_repository`, extended `ambiguous_host_forms_are_handled_predictably` |
| DOC-1 (this round) | DOC | `lib.rs` comment | key id cited as "published in CODE_SIGNING.md" — it is published in `docs/release-readiness.md:168` | comment corrected | — |
| DEP-1 (this round, live audit) | MEDIUM (4 TLS advisories) | `Cargo.lock` (rustls 0.23.45, transitive of reqwest) | RUSTSEC-2026-0346/-0347/-0348/-0349: pre-auth memory amplification, TLS-secret Debug exposure, ServerHello downgrade, ECH-rejection data leak — present on the reconciled candidate, found by the live RustSec scan | compatible-range bump to rustls 0.23.46 (+ yoke-derive 0.8.4 for the yank); crates.io source unchanged | `cargo audit` exit 0 re-run on the final tree; lockfile diff = 2 packages, 4 lines |

Adversarial critique loop (two independent reviewers over the final diff)
verified: the PathPin admits no bypass string the allowlist doesn't already
refuse (identical normalization both sides); no other append-then-refuse
path exists that keeps poisoned staging; the one-chunk transient memory bound
is hyper's (~408 KiB, not attacker-controlled); the slow-drip test's timing
budget was widened for CI-load tolerance (per_byte × count > timeout +
margin); the legacy tests cannot pass for a wrong reason (error-text
discrimination) and fail if `allow_legacy` were ever enabled; no
frontend-matched error string changed (`open-artifact/*` codes,
`resume-invalid` kind unchanged; the reused NotFound detail string is still
produced verbatim).

**Kill-test review (executed this round on the reconciled tree, harness
run):** for each new guard, the guard was deleted, the named test run, the
guard restored, and the full suite re-run:

- **PathPin deleted** (`self_update_feed`'s `path_pin: Some(..) → None`) →
  `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` AND the
  client-level `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin`
  both FAIL. Guard restored → suite green.
- **A-4's 64 KiB `take()` bound deleted** (unbounded `read_to_string`
  restored) → **the original fixture did NOT fail** (it was malformed JSON,
  which refuses with or without the bound — a real test-quality gap found by
  this exercise, fixed in `6b6b047`). The strengthened fixture (valid JSON
  with an 80 KiB etag value) FAILS without the bound and passes with it —
  verified in both directions.
- **A-1's staging discard deleted** from the impossible-range refusal →
  `a_hostile_u64_max_content_range_fails_named_without_completing` FAILS on
  the "the poisoned .part must be discarded" assertion (the pure arithmetic
  test correctly keeps passing — it pins a different property). Guard
  restored → 158/158 green.
- Properties that are implementation- rather than behavior-observable (A-2's
  physically-unreachable counter overflow; A-3's never-transiently-over-cap
  buffer; OBS-3's `u32::try_from` and OBS-4's launch-time re-check, whose
  tests live in CI-compiled files) are covered by their named CI-proven
  regressions and the line-by-line re-audit, not by an executed kill-test —
  stated plainly rather than claimed.

## 9. Remaining tests that need real hardware / OS

Unchanged from the documented smoke matrix
(`docs/testing/download-open-smoke.md`) — none block this audit, none are
claimed as run:

- Windows: installer launch via `open_path` (UAC / SmartScreen surfaces),
  OneDrive-redirected Downloads default, MSI handoff to msiexec.
- macOS: first-launch Gatekeeper right-click → Open on unsigned dmgs,
  reveal-in-Finder.
- Linux: AppImage launch from a stock GNOME/KDE session (the
  validated-chmod + direct-exec path), XDG download-dir localization.
- Android: the in-app installer handoff code (PR #74) is now part of the
  integrated candidate, but NO physical-device results exist for it on this
  tree (Agent 7 owns that evidence); APK installs otherwise go through the
  browser per the documented limitation. The Android adapter (Agent 7) must
  conform to the open_path identity/path contract documented in
  `artifact_open.rs` / `src/lib/artifactOpen.ts`; nothing in this round
  changed that contract (the launcher hardening is Linux-only). The native
  unit/integration suites and the frontend unit suite (758 passed + 2
  pre-existing offline skips) were re-run locally on the reconciled tree.

## 10. Conclusion

**PASS on the reconciled stable candidate — PR #81's fixes verified real;
PR #84's round-2 fixes verified real and retained; 2 release-adjacent defects
found and fixed this round (A-1, N-3) plus hardening (OBS-3/OBS-4,
A-2/A-3/A-4) and 7 test-gap fills; the round-2 CI-clippy regression fixed;
one regression fixture strengthened after its kill-test found it could pass
without its guard; no known release-blocking native security/correctness
defect remains.**

- The response-reading and arithmetic defects are fixed WITH regressions, and
  the size-cap/timeout rails are proven independently enforced by loopback
  tests that run against the real readers (158/158 locally executed on the
  reconciled tree; per-module: download_finalize 94, network_policy 52,
  http_body 12).
- The trust boundaries hold end to end: registry → verification → launch
  (now re-checked at the launch instant), admission → per-hop rules →
  public-only DNS (now path-pinned for the self-update feed), embedded-key
  minisign verification (now legacy-refusal-pinned on both paths).
- Capabilities are minimal and match the documented matrix; no shell surface;
  three accepted residuals documented (§5) with no change to the intentional
  trust policy.
- Dependency audit: **live-verified, not expected** — the first live scan of
  the reconciled candidate found 4 rustls advisories (RUSTSEC-2026-0346/
  -0347/-0348/-0349); the compatible-range bump to rustls 0.23.46 on this
  branch fixes all four and the re-run is clean (0 vulnerabilities, exit 0),
  with 7 advisory-grade transitive warnings documented as accepted residuals
  (§7). An independent from-scratch scan of the same DB reproduces the live
  result (4 findings pre-fix, 0 post-fix) and adds a full yanked-pins sweep
  (pre-fix: exactly yoke-derive 0.8.3; final tree: 0 yanked) — §7's
  cross-check row, including its recorded false positive. The final diff
  carries no secrets/debug/unsafe/spawn changes and the zero-CJK gate passes
  with zero warnings.
- Reconciliation: this branch now stacks on `integrate/stable-candidate`
  (PR #85) and carries ALL of PR #81; no #85 change is overwritten and no
  competing release branch exists (the retargeted PR #84 is the single
  native-integrity delta on the candidate).
- Version coherence: `validate:versions` PASSES on the reconciled tree (8
  authoritative fields agree on 1.0.0, including the in-repo plugin crate
  after Agent 3's fix on the candidate). The final diff carries no
  secrets/debug/unsafe/spawn changes and the zero-CJK gate passes with zero
  warnings.

NOT RUN locally (CI-proven on linux+windows+macos instead): the full
workspace clippy/test build (sandbox lacks the GTK/WebKit system libraries);
the exact CI run for this branch's final head is cited in the PR report
comment. Every real-device row in §9 remains manual (NOT RUN). Nothing in
this report relies on those unrun checks; scope statements are per-file and
per-test, and this report does not claim the absence of unknown bugs — only
that no known release blocker remains and every stated property is code- or
test-cited.
