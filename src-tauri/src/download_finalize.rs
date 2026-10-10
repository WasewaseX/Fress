//! Transaction-safe download engine for Fress.
//!
//! This module owns everything that happens between "the user clicked
//! download" and "a complete file exists on disk": the lifecycle state
//! machine, staging (.part) files and their validator sidecars, resume
//! correctness, integrity verification, and the final commit that turns a
//! staging file into the real, never-clobbered destination file.
//!
//! The module is deliberately self-contained (no Tauri types): the GUI layer
//! in `lib.rs` passes a [`ProgressSink`] for event emission and receives a
//! typed result per download, which keeps the whole engine unit-testable
//! against temporary directories and a local mock HTTP server.
//!
//! # State-transition specification
//!
//! Every download moves through the states of [`DownloadState`]:
//!
//! ```text
//! Queued ──▶ Downloading ──▶ Verifying ──▶ Completed
//!    │           │  ▲             │
//!    │           ▼  │             └──▶ Failed
//!    │         Retrying            Downloading/Verifying ──▶ Failed
//!    │           │  │
//!    │           ▼  │ (retry re-enters Downloading)
//!    └──────────────┴──────▶ Cancelled
//! ```
//!
//! Legal transitions (everything else is rejected):
//!
//! | from        | allowed to                              |
//! |-------------|-----------------------------------------|
//! | Queued      | Downloading, Cancelled                  |
//! | Downloading | Verifying, Retrying, Failed, Cancelled  |
//! | Retrying    | Downloading, Failed, Cancelled          |
//! | Verifying   | Completed, Failed                       |
//! | Completed / Failed / Cancelled | (terminal, no exits) |
//!
//! Invariants:
//!
//! - Only the download task itself mutates its state; `cancel_download` only
//!   signals the cancellation channel. Two concurrent operations therefore
//!   can never write different states for the same download id.
//! - Once a download has reported Cancelled it can never report success: the
//!   cancellation channel is re-checked (drained) at the last possible point
//!   before the transfer body is declared complete, and a cancelled task
//!   returns immediately without running verification or finalization.
//! - Cancellation is honored while bytes are streaming and through every
//!   retryable outcome (short transfer, stalled connection). Only when the
//!   body is fully received AND its byte count is verified against the
//!   response's promise does the download enter Verifying, from where it
//!   always runs to a terminal state: the bytes are already on disk, and
//!   deleting a fully received, hash-checked artifact would only waste the
//!   transfer.
//! - A download that ends in a terminal state is removed from the active
//!   registry; a failure path can never leave an entry behind (the session
//!   is released by the spawned task even if the task panics).
//!
//! # Staging files and sidecars
//!
//! In-flight bytes live in `&lt;name&gt;.part` next to the eventual destination,
//! with `&lt;name&gt;.part.meta` holding the HTTP validators (ETag /
//! Last-Modified) the origin served those bytes with. The final name is
//! claimed only at finalization, so a dropped connection can never leave a
//! half-written file that looks finished. A `.part` is owned by exactly one
//! download attempt: fresh downloads reserve it with an atomic
//! `create_new`, and automatic retries reuse the exact path the previous
//! attempt opened.
//!
//! # Resume correctness rules
//!
//! - A `206` answer is only trusted when its `Content-Range` is present,
//!   well-formed, starts exactly at the staging length, and has a sane end
//!   and total ([`validate_resume_content_range`]); anything else fails the
//!   attempt as `resume-invalid` and discards the staging bytes.
//! - A full `200` answer to a resume request restarts the staging file from
//!   zero (truncate), never appends.
//! - The delivered byte count is checked against both the promised range /
//!   Content-Length and the total resource size, so a short subrange or an
//!   early connection close is never finalized as a complete file.
//! - Staging bytes may only be resumed when their origin is provably the
//!   same resource (validators present, or a trusted checksum will judge
//!   the assembled file); otherwise they are discarded.
//!
//! # Integrity verification semantics
//!
//! Computing a SHA-256 digest is not verification. [`verify_digest`]
//! distinguishes "digest compared against a trusted expected value and it
//! matched" from "digest computed but nothing to compare against". A
//! mismatching file is never finalized: the staging artifact is deleted and
//! the download fails with kind `checksum`.
//!
//! # No-clobber finalization
//!
//! [`commit_no_clobber`] turns the staging file into the destination file
//! without ever replacing an existing file and without a check-then-act
//! race. The primary path is an atomic hard link (`link(2)` on Unix,
//! `CreateHardLinkW` on Windows - both are specified to fail when the
//! target exists, so the existence check and the creation are one kernel
//! operation), followed by unlinking the staging name. Filesystems that
//! refuse links (cross-device, FAT/exFAT, some network mounts) fall back to
//! reserving the destination name with `create_new` (also atomic) and
//! copying the bytes. A filename collision picks the next candidate name
//! ("name (1).ext", ...); a genuine filesystem error is reported as such.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

// ---------------------------------------------------------------------------
// Event payloads (wire shapes consumed by the frontend - do not change)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ProgressPayload {
    pub(crate) id: u32,
    pub(crate) downloaded: u64,
    pub(crate) total: u64,
    pub(crate) speed_bps: f64,
    pub(crate) eta_secs: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct CompletePayload {
    pub(crate) id: u32,
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
    /// Some(true) = compared against the publisher's trusted hash and it
    /// matched. Some(false)/None = no trusted reference hash was supplied,
    /// so the digest was computed but NOT verified. The UI must never show
    /// "verified" for a hash that was only calculated.
    pub(crate) verified: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ErrorPayload {
    pub(crate) id: u32,
    pub(crate) message: String,
    /// "checksum" marks a failed integrity verification (the file has been
    /// deleted); "network" marks a transient failure that was or can be
    /// retried; "resume-invalid" marks a partial download whose staging
    /// bytes were discarded. Absent for ordinary disk/protocol errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub(crate) struct RetryPayload {
    pub(crate) id: u32,
    /// 1-based count of automatic retries so far.
    pub(crate) attempt: u32,
    pub(crate) message: String,
}

/// Error message a cancelled download resolves to; the GUI layer maps it to
/// a plain "Cancelled" error event. Never user-facing.
pub(crate) const CANCEL_SENTINEL: &str = "__cancelled__";

// ---------------------------------------------------------------------------
// Download lifecycle state machine
// ---------------------------------------------------------------------------

/// Explicit lifecycle state of one download. The states and the legal
/// transitions between them are documented at the top of this module.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum DownloadState {
    /// Registered in the active set; the task has not started streaming.
    Queued,
    /// Response body bytes are in flight (including a resumed tail).
    Downloading,
    /// An automatic retry is backing off before the next attempt.
    Retrying,
    /// Body fully received and its byte count verified against the
    /// response's promise: digest comparison and the final commit are
    /// running. Cancellation is no longer honored here (see the module
    /// invariants).
    Verifying,
    /// Committed to its destination path; terminal.
    Completed,
    /// Definitively failed (network budget exhausted, disk error, checksum
    /// mismatch, protocol violation); terminal.
    Failed,
    /// Cancelled by the user before the body completed; terminal.
    Cancelled,
}

impl DownloadState {
    /// Is `to` a legal successor of `self`? The table is the single source
    /// of truth; every runtime transition goes through it.
    pub(crate) fn can_transition_to(self, to: DownloadState) -> bool {
        use DownloadState::*;
        matches!(
            (self, to),
            (Queued, Downloading)
                | (Queued, Cancelled)
                | (Downloading, Verifying)
                | (Downloading, Retrying)
                | (Downloading, Failed)
                | (Downloading, Cancelled)
                | (Retrying, Downloading)
                | (Retrying, Failed)
                | (Retrying, Cancelled)
                | (Verifying, Completed)
                | (Verifying, Failed)
        )
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            DownloadState::Completed | DownloadState::Failed | DownloadState::Cancelled
        )
    }
}

// ---------------------------------------------------------------------------
// Active-download registry and per-download session
// ---------------------------------------------------------------------------

struct ActiveDownload {
    /// Cancellation signal. A capacity of 1 is enough: a pending signal is
    /// latched until the task reads it, and extra requests are dropped.
    cancel: mpsc::Sender<()>,
    state: DownloadState,
}

/// Registry of live downloads, keyed by download id. The state machine and
/// the cancel channel live behind one mutex, so a state read and the cancel
/// signal are always consistent with each other.
#[derive(Default)]
pub(crate) struct DownloadRegistry {
    next_id: AtomicU32,
    active: Mutex<HashMap<u32, ActiveDownload>>,
}

impl DownloadRegistry {
    /// Registers a new download id in the Queued state and returns the id
    /// plus the receiver end of its cancellation channel.
    pub(crate) async fn register(&self) -> (u32, mpsc::Receiver<()>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<()>(1);
        self.active.lock().await.insert(
            id,
            ActiveDownload {
                cancel: tx,
                state: DownloadState::Queued,
            },
        );
        (id, rx)
    }

    /// Delivers a cancellation signal to a live download. Never mutates the
    /// download's state: observing the signal and updating the state is the
    /// download task's job, which keeps a single writer per id.
    pub(crate) async fn request_cancel(&self, id: u32) {
        if let Some(entry) = self.active.lock().await.get(&id) {
            let _ = entry.cancel.try_send(());
        }
    }
}

/// Handle one download task uses to advance its own lifecycle state.
/// Cloning is not allowed on purpose: one session per download id.
pub(crate) struct DownloadSession {
    registry: Arc<DownloadRegistry>,
    id: u32,
}

impl DownloadSession {
    pub(crate) fn new(registry: Arc<DownloadRegistry>, id: u32) -> Self {
        Self { registry, id }
    }

    /// Checked transition: succeeds only when the current state allows the
    /// move. Returns the unexpected current state on rejection.
    pub(crate) async fn advance(&self, to: DownloadState) -> Result<(), DownloadState> {
        let mut active = self.registry.active.lock().await;
        match active.get_mut(&self.id) {
            Some(entry) if entry.state.can_transition_to(to) => {
                entry.state = to;
                Ok(())
            }
            Some(entry) => Err(entry.state),
            // Already released (only possible after a terminal state was
            // reached); nothing left to advance.
            None => Err(DownloadState::Failed),
        }
    }

    /// Defensive terminal write for the failure paths: sets `to` unless the
    /// state is already terminal. Guarantees a download can never stay in
    /// the active set in a non-terminal state after its task gave up.
    pub(crate) async fn settle(&self, to: DownloadState) {
        let mut active = self.registry.active.lock().await;
        if let Some(entry) = active.get_mut(&self.id) {
            if !entry.state.is_terminal() {
                entry.state = to;
            }
        }
    }

    /// Removes the download from the active set (idempotent).
    pub(crate) async fn release(&self) {
        self.registry.active.lock().await.remove(&self.id);
    }

    /// Observes the current state. Test-only: production code learns the
    /// lifecycle from the terminal events, never by polling the registry.
    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> Option<DownloadState> {
        self.registry
            .active
            .lock()
            .await
            .get(&self.id)
            .map(|e| e.state)
    }
}

// ---------------------------------------------------------------------------
// Filename policy (server-supplied names must never escape the directory)
// ---------------------------------------------------------------------------

pub(crate) fn sanitize_filename(name: &str) -> String {
    // Unicode-aware on purpose: the RFC 5987 branch decodes UTF-8 ext-values
    // (a Japanese PDF must not land on disk as "__.pdf"), so any letter or
    // digit - any script - survives. Path separators are NEVER in the kept
    // set, which is the whole security property: the result can be joined
    // onto the download directory without escaping it.
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '(' || c == ')' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_').trim().to_string();
    // "." and ".." survive the character filter (dots are legal name
    // characters) but would make dir.join() walk up the directory tree, so
    // they collapse to the safe default like any other empty result.
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "download.bin".to_string();
    }
    // Windows reserve device names: "CON", "NUL", "COM1".."COM9",
    // "LPT1".."LPT9" cannot be file names. The rule applies to the name up
    // to the FIRST dot ("NUL.tar.gz" is reserved just like "NUL"), and a
    // server-supplied Content-Disposition must never be able to trigger a
    // finalize-time failure, so they collapse to the safe default too.
    let first_segment = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        first_segment.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        return "download.bin".to_string();
    }
    trimmed
}

