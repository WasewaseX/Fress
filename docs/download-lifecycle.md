# Download lifecycle: state transitions and cleanup policy

Scope: the download engine in `src-tauri/src/download_finalize.rs` (introduced by
the transaction-safety work) and the thin Tauri command surface in
`src-tauri/src/lib.rs`. This document is the reviewer-facing copy of the
authoritative specification, which lives next to the code as the module docs of
`download_finalize.rs`.

## 1. States

| State | Meaning |
|---|---|
| `Queued` | Registered in the active set; the task has not started streaming. |
| `Downloading` | Response body bytes are in flight (including a resumed tail) and every retryable outcome is still possible. |
| `Retrying` | An automatic retry is backing off before the next attempt. |
| `Verifying` | Body fully received AND its byte count verified against the response's promise: digest comparison and the final commit are running. Short and non-retryable. |
| `Completed` | Committed to its destination path. Terminal. |
| `Failed` | Definitively failed (retry budget exhausted, disk error, checksum mismatch, protocol violation). Terminal. |
| `Cancelled` | Cancelled by the user before verification began. Terminal. |

## 2. Legal transitions

| From | Allowed to |
|---|---|
| `Queued` | `Downloading`, `Cancelled` |
| `Downloading` | `Verifying`, `Retrying`, `Failed`, `Cancelled` |
| `Retrying` | `Downloading`, `Failed`, `Cancelled` |
| `Verifying` | `Completed`, `Failed` |
| `Completed` / `Failed` / `Cancelled` | none (terminal) |

Every runtime transition goes through `DownloadState::can_transition_to`, which
is exhaustively unit-tested against this exact table. `DownloadSession::settle`
is a defensive terminal write used by failure paths; it never overwrites a
terminal state, so a cancelled download can never be relabelled `Failed` or
`Completed`.

Invariants:

- Only the download task mutates its own state. `cancel_download` only signals
  the cancellation channel. One writer per download id means two concurrent
  operations can never update the same id inconsistently.
- Once a download has reported `Cancelled` it can never report success: the
  cancellation channel is re-checked (drained) at the last possible point
  before any completion decision, and a cancelled task returns immediately
  without running verification or finalization.
- Cancellation is honored while streaming and through every retryable outcome
  (short transfer, stalled connection, retry backoff - the backoff sleep
  itself is cancellable). Entering `Verifying` is the point of no return: the
  bytes are already on disk, and deleting a fully received, length-verified,
  hash-checked artifact would only waste the transfer.
- Every terminal outcome releases the download from the active registry - on
  the normal path by an explicit release, on a panic path by the
  `catch_unwind` wrapper in `start_download`. A failed download can never
  remain active indefinitely.

## 3. Staging files and sidecars

- In-flight bytes live in `<name>.part` next to the eventual destination; the
  final name is claimed only at finalization. A half-written file never looks
  finished.
- `<name>.part.meta` holds the HTTP validators (ETag / Last-Modified) the
  origin served the staged bytes with, enabling `If-Range` on resume.
- Ownership: exactly one download attempt owns a staging file. Fresh downloads
  reserve `<name>.part` with an atomic `create_new`; the loser of the race
  moves to `<name> (1).part`. Automatic retries reuse the exact path the
  previous attempt opened (`DownloadPlan.staging`), never a re-derived name.
- Byte-identity rule: staged bytes may only be resumed when their origin is
  provably the same resource (validators present in the sidecar for the same
  URL, or a trusted checksum will judge the assembled file anyway). Otherwise
  the staging bytes are discarded and the download restarts from zero.

## 4. Resume correctness

- Only `200` and `206` are accepted as body-bearing answers. Other 2xx codes
  (204, 205, ...) are rejected instead of finalizing an empty or bodyless
  file.
- A `206` is trusted only when its `Content-Range` is present, well-formed,
  starts exactly at the staging length, and has a sane end and total
  (`validate_resume_content_range`, RFC 9110 15.3.7). Any violation fails the
  attempt as kind `resume-invalid` and discards the staging bytes - never
  append.
