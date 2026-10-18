# Native code-integrity audit — October 2026 (rounds 2–3, reconciled onto the stable candidate; §10 = independent post-tag re-verification + finish-the-PR re-execution, §10.9 + handoff re-execution at the pushed head, §10.10 + full-coverage read at the final head §10.11)

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

An INDEPENDENT re-verification round (Agent 6, after the `v1.0.0` tag) then
re-audited the tagged tree from scratch — fresh toolchain install, fresh test
execution, executed kill-tests of every executable guard, a live RustSec
scan, and its own defect hunt. That round is recorded in §10 and found one
test-quality gap (a byte-identity regression that survived guard removal),
closed with a new production-path test; no production defect was found.
A second independent pass (§10.9) re-executed every §10 claim on the PR
branch head itself — fresh sandbox, all five kill-tests re-run by hand,
CI evidence re-verified on the exact head — and confirmed the record with
one reporting correction (a harness-only clippy allowance, disclosed there).

## 1. Native command inventory

All 12 commands registered in `src-tauri/src/lib.rs`
(`tauri::generate_handler!`, lib.rs ~:1140), re-verified against the code and
the frontend's `invoke(...)` call sites this round (no command unregistered,
no invoke of an unregistered command; the only extra name seen,
`open_downloaded_artifact` in `tests/e2e/tauri-bridge.ts:410`, is a test-only
mock hook). Count and line reconciled in the §10.10 handoff round: the table
below predates the Android open-boundary integration (PR #74), which added
`open_downloaded_file` as the twelfth command — its row is now recorded here
rather than only in §10.2.

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
| `open_downloaded_file` | `src/lib/artifactOpen.ts` (`openCompletedArtifact` policy binds it as the Android `openPath` dep) | `resolve_completed_artifact` (lib.rs:504): staging-name gates before ANY fs touch, session-scoped registry record for the EXACT path, canonical stability, regular file + committed size; every out-of-scope path gets ONE uniform refusal (anti-probe) | Filesystem open of ONE registered completed artifact | Android: FileProvider `content://` install/open intent through `tauri-plugin-fress-open` (temporary READ grant only; APK → system package installer, everything else → viewer/share fallback); desktop: opener plugin `open_path` of the validated canonical path | Uniform typed `open-artifact/not-registered` for every unregistered path; restored (persisted) rows have no record and fail closed | lib.rs open-boundary matrix over the shared `resolve_completed_artifact` (staging/traversal/replacement/eviction/cross-wiring) + the Android adapter crate's own tests (Agent 7's scope) |
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
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, RustSec DB fetched live 2026-10-14, 528 deps) | **First live run against the reconciled candidate: FAIL — 4 vulnerabilities, all `rustls 0.23.45`** (transitive of reqwest, no in-repo code path needed): RUSTSEC-2026-0346 (Debug impls expose TLS secrets), -0347 (ECH-rejection buffered data sent to outer server), -0348 (Brotli cert decompression ≤1 GiB pre-auth alloc), -0349 (unauthenticated ServerHello downgrade) — all patched in ≥0.23.46. **Fix applied on main via PR #88 (commit `84eecc9`, merged `0db3d09`):** compatible-range lockfile bump `rustls 0.23.45 → 0.23.46` (crates.io source unchanged; the yanked `yoke-derive 0.8.3 → 0.8.4` rides along in-range). **Re-run on main's tree: PASS — 0 vulnerabilities, exit 0.** 7 advisory-grade warnings remain, all transitive, none counted as vulnerabilities: RUSTSEC-2024-0370 (`proc-macro-error` unmaintained), RUSTSEC-2025-0081/-0075/-0080/-0100/-0098 (`unic-*` unmaintained, via `urlpattern`), RUSTSEC-2024-0429 (`glib` unsound iterator impls, GTK Linux stack). A zero-vulnerability scanner result is NOT proof of zero dependency risk — the unmaintained/unsound advisories are accepted, documented residuals, and the scanner's advisory lag is exactly why the earlier "0 vulnerabilities expected to persist" phrasing was replaced by this live-verified record. Note: security.yml's audit job is advisory-only (`continue-on-error`) and does not run on PRs. |
| Cargo.lock / Cargo.toml drift vs release tag `6d338fd` | **Exactly three intentional changes, zero unexplained third-party drift:** (1) `fress` package version `1.0.12-beta → 1.0.0` (PR #80's release candidate bump); (2) the in-repo path dependency `tauri-plugin-fress-open` (PR #74's Android open boundary; adds only packages already present in the lock); (3) the advisory bump `rustls 0.23.46` + `yoke-derive 0.8.4` (row above; the only third-party version changes, both compatible-range, registry source unchanged). The plugin crate's version — the one `validate:versions` defect recorded earlier on this integration — is **fixed on the current candidate** (Agent 3's `9133655`/`639ecfb`); the gate now reports **PASSED — 8 authoritative fields agree on 1.0.0** (re-run locally on the reconciled tree). No new external dependency, no git source, no upgrade outside the compatible range. |
| Independent cross-check of the same DB (this audit's second pass) | A from-scratch scanner reproducing cargo-audit's data source and matching semantics (RustSec DB cloned 2026-10-14, 1294 files, `unaffected`/`patched` ranges honored) independently reproduces the live result: the PRE-fix lock yields exactly the same 4 rustls findings and nothing else; the POST-fix tree yields 0. Honesty note: the scanner's FIRST draft flagged hashbrown 0.12.3 because it ignored the advisory's explicit `unaffected: < 0.15.0` range — corrected, the finding disappears; the false positive is recorded because the kill-test discipline applies to audit tooling too. The cross-check also adds a full yanked-pins sweep (all 526 registry versions via the crates.io API, 0 lookup errors): the pre-fix lock has exactly 1 yanked pin (yoke-derive 0.8.3), the final tree has 0. Graph reachability notes: the lock's rustls carries NO brotli/zlib/ECH feature dependencies, so the paths flagged by -0346/-0347/-0348 are feature-gated OFF in this build; -0349 (ServerHello downgrade) applies to the protocol proper, and the production stack (reqwest 0.12.28 → hyper-rustls → rustls) IS reachable — the bump, not the feature gate, is the fix. The scanner's informational-class count is broader than the tool's 7 warnings (it matches unsound/unmaintained advisories without default tool filtering); the live tool's count is the authoritative one. (Environment note: the final-integration audit sandbox DID build the real cargo-audit 0.22.2 and ran it live — exit 0 on the final tree — so the tool-run claim in the Conclusion's dependency bullet and this row's from-scratch reproduction are two independent environments reaching the same verdict.) |
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
| DOC-2 (round 3, Agent 4 final integration) | DOC | `validate_resume_content_range` docstring | claimed "the .part survives so a corrected server can still recover" — stale: every validation failure maps to `DiscardAndFail`, which deletes the staging files | docstring rewritten to the actual discard semantics | — |
| R-5 (round 3, Agent 4 final integration) | INFO (test gaps) | `http_body.rs` text rail; `download_finalize.rs` e2e | the text rail had no exactly-at-cap ACCEPTANCE pins (invariant 5 covers BOTH rails; only the 3 MiB truncate shape was pinned), and the mismatched-start hostile resume had no filesystem-side-effect proof (only the u64::MAX and 416 shapes did) | two exactly-at-cap acceptance pins (`text_reads_accept_a_close_delimited_body_at_exactly_the_cap`, `text_reads_accept_an_advertised_body_at_exactly_the_cap`) and `a_mismatched_start_content_range_discards_the_staged_bytes` (asserts `.part` + `.meta` gone, no destination, no registry record) | harness 161/161 on the final tree; kill-test: flipping either strict `>` to `>=` fails the cap pins; deleting the DiscardAndFail `discard_staging` call fails the e2e on `part.exists()` |
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
- **Round 3 additions share the A-1 discard path**: the new
  `a_mismatched_start_content_range_discards_the_staged_bytes` drives the
  SAME `DiscardAndFail → discard_staging` call site through a THIRD hostile
  shape (mismatched start), so the executed A-1 kill-test (discard deleted →
  e2e fails on the filesystem assertion) covers it by construction; the
  exactly-at-cap pins fail on any `>` → `>=` boundary flip in either the
  advertised-length or the streaming check.
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

## 10. Independent re-verification of the tagged stable candidate (Agent 6, post-tag)

A fresh, independent audit round re-verified every conclusion above on the
ACTUAL tagged tree and searched for additional defects at the filesystem,
HTTP, download-completion, updater and privileged-IPC boundaries. It did not
repeat round 2's prose; it re-executed the evidence.

### 10.1 Tested source (exact refs)

| Ref | SHA |
| --- | --- |
| `main` | `78d5e8ff8e1bc38ca8789539da005fdea4b15613` |
| `v1.0.0` (tag) | `78d5e8ff8e1bc38ca8789539da005fdea4b15613` (same commit — the tag is ON main HEAD) |
| Base for this round's changes | the same `78d5e8ff`, branch `agent6/native-audit-round2` |

Every command and test below ran against that exact SHA. The production
files audited in full this round (`wc -l`): `http_body.rs` (460 L),
`network_policy.rs` (928 L) + `network_policy/tests.rs` (1374 L),
`artifact_open.rs` (780 L), `download_finalize.rs` (5606 L incl. tests),
`lib.rs` (2037 L incl. tests), `download_integration.rs` (426 L),
`main.rs` (10 L), plus `plugins/fress-open` (review-only, Agent 7's).

### 10.2 Audit map re-derived (Part A)

Every native entry point that accepts a URL, an id, a path, a caller-supplied
size, a manifest body or an open/launch request, with its production
boundary — re-traced caller→callee, not taken from the prior table:

- URLs: `fetch_latest_release` / `fetch_recent_releases` (`api_github`
  admission → policy client → `read_capped_api_text`), `fetch_text`
  (`resolver_manifest`), `fetch_self_update_text` (`self_update_feed`
  admission + `check_self_update_repo_path` production gate at lib.rs:255),
  `fetch_fdroid_package` (`api_fdroid`), `start_download`
  (`executable_download` before ANY filesystem side effect).
- Ids: `cancel_download(id: u32)` (wire type rejects out-of-range before the
  command body), `launch_app_image_artifact(id: i64)` → `u32::try_from` gate
  in `plan_open` (artifact_open.rs:238).
- Paths: `open_downloaded_file` → `resolve_completed_artifact` (lib.rs:504,
  shared by the signature boundary), `launch_app_image_artifact` →
  `plan_open` → `launch_app_image`, `verify_self_update_signature` →
  `resolve_completed_artifact` → `verify_signature_over_open_file`.
- Caller-supplied sizes: download byte accounting (checked_add on the
  running counter, on `already_have + range_len`, saturating display total),
  Content-Range validation (`validate_resume_content_range`), the 64 KiB
  sidecar bound (`read_part_meta`), asset `size` fields (display only).
- Manifest bodies: `read_capped_api_text` (10 MiB, refuse) and
  `read_capped_text` (2 MiB, truncate-and-report) — the ONLY body readers;
  zero `.text()`/`.bytes()`/`.json()` call sites remain in production code
  (re-swept this round, including the plugin crate).

### 10.3 Executed checks and results (pinned toolchain, exact SHA)

The sandbox has no WebKit/GTK development libraries (no root), so the full
Tauri workspace cannot compile locally — the same constraint round 2
recorded. The three Tauri-free production modules were re-run through the
unmodified-source harness with LOCK-EXACT dependencies (reqwest 0.12.28
`rustls-tls+stream+http2`, serde 1.0.229, serde_json 1.0.151, sha2 0.10.9,
tokio 1.53.1, futures-util 0.3.34) and the repo-pinned toolchain
(`rust-toolchain.toml` → 1.98.1; installed fresh this round: cargo/rustc
1.98.1, rustfmt 1.9.0, clippy 0.1.98):

| Check | Result on `78d5e8ff` |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` (pinned 1.98.1) | **PASS**, exit 0 — re-run after this round's test addition |
| Harness `cargo test` (real `download_finalize.rs` + `network_policy.rs`/`tests.rs` + `http_body.rs`, unmodified) | **162/162 PASS** (round 2 finished at 161; +1 new test this round). Per-module: download_finalize **96**, network_policy **52**, http_body **14** |
| Harness `cargo clippy --all-targets -- -D warnings` | **PASS**, exit 0, zero findings |
| CI run **38595199247** on the exact SHA (the run the repo's own CI produced for this commit) | `Rust fmt, clippy, tests (linux)` **success** (fmt + `clippy --all-targets -D warnings` + full `cargo test`), `Rust tests (windows-latest)` **success**, `Rust tests (macos-latest)` **success** — this is the CI-backed proof for the Tauri-coupled files this sandbox cannot compile (`lib.rs`, `artifact_open.rs`, `download_integration.rs`) |
| CI run **38597496640** (Release, same SHA) | all build/checksum/verify-release jobs **success** (the shipped v1.0.0 artifacts were produced and verified from this tree) |
| NOT RUN locally | full-workspace clippy/test build (no webkit2gtk-4.1 dev headers, no root) — CI-proven per the row above; all §9 device rows remain NOT RUN |

### 10.4 Executed kill-tests (guard deleted → named test run → guard restored)

This round EXECUTED the kill-test discipline on every guard reachable
without the Tauri system libraries, rather than asserting it:

| # | Guard killed (file:function) | Kill shape | Named test after the kill | Verdict |
| --- | --- | --- | --- | --- |
| KT-1 | `validate_resume_content_range` checked arithmetic (download_finalize.rs:936) | `(end - start).checked_add(1)` → wrapping `end - start + 1` | `a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked` | **FAILS** (u64::MAX range wraps/overflows exactly as the test forbids) — guard verified |
| KT-2 | `self_update_feed` `path_pin: Some(..)` → `None` (network_policy.rs:471) | pin removed | `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` AND `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin` | **BOTH FAIL** — guard verified |
| KT-3 | `read_part_meta` 64 KiB `take()` (download_finalize.rs:742) | unbounded `read_to_string` restored | `an_oversized_part_meta_sidecar_reads_as_no_validators` | **FAILS** (the strengthened valid-JSON 80 KiB fixture parses unbounded and yields validators) — guard verified |
| KT-4 | A-1 discard in the impossible-range refusal (download_finalize.rs:1750) | `discard_staging(&part)` deleted from the checked_add-overflow branch | `a_hostile_u64_max_content_range_fails_named_without_completing` | **FAILS** on the filesystem-side-effect assertion — guard verified |
| KT-5 | byte-identity rule (download_finalize.rs, `planned_resume_len > 0 && resume_validator.is_none() && !checksum_will_verify`) | rule disabled (`if false &&`) | `validator_less_staging_is_discarded_on_resume` | **STILL PASSES** — test-quality GAP found by this execution (details in §10.5) |

KT-1–KT-4 confirm the round-2 kill-test claims independently. KT-5 is the
round's finding: the named regression exercises the 200-answer shape, where
the truncate path removes the unprovable prefix TOO — so the discard guard
and the truncate path are indistinguishable to that test and removing the
guard changes nothing it observes. The DANGEROUS shape (a server answering
the resume's `Range` with a 206, gluing the unprovable prefix to a hostile
tail) was unpinned.

### 10.5 Gap closed: the byte-identity rule now has a guard-sensitive pin

New regression (download_finalize.rs tests, production-path e2e):
`a_validator_less_resume_never_sends_a_range_request_or_glues_a_tail`.

- Scenario: validator-less staging (valid sidecar JSON, no ETag/Last-Modified)
  + a hostile origin that answers ANY request with `206 bytes 5-14/15` — the
  glue shape a full-200 server cannot produce.
- Assertions (side effects, not error strings): the download is refused; the
  `.part` AND `.part.meta` are gone BEFORE the request (the rule discards
  pre-request); the ONE request the server received carries NO `Range`
  header; no destination file exists (the poisoned hybrid was never
  committed); the completed-artifact registry holds zero records; the
  session state is `Failed`.
- Kill-proof EXECUTED this round: with the byte-identity rule disabled, this
  test **FAILS** (the Range request goes out, the 206 is accepted, the
  `12345` prefix + hostile tail hybrid is committed and recorded) while the
  old test keeps passing; with the rule restored it passes. The guard now
  has a regression that cannot survive its removal.
- Suite after the addition: 162/162, `cargo fmt --check` clean, harness
  clippy `-D warnings` clean.

### 10.6 Independent defect hunt — results

A full re-read of all owned files plus a pattern sweep over `src-tauri/**`
(production, not tests) found NO new production defect:

- Unbounded reads: zero `.text()` / `.bytes()` / `.json()` call sites in
  production code; the only `read_to_string` is the 64 KiB-bounded sidecar
  reader (KT-3-verified).
- `unsafe`: exactly one block (lib.rs `windows_machine_arch`,
  `GetNativeSystemInfo` — documented, no memory risk surface).
- Process spawning: exactly one `Command::new` (artifact_open.rs:305, direct
  argv, stdio nulled, behind the full identity boundary); no shell
  interpolation anywhere.
- Arithmetic: every server-reachable sum is `checked_add`/`saturating_add`
  (running counter, `already_have + range_len`, `remote_len +
  already_have`; display totals saturate); `end - start + 1` guarded
  (KT-1).
- Staging lifecycle: `DiscardAndFail` deletes `.part` + `.part.meta` on
  416/invalid-range/impossible-range/checksum-mismatch paths; the
  byte-identity rule discards pre-request (now pinned, §10.5); commit is
  atomic hard-link (create_new fallback), never clobbering; registry
  records only after a successful commit with fresh metadata.
- Identity boundaries: restored rows (negative ids) refused; wide ids
  refused by `u32::try_from` (CI-proven test); canonical stability +
  committed size re-checked at plan time AND at launch time; `.sig` /
  `.part` / `.part.meta` names refused by every boundary; the signature
  boundary's uniform out-of-scope refusal is unchanged.
- Redirect/host policy: admission + per-hop rules + public-only resolver
  re-verified line by line; the trailing-slash prefix `/WasewaseX/Fress/`
  admits no sibling-prefix string (`/WasewaseX/Fress-evil/` refuses);
  IDN/homoglyph hosts normalize to punycode and fail the exact host match;
  IPv4-mapped IPv6, NAT64, 6to4, Teredo, zone-ids all refuse (matrix tests
  green in the harness run).
- The `start_download` `directory` residual (round-2 N-4, accepted
  residual 3) was re-reviewed: the bounded-impact rationale still holds
  (sanitized single-component names, no-clobber creates only, opener
  permissions already unscoped). Disposition unchanged; any tightening of
  picker provenance remains a lib.rs owner decision.

### 10.7 Dependency audit re-run (independent, this round)

| Item | Result |
| --- | --- |
| Tool | cargo-audit 0.22.2 (installed fresh from crates.io `--locked`), advisory DB fetched live 2026-10-15: **1329 advisories** |
| Scope | `src-tauri/Cargo.lock` as committed at `78d5e8ff` (528 crate dependencies) |
| Vulnerabilities | **0** — exit 0 |
| Advisory-grade warnings | **7**, all transitive, classified: 6 × unmaintained (`proc-macro-error` RUSTSEC-2024-0370; `unic-char-property` -0081, `unic-char-range` -0075, `unic-common` -0080, `unic-ucd-ident` -0100, `unic-ucd-version` -0098 — via `urlpattern`) + 1 × unsound (`glib` 0.18.5 RUSTSEC-2024-0429, Linux GTK stack). Same set round 2 recorded; none is a vulnerability; all are accepted, documented residuals |
| Yanked pins | **0** findings in the scan output |
| Lock delta vs the beta tag `6d338fd` | re-verified byte-level: exactly the three documented changes (`fress` 1.0.12-beta → 1.0.0; `rustls` 0.23.45 → 0.23.46; `yoke-derive` 0.8.3 → 0.8.4) plus the in-repo `tauri-plugin-fress-open` package — zero unexplained drift |
| Policy note (unchanged) | `.github/workflows/security.yml` runs this scan weekly/advisory-only (`continue-on-error: true`, never on PRs); a zero-vulnerability result is NOT proof of zero dependency risk — the seven warnings above ARE the current accepted risk, and the advisory lag argument in §7 still applies |

### 10.8 Verdict of the re-verification round

**PASS.** Every round-2/round-3 claim this round could execute was
re-executed and held (fmt, harness tests, clippy, four executable guards,
dependency scan); the CI record on the exact SHA covers the rest; one
test-quality gap was found in the byte-identity regression and closed with
a guard-sensitive production-path test whose kill-proof was executed; no
new production defect was found; the dependency baseline is unchanged
(0 vulnerabilities, 7 classified advisory warnings, 0 yanked). The release
itself was not touched this round: no tag moved, no release metadata
changed, and the audit delta is the new test plus this report.

### 10.9 Finish-the-PR round: independent re-execution on the branch head (Agent 6)

A second, independent pass (a fresh sandbox: new rustup install, empty
cargo cache, cargo-audit installed fresh) re-executed the claims of §10.3–§10.7
against the PR branch head rather than the base, and re-ran every kill-test
with its own hands. The PR's diff against `78d5e8ff` is exactly two files
(this report's §10 + the §10.5 regression test in `download_finalize.rs`);
no production code changed, so the production conclusions of §10.6 carry
over unchanged to the head.

Tested source:

| Ref | SHA |
| --- | --- |
| `main` / `v1.0.0` tag | `78d5e8ff8e1bc38ca8789539da005fdea4b15613` |
| This PR's head | `cf27c20c0fc4133e9609702756e5228d5343c029` (branch `agent6/native-audit-round2`, base = the SHA above) |

Executed checks (pinned toolchain 1.98.1 — rustc/cargo 1.98.1, rustfmt
1.9.x, clippy 0.1.98 — installed fresh this round):

| Check | Result on `cf27c20` |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | **PASS**, exit 0 |
| Tauri-free harness `cargo test` (real `download_finalize.rs` + `network_policy.rs`/`tests.rs` + `http_body.rs` as UNMODIFIED symlinks; direct deps locked-exact: reqwest 0.12.28 rustls-tls+stream+http2, serde 1.0.229, serde_json 1.0.151, sha2 0.10.9, tokio 1.53.1, futures-util 0.3.34) | **162/162 PASS** (per-module re-count: download_finalize **96**, network_policy **52**, http_body **14**) |
| Harness `cargo clippy --all-targets -- -D warnings` | **PASS** with a disclosed harness-level allowance — see the correction below |
| Full-crate `cargo check --manifest-path src-tauri/Cargo.toml` | **FAILS in this sandbox** at `gdk-sys` (no `gdk-3.0.pc` / webkit2gtk-4.1 dev headers; no root to install) — the same documented constraint as §10.3; CI-backed proof on the exact head covers the full workspace |
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2 fresh from crates.io, live advisory DB) | **exit 0 — 0 vulnerabilities; 7 advisory warnings; 0 yanked**, all classified below |
| CI run **38648622950** on `cf27c20` (verified via the GitHub API this round) | **all 10 jobs success**, including `Rust fmt, clippy, tests (linux)`, `Rust tests (windows-latest)`, `Rust tests (macos-latest)` — the Tauri-coupled modules (`lib.rs`, `artifact_open.rs` and its 23 boundary tests, `download_integration.rs`) and the new test compile and pass on all three desktop platforms |
| CI run **38595199247** on `78d5e8ff` + Release run **38597496640** | re-verified success via the API (all jobs; the shipped v1.0.0 artifacts came from this tree) |

Reporting correction (found while re-executing, not a production issue):
§10.3's "harness clippy … zero findings" was optimistic. The three modules
contain a `pub(crate)` surface whose PRODUCTION consumer is `lib.rs`
(`read_capped_api_text`, the wire payload structs, the registry
constructors); a harness that compiles the subset without `lib.rs` makes
those items dead code, and `clippy -D warnings` refuses the build until the
harness crate root carries `#![allow(dead_code)]` (harness-only; the real
crate's CI clippy runs WITHOUT any allowance and is green on the exact
head). This round's record states the allowance explicitly instead of
silencing it silently; with it, the harness clippy result is exit 0.

Executed kill-tests, round-finish edition (each kill applied to the working
tree, named test run, tree restored to clean — `git status` verified between
runs; kill shapes named so they are repeatable):

| # | Guard killed (file:line at `cf27c20`) | Kill shape | Named test after the kill | Verdict |
| --- | --- | --- | --- | --- |
| KT-1 | `validate_resume_content_range` checked arithmetic (download_finalize.rs:936) | `.checked_add(1)` → `wrapping_sub/wrapping_add` | `a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked` | **FAILS** with `a u64::MAX range must be refused: 0` — the silent wrap-to-0 the guard forbids, observed live |
| KT-2 | `self_update_feed` PathPin (network_policy.rs:471) | `path_pin: Some(..)` → `None` | `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` AND `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin` | **BOTH FAIL** (the off-allowlist hop test still passes — the host rule alone, exactly the N-3 gap) |
| KT-3 | `read_part_meta` 64 KiB `take()` (download_finalize.rs:742) | unbounded `read_to_string` restored (plus the `mut` the non-`take` form needs) | `an_oversized_part_meta_sidecar_reads_as_no_validators` | **FAILS** — the oversized valid-JSON sidecar parses unbounded and yields validators |
| KT-4 | impossible-range discard (download_finalize.rs:1750) | `discard_staging(&part)` commented out of the `checked_add`-overflow branch | `a_hostile_u64_max_content_range_fails_named_without_completing` | **FAILS on the filesystem-side-effect assertion** (`the poisoned .part must be discarded`) — not on an error string |
| KT-5 | byte-identity rule (download_finalize.rs:1423) | `if planned_resume_len > 0 && …` → `if false && …` | `a_validator_less_resume_never_sends_a_range_request_or_glues_a_tail` (new) + sibling `validator_less_staging_is_discarded_on_resume` | **NEW TEST FAILS** (the hostile 206 glue is accepted, the hybrid would commit) while **the sibling STILL PASSES** — re-proving this round that the old regression cannot detect the kill and the new one can; guard restored → new test passes |

Dependency audit re-run (this round, live DB): **0 vulnerabilities**, 7
advisory warnings — 6 × unmaintained (`proc-macro-error`
RUSTSEC-2024-0370; `unic-char-property` -0081, `unic-char-range` -0075,
`unic-common` -0080, `unic-ucd-ident` -0100, `unic-ucd-version` -0098, via
`urlpattern`) + 1 × unsound (`glib` 0.18.5 RUSTSEC-2024-0429, Linux GTK
stack) — **0 yanked pins**, and NO ignore/suppression config exists in the
repo, so all seven findings are live reports, not filtered ones. Same set
§10.7 recorded; none is a vulnerability; the classification and policy
notes there carry over verbatim.

Defect hunt re-run: the full re-read of all owned production files
(`http_body.rs` 460 L, `network_policy.rs` 928 L, `artifact_open.rs` 780 L,
`download_finalize.rs` 5606 L, `download_integration.rs` 426 L,
`main.rs` 10 L) plus the command wiring in `lib.rs` (2037 L, read-only)
re-confirmed §10.6 line by line: zero unbounded body readers remain (the
only `read_to_string` is the KT-3-verified 64 KiB sidecar take), exactly
one `unsafe` block (`windows_machine_arch`, documented), exactly one
`Command::new` (direct argv, stdio nulled, behind the full identity
boundary), every server-reachable sum checked or saturating, staging
discard paths intact on every refusal branch, registry records only after
byte-count + canonical + integrity + commit pass, restored rows and
cross-wired ids refused at both open boundaries. **No new production
defect; the PR stays narrowly scoped (two files, no production change).**

Verdict of this round: **PASS** — the PR head is ready as the audit record;
nothing needs to be added to the diff, and no release artifact, tag or
release metadata was touched.

### 10.10 Handoff round: independent re-execution at the pushed head `202d002` (Agent 6, fresh sandbox, REST-backed CI evidence)

A further independent pass — a different machine, fresh rustup, empty cargo
cache, cargo-audit installed from crates.io minutes before use — re-executed
the §10.3–§10.9 claims against the PR's ACTUAL pushed head. Motivation: the
PR head had moved one commit past the SHA §10.9 tested (`cf27c20` →
`202d002`), and the standing rule is that verification results are never
copied forward to a different SHA. The move is docs-only (an empty
`git diff cf27c20..202d002 -- src-tauri/`), so every code conclusion carries
over by construction — this round re-proved the load-bearing ones by
execution anyway.

Tested source:

| Ref | SHA |
| --- | --- |
| `main` / `v1.0.0` tag | `78d5e8ff8e1bc38ca8789539da005fdea4b15613` (re-fetched this round; the tag is ON main HEAD) |
| PR #94 base | `78d5e8ff…` (merge-base of the PR head and main — the claimed base is exact) |
| PR #94 head | `202d0020a765d518c5e62ff677c57339058205bd` (branch `agent6/native-audit-round2`; code-identical to `cf27c20`) |

Environment: rustup 1.29.1 fresh; toolchain from `rust-toolchain.toml`
(1.98.1: rustc/cargo 1.98.1, rustfmt 1.9.0, clippy 0.1.98 — component
versions match §10.3's record exactly). Harness rebuilt from scratch on this
machine: the three Tauri-free production modules as UNMODIFIED symlinks,
direct dependencies pinned `=` to the `src-tauri/Cargo.lock` versions
(reqwest 0.12.28 `rustls-tls+stream+http2` default-features-off, serde
1.0.229, serde_json 1.0.151, sha2 0.10.9, tokio 1.53.1, futures-util
0.3.34), `#![allow(dead_code)]` in the harness root only (the §10.9
disclosure). One harness-only delta from §10.9's harness description, for
completeness: two engine tests declare `#[tokio::test(flavor =
"multi_thread")]`, so the harness's tokio features must include
`rt-multi-thread` (in the real crate the feature arrives transitively
through the Tauri dependency graph; the harness must name it explicitly).
No source file was modified to build the harness.

| Check | Result on head `202d002` |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | **PASS**, exit 0 |
| Harness `cargo test` (unmodified sources) | **162/162 PASS** (per-module re-count: download_finalize **96**, network_policy **52**, http_body **14** — matches §10.9) |
| Harness `cargo clippy --all-targets -- -D warnings` | **PASS**, exit 0 (with the harness-root dead_code allowance) |
| `cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, live advisory DB fetched this round) | **exit 0 — 0 vulnerabilities, 7 advisory warnings, 0 yanked findings**: 6 × unmaintained (`proc-macro-error` RUSTSEC-2024-0370; `unic-char-property` -0081, `unic-char-range` -0075, `unic-common` -0080, `unic-ucd-ident` -0100, `unic-ucd-version` -0098, via `urlpattern`) + 1 × unsound (`glib` 0.18.5 RUSTSEC-2024-0429). Same classification as §10.7/§10.9, independently reproduced |
| Production-read sweeps (re-run, not copied): `.text()`/`.bytes()`/`.json()`/`read_to_string`, `unsafe`, `Command::new`, unchecked `+=` | same as §10.6 — the only `read_to_string` is the 64 KiB-bounded sidecar take (download_finalize.rs:742); the only `unsafe` is `windows_machine_arch` (lib.rs:912-915); the only `Command::new` is the AppImage launcher (artifact_open.rs:305, argv-only, stdio nulled); every server-reachable sum checked/saturating (:937, :1584, :1658, :1734, :1785) — the two plain-`+=` hits in the sweep are both inside `mod tests` |
| Key guard sites re-read at their claimed lines | byte-identity rule (download_finalize.rs:1423, discards pre-request), `checked_add(1)` in `validate_resume_content_range` (:936-941), impossible-range `discard_staging` (:1750), `u32::try_from` id gate (artifact_open.rs:238), launch-time re-check (artifact_open.rs:289-295), `PathPin` (network_policy.rs:471) + hop ordering (pin evaluated LAST, after host rule) + `is_publicly_routable` v4/v6 tables + the admission-side repo pin (`check_self_update_repo_path`, lib.rs:255) — all present exactly as documented |
| Deeper reads this round (health pass) | `download_integration.rs` (426 L, test-only — all assertions sound), the lib.rs command surface (all 12 registrations traced, §1 below), `capabilities/default.json` (matches the documented permission set exactly), `main.rs` (10 L, trivial), and a review-only read of Agent 7's `plugins/fress-open` Kotlin adapter (READ-only URI grants on every intent, no exec/delete/write-grant surface, correct layering behind the Rust boundary) |

Kill-tests EXECUTED by hand this round (edit → named test → observe →
`git checkout` restore → clean-tree re-run; `git status` verified between
runs):

| # | Guard killed | Named test after the kill | Observed verdict |
| --- | --- | --- | --- |
| KT-1 | `(end - start).checked_add(1)` → `wrapping_sub/wrapping_add` (download_finalize.rs:936) | `a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked` | **FAILS** — guard verified |
| KT-2 | `self_update_feed` `path_pin: Some(..)` → `None` (network_policy.rs:471) | `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` AND `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin` | **BOTH FAIL** (the sibling off-allowlist-hop test keeps passing — the host rule alone, exactly the N-3 gap) — guard verified |
| KT-3 | `read_part_meta` `take(64 KiB)` → unbounded `read_to_string` (download_finalize.rs:740-742) | `an_oversized_part_meta_sidecar_reads_as_no_validators` | **FAILS** — the oversized sidecar parses unbounded and yields validators — guard verified |
| KT-4 | `discard_staging(&part)` removed from the impossible-range branch (download_finalize.rs:1750) | `a_hostile_u64_max_content_range_fails_named_without_completing` | **FAILS on the filesystem assertion** — "the poisoned .part must be discarded" — not on an error string — guard verified |
| KT-5 | byte-identity rule disabled (`if false && …`, download_finalize.rs:1423) | `a_validator_less_resume_never_sends_a_range_request_or_glues_a_tail` + sibling `validator_less_staging_is_discarded_on_resume` | **NEW TEST FAILS while the SIBLING STILL PASSES** — re-proving the §10.5 discriminator claim by execution; guard restored → both pass |

After all kills were restored: full harness re-run **162/162 PASS**, working
tree clean against the head.

CI evidence, re-verified this round through the REST API with a live
maintainer token (the token available to the previous handoff attempt had
been revoked — `401 Bad credentials` — forcing HTML-page evidence there;
this round's checks below are API responses, not page scrapes):

| Commit | Check runs | Result |
| --- | --- | --- |
| `202d002` (PR #94 head) | 12 of 12 | **success** — including `Rust fmt, clippy, tests (linux)`, `Rust tests (windows-latest)`, `Rust tests (macos-latest)`, version consistency, No-Chinese zero-hit scan, typecheck/build, E2E + visual, perf invariants, release-artifact verifier, Ubuntu 26 canary, both author guards |
| `cf27c20` (§10.9's tested head) | 12 of 12 | **success** — same shape; the earlier round's claim re-verified via API |
| `78d5e8ff` (main = v1.0.0) | 26 of 26 | **success** — the CI-backed proof for the Tauri-coupled files at the exact base |
| PR #94 mergeability | `mergeable: true`, `mergeable_state: clean` | the branch merges into main without conflict |

One record-accuracy finding (doc-only, fixed in this commit): §1's command
inventory still said "All 11 commands" with a `lib.rs ~:1009` registration
line — both stale since the Android open-boundary integration added
`open_downloaded_file` as the twelfth registered command (registration now
at ~:1140). §10.2 already covered the command's boundary; the missing §1
table row has been added, and the count/line reconciled. No production
change; no code finding was involved.

Defect hunt: the pattern sweeps, the deeper reads above, and the full re-read
of the owned production files found **no new production defect**; nothing in
this round required a code change, and the PR's diff remains exactly the two
files (the §10.5 regression test + this report). Per §10.9's correction, the
statement of scope stands: the Tauri-free harness proves the
engine/policy/body modules; `lib.rs`, `artifact_open.rs` and
`download_integration.rs` remain CI-proven, and §9's hardware rows remain
NOT RUN.

Verdict of this round: **PASS** — every executable claim of §10.3–§10.9 was
re-executed on the pushed head `202d002` and held; the audit record is
accurate as it stands, now with the §1 inventory reconciled.

### 10.11 Full-coverage read round: CI completed at `2075038`, every owned file read end to end (Agent 6, fresh token round)

This round closed the two items §10.10 left open — the CI runs that were
still in flight when that round pushed, and the targeted-read shape of the
source review — after the environment was reset again (the sandbox lost the
cargo PATH between turns; `~/.cargo/bin` and the pinned 1.98.1 toolchain
survived, and a fresh fine-grained token supplied by the repository owner
replaced the revoked one for git + REST access).

**CI completion at the final PR head `2075038`.** The §10.10 table showed
4 of 12 checks green within 45 s of the push. With the new token the REST
check-run query at the same SHA now reports **12 of 12 `success`**,
including `Rust fmt, clippy, tests (linux)`, `Rust tests (windows-latest)`,
`Rust tests (macos-latest)`, and both author guards. The docs-only delta
`202d002..2075038` is exactly the §10.10 report (105 lines in this file,
zero source lines), so the §10.3–§10.9 evidence at `202d002` transfers to
the pushed head unchanged.

**Gates re-run on the current tree (= PR head `2075038`).** Harness
**162/162** (`96 + 52 + 14`, 30.1 s), harness clippy `-D warnings` PASS,
`cargo fmt --check` PASS in `src-tauri`, and `cargo audit` (0.22.2, live
advisory DB re-fetched this round) exit 0 with the same 7 known warnings
and **0 vulnerabilities** — no new advisory published since §10.4.

**First complete line-coverage read of every owned file.** Earlier rounds
verified the security-critical regions by targeted reads plus kill-tests;
this round read the full production surface at the pushed head:

| File (lines read) | Focus of the read | Verdict |
| --- | --- | --- |
| `http_body.rs` (460, all) | Both cap rails: check-before-extend in u64; `room` subtraction cannot underflow (loop invariant `buf.len() ≤ cap`); JSON-refuses / text-truncates contrast; exactly-at-cap boundary pins; slow-drip time-rail pin | CLEAN |
| `network_policy.rs` (928, all) | Admission (https-only, credentials, exact-host post-normalization), hop evaluation order with the path pin LAST (:697), v4 table completeness (`b[0] < 224` tail), v6 `2000::/3` gate — confirmed `2001:db8::/32` is NOT shadowed by the `/23` check (`0x0db8 & 0xfe00 = 0x0c00 ≠ 0`, both rows load-bearing), IPv4-mapped/NAT64/Teredo refused by the native-unicast gate, `PathPin` prefix ends with `/` (defeats `FressEvil` siblings), resolver never caches | CLEAN |
| `download_finalize.rs` (1–2012 production, all) | State-machine table = documented spec; registry cap FIFO + replace-by-canonical; `percent_decode` bounds; `sanitize_filename` keeps no separators, collapses `.`/`..`/reserved names; `validate_resume_content_range` checked arithmetic; `evaluate_response` 200/206/416 matrix; link-refused fallback set (unix 1\|2\|13\|18\|30\|38\|95, windows 1\|5\|17\|50); reservation-copy cleans a failed commit; streaming loop cancel + 60 s stall + checked counter; flush+sync before commit; record only after commit | CLEAN |
| `artifact_open.rs` (780, all) | Name gates (staging/sidecar/`.sig` case-insensitive, `..` components, no file-name), `symlink_metadata` shape gate, AppImage-only routing, negative-id and `u32::try_from` gates (:238), id binding, canonical + size stability at plan AND launch time, argv-only spawn with nulled stdio, `0o100` chmod restricted to the validated file; 20 unit tests pin every gate | CLEAN |
| `network_policy/tests.rs` (1374, all) | 52 tests: per-class admission, credential/userinfo disguises, v4/v6 boundary rows, IDN/punycode/trailing-dot look-alikes, zone ids, redirect decisions incl. loops/budget/allowlist/pin, strict-policy drift guard, scripted resolver (mixed / all-private / rebinding re-check / lookup failure), literals-skip-DNS pin, self-update 3-host allowlist + `.sig` rides the same policy + path-pin matrix incl. the dot-segment escape; spot-read the rebinding and path-pin bodies — both assert what their names claim | CLEAN, no material coverage gap |

**Cross-file boundary check (read-only, `lib.rs` not owned).** The one
unverified ingress into the engine's filename handling was
`DownloadPlan.requested_name`: inside `download_finalize.rs` only header- and
URL-derived names pass through `sanitize_filename`, so a pass-through of the
frontend-supplied name would have allowed `dir.join()` traversal. Verified
closed: `start_download` (lib.rs:942) is the ONLY production plan-construction
site, it sanitizes at lib.rs:980 (`filename.map(|n| sanitize_filename(&n))`)
AFTER the URL has been admitted and BEFORE any filesystem side effect, and the
spawned task wraps the engine in `catch_unwind` with an unconditional
`session.release()` — matching the module invariant that no failure path can
leave an active-set entry behind. No change needed.

Defect hunt result of this round: **no new production defect**; the PR diff
remains exactly the two files it has been since `202d002`. Scope statement
unchanged: the Tauri-free harness proves the engine/policy/body modules;
`lib.rs`, `artifact_open.rs` and `download_integration.rs` remain CI-proven;
§9's hardware rows remain NOT RUN.

Verdict of this round: **PASS** — CI evidence is now complete at the pushed
head, and the audit's source-review claim can be upgraded from
"security-critical regions verified" to "every owned production file read in
full at the pushed head, with the one cross-file ingress boundary verified
closed".

### 10.12 Round 4: the v1.0.1 stable boundary — independent re-verification after the open/reveal redesign (Agent 6, fresh sandbox)

Why a fourth round: after §10.10/§10.11 closed on the audited tree
(`2075038`), main kept moving and **shipped two stable releases**. PR #95
("close every reported defect, gate open/reveal natively, enforce TS
strict") rebuilt exactly the territory this audit owns — the open/reveal
boundary — and `v1.0.1` was tagged on top of it. Claims are re-verified on
the exact new SHA; nothing from §10.1–§10.11 is reused on a different tree.

**Tested source (exact refs).** Tag `v1.0.1` = commit `7fcb4fe31012`
(also current `main` tip at the time of this round, which includes the PR
#95 boundary redesign, PR #98's release commit `16a2359`, and the CI-only
fixes #99/#100). Diff from the §10.11 tree (`2075038`) touches 86 files;
the audit-relevant subset is enumerated below. The unmerged head of PR #94
(`c662993`, docs-only §10.11) is carried onto this round's branch by
cherry-pick so the section numbering stays continuous.

**What changed in owned territory since `2075038` (read in full):**

- `download_finalize.rs` (+46/-6): (a) new `completed_parent_dirs()` —
  canonicalized, deduplicated parents of this session's completed
  artifacts, feeding the directory-admission rule of the new
  `open_download_dir`; (b) `sanitize_filename` hardening — Windows
  trailing-dot/space parity (`readme.` / `readme. ` now strip to the name
  Windows actually materializes; an all-dots run `"..."` strips to empty
  and collapses to `download.bin`, where the old rule caught only `.` and
  `..`). Both changes verified against the code: the hardening strictly
  narrows accepted names; `completed_parent_dirs` derives only from
  engine-committed canonical records.
- `download_integration.rs` (+43): three new deterministic tests pinning
  (a) all-dots collapse, (b) trailing-dot/space parity incl. reserved
  `NUL.`, (c) Content-Disposition dot-run names. Executed below.
- `lib.rs` (+164/-23, **report-only file** for this audit): the boundary
  redesign — `opener:allow-open-path` /
  `opener:allow-reveal-item-in-dir` removed from
  `capabilities/default.json` (verified: the permission array now grants
  only event listen/unlisten, `path:dirname`, `dialog:open`, and
  https-scoped `open-url`); desktop dispatch of `open_downloaded_file` now
  exists (opener plugin's **Rust** API, capability files gate webview IPC
  only); new commands `reveal_download_file` (same
  `resolve_completed_artifact` discipline via `spawn_blocking`),
  `open_download_dir` (admits only: platform default download folder, OR a
  `completed_parent_dirs()` member, OR a `record_download_directory`
  admission; every refusal the uniform typed code; Android refused typed),
  and `record_download_directory` (in-memory, LRU-capped at 32,
  session-scoped by design — the code comment correctly argues a persisted
  admission set would let webview-influenced state outlive the process
  that verified the pick).
- `docs/security/tauri-security.md` (+33): the permission matrix and the
  residual-risk statement updated to the new architecture; verified
  consistent with the capability file and the command code, with one
  refinement noted below (finding R4-1).

**Independent re-execution (fresh sandbox, toolchain exactly
`rustc 1.98.1` / rustfmt 1.9.0 / clippy 0.1.98 per `rust-toolchain.toml`):**

- Harness rebuilt at `7fcb4fe`: production files **symlinked verbatim**
  (never copied) — `http_body.rs`, `network_policy.rs` +
  `network_policy/tests.rs`, `artifact_open.rs`, `download_finalize.rs`,
  `download_integration.rs`; the `tauri` dependency is an inert local stub
  (pass-through `#[command]` proc-macro + never-constructed `State`); the
  lib.rs root items `download_integration.rs` imports (`fetch_text`, the
  GhRelease/FdroidPackage structs and callees) are **machine-extracted
  verbatim** from the audited `lib.rs` by a checked-in generator script
  (`scripts/extract_root_items.py`, source SHA recorded in the generated
  header — no hand-copies). Direct dependencies `=`-pinned to the exact
  `src-tauri/Cargo.lock` resolutions: reqwest 0.12.28, serde 1.0.229,
  serde_json 1.0.151, sha2 0.10.9, tokio 1.53.1, futures-util 0.3.34.
  Disclosed deviation: blanket `#![allow(dead_code)]` at the harness root.
- **Native tests: 209 passed, 0 failed** (http_body 14, network_policy 52,
  artifact_open 23, download_finalize 96, download_integration 24 —
  exact `--list` census). Up from 162 at §10.10's tree: PR #95's suites
  grew the owned-module count by 47.
- fmt: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — exit
  0 on the full workspace. clippy: `-D warnings` clean on every owned
  module via the harness (the full-workspace clippy remains CI-proven:
  run on `c662993`'s mergeable ancestor, linux/windows/macos all green —
  12/12 checks at the PR head).
- **Kill-tests executed this round (guard deleted → named tests run →
  guard restored → clean tree re-verified green):**
  1. `sanitize_filename` trailing-dot strip disabled →
     `all_dot_runs_collapse_to_the_safe_default`,
     `trailing_dots_and_spaces_strip_to_the_name_windows_will_create`,
     `content_disposition_dot_run_filename_collapses` and
     `dot_dot_and_empty_collapse_to_the_safe_default` all FAIL. Restored.
  2. Byte-identity validator-less discard disabled (the `if false &&`
     mutation at the `discard_staging` rule) →
     `a_validator_less_resume_never_sends_a_range_request_or_glues_a_tail`
     FAILS — the §10.5 guard-sensitive pin still bites exactly as
     designed (the 206-shape catches what the 200-shape cannot).
     Restored.
  3. `PathPin::admits` host comparison inverted (`!=` → `==`) →
     `the_self_update_path_pin_binds_github_hops_to_the_fress_repo` and
     `the_self_update_client_refuses_a_redirect_back_onto_github_outside_the_repo_pin`
     both FAIL. Restored; full suite re-run green (209/209).

**Dependency audit re-run at `v1.0.1`'s `src-tauri/Cargo.lock`**
(cargo-audit 0.22.2, advisory DB as of 2026-10-18): **0 vulnerabilities;
10 warnings** (9 unmaintained + 1 unsound). Drift since §10.7's "7
warnings": three NEW 2026 advisories on the Linux DBus stack that Tauri
pulls in — `zbus_names` (RUSTSEC-2026-0371), `zvariant`
(RUSTSEC-2026-0370), `zvariant_derive` (RUSTSEC-2026-0372), all
"unmaintained" classifications with no fix release; the pre-existing
`proc-macro-error`, `unic-*` (×5) and `glib` unsound advisory are
unchanged. None is in Fress-owned code; all remain transitive to Tauri's
Linux backend. CI policy unchanged (security.yml `cargo audit` is
`continue-on-error` on purpose, documented; the job succeeded at the
release commit `4528009`).

**Defect hunt at the new tree — one finding, severity LOW (report-only,
`lib.rs` is outside the audit's fix scope):**

- **R4-1 — `record_download_directory` is webview-callable with an
  arbitrary path.** The command takes any `dir: String`, canonicalizes it,
  and inserts it into the session admission set on success — there is no
  native binding between the call and an actual picker interaction
  (the native `dialog` plugin cannot hand the app a "the user really
  picked this" token that the command could demand). A compromised
  webview can therefore self-admit any existing directory (e.g.
  `invoke('record_download_directory', { dir: '/home/user' })`) and then
  `open_download_dir` it. Impact is bounded and honest: a file-manager
  window on a directory the user can see being opened — **no file can be
  opened** (the file path stays registry-bound), **no content returns to
  the webview** (no read/readdir command exists), no exec surface, the
  refusal code is uniform, and the set is in-memory only. This is still a
  strict improvement over the pre-redesign grants, which allowed opening
  any file with the OS handler. Two corrections follow from it:
  (a) `docs/security/tauri-security.md`'s residual-risk sentence ("the
  effective blast radius is 'files the engine itself committed this
  session'") is true for FILES but slightly understates the DIRECTORY
  surface — a compromised webview can pop a file-manager window on any
  existing directory, not only engine-touched ones; (b) if the project
  wants the "user picked it" invariant enforced natively, the admission
  should be recorded inside the dialog plugin's accept path (native side
  of the picker) rather than by a webview-invoked command — or the
  command should require a one-time admission token minted by the dialog
  plugin's accept handler. Routed to the boundary owner; no fix attempted
  from this audit (file ownership).

**Tag-level verification of the two stable releases** (both tags fetched
and diffed directly): `v1.0.0` = `e8830c4` (= `78d5e8f`, the tree §10.1–
§10.11 already audited: grants present, desktop open/reveal via the
plugin JS API, `open_downloaded_file` desktop-dispatching to the opener
plugin's Rust API) — its release notes' account of a desktop
open/reveal regression is the release owner's record and outside this
audit's scope; what this audit verifies independently is the endpoint:
`v1.0.1` grants are REMOVED, every webview-reachable open/reveal flows
through registry-validated commands, and the boundary's own test battery
(§10.12 re-execution) is green with kill-test-proven teeth.

**PR #94 status at this round's close:** 3 of its 4 commits (`cf27c20`,
`202d002`, `2075038`) are merged into `main` (verified by
`merge-base --is-ancestor`); only the docs-only head `c662993` remains,
CI 12/12 green at that head; this round's branch carries the same commit
as `b51cc7c` so the sections merge in order.

**Verdict of Round 4: PASS.** The v1.0.1 boundary redesign was verified
end to end at the tagged SHA: the owned-file changes are hardening plus
tests, the redesign's claims hold in code and in execution, three new
kill-tests prove the guards have teeth, and the dependency baseline is
unchanged in kind (0 vulnerabilities; 10 advisory-grade transitive
warnings, three of them new 2026 unmaintained classifications on
Tauri's Linux stack). One LOW finding (R4-1) is reported to the boundary
owner with a concrete native-enforcement recommendation; no known
security or correctness defect remains in the audit-owned code.

### §10.13 Round 5 — re-verification at main `0be68b7` after the second review wave merged (Agent 6)

**Why a new round:** the exact-SHA rule forbids reusing Round 4's results
on a different tree. Between Round 4 and this round, `main` advanced
`7fcb4fe` → `0be68b7`: the second review wave merged in full (#93, #96,
#97, #101, #102, #103, #104 — this audit's own §10.12 — and #105;
#94 was closed unmerged, its only unmerged head commit being the
docs-only §10.11 whose content PR #104 carries byte-identically). The
entire `src-tauri/` delta between the two heads is **one file**:
`download_finalize.rs` +610/−31 (PR #103). Every other native file the
audit owns is byte-identical (verified by `git diff 7fcb4fe..0be68b7 --
src-tauri/`).

**Full-delta read of PR #103's merged production code** (all four
clusters):

1. *Cancellable, bounded first-response wait.* The unbounded
   `request.send().await` is now a `tokio::select!` with `biased;` — the
   cancel arm is polled first, so a pre-latched cancel wins the race
   against a response that has already arrived; the send is wrapped in a
   60 s window (`FIRST_RESPONSE_TIMEOUT`, same policy as the body stall,
   one phase earlier). On cancel before a byte moved: state → Cancelled,
   `CANCEL_SENTINEL` with kind `None`, nothing on disk (the gate precedes
   the staging reservation). On timeout: retryable `network` failure with
   a named message. The window also covers redirect hops (reqwest follows
   them inside `send`), so a slow-drip redirect chain cannot wedge the
   attempt either.
2. *Transient-vs-deterministic status taxonomy.* `evaluate_response`
   returns kind `Some("network")` for 429/502/503/504 (retryable — the
   retry loop exists for exactly these) and stays final `None` for every
   other status; the protocol gate still admits only 200/206. The unit
   pin `transient_server_statuses_are_retryable_and_deterministic_ones_
   are_not` asserts both directions, and `a_deterministic_404_is_never_
   retried` proves the budget is not burned (exactly one request hits the
   mock).
3. *Named redirect refusals.* `classify_send_error` maps
   `reqwest::Error::is_redirect()` — the surface on which
   `network_policy`'s per-hop refusals (scheme downgrade, allowlist miss,
   loop, hop budget, credentials on a hop) arrive — to a FINAL failure
   whose message names the refusal ("Insecure redirect refused: …"),
   replacing the old misleading "Connection failed" + retry-budget burn.
   `a_redirect_policy_refusal_is_final_and_named_not_retried` pins final
   classification, naming, and single-request behavior. Security-positive:
   a security decision is no longer misreported as a network blip.
4. *Flush-on-stop on every stop path.* All four stop paths (cancel
   mid-body, 60 s stall, mid-body connection death, the pre-finalize
   cancel drain) now run `file.flush().await` before `drop(file)` and
   state advance, so the `.part` file's on-disk length equals exactly the
   bytes the engine accepted at the moment the error returns — closing
   the window where a buffered tail or a pending drop-flush would make a
   fast automatic retry (or the user's Resume) probe a stale length and
   glue a corrupted file. The test-only `DeferredFlushSink` models
   tokio's buffering semantics and turns the invariant into a
   deterministic byte-equality assertion on both the interrupt and stall
   paths.

Static sweep of the file's 2 134 production lines: **zero `unsafe`**
(the single grep hit is the English word in a doc comment), **zero
`unwrap`, zero `panic!`/`todo!`**, no TODO/FIXME markers; the four
`.expect(...)` sites are the pre-existing, documented completed-artifact
registry lock-poisoning guards (:436/:463/:481/:497), unchanged by this
PR. No new command, no new fs surface, no path-handling change.

**Harness rebuilt at `0be68b7`** (sandbox reset had wiped the previous
rig): same discipline — the five production modules symlinked verbatim
from the live tree; the inert `tauri` stub reduced to exactly what the
modules reference (`State<'r, T>` with `.inner()`, and the pass-through
`#[tauri::command]` proc macro); the root items `download_integration`
imports (`fetch_text`, `fetch_latest_release`, `fetch_recent_releases`,
`fetch_fdroid_package`, `parse_gh_release`, `sanitize_filename` + the
three resolver structs) copied verbatim from `lib.rs` @ `0be68b7` (lines
38–246, 943–1005); direct dependencies pinned `=` to the audited versions
(reqwest 0.12.28, serde 1.0.229, serde_json 1.0.151, sha2 0.10.9, tokio
1.53.1, futures-util 0.3.34). Disclosed harness-only deviations: the
root `#![allow(dead_code)]`; a private `use download_finalize::
sanitize_filename` with an explicit `allow(unused_imports)` (production
resolves the same name the same way); tokio's `rt-multi-thread` feature
enabled for the two `#[tokio::test(flavor = "multi_thread")]` attributes
(in production this feature arrives transitively via Tauri). Toolchain
exactly per `rust-toolchain.toml`: 1.98.1 / rustfmt 1.9.0 / clippy
0.1.98.

**Native battery at `0be68b7`: 217 passed / 0 failed** (census:
http_body 14, network_policy 52, artifact_open 23, download_finalize
104, download_integration 24 — exactly +8 over Round 4's 209, matching
the eight new tests PR #103 adds). `cargo fmt --check` exit 0 on the
full harness; `cargo clippy --tests -- -D warnings` clean (the test
target is where every production line compiles; the bare-lib pass emits
harness-only unused-import warnings for imports the Tauri command surface
consumes in production).

**Kill-tests executed this round (both prove the new teeth, both
restored to a clean tree and 217/217 green afterwards):**

1. Stall-path flush deleted (`let _ = file.flush().await;` at the 60 s
   stall arm) → `a_stalled_transfer_flushes_its_accepted_bytes_before_
   returning` FAILS with exactly the invariant assertion ("the staging
   file must hold exactly the bytes the engine accepted"). Restored.
2. `503` dropped from the transient-taxonomy `matches!` → BOTH
   `transient_server_statuses_are_retryable_and_deterministic_ones_are_
   not` (unit pin) and `a_transient_503_is_retried_and_the_download_
   completes` (end-to-end) FAIL. Restored.

**Dependency audit re-run at `0be68b7`'s lock** (cargo-audit 0.22.2,
advisory DB as of 2026-10-18): **0 vulnerabilities; 10 warnings** — the
identical set to Round 4 (proc-macro-error, unic ×5, zbus_names /
zvariant / zvariant_derive, glib unsound). Zero drift; no new advisories.

**Frontend wave verified in review** (TS/TSX is report-only territory
for this audit): PR #101's per-id slot accounting traced sound against
the engine contract — the design's load-bearing assumption (Rust
download ids are never reused) verified at `download_finalize.rs:386`
(monotonic `AtomicU32::fetch_add`, SeqCst); PR #102's URL reroutes
verified official domain-by-domain (VLC's iOS listing live-verified as
`id650377962`; Krita's Flathub id, Tuta's and Proton's Play package ids
all corrected); PR #97's lockfile diff verified confined to the vitest-3
subtree (the RCE-advisory-carrying `tinypool 1.1.1` pin removed with it).
Reviews posted on the PRs.

**Process finding (report-only):** PR #103 merged with its commit
authored `Fress Agent 2 <agent2@fress.local>` — the author-guard
convention (`WasewaseX <WasewaseX@users.noreply.github.com>`) was
violated despite being flagged blocking-for-merge in the pre-merge
review; the merge commit itself is correctly authored. The violation is
historical-record only and carries no code risk, but the convention is
unenforceable if review flags do not gate merges.

**Release scaffold #106 cross-checked** (report-only): all four
authoritative version fields at 1.0.2 with version-only lockfile diffs;
every changelog claim about the merged wave cross-checked against this
audit's own verification (not the PR bodies) and found accurate.

**Verdict of Round 5: PASS.** The second review wave's native delta is
hardening plus tests, verified in code and in execution with
kill-test-proven teeth; the dependency baseline is unchanged (0
vulnerabilities, same 10 advisory-grade transitive warnings); no defect
was found in audit-owned code at `0be68b7`; one process finding (the
#103 author-guard violation) is recorded above. The audit doc's claims
now stand verified at `0be68b7` under the exact-SHA rule.

### §10.14 Round 6 — re-verification at main `d09914e` and the v1.0.2 release `e60d2a9` (Agent 6)

**Why a new round:** under the exact-SHA rule the Round 5 results stand
only at `0be68b7`. Main then advanced in three merges: PR #106 (the
v1.0.2 release, tag `v1.0.2` = `e60d2a9`), PR #108 (the zlib-bomb DoS
fix, `1a53399`), and PR #107 (this audit's §10.13). This round
re-verifies at main `d09914e` and records what the new commits surface.

**Native carry-over by byte-identity.** `git diff 0be68b7..d09914e --
src-tauri/` touches four metadata files only — `Cargo.toml`,
`Cargo.lock` (both version-only: `fress` and `tauri-plugin-fress-open`
1.0.1 → 1.0.2, no URL or hash swaps), `plugins/fress-open/Cargo.toml`,
and `tauri.conf.json`. **Zero `.rs` deltas.** Every Round 5 claim (the
full-delta read of PR #103's four clusters, the 217/0 native battery,
both kill-tests, the 0-vulnerability dependency audit) therefore
transfers verbatim to `d09914e` by the byte-identity rule. CI
independently executes the tree at `d09914e`: 13/13 check runs green.
Disclosed limitation: this sandbox holds no Rust toolchain this round,
so the battery was not re-executed locally — no claim below relies on
it.

**PR #108 reviewed in full (the round's only new security-relevant
code).** `boundedInflate()` wraps `inflateSync(buf, { maxOutputLength:
64 MiB })` — the correct Node zlib cap API; cap overflow and malformed
streams both return null. Callers preserve the pre-existing failure
semantics exactly: iTXt falls back to the raw bytes (still passed
through the scan), zTXt skips the payload (previously the whole
`out.push` was skipped on catch). The gate cannot crash and cannot be
bypassed — a capped chunk becomes undetectable, which matches the
pre-fix behavior for malformed streams while removing the OOM. Test 27
pins the composite case: an ~80 MiB-expansion bomb and a normal
compressed Han chunk in the same PNG → bomb neutralized, Han still
detected, exit 1 (gate healthy, fail-closed). Style note, non-blocking:
`boundedInflate` is declared between two import statements — legal ESM
(imports hoist), cosmetically unusual.

**Release-boundary record:** `v1.0.2` (`e60d2a9`) does NOT contain
`1a53399` — `git merge-base --is-ancestor 1a53399 e60d2a9` is false;
the fix merged one merge later (`909fb49`). Impact is bounded: the
changed file is the CI no-Chinese gate, never shipped in any artifact;
the weakness was availability-only (the gate could be disrupted, never
bypassed); the tag tree is fixed trusted content, so a CI re-run at the
tag has no attacker-controlled PNG path; the real attack surface — PR
heads — all carry the fix. Residual exposure of the v1.0.2 tag itself:
negligible; recorded for exact-SHA honesty.

**Finding (report-only, release-metadata owner): the v1.0.2 release
commit corrupted one dev-transitive lockfile version field.** `aced69d`
bumped `"version": "1.0.1"` → `"version": "1.0.2"` across
`package-lock.json` and swept three occurrences; two are the project's
own root entries, the third is `node_modules/is-potential-custom-element-name`
(a jsdom test-infra dependency, `dev: true`) — the only dependency in
the tree whose version coincidentally equaled the old project version.
The registry carries no 1.0.2 of that package (published versions:
1.0.0/1.0.1, untouched since 2022-06-19); `resolved` and `integrity`
still pin the real 1.0.1 tarball and the hash matches the registry, so
the installed bytes are authentic and unchanged — a lockfile-truth lie,
not a supply-chain swap. `npm ls` stays green and CI (which installs
from this lock) is 13/13 green at `d09914e`; exposure is dev-only and
not bundled. Fix is one line on main (revert that field to 1.0.1) plus
a process note: version sweeps over lockfiles must exclude `packages`
entries, or delegate to the tool's own version update. `Cargo.lock` was
verified clean — its delta touches exactly the two project crates and
no other crate.

**Correction to §10.13's process finding.** §10.13 recorded PR #103 as
"merged with its commit authored `agent2@fress.local`". The final
merged history supersedes that record: both merged commits (`6016a81`,
`84ee6c9`) are authored `WasewaseX <WasewaseX@users.noreply.github.com>`
— the violation flagged during review was remediated before the merge
landed, and the merged tree is compliant. Separately, the gmail-shaped
author on GitHub-composed merge commits (`WasewaseX
<khosraviasghar55@gmail.com>`, uniform across the last ten merges) is
explicitly whitelisted by `author-guard.yml` with a comment noting the
shape ends when the account enables private-email mode — documented
pattern, not a violation. The §10.13 process finding is closed as
resolved-by-rebase.

**Release surface cross-check (report-only):** the `v1.0.2` GitHub
release lists 22 assets including `.sig` signatures for every signable
bundle, not draft, not prerelease, target `main`. The changelog's 1.0.2
claims were cross-checked against this audit's own per-PR verification
(not the PR bodies): #103's bounded wait/flush/taxonomy, #101's per-id
slots at `download_finalize.rs:386`, #97's tinypool removal, #102's
live-verified reroutes, #105's token parity, #96's Han G/H/I — all
match. The changelog's unit-battery figure (877 passed / 2 skipped
across 59 files) is the frontend suite, outside this audit's execution
scope; CI green at the released heads backs it.

**Verdict of Round 6: PASS carried to `d09914e` / `v1.0.2`.** The
native verdict transfers by byte-identity with zero `.rs` drift; the
round's one new security-relevant review (PR #108) is sound; one
dev-only lockfile-truth defect is recorded and routed (report-only,
release-metadata owner); the §10.13 process finding is closed as
resolved. No defect was found in audit-owned code this round.

### §10.15 Round 7 — re-verification at main `1812878f` and `ab2e2723` after the resilience wave merged (Agent 6)

**Why a new round:** under the exact-SHA rule the Round 6 results stand
only at `d09914e`. Main then advanced twice: `d09914e` → `1812878f`
(13 commits — PR #109, this audit's §10.14; PR #111, the deny-all
loopback boundary fix; PR #112, the `write_part_meta` doc correction;
PR #113, the rate-limit-proof release lookup; PR #114, the catalog
lookup resilience layer), then `1812878f` → `ab2e2723` (PR #115, the
v1.0.4 release commit `3447371`). Unlike Round 6, this round is **NOT**
carried by byte-identity: the delta adds substantial Rust code and the
full delta was read.

**The resilience wave, audited in full.** Three new surfaces entered
the native layer, all reviewed line-by-line at `ab2e2723`:

- **`api_resilience.rs` (new, 604 lines + 564 test lines).** A bounded
  retry + ETag-cache layer for API lookups: 4 attempts max, retryable
  statuses limited to 408/429/5xx plus 403 only when GitHub's own
  rate-limit headers say so; `Retry-After` honored but hard-capped
  (15 s production); deterministic answers (other 4xx, policy
  refusals, oversized bodies, non-UTF-8) never retried; redirect
  refusals never retried. The persistent cache enforces three budgets
  (2 MiB/entry, 256 entries, 16 MiB total) with oldest-first eviction,
  is schema-version-filtered on load (a `version: 1` stamp written at
  creation, not the integer default), persists via temp-file rename,
  and every I/O error is swallowed by contract — the cache can never
  become a new way for a lookup to fail. An unexpected 304 with no
  cached body is an error, not a panic. Stale fallback is bounded to
  7 days. The layer never constructs URLs, never chooses hosts, and
  never sees a credential; admission and redirects stay in
  `network_policy`. **One LOW observation (non-blocking):** a
  retryable status that carries no `Retry-After` header is recorded as
  `planned_delay = Some(ZERO)`, which skips the backoff schedule the
  module docs promise would "fill every other gap" — bounded to the 4
  attempts, politeness-only impact (quota and origin load, never
  correctness or security). Report-only; no fix filed.
- **`network_policy.rs` (+122).** A new request class
  `github_releases_doc()` admitting github.com for exactly two document
  shapes (`/{owner}/{repo}/releases.atom` and
  `/{owner}/{repo}/releases/tag/{tag}/expanded_assets`) via a new
  `ReleasesDocShape` gate: percent-encoded path segments validated
  against a strict charset (non-empty, ≤120 bytes, no `.`/`..`,
  `[A-Za-z0-9._~+%]` only), the shape re-checked on **every redirect
  hop** (mirrored `RedirectRejection::OffDocumentShape`), private
  addresses blocked, 3-hop budget, `PinToOrigin`. The pinned invariant
  "github.com stays off the generic resolver-manifest allowlist" is
  preserved — this is a dedicated class, not a widening — so the
  self-update checksum document remains reachable only through its
  path-pinned policy. Encoded lookalikes (`releases%2Eatom`) fail the
  shape and are refused. Dedicated tests pin exact-two-shapes
  admission, refusal of everything else on github.com, and hop-shape
  re-checks.
- **`lib.rs` (+170/−56).** The GitHub/F-Droid lookup commands now
  route through the resilience layer via `AppHandle`-free `gh_*` /
  `fdroid_package` cores (harness-drivable, cache injectable);
  command signatures keep their frontend contract (Tauri injects the
  handle). `fetch_text` gains retry-only resilience with **no cache**
  — deliberate, manifest freshness is its contract — and
  `fetch_github_release_doc` is the single-shot dedicated-class
  reader. The 404 wording mapping preserves the frontend's failure
  classification verbatim.

**Owned-file deltas this round:** `download_finalize.rs` is
**comment-only** (PR #112's doc correction; zero code semantics), and
`download_integration.rs` is the command-rename + cache-parameter
plumbing with matching test updates. `http_body.rs` is untouched; the
transient-error wording contract between the capped reader
(`"Bad response: {transport}"` → retryable; `"too large"`/`"not
UTF-8"` → deterministic) and `api_resilience::is_transient_body_error`
was re-verified against the new call sites.

**The TS fallback path, audited in full.** `atomReleases.ts` builds
URLs only from strict allowlists (`isSafeRepoSlug` charset regex
before any request; tags ≤120 chars over `[A-Za-z0-9._+~ -]`), takes
the release tag only from the canonical alternate link matching THIS
exact repo, accepts exactly two path segments per asset href, refuses
truncated documents outright (an anti-downgrade check: a body cut at
the native cap could otherwise silently resolve an OLD release),
bounds fragment fetches to 5 per run, and fails closed to the
caller's ORIGINAL API error — the UI's failure classification never
changes. `githubProvider.ts` short-circuits the honest 404 (a
release-less repo gains nothing from the feed and must not spend
requests on it) and rethrows the original error when the fallback
dies. Minor observation, non-blocking: `repo` is interpolated into a
`RegExp` in `parseExpandedAssets`, but the slug charset contains no
significant metacharacters and catalog slugs are curated input.

**Executed locally at `ab2e2723`:** the full TS/TSX suite — **897
passed / 2 skipped / 0 failed across 61 files**, including the 19 new
tests (16 atom-fallback, 3 deny-all-boundary). Disclosed limitation
unchanged: this sandbox holds no Rust toolchain, so the native battery
was not re-executed locally — CI executes it on linux/windows/macos
instead, and no claim below relies on the unexecuted battery.

**CI flake found at `1812878f`, root-caused, de-flaked (PR #117).**
The macOS Rust-test check failed once at `1812878f` (run 39133960118,
272 passed / 1 failed): the adversarial stall-window test pinned the
body-phase stall wording (`"Connection stalled"`) but the attempt can
equally name the same 60 s policy through the response-phase window
(`"No response from the server for 60s"`). In the failing run every
behavioral assertion passed (retryable error, `"network"` kind,
`Failed` state, no finalization, `.part` survival) — only the wording
differed. Both windows carry the identical retryable-`"network"`
contract, and the sibling test already pins the response-phase
wording on purpose. The suite is green on macOS at `5d8630e` (v1.0.3),
`3447371` (v1.0.4 release commit) and `ab2e2723` (current main) —
one-off, load-dependent scheduling race, not a regression. PR #117
(owned file, test-only) accepts either naming; every other assertion
stays byte-for-byte strict. Neither release was built from the red
state.

**Release provenance.** `v1.0.3` (`5d8630e7c`, the PR #114 merge):
Release run 39130358671 built from exactly the tag SHA; 22 assets, 5
`.sig` files, `SHA256SUMS.txt`, `latest.json` present — asset pattern
identical to v1.0.1/v1.0.2 (macOS absence from the updater feed
remains the established pattern, observation only). `v1.0.4`: release
commit `3447371` touches version metadata + CHANGELOG only (verified
clean sweep — the v1.0.2 lockfile corruption did NOT repeat, see
below); the Release run 39135340523 was in progress at head `ab2e2723`
at audit time with the stable tag not yet pushed, so its provenance
verdict is deferred to the next round once the tag exists. **Note for
the boundary record:** as with v1.0.2, the stable tag (built from the
release commit) will not contain the fix PRs merged after it — here
PR #113/#114 are IN v1.0.3/`5d8630e`, but PR #117's de-flake and any
later merge land after `3447371`.

**Issue #110 status at `ab2e2723`: still open and still valid.** The
`is-potential-custom-element-name` field still carries the corrupted
`"version": "1.0.2"` while `resolved`+`integrity` still pin the real
1.0.1 tarball — the lockfile-truth lie persists unchanged. The 1.0.3
and 1.0.4 version sweeps were clean (both lockfile deltas touch only
the two root `version` fields and the two project crates), so the
sweep process has evidently stopped repeating the mistake, but the
one-line remediation of the pre-existing field remains outstanding
for the release-metadata owner.

**Author guard:** all 7 non-merge commits in `d09914e..ab2e2723` are
authored `WasewaseX <WasewaseX@users.noreply.github.com>`; the
gmail-shaped author on GitHub-composed merge commits remains the
documented whitelisted pattern (§10.14).

**Verdict of Round 7: PASS at `ab2e2723` (provisionally carried from
the line-by-line native read; CI green on the release heads), with two
routed items:** one LOW non-blocking observation on the resilience
backoff (report-only), and one CI-wording flake fixed by PR #117
(test-only, owned file). No defect was found in audit-owned code this
round; the resilience wave's security posture is sound — bounded
retries, budgeted cache, shape-gated github.com admission with the
generic-allowlist invariant intact, and fail-closed semantics at
every layer boundary.

## 11. Conclusion

**PASS with the dependency follow-up RESOLVED — PR #81's fixes verified
real; PR #84's round-2 fixes verified real and retained; 2 release-adjacent
defects found and fixed this round (A-1, N-3) plus hardening (OBS-3/OBS-4,
A-2/A-3/A-4) and 9 test-gap fills; the round-2 CI-clippy regression fixed;
one regression fixture strengthened after its kill-test found it could pass
without its guard; round 3 (final integration, Agent 4) added the text-rail
exactly-at-cap pins and the mismatched-start discard proof (R-5) and
corrected the stale resume docstring (DOC-2); no native security/correctness
defect remains in the audit-owned code; the dependency scan's findings were
resolved the same day (PR #88: rustls 0.23.46, yoke-derive 0.8.4) and the
final tree re-audits clean.**

- The response-reading and arithmetic defects are fixed WITH regressions, and
  the size-cap/timeout rails are proven independently enforced by loopback
  tests that run against the real readers (161/161 locally executed on the
  final tree; per-module: download_finalize 95, network_policy 52,
  http_body 14). Reconciled by the handoff rounds: the strengthened
  byte-identity fixture brings this to 162/162 (download_finalize 96) at the
  pushed PR head, re-executed and CI-green there; §10.11 records the
  full-coverage read of every owned file at that head.
- The trust boundaries hold end to end: registry → verification → launch
  (now re-checked at the launch instant), admission → per-hop rules →
  public-only DNS (now path-pinned for the self-update feed), embedded-key
  minisign verification (now legacy-refusal-pinned on both paths).
- Capabilities are minimal and match the documented matrix; no shell surface;
  three accepted residuals documented (§5) with no change to the intentional
  trust policy.
- Dependency audit: final tree re-audited with the real tool — **exit 0, 0
  vulnerabilities** (rustls 0.23.46 + yoke-derive 0.8.4 landed via PR #88 the
  same day the advisories published); 7 advisory-grade transitive warnings,
  classified (§7); the hashbrown-via-indexmap pin remains optional hygiene
  (borsh path unused). The final diff carries no
  secrets/debug/unsafe/spawn changes and the zero-CJK gate passes with zero
  warnings.
- Reconciliation: the round's integration is complete — PR #85 (the
  integrated candidate, merged `0767082`), PR #84 (this audit, merged
  `80250f1`), PR #88 (the dependency fix, merged `0db3d09`), the no-Chinese
  round (PR #79, merged `550c030`) and the per-workstream integration merges
  (#81 at `7e029c9`, #82 at `2bd125e`) are all on main; the final-integration
  PR adds the last uncovered work (Agent 1's #86 frontend fix and the round-3
  R-5/DOC-2 fills). No #85 change was overwritten and no competing release
  branch exists.
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

The independent post-tag re-verification (§10) re-executed every executable
claim of this conclusion on the tagged tree (`78d5e8ff` = `v1.0.0`), found
the conclusion's evidence intact, and closed the one test-quality gap its
executed kill-tests uncovered. The acceptance disposition above is
therefore re-confirmed at the tagged SHA: still PASS, still zero known
native integrity defects, with the byte-identity rule now pinned by a test
that fails when the guard is removed.