pub(crate) fn filename_from_headers(
    url: &reqwest::Url,
    headers: &reqwest::header::HeaderMap,
) -> Option<String> {
    // Every branch funnels through sanitize_filename() before returning:
    // the value is joined onto the download directory, so a server-supplied
    // name like "../../something" (or its percent-encoded form - the RFC
    // 5987 branch decodes first) must never be able to escape the folder.
    // sanitize_filename also collapses "."/".."/empty to a safe name.
    if let Some(cd) = headers.get(reqwest::header::CONTENT_DISPOSITION) {
        let cd = cd.to_str().ok()?;
        // attachment; filename="app.apk" or filename*=UTF-8''app.apk
        if let Some(pos) = cd.find("filename*=") {
            let rest = &cd[pos + 10..];
            if let Some(name) = rest.split("''").nth(1) {
                let name = name.trim_matches('"').trim_end_matches(';');
                // RFC 5987 ext-values are percent-encoded; without decoding,
                // a Japanese PDF would land on disk as a literal "%E6%97%A5...".
                return Some(sanitize_filename(&percent_decode(name)));
            }
        }
        if let Some(pos) = cd.find("filename=") {
            let rest = &cd[pos + 9..];
            let end = rest.find(';').unwrap_or(rest.len());
            return Some(sanitize_filename(rest[..end].trim_matches('"')));
        }
    }
    // Fall back to the last URL path segment. Segments come percent-encoded;
    // decode for a readable name, then sanitize like any other
    // server-controlled value.
    let segment = url.path_segments()?.next_back()?.to_string();
    if segment.is_empty() {
        return None;
    }
    let decoded = percent_decode(&segment);
    if !decoded.contains('.') {
        None
    } else {
        Some(sanitize_filename(&decoded))
    }
}

/// Percent-decoding per RFC 5987/8187 (e.g. `%E6%97%A5` becomes the actual
/// Unicode character). Invalid or truncated escapes are kept literally, and
/// the byte sequence is lossily converted to UTF-8 so a filename always
/// exists on disk even for non-UTF-8 charsets.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// "setup.exe", 3 -> "setup (3).exe"; extension-less names keep no dot.
pub(crate) fn numbered_name(name: &str, i: u32) -> String {
    if i == 0 {
        return name.to_string();
    }
    let p = PathBuf::from(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if ext.is_empty() {
        format!("{} ({})", stem, i)
    } else {
        format!("{} ({}).{}", stem, i, ext)
    }
}

// ---------------------------------------------------------------------------
// Staging file identity and sidecar metadata
// ---------------------------------------------------------------------------

/// Staging file for an in-flight download. The final name only appears when
/// the download finished (and verified, when a trusted hash was supplied),
/// so a dropped connection can never leave a half-written "installer.exe"
/// behind that a retry would then call "installer (1).exe".
pub(crate) fn part_path_for(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|s| format!("{}.part", s.to_string_lossy()))
        .unwrap_or_else(|| "download.part".to_string());
    match dest.parent() {
        Some(p) => p.join(name),
        None => PathBuf::from(name),
    }
}

/// Inverse of part_path_for: the final destination a staging file belongs
/// to. "dir/setup.exe.part" -> "dir/setup.exe"; anything not ending in
/// ".part" has no destination.
pub(crate) fn dest_for_part(part: &Path) -> Option<PathBuf> {
    let name = part.file_name()?.to_string_lossy();
    let stem = name.strip_suffix(".part")?;
    part.parent().map(|p| p.join(stem))
}

/// Sidecar for a staging file: the HTTP validators (ETag / Last-Modified)
/// the origin served the staged bytes with. Written when the .part is
/// created and consulted on resume so the `Range` request can also carry
/// `If-Range` - without it, a server that replaced the file between
/// sessions would answer the Range with the NEW file's tail and the result
/// would be a silent old-prefix + new-suffix hybrid that only a checksum
/// (when one exists) could ever catch.
pub(crate) fn meta_path_for(part: &Path) -> PathBuf {
    PathBuf::from(format!("{}.meta", part.to_string_lossy()))
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct PartMeta {
    pub(crate) url: String,
    pub(crate) etag: Option<String>,
    pub(crate) last_modified: Option<String>,
}

pub(crate) async fn read_part_meta(part: &Path) -> Option<PartMeta> {
    let raw = tokio::fs::read_to_string(meta_path_for(part)).await.ok()?;
    serde_json::from_str(&raw).ok()
}

/// Persist the validators from `headers` for the staging file `part`.
/// Failures are deliberately silent: a missing sidecar only means the next
/// resume cannot send If-Range and behaves like before.
pub(crate) async fn write_part_meta(part: &Path, url: &str, headers: &reqwest::header::HeaderMap) {
    let get = |key: &str| -> Option<String> {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let meta = PartMeta {
        url: url.to_string(),
        etag: get("etag"),
        last_modified: get("last-modified"),
    };
    if let Ok(json) = serde_json::to_string(&meta) {
        let _ = tokio::fs::write(meta_path_for(part), json).await;
    }
}

/// Cleanup policy for a staging artifact: remove the .part file and its
/// validator sidecar. Both removals are best-effort and idempotent - the
/// function is safe to call on paths that were already deleted, and a
/// leftover sidecar without its .part self-heals (nothing reads a .meta
/// whose staging file is gone).
pub(crate) async fn discard_staging(part: &Path) {
    let _ = tokio::fs::remove_file(part).await;
    let _ = tokio::fs::remove_file(meta_path_for(part)).await;
}

// ---------------------------------------------------------------------------
// Resume response evaluation
// ---------------------------------------------------------------------------

/// Validate the `Content-Range` header of a single-range `206 Partial
/// Content` answer against the offset we asked to resume from.
///
/// RFC 9110 section 15.3.7: a 206 for a single range MUST carry a
/// `Content-Range: bytes N-M/T` (or `bytes N-M/*` when the total is
/// unknown). Trusting a MISSING header used to be allowed, which let a
/// broken or hostile server append bytes from an unknown offset - silent
/// corruption of the assembled file. The rules are now strict:
///   - the header MUST exist (enforced by the caller),
///   - the unit MUST be `bytes` (case-insensitive),
///   - the start N MUST equal `expected_start`,
///   - the end M MUST parse and be >= N,
///   - the total T, when present (not `*`), MUST be greater than M.
///
/// Any violation refuses the resume instead of appending to the staging
/// file; the download fails with a clear reason and the .part survives so
/// a corrected server (or a fresh start) can still recover.
///
/// On success returns the number of bytes the range promised
/// (`end - start + 1`) so the caller can verify the body actually
/// delivered that many bytes before declaring the download complete.
pub(crate) fn validate_resume_content_range(
    header: &str,
    expected_start: u64,
) -> Result<u64, String> {
    let mut parts = header.split_whitespace();
    let unit = parts
        .next()
        .ok_or_else(|| "Content-Range header is empty".to_string())?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return Err(format!("unsupported Content-Range unit \"{}\"", unit));
    }
    let range = parts
        .next()
        .ok_or_else(|| "Content-Range carries no byte range".to_string())?;
    let (range_part, total_part) = range
        .split_once('/')
        .ok_or_else(|| "Content-Range has no \"/\" separator".to_string())?;
    let (start_s, end_s) = range_part
        .split_once('-')
        .ok_or_else(|| "Content-Range range has no \"-\" separator".to_string())?;
    let start: u64 = start_s
        .parse()
        .map_err(|_| format!("Content-Range start \"{}\" is not a number", start_s))?;
    let end: u64 = end_s
        .parse()
        .map_err(|_| format!("Content-Range end \"{}\" is not a number", end_s))?;
    if start != expected_start {
        return Err(format!(
            "Server resumed at offset {} but the staging file ends at {}",
            start, expected_start
        ));
    }
    if end < start {
        return Err(format!(
            "Content-Range end {} precedes its start {}",
            end, start
        ));
    }
    if total_part != "*" {
        let total: u64 = total_part.parse().map_err(|_| {
            format!(
                "Content-Range total \"{}\" is neither a number nor *",
                total_part
            )
        })?;
        if total <= end {
            return Err(format!(
                "Content-Range total {} is not larger than its end {}",
                total, end
            ));
        }
    }
    Ok(end - start + 1)
}

/// What the caller must do with one HTTP response before any byte of the
/// body may be written to the staging file. Produced purely from the
/// response status line and headers, which makes every protocol decision
/// unit-testable without a network.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResponsePlan {
    /// 200: the server ignored the Range header (or none was sent) and is
    /// resending the whole resource. Any staging file this attempt owns is
    /// truncated and rewritten from byte 0 - appending would silently
    /// concatenate incompatible bodies.
    FullRestart,
    /// 206 with a verified Content-Range: append exactly `range_len` bytes
    /// to the staging file. `total` is the complete resource size when the
    /// server declared it (None for `bytes N-M/*`).
    AppendRange { range_len: u64, total: Option<u64> },
    /// Refuse the response AND discard the staging file: the staged bytes
    /// are proven useless against this server (HTTP 416, invalid or
    /// mismatched Content-Range). The only sound remedy is a fresh Retry.
    DiscardAndFail {
        message: String,
        kind: Option<String>,
    },
    /// Refuse the response; any staging file stays untouched (nothing
    /// proved wrong with it).
    Fail {
        message: String,
        kind: Option<String>,
    },
}