- A `200` answer to a resume request restarts the staging file from zero
  (truncate in place). A full response is never appended to a partial file.
- HTTP 416 on a resume: the staged bytes can no longer be satisfied; they are
  discarded and the failure is reported as `resume-invalid` so the UI offers a
  fresh Retry, not a replay of the same broken exchange.
- A `206` without a matching range request (server misbehaviour) is rejected.
- Completion requires byte-count agreement with everything the response
  promised: the `Content-Range` promise for a 206 tail, `Content-Length` for a
  full 200 body, and the total resource size. A short subrange (RFC 9110
  15.3.7.2 allows it) or an early connection close is a `network`-kind error
  that the automatic retry continues from the exact staged length - a
  truncated file is never finalized. A chunked 200 without `Content-Length`
  cannot be length-checked (documented limitation); a supplied checksum is the
  safety net there.
- Before the final commit the staging file is `flush`ed and `sync_all`'d, so a
  power cut cannot leave truncated bytes behind a completed-looking name.

## 5. Digest computation vs. trusted verification

- The SHA-256 digest is computed over the complete assembled bytes, including
  a resumed prefix.
- Computing is not verifying. `verify_digest` distinguishes:
  - `TrustedMatch`: compared against the caller-supplied trusted digest and it
    matched; the payload reports `verified: Some(true)`.
  - `Unverified`: no trusted digest supplied; the digest was computed but
    nothing was verified; the payload reports `verified: None`.
  - `Mismatch`: the trusted digest does not match; the artifact is corrupt.
- Normalization: surrounding whitespace ignored, optional `0x` prefix
  stripped, case-insensitive comparison.

## 6. No-clobber finalization

`commit_no_clobber` replaces the old check-then-rename, which raced (two
concurrent finalizations could each pass `exists() == false` and `rename`
silently replaces on every platform). The commit is now atomic per candidate:

- Primary path: `hard_link` (`link(2)` on Unix, `CreateHardLinkW` on Windows).
  Both are specified to FAIL when the target exists - existence check and
  creation are one kernel operation, so there is no window in which an
  existing file can be overwritten. The staging file always lives in the
  destination directory (`part_path_for`), so the link is same-volume by
  construction. After the link succeeds, the staging name is unlinked
  (best-effort).
- Fallback for filesystems that refuse links (cross-device mounts, FAT/exFAT,
  some FUSE/network filesystems): reserve the destination name with
  `create_new` (also atomic) and copy the bytes in, then sync and unlink the
  staging file. A failure removes the reservation; the staging file survives.
- Collisions pick the next candidate name (`name`, `name (1).ext`, ... up to
  10,000). Exhaustion is reported as an error - never an overwrite.
- A genuine filesystem error (disk full, permission denied, directory gone) is
  reported as `FinalizeError::Io` and never mistaken for a collision. A failed
  commit leaves the staging file in place.
- The exact committed destination path is returned and reported in the
  `download-complete` payload.

## 7. Cleanup policy (deterministic per outcome)

| Outcome | `<name>.part` | `<name>.part.meta` | Destination |
|---|---|---|---|
| Completed | unlinked by the commit | removed | created via no-clobber commit |
| Cancelled (streaming or backoff) | kept, resumable | kept | not created |
| Network failure (retryable, retries left) | kept, resumable | kept/updated | not created |
| Network failure (budget exhausted) | kept, resumable | kept | not created |
| Truncated / short-subrange transfer | kept with the bytes received | kept | not created |
| Checksum mismatch | removed (policy: delete, not quarantine - a corrupt installer must never look runnable; quarantine would leave a half-behaviour for users to discover) | removed | not created |
| 416 / invalid / mismatched `Content-Range` | removed (bytes proven useless) | removed | not created |
| Unexpected status / protocol error | untouched (nothing proven wrong) | untouched | not created |
| Validator-less staging at resume | removed (byte-identity rule) | removed | not created |

