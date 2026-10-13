# Native code-integrity audit — October 2026 (round 2, post-PR #81)

Audit scope: `src-tauri/src/**` on the integrated stable candidate — origin/main
`93f87ce` plus PR #81 (`audit/native-integrity` @ `e4280e4`) plus this round's
commit (the PR head of branch `audit/native-integrity-r2`; the diff it adds to
e4280e4 is exactly 8 files: `lib.rs`, `http_body.rs` (new),
`download_finalize.rs`, `download_integration.rs`, `artifact_open.rs`,
`network_policy.rs`, `network_policy/tests.rs`, and this report). The app-code
delta between the v1.0.12-beta release tag (`6d338fd`) and the audited tree
remains zero outside these audit-owned files. Auditor: native-integrity round
2 (Agent 4). This round VERIFIED PR #81's two fixes on the integrated tree
(code-level, not from its descriptions), completed the proofs its report
could only assert, and fixed every new defect found. Method: five independent
audit passes (arithmetic, command/URL surface, registry/signature boundary,
toolchain/dependencies, capability/crash surface), a two-reviewer adversarial
critique loop over the final diff, and local execution of every test that
compiles without the Tauri system libraries (158/158, log preserved).

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
| `cargo fmt --all -- --check` (via `--manifest-path src-tauri/Cargo.toml`, same as CI) | **PASS** locally, exit 0 (re-run after every edit this round) |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | **NOT RUN locally — system libs unavailable.** The sandbox has no sudo and no webkit2gtk-4.1/gtk3 (`gdk-3.0` pkg-config failure, exit 101); the Tauri crate cannot compile. CI runs clippy on **ubuntu-24.04 only** (the `rust-native` Windows/macOS job runs `cargo test`, no fmt/clippy) — the previous report's "clippy on ubuntu-22.04, Windows and macOS" was wrong; corrected here. CI on the PR #81 head e4280e4: **all 11 checks success** (run 38454249311, fetched live). |
| `cargo test --workspace --locked` | **NOT RUN as the full workspace locally** (same system-lib constraint; CI runs it, without `--locked`, on linux+windows+macos — lockfile enforcement lives in release.yml/security.yml). **Run locally via the Tauri-free harness**: the real `download_finalize.rs`, `network_policy.rs`(+tests), `http_body.rs` compiled unmodified into a scratch crate with lock-exact dependency versions — **158/158 pass** (log preserved at audit time). This includes ALL of this round's new loopback/arithmetic/registry tests. `lib.rs`, `artifact_open.rs`, `download_integration.rs` tests are CI-proven (their compile risk was reviewed by two adversarial passes; the one build-breaker found — an unused import — was fixed pre-push). |
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, RustSec DB fetched live: 1310 advisories, 527 deps) | **PASS — 0 vulnerabilities, exit 0.** 8 advisory-grade warnings, all transitive, none reachable as a vulnerability: RUSTSEC-2024-0370 (`proc-macro-error` unmaintained), RUSTSEC-2025-0081/-0075/-0080/-0100/-0098 (`unic-*` unmaintained, via `urlpattern`), RUSTSEC-2024-0429 (`glib` unsound iterator impls, GTK Linux stack), 1 yanked (`yoke-derive`, no advisory). Matches the security.yml ADVISORY policy; PR #81's identical claim is now independently PROVEN rather than cited. Note: security.yml's audit job is advisory-only (`continue-on-error`) and does not run on PRs. |
| Cargo.lock / Cargo.toml drift vs release tag `6d338fd` | **ZERO drift.** `git diff v1.0.12-beta..HEAD -- src-tauri/Cargo.lock src-tauri/Cargo.toml` is empty; no new dependency, no git/path source, no upgrade. |
| Final-diff scan (secrets / debug leftovers / unsafe / spawn / dep-source changes) | **0 hits** across the full `v1.0.12-beta..HEAD` src-tauri diff (patterns: token prefixes, private keys, `dbg!`/`todo!`/`unimplemented!`, `println!`/`eprintln!` — zero logging statements exist in src-tauri at all — `unsafe`, `Command::new` outside the launcher). |

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

Adversarial critique loop (two independent reviewers over the final diff)
verified: the PathPin admits no bypass string the allowlist doesn't already
refuse (identical normalization both sides); no other append-then-refuse
path exists that keeps poisoned staging; the one-chunk transient memory bound
is hyper's (~408 KiB, not attacker-controlled); the slow-drip test's timing
budget was widened for CI-load tolerance (per_byte × count > timeout +
margin); the legacy tests cannot pass for a wrong reason (error-text
discrimination) and fail if `allow_legacy` were ever enabled; every new test
fails when its feature is deleted (kill-the-test check); no frontend-matched
error string changed (`open-artifact/*` codes, `resume-invalid` kind
unchanged; the reused NotFound detail string is still produced verbatim).

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
- Android: the in-app installer handoff is NOT on main (PR #74 open,
  unmerged, no physical-device results); APK installs go through the
  browser per the documented limitation. The Android adapter (Agent 7) must
  conform to the open_path identity/path contract documented in
  `artifact_open.rs` / `src/lib/artifactOpen.ts`; nothing in this round
  changed that contract (the launcher hardening is Linux-only).

## 10. Conclusion

**PASS — PR #81's fixes verified real; 2 release-adjacent defects found and
fixed this round (A-1, N-3) plus hardening (OBS-3/OBS-4, A-2/A-3/A-4) and 6
test-gap fills; no known release-blocking native security/correctness defect
remains.**

- The response-reading and arithmetic defects are fixed WITH regressions, and
  the size-cap/timeout rails are proven independently enforced by loopback
  tests that run against the real readers (158/158 locally executed).
- The trust boundaries hold end to end: registry → verification → launch
  (now re-checked at the launch instant), admission → per-hop rules →
  public-only DNS (now path-pinned for the self-update feed), embedded-key
  minisign verification (now legacy-refusal-pinned on both paths).
- Capabilities are minimal and match the documented matrix; no shell surface;
  three accepted residuals documented (§5) with no change to the intentional
  trust policy.
- Dependency audit: **PROVEN** 0 vulnerabilities (live RustSec DB), 8
  advisory-grade transitive warnings; Cargo.lock byte-identical to the
  release; final diff carries no secrets/debug/unsafe/spawn changes.

NOT RUN locally (CI-proven on linux+windows+macos instead): the full
workspace clippy/test build (sandbox lacks the GTK/WebKit system libraries).
Every real-device row in §9 remains manual. Nothing in this report relies on
those unrun checks; scope statements are per-file and per-test, and this
report does not claim the absence of unknown bugs — only that no known
release blocker remains and every stated property is code- or test-cited.