/// Turn one response's status line and `Content-Range` header into a
/// [`ResponsePlan`]. `resume_from` is the number of bytes already staged
/// (0 for a fresh download). Only 200 and 206 are accepted as body-bearing
/// success answers; every other status - including other 2xx codes like
/// 204, which carry no body and would otherwise finalize as an empty file -
/// is rejected.
pub(crate) fn evaluate_response(
    status: u16,
    content_range: Option<&str>,
    resume_from: u64,
) -> ResponsePlan {
    const RESUME_INVALID: &str = "resume-invalid";
    match status {
        200 => ResponsePlan::FullRestart,
        206 => {
            if resume_from == 0 {
                // We never asked for a range. A partial body cannot be
                // validated against any offset, so it must not be written.
                return ResponsePlan::Fail {
                    message: "Server sent partial content (HTTP 206) without a range request"
                        .to_string(),
                    kind: None,
                };
            }
            let verdict = match content_range {
                Some(h) => validate_resume_content_range(h, resume_from),
                None => Err(
                    "Server answered a partial body without Content-Range; the byte offset cannot be verified"
                        .to_string(),
                ),
            };
            match verdict {
                Ok(range_len) => {
                    let total = content_range
                        .and_then(|h| h.split_whitespace().nth(1))
                        .and_then(|r| r.split_once('/'))
                        .map(|(_, t)| t.to_string())
                        .and_then(|t| t.parse::<u64>().ok());
                    ResponsePlan::AppendRange { range_len, total }
                }
                Err(reason) => ResponsePlan::DiscardAndFail {
                    message: format!("{}; the partial download was discarded", reason),
                    kind: Some(RESUME_INVALID.to_string()),
                },
            }
        }
        416 => {
            if resume_from > 0 {
                // The byte range we hold can no longer be satisfied (the
                // remote file shrank or was replaced and the server does
                // not honor If-Range). The staging bytes are worthless.
                ResponsePlan::DiscardAndFail {
                    message: "Server reports the saved byte range is no longer valid (HTTP 416); the partial download was discarded"
                        .to_string(),
                    kind: Some(RESUME_INVALID.to_string()),
                }
            } else {
                ResponsePlan::Fail {
                    message: "Server returned HTTP 416".to_string(),
                    kind: None,
                }
            }
        }
        other => ResponsePlan::Fail {
            message: format!("Server returned HTTP {}", other),
            kind: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Digest computation vs. trusted verification
// ---------------------------------------------------------------------------

/// The outcome of judging a downloaded file's SHA-256 digest. Computing a
/// digest is a measurement; only a comparison against an independently
/// trusted expected value is verification.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verification {
    /// A trusted expected digest was supplied and matches.
    TrustedMatch,
    /// No trusted expected digest was supplied; the digest was computed but
    /// nothing was verified.
    Unverified,
    /// A trusted expected digest was supplied and does NOT match. The
    /// artifact must be treated as corrupt: never finalized, staging bytes
    /// removed, download reported as an integrity failure.
    Mismatch { computed: String, expected: String },
}

/// Compare a computed hex digest against the caller-supplied trusted value.
/// Normalization mirrors the original inline logic: surrounding whitespace
/// is ignored, an optional leading "0x" is stripped, and the comparison is
/// case-insensitive over the lowercase computed hex.
pub(crate) fn verify_digest(expected: Option<&str>, computed_hex: &str) -> Verification {
    let expected = match expected.map(str::trim).filter(|s| !s.is_empty()) {
        Some(e) => e,
        None => return Verification::Unverified,
    };
    let expected_norm = expected.trim_start_matches("0x").to_lowercase();
    if expected_norm == computed_hex {
        Verification::TrustedMatch
    } else {
        Verification::Mismatch {
            computed: computed_hex.to_string(),
            expected: expected_norm,
        }
    }
}

// ---------------------------------------------------------------------------
// No-clobber finalization
// ---------------------------------------------------------------------------

/// Upper bound for candidate names tried at finalization. Matches the bound
/// the fresh-start staging reservation uses, so a pathological directory
/// (10k collisions) fails loudly instead of overwriting candidate 9999.
pub(crate) const MAX_FINALIZE_CANDIDATES: u32 = 10_000;

/// Why a staging file could not be committed. `NoCandidateName` means every
/// candidate name was taken at commit time; `Io` is a genuine filesystem
/// error (not a filename collision) and is reported to the user verbatim.
#[derive(Debug)]
pub(crate) enum FinalizeError {
    NoCandidateName,
    Io(io::Error),
}

impl FinalizeError {
    pub(crate) fn message(&self) -> String {
        match self {
            FinalizeError::NoCandidateName => {
                "every candidate filename is already taken".to_string()
            }
            FinalizeError::Io(e) => e.to_string(),
        }
    }
}

enum CommitAttempt {
    Committed,
    /// The destination name is taken by another file; try the next
    /// candidate. Never an error: concurrent downloads of the same name are
    /// expected and each gets its own copy.
    Collision,
    /// A filesystem error that is not a filename collision.
    Failed(io::Error),
}

/// Filesystem conditions under which a hard link is simply unavailable and
/// the reservation+copy fallback should be tried: cross-device staging
/// (should not happen - staging lives next to the destination - but is not
/// impossible with exotic mounts), link-unsafe filesystems (FAT/exFAT,
/// certain FUSE and network mounts), and permission shapes where the
/// reservation attempt produces the honest error.
fn link_refused(e: &io::Error) -> bool {
    match e.kind() {
        io::ErrorKind::PermissionDenied
        | io::ErrorKind::CrossesDevices
        | io::ErrorKind::Unsupported
        | io::ErrorKind::InvalidInput => return true,
        _ => {}
    }
    #[cfg(unix)]
    {
        // EPERM, EMLINK, EACCES, EXDEV, EROFS, ENOSYS, EOPNOTSUPP
        matches!(e.raw_os_error(), Some(1 | 2 | 13 | 18 | 30 | 38 | 95))
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_FUNCTION, ERROR_ACCESS_DENIED,
        // ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED
        matches!(e.raw_os_error(), Some(1 | 5 | 17 | 50))
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Commit the staging file onto `dest` without ever replacing an existing
/// file, using one atomic kernel operation.
///
/// Primary path: `hard_link` (link(2) / CreateHardLinkW). Both interfaces
/// FAIL when the target name exists - the existence check and the creation
/// are a single atomic operation, so there is no check-then-rename window
/// in which a concurrent finalization could be overwritten. The staging
/// file is always created in the destination directory (see part_path_for),
/// so the link is same-volume by construction. After the link succeeds the
/// destination holds the complete bytes and the staging name is unlinked
/// (best-effort: a leftover .part self-heals on any later resume).
///
/// Fallback path (see link_refused): reserve the destination name with
/// `create_new` - also atomic - and copy the bytes into the reservation.
///
/// Returns the exact committed destination path.
async fn commit_candidate(part: &Path, dest: &Path) -> CommitAttempt {
    match tokio::fs::hard_link(part, dest).await {
        Ok(()) => {
            // The staging name has served its purpose; a failure to unlink
            // it is harmless (see the module cleanup policy).
            let _ = tokio::fs::remove_file(part).await;
            CommitAttempt::Committed
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => CommitAttempt::Collision,
        Err(e) if link_refused(&e) => match commit_via_reservation(part, dest).await {
            Ok(()) => CommitAttempt::Committed,
            Err(ReservationError::Collision) => CommitAttempt::Collision,
            Err(ReservationError::Io(e)) => CommitAttempt::Failed(e),
        },
        Err(e) => CommitAttempt::Failed(e),
    }
}

enum ReservationError {
    Collision,
    Io(io::Error),
}

impl std::fmt::Debug for ReservationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReservationError::Collision => write!(f, "Collision"),
            ReservationError::Io(e) => write!(f, "Io({})", e),
        }
    }
}

/// Fallback commit for filesystems that refuse hard links: reserve the
/// name with an exclusive create (atomic, fails with AlreadyExists when
/// taken), copy the staging bytes in, sync, then unlink the staging file.
/// A failure at any point removes the reservation and leaves the staging
/// file untouched for a retry.
async fn commit_via_reservation(part: &Path, dest: &Path) -> Result<(), ReservationError> {
    use ReservationError::*;
    let mut out = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .await
    {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(Collision),
        Err(e) => return Err(Io(e)),
    };
    let result = async {
        let mut src = tokio::fs::File::open(part).await?;
        tokio::io::copy(&mut src, &mut out).await?;
        out.flush().await?;
        out.sync_all().await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        // Release the reserved name: a half-copied file must never sit at
        // the destination looking finished.
        let _ = tokio::fs::remove_file(dest).await;
        return Err(Io(e));
    }
    drop(out);
    let _ = tokio::fs::remove_file(part).await;
    Ok(())
}

/// Move a finished staging file to its destination without clobbering.
///
/// Tries candidate names starting at `name` ("name", "name (1).ext", ...)
/// up to [`MAX_FINALIZE_CANDIDATES`]. For each candidate the commit itself
/// is atomic (see [`commit_candidate`]), so:
///
/// - an existing file is never overwritten, whatever the interleaving of
///   concurrent finalizations;
/// - two downloads racing on the same filename each get their own name;
/// - a filesystem error (disk full, permission denied, directory gone) is
///   reported as [`FinalizeError::Io`] and never mistaken for a collision;
/// - on success the validator sidecar is removed and the exact committed
///   path is returned.
pub(crate) async fn commit_no_clobber(
    part: &Path,
    dir: &Path,
    name: &str,
) -> Result<PathBuf, FinalizeError> {
    commit_no_clobber_limited(part, dir, name, MAX_FINALIZE_CANDIDATES).await
}

pub(crate) async fn commit_no_clobber_limited(
    part: &Path,
    dir: &Path,
    name: &str,
    max_candidates: u32,
) -> Result<PathBuf, FinalizeError> {
    for i in 0..max_candidates {
        let candidate_name = numbered_name(name, i);
        let dest = dir.join(&candidate_name);
        match commit_candidate(part, &dest).await {
            CommitAttempt::Committed => {
                // The staging file is gone; its validator sidecar has no
                // reason to outlive it.
                let _ = tokio::fs::remove_file(meta_path_for(part)).await;
                return Ok(dest);
            }
            CommitAttempt::Collision => continue,
            CommitAttempt::Failed(e) => return Err(FinalizeError::Io(e)),
        }
    }
    Err(FinalizeError::NoCandidateName)
}

// ---------------------------------------------------------------------------
// Download engine
// ---------------------------------------------------------------------------

/// Event outlet the engine reports through. The Tauri layer maps these to
/// the `download-progress` / `download-retrying` events; tests collect
/// them in memory. Keeping emission behind this trait is what makes the
/// whole engine runnable without an AppHandle.
pub(crate) trait ProgressSink: Send + Sync {
    fn progress(&self, payload: ProgressPayload);
    fn retrying(&self, payload: RetryPayload);
}

/// HTTP client configuration for the download stream.
///
/// NOTE: the policy knobs here (user agent, connect timeout, redirect
/// limit, and deliberately NO whole-request timeout) are the download
/// client configuration owned by Agent 1 - they were moved here verbatim
/// from `run_download` in lib.rs. Coordinate any policy changes with that
/// ownership split; the engine itself only relies on the absence of a
/// whole-request timeout (the stream loop enforces its own 60s stall rule)
/// and on redirect following.
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!(
            "Fress/{} (+https://github.com/WasewaseX/Fress)",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())
}

/// Everything one download attempt needs, bundled so the runner keeps a
/// readable signature and new knobs don't grow the parameter list forever.
#[derive(Clone)]
pub(crate) struct DownloadPlan {
    pub(crate) url: String,
    pub(crate) requested_name: Option<String>,
    pub(crate) dir: PathBuf,
    pub(crate) resume: bool,
    pub(crate) expected_sha256: Option<String>,
    /// Exact staging (.part) path opened by the PREVIOUS attempt of this
    /// download chain. Set by the retry loop so an automatic retry reopens
    /// its own file instead of re-deriving a candidate name; None on a
    /// fresh start_download call.
    pub(crate) staging: Option<PathBuf>,
}

/// Stream the resource into a staging file and, on success, commit it to
/// the destination. One attempt only: retry orchestration lives in
/// [`execute_with_retries`].
///
/// Error kinds returned in the `(message, kind)` pair:
/// - `Some("network")` - transient, the retry loop may re-attempt;
/// - `Some("checksum")` / `Some("resume-invalid")` - final, staging bytes
///   were discarded, never retried automatically;
/// - `None` - final (disk, protocol, or server-status errors);
/// - the [`CANCEL_SENTINEL`] message - cancelled, staging bytes kept.
pub(crate) async fn run_download<E: ProgressSink>(
    events: &E,
    session: &DownloadSession,
    id: u32,
    plan: DownloadPlan,
    cancel_rx: &mut mpsc::Receiver<()>,
    staging_out: &mut Option<PathBuf>,
) -> Result<CompletePayload, (String, Option<String>)> {
    let DownloadPlan {
        url,
        requested_name,
        dir,
        resume,
        expected_sha256,
        staging,
    } = plan;
    // The out-param describes THIS attempt only.
    *staging_out = None;

    let client = download_client().map_err(|e| (e, None))?;

    // Resolve the resume target BEFORE the first request, in priority order:
    //   1. the exact staging file the previous attempt of this download
    //      chain opened (an automatic in-task retry),
    //   2. the canonical <name>.part for the requested name (a deliberate
    //      stop + manual Resume: the first attempt of a download always
    //      reserves candidate 0's .part through create_new, so the mapping
    //      name -> name.part is the ownership record itself).
    // The candidate search must NOT skip taken FINAL names: when e.g.
    // setup.exe already exists on disk a resumed download would drift onto
    // "setup (1).exe.part" - possibly a concurrent download's staging file -
    // instead of its own .part.
    let mut planned_resume_len: u64 = 0;
    let mut resume_paths: Option<(PathBuf, PathBuf)> = None; // (dest, part)
                                                             // HTTP validator (ETag / Last-Modified) the origin served the staged
                                                             // bytes with, carried into an If-Range header on the resume request.
    let mut resume_validator: Option<String> = None;
    if resume {
        let probe: Option<PathBuf> = match staging.as_ref() {
            Some(p) => Some(p.clone()),
            None => requested_name
                .as_ref()
                .map(|name| part_path_for(&dir.join(name))),
        };
        if let Some(p) = probe {
            if let Ok(meta) = tokio::fs::metadata(&p).await {
                if let Some(dest) = dest_for_part(&p) {
                    planned_resume_len = meta.len();
                    resume_paths = Some((dest, p.clone()));
                }
            }
            // The validator is only meaningful for the same resource the
            // staging bytes came from: an ETag belongs to one URL, and
            // reusing it against a different download target would compare
            // unrelated identities.
            if let Some(m) = read_part_meta(&p).await {
                if m.url == url {
                    resume_validator = m.etag.or(m.last_modified);
                }
            }
            // Byte-identity rule: staging bytes may only be resumed when
            // their origin can still be PROVEN. With neither ETag nor
            // Last-Modified in the sidecar (a validator-less server), a
            // Range request would glue an old prefix onto a possibly
            // changed remote suffix with nothing able to detect it -
            // exactly the corruption the validator system exists to
            // prevent. Unless a published checksum will verify the
            // assembled file anyway (expected_sha256, which catches the
            // mixture at completion), the only sound move is to discard
            // the staging bytes and start over.
            let checksum_will_verify = expected_sha256
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_some();
            if planned_resume_len > 0 && resume_validator.is_none() && !checksum_will_verify {
                discard_staging(&p).await;
                planned_resume_len = 0;
                resume_paths = None;
            }
            // A missing staging file (deleted while stopped, or a stale path
            // carried past its lifetime) simply falls through to a fresh
            // download below, exactly like a resume without a .part.
        }
    }

    let mut request = client.get(&url);
    if planned_resume_len > 0 {
        request = request.header(
            reqwest::header::RANGE,
            format!("bytes={}-", planned_resume_len),
        );
        // If-Range makes a changed remote file answer with a plain 200
        // (full body) instead of a 206 tail - the 200 path below already
        // truncates the staging file and restarts in place. Without the
        // header, a replaced file would be silently glued together from an
        // old prefix and a new suffix.
        if let Some(v) = &resume_validator {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(v) {
                request = request.header(reqwest::header::IF_RANGE, value);
            }
        }
    }
    let first = request.send().await.map_err(|e| {
        (
            format!("Connection failed: {}", e),
            Some("network".to_string()),
        )
    })?;

    // Protocol gate: only 200 (full body) and 206 (verified range) are
    // acceptable answers. Everything else - other 2xx codes without a
    // body, 4xx, 5xx - fails the attempt; a 416 on a resume discards the
    // staging bytes. No byte is written before this gate passes.
    let content_range_header = first
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let response_plan = evaluate_response(
        first.status().as_u16(),
        content_range_header.as_deref(),
        planned_resume_len,
    );
    let (resuming, expected_range_len, range_total) = match response_plan {
        ResponsePlan::FullRestart => (false, None, None),
        ResponsePlan::AppendRange { range_len, total } => (true, Some(range_len), total),
        ResponsePlan::DiscardAndFail { message, kind } => {
            // The staging bytes are proven useless against this server.
            if let Some((_, p)) = resume_paths.as_ref() {
                discard_staging(p).await;
            }
            return Err((message, kind));
        }
        ResponsePlan::Fail { message, kind } => {
            return Err((message, kind));
        }
    };
    let already_have = if resuming { planned_resume_len } else { 0 };

    let headers = first.headers().clone();
    let final_url = first.url().clone();
    let remote_len = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let name = requested_name
        .or_else(|| filename_from_headers(&final_url, &headers))
        .unwrap_or_else(|| format!("fress-download-{}.bin", id));

    // Staging-file ownership. Two downloads racing on the same filename must
    // never share one .part: both used to observe "setup.exe is free", both
    // picked setup.exe.part, and both streamed bytes into the same staging
    // file (batch downloads made this reachable). `create_new` is an atomic
    // reservation - the winner keeps the name, the loser moves on to
    // "name (1).part". The final filename is only claimed by the commit at
    // completion, so nothing half-written ever looks finished.
    let (dest, part, mut file) = if let Some((candidate, p)) = resume_paths.as_ref() {
        // Continuing our own staging file, resolved above from the exact
        // path this chain owns. The server honored the Range (206): append
        // to what we already have. It ignored the range and resends the
        // whole body (200): truncate the same staging file and restart in
        // place. Either way the file is ours - never a neighbor candidate's.
        let f = if resuming {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(p)
                .await
                .map_err(|e| (format!("Cannot reopen partial download: {}", e), None))?
        } else {
            tokio::fs::File::create(p)
                .await
                .map_err(|e| (format!("Cannot write file: {}", e), None))?
        };
        (candidate.clone(), p.clone(), f)
    } else {
        // Fresh download: atomically reserve a staging file for ourselves.
        let mut reserved: Option<(PathBuf, PathBuf, tokio::fs::File)> = None;
        for i in 0..10_000u32 {
            let candidate = dir.join(numbered_name(&name, i));
            let p = part_path_for(&candidate);
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&p)
                .await
            {
                Ok(f) => {
                    reserved = Some((candidate, p, f));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err((format!("Cannot write file: {}", e), None)),
            }
        }
        reserved.ok_or_else(|| {
            (
                "Could not reserve a staging file for the download".to_string(),
                None,
            )
        })?
    };
    // From here on this attempt owns `part`; record it so an automatic retry
    // continues this exact file (see the staging carry in execute_with_retries).
    *staging_out = Some(part.clone());

    // Persist the origin's validators for the resume path. On a 200 restart
    // the previously stored validators are stale by definition - the fresh
    // response's overwrite them. On a 206 they should be identical, and on a
    // fresh download the sidecar is created for the first time.
    write_part_meta(&part, &url, &headers).await;

    let mut hasher = Sha256::new();
    // Seed the digest with the bytes from the earlier attempt so the final
    // hash covers the complete file, not just the resumed tail.
    if resuming {
        let mut existing = tokio::fs::File::open(&part)
            .await
            .map_err(|e| (format!("Cannot read partial download: {}", e), None))?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = existing
                .read(&mut buf)
                .await
                .map_err(|e| (format!("Cannot read partial download: {}", e), None))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }

    let mut stream = first.bytes_stream();
    let mut downloaded: u64 = already_have;
    let total = if remote_len > 0 {
        remote_len + already_have
    } else if resuming {
        range_total.unwrap_or(0)
    } else {
        0
    };
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    // Rolling samples for a truthful CURRENT speed. The old number was the
    // average since the download started, so after any stall or auto-resume
    // it stayed pinned near the early peak and the ETA looked stuck.
    let mut speed_samples: Vec<(Instant, u64)> = Vec::with_capacity(40);
    const SPEED_WINDOW: Duration = Duration::from_secs(4);

    while let Some(chunk) = tokio::select! {
        biased;
        _ = cancel_rx.recv() => {
            // Deliberate stop: keep the .part file so the user can resume
            // instead of restarting from zero.
            drop(file);
            let _ = session.advance(DownloadState::Cancelled).await;
            return Err((CANCEL_SENTINEL.to_string(), None));
        }
        chunk = tokio::time::timeout(Duration::from_secs(60), stream.next()) => {
            match chunk {
                Ok(c) => c,
                Err(_) => {
                    // No bytes for a full minute: treat the connection as
                    // dead. The .part stays on disk for the Resume button.
                    drop(file);
                    return Err((
                        "Connection stalled (no data for 60s)".to_string(),
                        Some("network".to_string()),
                    ));
                }
            }
        }
    } {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                drop(file);
                return Err((
                    format!("Download interrupted: {}", e),
                    Some("network".to_string()),
                ));
            }
        };
        hasher.update(&bytes);
        if file.write_all(&bytes).await.is_err() {
            drop(file);
            return Err(("Disk write failed".to_string(), None));
        }
        downloaded += bytes.len() as u64;

        // Emit progress at most ~10x per second
        if last_emit.elapsed() >= Duration::from_millis(100) {
            speed_samples.retain(|(t, _)| t.elapsed() < SPEED_WINDOW);
            speed_samples.push((Instant::now(), downloaded));
            let speed = if let Some((oldest_t, oldest_b)) = speed_samples.first() {
                let dt = oldest_t.elapsed().as_secs_f64();
                if dt > 0.05 {
                    (downloaded.saturating_sub(*oldest_b)) as f64 / dt
                } else {
                    0.0
                }
            } else {
                0.0
            };
            let eta = if total > downloaded && speed > 0.0 {
                (total - downloaded) as f64 / speed
            } else {
                0.0
            };
            events.progress(ProgressPayload {
                id,
                downloaded,
                total,
                speed_bps: speed,
                eta_secs: eta,
            });
            last_emit = Instant::now();
        }
    }

    // Last cancellation checkpoint. The biased select above observes a
    // cancel while streaming; a signal that arrived while the final chunk
    // was being processed is drained HERE, before any completion decision.
    // Past this point the transfer keeps running to a terminal state (see
    // the module invariants).
    if cancel_rx.try_recv().is_ok() {
        drop(file);
        let _ = session.advance(DownloadState::Cancelled).await;
        return Err((CANCEL_SENTINEL.to_string(), None));
    }

    file.flush().await.map_err(|e| (e.to_string(), None))?;
    // Durability: the bytes reach the disk before the file is committed
    // under its final name, so a power cut cannot leave a truncated file
    // behind a completed-looking name.
    file.sync_all().await.map_err(|e| (e.to_string(), None))?;
    drop(file);

    // EOF is not completion: a connection that closed early used to look
    // exactly like a finished download ("server said 10MB, delivered 7MB,
    // Fress said done"). Compare what arrived against what the response
    // promised - the Content-Range tail for a 206, the Content-Length for
    // a full 200 body - and refuse to finalize a truncated file. The
    // .part survives so Resume can fetch exactly the missing bytes.
    let expected_downloaded: Option<u64> = match expected_range_len {
        Some(range_len) => Some(already_have + range_len),
        // No verifiable range: fall back to Content-Length on a full-body
        // 200. A chunked 200 without Content-Length cannot be checked.
        None if !resuming && remote_len > 0 => Some(remote_len),
        None => None,
    };
    if let Some(expected) = expected_downloaded {
        if downloaded != expected {
            let detail = if downloaded < expected {
                format!(
                    "Download cut short: received {} of {} bytes before the connection closed. The missing bytes are fetched automatically.",
                    downloaded, expected
                )
            } else {
                format!(
                    "Server sent {} bytes although it announced {}; the download was not committed.",
                    downloaded, expected
                )
            };
            return Err((detail, Some("network".to_string())));
        }
    }
    // A server MAY answer a range request with a shorter subrange than it
    // promised to serve (RFC 9110 15.3.7.2); treating that tail as complete
    // would finalize a truncated file. When the total resource size is
    // known and what arrived is less, keep resuming instead.
    let full_size: Option<u64> = if resuming {
        range_total.or_else(|| remote_len.checked_add(already_have))
    } else if remote_len > 0 {
        Some(remote_len)
    } else {
        None
    };
    if let Some(full) = full_size {
        if downloaded < full {
            return Err((
                format!(
                    "Server delivered {} of {} bytes; the remaining bytes are fetched automatically.",
                    downloaded, full
                ),
                Some("network".to_string()),
            ));
        }
    }

    // The received byte count is now proven complete against everything
    // the response promised. What remains - digest comparison and the
    // final commit - is the Verifying phase: short and non-retryable, so
    // the transition happens only here, after every retryable outcome has
    // been decided.
    if session.advance(DownloadState::Verifying).await.is_err() {
        // Unreachable by construction (only this task writes its state),
        // but a broken transition must never yield a "completed" claim.
        session.settle(DownloadState::Failed).await;
        return Err((
            "Download state became inconsistent; the file was not committed".to_string(),
            None,
        ));
    }

    let digest = hasher.finalize();
    let sha_hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();

    // Verification is a comparison against a trusted published value, not a
    // mere calculation. A mismatching file is rejected and removed: it must
    // never sit in the downloads folder looking finished.
    let verified: Option<bool> = match verify_digest(expected_sha256.as_deref(), &sha_hex) {
        Verification::TrustedMatch => Some(true),
        Verification::Unverified => None,
        Verification::Mismatch { computed, expected } => {
            discard_staging(&part).await;
            return Err((
                format!(
                    "Integrity check failed: the file hashes to {} but the publisher published {}. It was deleted. Re-download from the official source.",
                    computed, expected
                ),
                Some("checksum".to_string()),
            ));
        }
    };

    // Only now does the file appear under its real name - through an atomic
    // no-clobber commit, never a plain rename: rename silently replaces on
    // every platform, so two downloads finalizing the same name could
    // destroy each other's completed file. A collision picks the next
    // candidate name; the commit starts from the name this attempt's
    // staging file was reserved for.
    let final_name = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.clone());
    let committed = match commit_no_clobber(&part, &dir, &final_name).await {
        Ok(p) => p,
        Err(e) => {
            return Err((
                format!("Cannot finalize the download: {}", e.message()),
                None,
            ));
        }
    };

    if session.advance(DownloadState::Completed).await.is_err() {
        // The file IS committed; report the truth even if the state book-
        // keeping somehow disagrees (defensive, unreachable).
        session.settle(DownloadState::Completed).await;
    }

    Ok(CompletePayload {
        id,
        path: committed.to_string_lossy().to_string(),
        bytes: downloaded,
        sha256: sha_hex,
        verified,
    })
}