Unrelated destination files are never touched by any cleanup path. A leftover
`.part` (e.g. its unlink failed at commit time on a scanner-locked Windows
box) is harmless and self-healing: the next resume of that name either
completes through the normal paths or discards it under the byte-identity
rule.

## 8. Automatic retries

- `kind == "network"` failures retry automatically, at most 2 times, with a
  cancellable backoff (2s, 4s). Everything else is final.
- A retry always continues the exact staging file the previous attempt opened.
- Retryable now includes: stalled connection, interrupted stream, refused
  connection, and byte-count mismatches (cut short / short subrange). A
  checksum failure, `resume-invalid` answer, HTTP status error or disk error
  is never retried.

## 9. The open boundary: from "downloaded" to "opened / installed"

The download-to-open contract lives in `docs/download-open-contract.md`
(frontend policy `src/lib/artifactOpen.ts`, desktop opener wiring, Linux
AppImage launcher `src-tauri/src/artifact_open.rs`). The ANDROID adapter
lands below the SAME boundary: on Android the provider binds the policy's
`openPath` dep to the registry-validated native command
`open_downloaded_file` (`src-tauri/src/lib.rs`), because the opener plugin
cannot hand out app-private files there.

The command shares the completed-artifact resolution with the updater's
signature-verification boundary (`resolve_completed_artifact`): session-scoped
registry match (exact reported path first, canonical fallback), staging names
never, canonical stability re-check, regular file, committed byte size.
Anything else receives one uniform typed refusal
(`open-artifact/not-registered` - the same `open-artifact/<code>` namespace
the AppImage launcher reports and the frontend's `parseOpenError` classifies),
so the command is not a filesystem probe: a compromised webview cannot point
it at arbitrary paths, distinguish existing from missing files, or learn
anything about unregistered paths.

The registry is intentionally in-memory and session-scoped. Panel rows
restored from localStorage after an app restart have no record here, so an
open attempt on them is refused with the typed `not-registered` code and an
honest, retryable failure - persisted, webview-writable state never feeds a
native open.

What a validated path does with:

- **Android, `.apk` artifact** (extension of the registry-recorded path,
  case-insensitive): handed to Android's normal package installer through the
  in-repo plugin `src-tauri/plugins/fress-open`:
  1. The Rust command classifies the artifact (`open_disposition`) and calls
     the plugin's Kotlin side (`FressOpenPlugin`).
  2. Kotlin wraps the file in a `content://` URI via androidx `FileProvider`,
     whose authority is `<applicationId>.fileprovider`. The provider itself is
     the one the Tauri app template generates; the plugin's build.rs patches
     the generated `gen/android/app/src/main/res/xml/file_paths.xml` (idempotently)
     so its roots cover EXACTLY `filesDir/Download` - the
     directory the engine commits downloads into on Android (see
     `platform_download_dir`). A path outside that root throws, so even a
     caller that bypassed the Rust validation cannot mint a URI for other
     app or device files.
  3. The URI is opened with `ACTION_VIEW`,
     `application/vnd.android.package-archive` and
     `FLAG_GRANT_READ_URI_PERMISSION` (plus `FLAG_ACTIVITY_NEW_TASK`), which
     routes to the system package installer. This is the standard,
     user-consented install flow: the installer - not Fress - shows the
     package details and enforces the unknown-sources restrictions. The
     plugin's manifest declares `REQUEST_INSTALL_PACKAGES`, which is what
     makes that STANDARD consent flow reachable for the calling app on
     Android 8+; Fress never touches `PackageInstaller` internals, silent
     install, or any bypass.
- **Android, any other artifact**: the safe fallback - `ACTION_VIEW` with a
  MIME type guessed from the extension when a viewer exists, otherwise an
  `ACTION_SEND` share chooser. Both grant temporary READ permission only;
  nothing is ever copied, written or executed by the plugin itself.