/// Runs one download through its automatic retry loop and drives the
/// lifecycle state machine around it.
///
/// Transient failures (`kind == "network"`) are retried automatically:
/// the .part file is already on disk, so a resume costs nothing and most
/// Wi-Fi/VPN blips heal within seconds. Deliberate cancels, checksum
/// failures, resume-invalid answers and other final errors are never
/// retried. `backoff` is the base wait before attempt N (scaled by the
/// attempt count); production uses 2s, tests pass a tiny duration.
pub(crate) async fn execute_with_retries<E: ProgressSink>(
    events: &E,
    session: &DownloadSession,
    id: u32,
    mut plan: DownloadPlan,
    mut cancel_rx: mpsc::Receiver<()>,
    backoff: Duration,
) -> Result<CompletePayload, (String, Option<String>)> {
    const MAX_AUTO_RETRIES: u32 = 2;
    let mut attempt: u32 = 0;
    // The staging file the last attempt opened, if any. An automatic
    // retry continues THAT exact file instead of re-deriving a candidate
    // name (which can drift onto a concurrent download's .part).
    let mut resolved_staging: Option<PathBuf> = None;
    loop {
        // (Re)enter the streaming phase: Queued -> Downloading on the
        // first pass, Retrying -> Downloading on every automatic retry.
        if session.advance(DownloadState::Downloading).await.is_err() {
            session.settle(DownloadState::Failed).await;
            return Err((
                "Download state became inconsistent; the download was stopped".to_string(),
                None,
            ));
        }
        match run_download(
            events,
            session,
            id,
            plan.clone(),
            &mut cancel_rx,
            &mut resolved_staging,
        )
        .await
        {
            Err((msg, kind))
                if kind.as_deref() == Some("network") && attempt < MAX_AUTO_RETRIES =>
            {
                attempt += 1;
                plan.resume = true; // pick up from the .part file
                plan.staging = resolved_staging.clone(); // ...the exact one we opened
                let _ = session.advance(DownloadState::Retrying).await;
                // Cancellable backoff: a cancel during the wait must not be
                // answered by yet another attempt on the same staging file.
                tokio::select! {
                    biased;
                    _ = cancel_rx.recv() => {
                        let _ = session.advance(DownloadState::Cancelled).await;
                        return Err((CANCEL_SENTINEL.to_string(), None));
                    }
                    _ = tokio::time::sleep(backoff.saturating_mul(attempt)) => {}
                }
                events.retrying(RetryPayload {
                    id,
                    attempt,
                    message: msg,
                });
            }
            Err((msg, kind)) => {
                if msg != CANCEL_SENTINEL {
                    // Final failure. run_download leaves terminal
                    // bookkeeping to this loop for network errors (the
                    // retry decision lives here); checksum, protocol and
                    // disk errors are decided inside run_download but
                    // must never stay active either way. settle() is a
                    // no-op when the state is already terminal, so a
                    // failed download can never remain in the active set
                    // in a non-terminal state.
                    session.settle(DownloadState::Failed).await;
                }
                return Err((msg, kind));
            }
            Ok(payload) => return Ok(payload),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Everything here is deterministic: temporary directories under the OS temp
// dir, a local mock HTTP server on 127.0.0.1 (never a public endpoint), and
// scripted responses. Cancellation, truncation and collisions are exercised
// through the same public entry points the Tauri layer uses.

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Mutex as StdMutex;

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /// Self-cleaning temporary directory for filesystem tests.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "fress-engine-test-{}-{}-{}",
                tag,
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn plan_for(url: &str, dir: &Path, name: Option<&str>) -> DownloadPlan {
        DownloadPlan {
            url: url.to_string(),
            requested_name: name.map(str::to_string),
            dir: dir.to_path_buf(),
            resume: false,
            expected_sha256: None,
            staging: None,
        }
    }

    /// A registry + session + cancel receiver, like the Tauri layer would
    /// create for one download.
    async fn test_session() -> (DownloadSession, mpsc::Receiver<()>) {
        let registry = Arc::new(DownloadRegistry::default());
        let (id, rx) = registry.register().await;
        (DownloadSession::new(registry, id), rx)
    }

    #[derive(Default)]
    struct EventLog {
        progress: StdMutex<Vec<ProgressPayload>>,
        retries: StdMutex<Vec<RetryPayload>>,
    }

    impl ProgressSink for EventLog {
        fn progress(&self, payload: ProgressPayload) {
            self.progress.lock().unwrap().push(payload);
        }
        fn retrying(&self, payload: RetryPayload) {
            self.retries.lock().unwrap().push(payload);
        }
    }

    /// Deterministic pseudo payload: every byte position has a stable value.
    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    async fn write_file(path: &Path, bytes: &[u8]) {
        tokio::fs::write(path, bytes)
            .await
            .expect("write test file");
    }

    async fn seed_staging(part: &Path, url: &str, etag: Option<&str>, bytes: &[u8]) {
        write_file(part, bytes).await;
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(tag) = etag {
            headers.insert("etag", tag.parse().expect("etag value"));
        }
        write_part_meta(part, url, &headers).await;
    }

    // -----------------------------------------------------------------------
    // Content-Range validation (moved from lib.rs with its original tests)
    // -----------------------------------------------------------------------

    #[test]
    fn accepts_a_well_formed_range_at_the_right_offset() {
        // bytes 1024-2047 promises 2047 - 1024 + 1 = 1024 bytes.
        assert_eq!(
            validate_resume_content_range("bytes 1024-2047/8192", 1024),
            Ok(1024)
        );
    }

    #[test]
    fn accepts_a_case_insensitive_unit() {
        assert_eq!(
            validate_resume_content_range("BYTES 1024-2047/8192", 1024),
            Ok(1024)
        );
    }

    #[test]
    fn accepts_an_unknown_total() {
        // RFC 9110: the complete-length may be "*" when unknown.
        assert_eq!(validate_resume_content_range("bytes 0-0/*", 0), Ok(1));
    }

    #[test]
    fn accepts_a_single_byte_range() {
        assert_eq!(
            validate_resume_content_range("bytes 4095-4095/8192", 4095),
            Ok(1)
        );
    }

    #[test]
    fn rejects_a_missing_range_after_the_unit() {
        assert!(validate_resume_content_range("bytes", 1024).is_err());
    }

    #[test]
    fn rejects_an_empty_header() {
        assert!(validate_resume_content_range("", 1024).is_err());
    }

    #[test]
    fn rejects_a_wrong_unit() {
        assert!(validate_resume_content_range("items 1024-2047/8192", 1024).is_err());
    }

    #[test]
    fn rejects_a_wrong_start_offset() {
        // The exact corruption case: bytes appended from anywhere else.
        assert!(validate_resume_content_range("bytes 512-2047/8192", 1024).is_err());
    }

    #[test]
    fn rejects_a_missing_separator() {
        assert!(validate_resume_content_range("bytes 1024/8192", 1024).is_err());
        assert!(validate_resume_content_range("bytes 1024-2047", 1024).is_err());
    }

    #[test]
    fn rejects_non_numeric_boundaries() {
        assert!(validate_resume_content_range("bytes abc-2047/8192", 1024).is_err());
        assert!(validate_resume_content_range("bytes 1024-xyz/8192", 1024).is_err());
        assert!(validate_resume_content_range("bytes */8192", 1024).is_err()); // 416 shape, never valid on 206
    }

    #[test]
    fn rejects_an_end_before_the_start() {
        assert!(validate_resume_content_range("bytes 1024-512/8192", 1024).is_err());
    }

    #[test]
    fn rejects_a_total_not_larger_than_the_end() {
        assert!(validate_resume_content_range("bytes 1024-2047/2047", 1024).is_err());
        assert!(validate_resume_content_range("bytes 1024-2047/0", 1024).is_err());
    }

    // -----------------------------------------------------------------------
    // Response evaluation matrix
    // -----------------------------------------------------------------------

    #[test]
    fn evaluate_fresh_200_is_a_full_body() {
        assert_eq!(evaluate_response(200, None, 0), ResponsePlan::FullRestart);
    }

    #[test]
    fn evaluate_resume_200_restarts_instead_of_appending() {
        // The server ignored Range (or If-Range no longer matches): the
        // staged bytes must be replaced, never concatenated with the body.
        assert_eq!(
            evaluate_response(200, None, 4096),
            ResponsePlan::FullRestart
        );
    }

    #[test]
    fn evaluate_valid_206_append_with_total() {
        assert_eq!(
            evaluate_response(206, Some("bytes 4096-8191/8192"), 4096),
            ResponsePlan::AppendRange {
                range_len: 4096,
                total: Some(8192)
            }
        );
    }

    #[test]
    fn evaluate_valid_206_append_with_unknown_total() {
        assert_eq!(
            evaluate_response(206, Some("bytes 10-19/*"), 10),
            ResponsePlan::AppendRange {
                range_len: 10,
                total: None
            }
        );
    }

    #[test]
    fn evaluate_206_without_a_range_request_is_rejected() {
        // A 206 cannot be verified against any offset when nothing was staged.
        match evaluate_response(206, Some("bytes 0-9/10"), 0) {
            ResponsePlan::Fail { message, kind } => {
                assert!(message.contains("without a range request"));
                assert_eq!(kind, None);
            }
            other => panic!("expected Fail, got {:?}", other),
        }
    }

    #[test]
    fn evaluate_206_missing_content_range_discards_staging() {
        match evaluate_response(206, None, 512) {
            ResponsePlan::DiscardAndFail { message, kind } => {
                assert!(message.contains("without Content-Range"));
                assert_eq!(kind.as_deref(), Some("resume-invalid"));
            }
            other => panic!("expected DiscardAndFail, got {:?}", other),
        }
    }

    #[test]
    fn evaluate_206_mismatched_start_discards_staging() {
        match evaluate_response(206, Some("bytes 100-199/1000"), 512) {
            ResponsePlan::DiscardAndFail { kind, .. } => {
                assert_eq!(kind.as_deref(), Some("resume-invalid"));
            }
            other => panic!("expected DiscardAndFail, got {:?}", other),
        }
    }

    #[test]
    fn evaluate_206_malformed_header_discards_staging() {
        for header in ["garbage", "bytes 100/1000", "items 100-199/1000"] {
            match evaluate_response(206, Some(header), 100) {
                ResponsePlan::DiscardAndFail { kind, .. } => {
                    assert_eq!(kind.as_deref(), Some("resume-invalid"));
                }
                other => panic!("expected DiscardAndFail for {:?}, got {:?}", header, other),
            }
        }
    }

    #[test]
    fn evaluate_416_on_a_resume_discards_staging() {
        match evaluate_response(416, None, 4096) {
            ResponsePlan::DiscardAndFail { message, kind } => {
                assert!(message.contains("HTTP 416"));
                assert_eq!(kind.as_deref(), Some("resume-invalid"));
            }
            other => panic!("expected DiscardAndFail, got {:?}", other),
        }
    }

    #[test]
    fn evaluate_416_without_a_resume_is_a_plain_failure() {
        match evaluate_response(416, None, 0) {
            ResponsePlan::Fail { message, kind } => {
                assert_eq!(message, "Server returned HTTP 416");
                assert_eq!(kind, None);
            }
            other => panic!("expected Fail, got {:?}", other),
        }
    }

    #[test]
    fn evaluate_only_200_and_206_are_accepted() {
        // 204 carries no body: without this gate it would finalize an
        // empty file. Every other status must fail as well.
        for status in [201, 202, 203, 204, 205, 226, 301, 302, 403, 404, 500, 503] {
            match evaluate_response(status, None, 0) {
                ResponsePlan::Fail { message, kind } => {
                    assert_eq!(message, format!("Server returned HTTP {}", status));
                    assert_eq!(kind, None);
                }
                other => panic!("expected Fail for {}, got {:?}", status, other),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Digest verification semantics
    // -----------------------------------------------------------------------

    #[test]
    fn digest_without_expected_value_is_unverified_not_verified() {
        // The core semantics rule: a computed digest is not a verification.
        assert_eq!(verify_digest(None, "abcd"), Verification::Unverified);
        assert_eq!(verify_digest(Some("  "), "abcd"), Verification::Unverified);
        assert_eq!(verify_digest(Some(""), "abcd"), Verification::Unverified);
    }

    #[test]
    fn digest_matching_expected_is_a_trusted_match() {
        let hex = sha256_hex(b"payload");
        assert_eq!(verify_digest(Some(&hex), &hex), Verification::TrustedMatch);
        // normalization: 0x prefix, uppercase, surrounding whitespace
        let shouty = format!("  0x{}  ", hex.to_uppercase());
        assert_eq!(
            verify_digest(Some(&shouty), &hex),
            Verification::TrustedMatch
        );
    }

    #[test]
    fn digest_mismatch_carries_both_values() {
        match verify_digest(Some("AAAA"), "bbbb") {
            Verification::Mismatch { computed, expected } => {
                assert_eq!(computed, "bbbb");
                assert_eq!(expected, "aaaa");
            }
            other => panic!("expected Mismatch, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // State machine transition table
    // -----------------------------------------------------------------------

    fn allowed_transitions() -> Vec<(DownloadState, DownloadState)> {
        use DownloadState::*;
        vec![
            (Queued, Downloading),
            (Queued, Cancelled),
            (Downloading, Verifying),
            (Downloading, Retrying),
            (Downloading, Failed),
            (Downloading, Cancelled),
            (Retrying, Downloading),
            (Retrying, Failed),
            (Retrying, Cancelled),
            (Verifying, Completed),
            (Verifying, Failed),
        ]
    }

    #[test]
    fn state_machine_accepts_exactly_the_documented_edges() {
        use DownloadState::*;
        let all = [
            Queued,
            Downloading,
            Retrying,
            Verifying,
            Completed,
            Failed,
            Cancelled,
        ];
        for from in all {
            for to in all {
                let allowed = allowed_transitions().contains(&(from, to));
                assert_eq!(
                    from.can_transition_to(to),
                    allowed,
                    "{:?} -> {:?} disagrees with the table",
                    from,
                    to
                );
            }
        }
    }

    #[test]
    fn terminal_states_have_no_exits() {
        use DownloadState::*;
        for terminal in [Completed, Failed, Cancelled] {
            assert!(terminal.is_terminal());
            for to in [
                Queued,
                Downloading,
                Retrying,
                Verifying,
                Completed,
                Failed,
                Cancelled,
            ] {
                assert!(
                    !terminal.can_transition_to(to),
                    "terminal {:?} must not transition to {:?}",
                    terminal,
                    to
                );
            }
        }
    }

    #[test]
    fn session_rejects_illegal_transitions_and_absorbs_terminals() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            use DownloadState::*;
            let (session, _rx) = test_session().await;
            assert_eq!(session.snapshot().await, Some(Queued));
            // Verifying straight from Queued skips three states: rejected.
            assert!(session.advance(Verifying).await.is_err());
            // A defensive settle never resurrects or overwrites terminals.
            session.settle(Completed).await;
            assert_eq!(session.snapshot().await, Some(Completed));
            session.settle(Failed).await;
            assert_eq!(session.snapshot().await, Some(Completed));
            // Release is idempotent and empties the snapshot.
            session.release().await;
            assert_eq!(session.snapshot().await, None);
            session.release().await;
        });
    }

    #[test]
    fn registry_cancel_signal_reaches_the_download() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let registry = Arc::new(DownloadRegistry::default());
            let (id, mut rx) = registry.register().await;
            registry.request_cancel(id).await;
            // A second request is dropped without error (channel is full).
            registry.request_cancel(id).await;
            registry.request_cancel(999).await; // unknown id: no-op
            rx.recv().await.expect("cancel signal must arrive");
        });
    }

    // -----------------------------------------------------------------------
    // Naming helpers
    // -----------------------------------------------------------------------

    #[test]
    fn numbered_name_variants() {
        assert_eq!(numbered_name("setup.exe", 0), "setup.exe");
        assert_eq!(numbered_name("setup.exe", 3), "setup (3).exe");
        assert_eq!(numbered_name("README", 2), "README (2)");
        assert_eq!(numbered_name("archive.tar.gz", 1), "archive.tar (1).gz");
    }

    #[tokio::test]
    async fn part_dest_meta_paths_round_trip() {
        let tmp = TempDir::new("paths");
        let dest = tmp.path().join("setup.exe");
        let part = part_path_for(&dest);
        assert_eq!(part, tmp.path().join("setup.exe.part"));
        assert_eq!(dest_for_part(&part).as_deref(), Some(dest.as_path()));
        assert_eq!(meta_path_for(&part), tmp.path().join("setup.exe.part.meta"));
        // A non-.part name has no destination.
        assert_eq!(dest_for_part(&tmp.path().join("other.bin")), None);
    }

    #[tokio::test]
    async fn discard_staging_removes_part_and_meta_and_is_idempotent() {
        let tmp = TempDir::new("discard");
        let part = tmp.path().join("file.bin.part");
        seed_staging(
            &part,
            "https://example.com/file.bin",
            Some("\"v1\""),
            b"12345",
        )
        .await;
        assert!(part.exists());
        assert!(meta_path_for(&part).exists());
        discard_staging(&part).await;
        assert!(!part.exists());
        assert!(!meta_path_for(&part).exists());
        // Second call is a no-op, not an error.
        discard_staging(&part).await;
    }

    #[tokio::test]
    async fn validator_less_staging_is_discarded_on_resume() {
        // The byte-identity rule: without ETag/Last-Modified (and without a
        // trusted checksum to judge the assembled file) staged bytes cannot
        // be proven to belong to the current remote resource. The download
        // must restart from scratch - and still succeed.
        let tmp = TempDir::new("no-validator");
        let part = tmp.path().join("file.bin.part");
        tokio::fs::write(&part, b"12345").await.unwrap();
        let headers = reqwest::header::HeaderMap::new(); // no validators
        write_part_meta(&part, "https://example.com/file.bin", &headers).await;
        assert!(read_part_meta(&part).await.is_some());

        let server = spawn_mock(vec![MockReply::full_200(&pattern(10))]);
        let plan = DownloadPlan {
            resume: true,
            ..plan_for(&server.url, tmp.path(), Some("file.bin"))
        };
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let result = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff()).await;
        let payload = result.expect("fresh restart after discarding unprovable staging");
        // The staged prefix (b"12345") must NOT appear in the final file:
        // it was discarded, and the body came from the local mock.
        assert_eq!(payload.bytes, 10);
        assert_eq!(
            tokio::fs::read(tmp.path().join("file.bin")).await.unwrap(),
            pattern(10)
        );
        assert!(!part.exists(), "validator-less staging must be discarded");
        assert!(!meta_path_for(&part).exists());
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));
    }

    // -----------------------------------------------------------------------
    // No-clobber finalization
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn commit_places_the_file_at_the_requested_name() {
        let tmp = TempDir::new("commit-basic");
        let part = tmp.path().join("setup.exe.part");
        write_file(&part, b"installer-bytes").await;
        seed_staging(
            &part,
            "https://example.com/s",
            Some("\"v\""),
            b"installer-bytes",
        )
        .await;

        let committed = commit_no_clobber(&part, tmp.path(), "setup.exe")
            .await
            .expect("commit must succeed");
        assert_eq!(committed, tmp.path().join("setup.exe"));
        assert_eq!(std::fs::read(&committed).unwrap(), b"installer-bytes");
        // staging file and sidecar are gone after the commit
        assert!(!part.exists());
        assert!(!meta_path_for(&part).exists());
    }

    #[tokio::test]
    async fn commit_never_overwrites_and_picks_the_next_candidate() {
        let tmp = TempDir::new("commit-collision");
        // An unrelated file already occupies the requested name.
        let existing = tmp.path().join("setup.exe");
        write_file(&existing, b"PRECIOUS-EXISTING").await;

        let part = tmp.path().join("setup.exe.part");
        write_file(&part, b"new-bytes").await;

        let committed = commit_no_clobber(&part, tmp.path(), "setup.exe")
            .await
            .expect("commit must pick the next candidate");
        assert_eq!(committed, tmp.path().join("setup (1).exe"));
        assert_eq!(std::fs::read(&existing).unwrap(), b"PRECIOUS-EXISTING");
        assert_eq!(std::fs::read(&committed).unwrap(), b"new-bytes");
    }

    #[tokio::test]
    async fn commit_walks_past_a_whole_chain_of_collisions() {
        let tmp = TempDir::new("commit-chain");
        for i in 0..3 {
            let name = numbered_name("app.zip", i);
            write_file(&tmp.path().join(&name), format!("taken-{}", i).as_bytes()).await;
        }
        let part = tmp.path().join("app.zip.part");
        write_file(&part, b"fresh").await;

        let committed = commit_no_clobber(&part, tmp.path(), "app.zip")
            .await
            .expect("commit must succeed");
        assert_eq!(committed, tmp.path().join("app (3).zip"));
        assert_eq!(std::fs::read(&committed).unwrap(), b"fresh");
    }

    #[tokio::test]
    async fn commit_reports_a_genuine_error_instead_of_a_collision() {
        let tmp = TempDir::new("commit-error");
        // The staging file does not exist: not a name collision, an error.
        let part = tmp.path().join("missing.part");
        match commit_no_clobber(&part, tmp.path(), "file.bin").await {
            Err(FinalizeError::Io(_)) => {}
            other => panic!(
                "expected Io error, got {:?}",
                other.map(|p| p.display().to_string())
            ),
        }
        // The destination directory does not exist: also a genuine error.
        let part2 = tmp.path().join("x.part");
        write_file(&part2, b"data").await;
        let nowhere = tmp.path().join("does-not-exist");
        match commit_no_clobber(&part2, &nowhere, "file.bin").await {
            Err(FinalizeError::Io(_)) => {}
            other => panic!(
                "expected Io error, got {:?}",
                other.map(|p| p.display().to_string())
            ),
        }
        // The staging file survives a failed commit (retryable).
        assert!(part2.exists());
    }

    #[tokio::test]
    async fn commit_reports_exhaustion_instead_of_overwriting() {
        let tmp = TempDir::new("commit-exhaust");
        write_file(&tmp.path().join("name.bin"), b"taken").await;
        let part = tmp.path().join("name.bin.part");
        write_file(&part, b"data").await;
        match commit_no_clobber_limited(&part, tmp.path(), "name.bin", 1).await {
            Err(FinalizeError::NoCandidateName) => {}
            other => panic!(
                "expected NoCandidateName, got {:?}",
                other.map(|p| p.display().to_string())
            ),
        }
        assert_eq!(
            std::fs::read(tmp.path().join("name.bin")).unwrap(),
            b"taken"
        );
        assert!(part.exists(), "staging must survive a failed commit");
    }

    #[tokio::test]
    async fn reservation_fallback_commits_without_clobbering() {
        // Exercises the fallback used on filesystems that refuse hard links.
        let tmp = TempDir::new("commit-reservation");
        let part = tmp.path().join("f.bin.part");
        write_file(&part, b"fallback-bytes").await;
        let dest = tmp.path().join("f.bin");
        commit_via_reservation(&part, &dest)
            .await
            .expect("fallback commit");
        assert_eq!(std::fs::read(&dest).unwrap(), b"fallback-bytes");
        assert!(!part.exists());

        // A taken destination name is a collision, never an overwrite.
        let part2 = tmp.path().join("g.bin.part");
        write_file(&part2, b"second").await;
        let dest2 = tmp.path().join("g.bin");
        write_file(&dest2, b"KEEP").await;
        match commit_via_reservation(&part2, &dest2).await {
            Err(ReservationError::Collision) => {}
            other => panic!("expected Collision, got {:?}", other.is_ok()),
        }
        assert_eq!(std::fs::read(&dest2).unwrap(), b"KEEP");
        assert!(part2.exists(), "staging must survive a collision");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_finalizations_of_one_name_all_succeed_distinctly() {
        let tmp = TempDir::new("commit-race");
        let n = 8u32;
        let mut handles = Vec::new();
        for i in 0..n {
            let dir = tmp.path().to_path_buf();
            let content = format!("payload-{}", i).into_bytes();
            handles.push(tokio::spawn(async move {
                let part = dir.join(format!("shared.bin.part-{}", i));
                tokio::fs::write(&part, &content).await.unwrap();
                let committed = commit_no_clobber(&part, &dir, "shared.bin")
                    .await
                    .expect("every racing finalization must commit");
                (committed, content)
            }));
        }
        let mut committed_paths = Vec::new();
        let mut contents = Vec::new();
        for h in handles {
            let (p, c) = h.await.unwrap();
            committed_paths.push(p);
            contents.push(c);
        }
        // No two downloads may share a committed path ...
        committed_paths.sort();
        let before = committed_paths.clone();
        committed_paths.dedup();
        assert_eq!(
            committed_paths.len(),
            before.len(),
            "paths must be distinct"
        );
        // ... and every payload must exist on disk exactly once.
        for content in &contents {
            let hits = committed_paths
                .iter()
                .filter(|p| std::fs::read(p).unwrap() == *content)
                .count();
            assert_eq!(hits, 1, "payload {:?} must appear exactly once", content);
        }
        // The unnumbered name holds exactly one of them - whoever won the
        // race - and its content was not replaced afterwards.
        let first = std::fs::read(tmp.path().join("shared.bin")).unwrap();
        assert!(contents.iter().any(|c| c == &first));
    }

    // -----------------------------------------------------------------------
    // Local mock HTTP server (no public endpoints anywhere in this suite)
    // -----------------------------------------------------------------------

    /// One scripted response. The server speaks just enough HTTP/1.1 for
    /// reqwest: request heads are drained and recorded, then the scripted
    /// head + body are written and the connection is closed.
    struct MockReply {
        status_line: &'static str,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
        /// Write only the first N body bytes, then close: produces a
        /// truncated transfer the client must detect.
        send_body_bytes: Option<usize>,
        /// Keep the connection open this long after writing: used so the
        /// body stream is still pending when a cancellation is requested.
        hold_ms: u64,
    }

    impl MockReply {
        fn raw(
            status_line: &'static str,
            headers: Vec<(&'static str, String)>,
            body: Vec<u8>,
        ) -> Self {
            MockReply {
                status_line,
                headers,
                body,
                send_body_bytes: None,
                hold_ms: 0,
            }
        }

        fn full_200(body: &[u8]) -> Self {
            Self::raw(
                "HTTP/1.1 200 OK",
                vec![
                    ("Content-Length", body.len().to_string()),
                    ("ETag", "\"test-etag\"".to_string()),
                ],
                body.to_vec(),
            )
        }

        fn partial_206(content_range: &str, tail: &[u8]) -> Self {
            Self::raw(
                "HTTP/1.1 206 Partial Content",
                vec![
                    ("Content-Length", tail.len().to_string()),
                    ("Content-Range", content_range.to_string()),
                    ("ETag", "\"test-etag\"".to_string()),
                ],
                tail.to_vec(),
            )
        }

        fn range_not_satisfiable() -> Self {
            Self::raw(
                "HTTP/1.1 416 Range Not Satisfiable",
                vec![("Content-Length", "0".to_string())],
                Vec::new(),
            )
        }
    }

    struct MockServer {
        url: String,
        requests: Arc<StdMutex<Vec<String>>>,
    }

    fn spawn_mock(replies: Vec<MockReply>) -> MockServer {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let requests: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let req_log = Arc::clone(&requests);
        std::thread::spawn(move || {
            for reply in replies {
                let (stream, _) = match listener.accept() {
                    Ok(x) => x,
                    Err(_) => return,
                };
                serve_one(stream, &reply, &req_log);
            }
            // Script exhausted: absorb any further connections so an
            // unexpected extra attempt fails fast instead of hanging.
            while let Ok((stream, _)) = listener.accept() {
                drop(stream);
            }
        });
        MockServer {
            url: format!("http://{}/payload.bin", addr),
            requests,
        }
    }

    fn serve_one(
        mut stream: std::net::TcpStream,
        reply: &MockReply,
        req_log: &StdMutex<Vec<String>>,
    ) {
        // Drain the request head (GET has no body).
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 2048];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
        req_log
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(&buf).to_string());

        let mut head = String::new();
        head.push_str(reply.status_line);
        head.push_str("\r\n");
        for (k, v) in &reply.headers {
            head.push_str(&format!("{}: {}\r\n", k, v));
        }
        head.push_str("Connection: close\r\n\r\n");
        let _ = stream.write_all(head.as_bytes());
        let limit = reply
            .send_body_bytes
            .unwrap_or(reply.body.len())
            .min(reply.body.len());
        let _ = stream.write_all(&reply.body[..limit]);
        let _ = stream.flush();
        if reply.hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(reply.hold_ms));
        }
        drop(stream);
    }

    fn test_backoff() -> Duration {
        Duration::from_millis(2)
    }

    /// So a spawned watcher task and the test body can share one sink.
    impl<P: ProgressSink> ProgressSink for Arc<P> {
        fn progress(&self, payload: ProgressPayload) {
            (**self).progress(payload)
        }
        fn retrying(&self, payload: RetryPayload) {
            (**self).retrying(payload)
        }
    }

    /// Lowercase request head N for case-insensitive header assertions
    /// (hyper writes header names in lowercase on the wire).
    fn request_head(server: &MockServer, n: usize) -> String {
        server.requests.lock().unwrap()[n].to_ascii_lowercase()
    }

    // -----------------------------------------------------------------------
    // End-to-end lifecycle tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn fresh_download_completes_and_cleans_up() {
        let tmp = TempDir::new("e2e-fresh");
        let body = pattern(70_000);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));

        let payload = execute_with_retries(&log, &session, 7, plan, cancel_rx, test_backoff())
            .await
            .expect("fresh download must complete");

        assert_eq!(payload.id, 7);
        assert_eq!(payload.path, tmp.path().join("setup.exe").to_string_lossy());
        assert_eq!(payload.bytes, body.len() as u64);
        assert_eq!(payload.sha256, sha256_hex(&body));
        assert_eq!(
            payload.verified, None,
            "computed digest without a trusted reference is NOT verified"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));

        // The file is at its final name; no staging artifacts remain.
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            body
        );
        assert!(!tmp.path().join("setup.exe.part").exists());
        assert!(!tmp.path().join("setup.exe.part.meta").exists());

        // Progress flowed; a fresh request carries no Range header.
        assert!(!log.progress.lock().unwrap().is_empty());
        let head = request_head(&server, 0);
        assert!(head.contains("get /payload.bin"));
        assert!(!head.contains("range:"));
    }

    #[tokio::test]
    async fn resume_206_appends_the_tail_only() {
        let tmp = TempDir::new("e2e-206");
        let full = pattern(1000);
        let server = spawn_mock(vec![MockReply::partial_206(
            "bytes 600-999/1000",
            &full[600..],
        )]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..600]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("resume from a valid partial response must complete");

        assert_eq!(payload.bytes, 1000);
        assert_eq!(payload.sha256, sha256_hex(&full));
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            full
        );
        let head = request_head(&server, 0);
        assert!(head.contains("range: bytes=600-"));
        assert!(head.contains("if-range: \"test-etag\""));
        assert!(!part.exists());
    }

    #[tokio::test]
    async fn resume_with_a_full_200_replaces_staging_never_concatenates() {
        // THE corruption scenario: the server ignored the Range request and
        // resends the whole (changed) resource. Appending it to the staged
        // prefix would produce a hybrid file; the engine must restart.
        let tmp = TempDir::new("e2e-200-restart");
        let full = pattern(1000);
        let server = spawn_mock(vec![MockReply::full_200(&full)]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(
            &part,
            &server.url,
            Some("\"old-etag\""),
            b"OLD-RESOURCE-PREFIX!!",
        )
        .await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("200 restart must complete");

        assert_eq!(payload.bytes, 1000);
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            full,
            "the assembled file must be exactly the new resource"
        );
    }

    #[tokio::test]
    async fn mismatched_content_range_discards_staging_and_fails() {
        let tmp = TempDir::new("e2e-bad-range");
        let full = pattern(1000);
        // The staging file ends at 600 but the server resumed at 300.
        let server = spawn_mock(vec![MockReply::partial_206(
            "bytes 300-999/1000",
            &full[300..],
        )]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..600]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let err = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect_err("a mismatched Content-Range must fail");
        assert_eq!(err.1.as_deref(), Some("resume-invalid"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        // Staging bytes were proven useless: both artifacts are gone.
        assert!(!part.exists());
        assert!(!meta_path_for(&part).exists());
        assert!(!tmp.path().join("setup.exe").exists());
    }

    #[tokio::test]
    async fn staging_larger_than_the_remote_total_is_discarded_via_416() {
        // A resumed staging file whose size exceeds the expected total: the
        // Range is unsatisfiable and a conforming server answers 416.
        let tmp = TempDir::new("e2e-416");
        let server = spawn_mock(vec![MockReply::range_not_satisfiable()]);
        let part = tmp.path().join("file.bin.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &pattern(20)).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("file.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let err = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect_err("an unsatisfiable range must fail the attempt");
        assert_eq!(err.1.as_deref(), Some("resume-invalid"));
        assert!(err.0.contains("HTTP 416"));
        assert!(!part.exists());
        assert!(!meta_path_for(&part).exists());
    }

    #[tokio::test]
    async fn truncated_tail_is_never_finalized_and_the_retry_completes() {
        let tmp = TempDir::new("e2e-truncated");
        let full = pattern(1000);
        // Attempt 1: valid 206 promising bytes 600-999, but the connection
        // closes after 200 of the 400 promised tail bytes.
        let mut first = MockReply::partial_206("bytes 600-999/1000", &full[600..]);
        first.send_body_bytes = Some(200);
        // Attempt 2 (automatic): the missing bytes, from the new length.
        let second = MockReply::partial_206("bytes 800-999/1000", &full[800..]);
        let server = spawn_mock(vec![first, second]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..600]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("the automatic resume must complete the truncated transfer");

        assert_eq!(payload.bytes, 1000);
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            full
        );
        // Exactly one automatic retry happened, and it resumed from the
        // staging file this chain owns (800 bytes, not 600). The guard is
        // dropped before the await below (clippy: await_holding_lock).
        let (retry_count, retry_attempt) = {
            let retries = log.retries.lock().unwrap();
            (retries.len(), retries.first().map(|r| r.attempt))
        };
        assert_eq!(retry_count, 1);
        assert_eq!(retry_attempt, Some(1));
        assert!(request_head(&server, 1).contains("range: bytes=800-"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));
    }

    #[tokio::test]
    async fn a_short_subrange_is_completed_by_another_resume_round() {
        // RFC 9110 15.3.7.2: a server MAY deliver fewer bytes than the
        // remaining range. The response is VALID (exact check passes) but
        // the file is not complete - the engine must resume, not finalize.
        let tmp = TempDir::new("e2e-short-range");
        let full = pattern(1000);
        let server = spawn_mock(vec![
            MockReply::partial_206("bytes 600-899/1000", &full[600..900]),
            MockReply::partial_206("bytes 900-999/1000", &full[900..]),
        ]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..600]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("the short subrange must be completed by another round");

        assert_eq!(payload.bytes, 1000);
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            full
        );
        assert_eq!(log.retries.lock().unwrap().len(), 1);
        assert!(request_head(&server, 1).contains("range: bytes=900-"));
    }

    #[tokio::test]
    async fn checksum_mismatch_deletes_the_artifact_and_fails() {
        let tmp = TempDir::new("e2e-checksum");
        let body = pattern(500);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        // An unrelated file in the same directory must not be touched.
        let keeper = tmp.path().join("keeper.txt");
        write_file(&keeper, b"keep-me").await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("app.exe"));
        plan.expected_sha256 = Some(sha256_hex(b"not the payload"));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a checksum mismatch must fail");
        assert_eq!(kind.as_deref(), Some("checksum"));
        assert!(message.contains("Integrity check failed"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));

        // No finished-looking file, no leftover staging artifacts.
        assert!(!tmp.path().join("app.exe").exists());
        assert!(!tmp.path().join("app.exe.part").exists());
        assert!(!tmp.path().join("app.exe.part.meta").exists());
        assert_eq!(tokio::fs::read(&keeper).await.unwrap(), b"keep-me");
    }

    #[tokio::test]
    async fn checksum_match_reports_verified() {
        let tmp = TempDir::new("e2e-checksum-ok");
        let body = pattern(500);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);

        let mut plan = plan_for(&server.url, tmp.path(), Some("app.exe"));
        // Deliberately uppercase to exercise normalization end to end.
        plan.expected_sha256 = Some(sha256_hex(&body).to_uppercase());
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a matching trusted checksum must complete");
        assert_eq!(payload.verified, Some(true));
        assert_eq!(payload.sha256, sha256_hex(&body));
    }

    #[tokio::test]
    async fn cancel_mid_transfer_keeps_staging_and_the_resume_completes() {
        let tmp = TempDir::new("e2e-cancel");
        let full = pattern(1_000_000);
        // Attempt 1: a large body; deliver 4 KiB then hold the connection
        // open so the stream is pending when the cancel arrives.
        let mut first = MockReply::full_200(&full);
        first.send_body_bytes = Some(4096);
        first.hold_ms = 1500;
        // Attempt 2 (after cancel + resume): the tail from the staged len.
        let second = MockReply::partial_206(
            &format!("bytes 4096-{}/{}", full.len() - 1, full.len()),
            &full[4096..],
        );
        let server = spawn_mock(vec![first, second]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());

        // Cancel as soon as the first progress event proves bytes flowed.
        let watcher_log = Arc::clone(&log);
        let watcher_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            while watcher_log.progress.lock().unwrap().is_empty() {
                if Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            watcher_registry.request_cancel(id).await;
        });

        let plan = plan_for(&server.url, tmp.path(), Some("big.bin"));
        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a cancelled transfer must not complete");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));

        // The staging file survives a cancel (resume must stay possible);
        // nothing sits at the final name.
        let part = tmp.path().join("big.bin.part");
        assert!(part.exists());
        assert!(tokio::fs::metadata(&part).await.unwrap().len() >= 4096);
        assert!(!tmp.path().join("big.bin").exists());

        // Resuming finishes the download exactly. Like the UI after a
        // cancel, the resumed attempt runs as a fresh download id against
        // the staging file the cancelled chain left behind.
        let mut plan2 = plan_for(&server.url, tmp.path(), Some("big.bin"));
        plan2.resume = true;
        plan2.staging = Some(part.clone());
        let (session2, cancel_rx2) = test_session().await;
        let payload = execute_with_retries(&log, &session2, id, plan2, cancel_rx2, test_backoff())
            .await
            .expect("resuming after a cancel must complete");
        assert_eq!(payload.bytes, full.len() as u64);
        assert_eq!(
            tokio::fs::read(tmp.path().join("big.bin")).await.unwrap(),
            full
        );
    }

    #[tokio::test]
    async fn cancel_during_the_retry_backoff_never_starts_another_attempt() {
        // A cancel that lands inside the automatic-retry backoff must be
        // answered by the Cancelled state, not by a fresh attempt on the
        // same staging file.
        let tmp = TempDir::new("e2e-cancel-backoff");
        let full = pattern(1000);
        // Only ONE scripted response: attempt 1 truncates. If the engine
        // (wrongly) started attempt 2, it would get no answer and the
        // connection would be closed immediately - the test's assertions
        // on the outcome would fail.
        let mut first = MockReply::full_200(&full);
        first.send_body_bytes = Some(400);
        let server = spawn_mock(vec![first]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());

        // Cancel as soon as the first progress event proves bytes flowed;
        // the long backoff window guarantees the cancel lands while the
        // state is Retrying.
        let watcher_log = Arc::clone(&log);
        let watcher_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            while watcher_log.progress.lock().unwrap().is_empty() {
                if Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            watcher_registry.request_cancel(id).await;
        });

        let plan = plan_for(&server.url, tmp.path(), Some("backoff.bin"));
        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, Duration::from_secs(30))
                .await
                .expect_err("the cancelled retry must not complete");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));
        // No retry was recorded as started... actually one WAS scheduled
        // (attempt 1 failed), but the backoff was interrupted before the
        // next attempt ran: the retry EVENT must not have been emitted.
        assert!(log.retries.lock().unwrap().is_empty());
        // The staging file stays resumable.
        assert!(tmp.path().join("backoff.bin.part").exists());
        assert!(!tmp.path().join("backoff.bin").exists());
    }

    #[tokio::test]
    async fn server_status_204_is_rejected_without_touching_the_directory() {
        let tmp = TempDir::new("e2e-204");
        let server = spawn_mock(vec![MockReply::raw(
            "HTTP/1.1 204 No Content",
            Vec::new(),
            Vec::new(),
        )]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("empty.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a bodyless 2xx status must be rejected");
        assert_eq!(message, "Server returned HTTP 204");
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        // Nothing was created: no destination file, no staging file.
        assert!(!tmp.path().join("empty.bin").exists());
        assert!(!tmp.path().join("empty.bin.part").exists());
    }

    #[tokio::test]
    async fn close_delimited_body_without_content_length_completes_at_eof() {
        // Unknown total size: without Content-Length and without a range,
        // EOF is the only completion signal (a supplied checksum would be
        // the safety net). The engine finalizes what arrived.
        let tmp = TempDir::new("e2e-no-length");
        let body = pattern(777);
        let server = spawn_mock(vec![MockReply::raw(
            "HTTP/1.1 200 OK",
            vec![("ETag", "\"test-etag\"".to_string())],
            body.clone(),
        )]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("stream.bin"));

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a close-delimited body must complete at EOF");
        assert_eq!(payload.bytes, 777);
        assert_eq!(
            tokio::fs::read(tmp.path().join("stream.bin"))
                .await
                .unwrap(),
            body
        );
    }

    #[tokio::test]
    async fn finalize_collision_picks_the_next_candidate_and_preserves_the_existing_file() {
        let tmp = TempDir::new("e2e-finalize-collision");
        write_file(&tmp.path().join("setup.exe"), b"DO-NOT-TOUCH").await;
        let body = pattern(100);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("the download must complete on the next candidate name");
        assert_eq!(
            payload.path,
            tmp.path().join("setup (1).exe").to_string_lossy()
        );
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup.exe")).await.unwrap(),
            b"DO-NOT-TOUCH",
            "the pre-existing file must survive byte for byte"
        );
        assert_eq!(
            tokio::fs::read(tmp.path().join("setup (1).exe"))
                .await
                .unwrap(),
            body
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_concurrent_same_name_downloads_both_survive() {
        let tmp = TempDir::new("e2e-concurrent");
        let body_a = pattern(4096);
        let body_b = pattern(4097);
        let server_a = spawn_mock(vec![MockReply::full_200(&body_a)]);
        let server_b = spawn_mock(vec![MockReply::full_200(&body_b)]);

        let (session_a, rx_a) = test_session().await;
        let (session_b, rx_b) = test_session().await;
        let log = EventLog::default();
        let plan_a = plan_for(&server_a.url, tmp.path(), Some("same.bin"));
        let plan_b = plan_for(&server_b.url, tmp.path(), Some("same.bin"));

        // Both downloads run concurrently (interleaved at every await
        // point), racing for the same final filename.
        let (payload_a, payload_b) = tokio::join!(
            execute_with_retries(&log, &session_a, 1, plan_a, rx_a, test_backoff()),
            execute_with_retries(&log, &session_b, 2, plan_b, rx_b, test_backoff()),
        );
        let payload_a = payload_a.expect("download A must complete");
        let payload_b = payload_b.expect("download B must complete");

        assert_ne!(
            payload_a.path, payload_b.path,
            "committed paths must differ"
        );
        let path_a = PathBuf::from(&payload_a.path);
        let path_b = PathBuf::from(&payload_b.path);
        assert_eq!(tokio::fs::read(&path_a).await.unwrap(), body_a);
        assert_eq!(tokio::fs::read(&path_b).await.unwrap(), body_b);
        // One of them holds the unnumbered name; both hashes are honest.
        assert_eq!(payload_a.sha256, sha256_hex(&body_a));
        assert_eq!(payload_b.sha256, sha256_hex(&body_b));
    }
}
