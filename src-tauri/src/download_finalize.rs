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
//! - Cancellation is honored while the attempt waits for the server's
//!   response, while bytes are streaming, and through every retryable
//!   outcome (short transfer, stalled connection, silent server). Only
//!   when the body is fully received AND its byte count is verified
//!   against the response's promise does the download enter Verifying,
//!   from where it
//!   always runs to a terminal state: the bytes are already on disk, and
//!   deleting a fully received, hash-checked artifact would only waste the
//!   transfer. A cancel signalled during Verifying is therefore ignored by
//!   design, and the phase reaches exactly ONE terminal outcome
//!   (Completed or Failed) - the state machine has no Verifying -> Cancelled
//!   edge, so a cancelled download can never emit success and a verified
//!   download can never emit an error afterwards.
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
//! Every staging byte flows through one small seam, the [`StagingSink`] /
//! [`PartWriter`] traits. Production always uses the [`DiskStaging`]
//! implementation, which is the direct `tokio::fs` path unchanged; the seam
//! exists so a mid-write disk failure can be driven end to end by a test
//! (see `DiskFullAfter` in the test module) without new dependencies and
//! without a production-visible difference.
//!
//! # Error cleanup policy
//!
//! What a failure leaves on disk is part of the contract, not an accident:
//!
//! | failure | staging (.part + sidecar) | automatic retry |
//! |---------|---------------------------|-----------------|
//! | network (short transfer, stall, reset) | kept, resumable | yes, same staging file |
//! | cancel | kept, resumable | no (user's Resume button) |
//! | checksum mismatch | deleted | no |
//! | resume-invalid (416, bad Content-Range) | deleted | no |
//! | disk write failure (ENOSPC, permissions) | kept, resumable | no (final) |
//! | transient server status (429, 502, 503, 504) | untouched - never written to | yes, fresh attempt |
//! | protocol violation (bad status/headers) | untouched - never written to | no |
//! | refused redirect (downgrade/loop/allowlist) | untouched - never written to | no |
//!
//! A disk write failure keeps the staging file because a full disk is a
//! recoverable condition: the user frees space and hits Resume, and the
//! download continues from exactly the bytes that made it to disk. It is
//! categorized as `kind = None` (final, never retried) so the retry loop
//! can never misread a local disk-full as a transient server problem.
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
//!
//! # Completed-artifact registry and the signature-verification boundary
//!
//! A successful commit leaves one bounded record in
//! [`DownloadRegistry`]'s completed-artifact queue: the exact reported
//! path, its canonical path resolved AT COMPLETION TIME, the committed
//! byte size, the source URL and the engine's own checksum verdict
//! (`checksum_verified`: `Some(true)` only when a publisher-supplied
//! trusted digest matched, `None` when the artifact completed without
//! one; a mismatch can never leave a record at all). The queue exists for
//! exactly one consumer - the updater's signature-verification command in
//! `lib.rs` - and is the reason that command cannot be turned into a
//! general-purpose "verify any file on disk" API:
//!
//! - A record is created ONLY by a successful, full, hash-checked commit.
//!   Cancelled, failed, checksum-mismatched and resume-invalid downloads
//!   never leave one, so a staging `.part` (or any other file the frontend
//!   picks a path for) can never present itself for verification.
//! - The queue is capped ([`COMPLETED_RECORD_CAP`], FIFO) and a newer
//!   completion of the same canonical path replaces the stale record, so a
//!   verification always judges the artifact the engine MOST RECENTLY
//!   finalized there.
//! - The verification command re-resolves the record's path and refuses
//!   when the on-disk canonical path no longer matches the recorded one
//!   (a symlink swap or rename between completion and verification), when
//!   the open file is not a regular file, or when its size no longer
//!   matches the committed size. A same-size in-place edit cannot be seen
//!   by metadata - the signature verdict itself is the rail there: the
//!   command verifies the bytes it actually reads from the opened handle,
//!   so ANY modification after completion can only produce a failed
//!   verification, never a false one.
//!
//! What the boundary deliberately does NOT promise: the release-version /
//! filename binding of the signature DOCUMENT. A minisign trusted comment
//! is not verifiable with the `minisign-verify` API, so "this .sig belongs
//! to release vX's asset" is the frontend delivery plan's gate (it matches
//! the sidecar to the asset on the pinned release feed). Natively, a
//! wrong-version signature document can never yield a false "verified":
//! it only verifies over artifact bytes that genuinely carry the embedded
//! key's signature.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use tokio::io::AsyncReadExt;
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
    ///
    /// This field carries the CHECKSUM verdict and nothing else. A trusted
    /// checksum match is not a publisher-signature verdict: artifact
    /// signature verification is a separate native command with its own
    /// result (see `verify_self_update_signature` in lib.rs), and its
    /// outcome never merges into this flag. The two self-update trust
    /// states the UI distinguishes - "checksummed" and
    /// "signature-verified" - therefore stay distinguishable end to end:
    /// `verified` can only ever attest the former, and a local SHA-256
    /// calculation (expected hash absent) can never attest even that.
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

/// How many completed artifacts the registry remembers for the
/// signature-verification boundary. A self-update flow realistically has
/// one; the cap only bounds memory if a user downloads many files and then
/// verifies them one after another. FIFO: the oldest record is evicted.
pub(crate) const COMPLETED_RECORD_CAP: usize = 32;

/// The record one successfully completed download leaves behind for the
/// updater's signature-verification boundary (see the module docs). Created
/// exclusively by the commit path; never by cancelled, failed or
/// checksum-mismatched downloads.
#[derive(Clone, Debug)]
pub(crate) struct CompletedArtifact {
    pub(crate) id: u32,
    /// The exact final path the engine reported in its completion event
    /// (`CompletePayload.path`) - the string the frontend echoes back.
    pub(crate) path: PathBuf,
    /// The path canonicalized at completion time (symlinks resolved). The
    /// verifier compares this against a FRESH canonicalization to detect a
    /// symlink swap or rename between completion and verification.
    pub(crate) canonical: PathBuf,
    /// Committed byte size. A cheap post-completion replacement detector;
    /// the signature verdict covers what metadata cannot.
    pub(crate) size: u64,
    /// Source URL the bytes were downloaded from (the plan URL the
    /// network policy admitted). Auditability only today: the verifier is
    /// invoked with a path, and the frontend correlates id -> url before
    /// it calls. The binding is kept so a future caller can demand it.
    pub(crate) url: String,
    /// The integrity verdict the engine itself produced at completion,
    /// copied verbatim from the commit path's digest comparison:
    ///   - `Some(true)`  - the bytes matched a PUBLISHER-supplied trusted
    ///     digest (expected_sha256 / expected_sha512, compared at the
    ///     Verifying phase);
    ///   - `None` - no trusted reference digest existed, so the digest was
    ///     computed but the artifact completed UNVERIFIED.
    ///
    /// `Some(false)` is unreachable by construction: a mismatching download
    /// is deleted and fails with kind `checksum` BEFORE any commit, so it
    /// can never leave a record here (pinned by
    /// `a_checksum_failure_leaves_no_completed_record`).
    ///
    /// This is the "expected checksum status" leg of the verifier's record
    /// contract (id, url, canonical path, size, completed state, checksum
    /// status). The signature verdict stays a separate, stronger check -
    /// this field exists so the boundary's caller (and any future caller)
    /// can see exactly what the engine itself proved about these bytes,
    /// and so a diagnostic can distinguish "checksummed" from "merely
    /// completed". It NEVER upgrades the signature result.
    pub(crate) checksum_verified: Option<bool>,
}

/// Registry of live downloads, keyed by download id. The state machine and
/// the cancel channel live behind one mutex, so a state read and the cancel
/// signal are always consistent with each other.
///
/// The completed-artifact queue uses a plain [`std::sync::Mutex`] on
/// purpose: its two callers are the engine's commit path (no await while
/// held) and the verifier's blocking thread, which cannot lock an async
/// mutex. No guard is ever held across an await point.
#[derive(Default)]
pub(crate) struct DownloadRegistry {
    next_id: AtomicU32,
    active: Mutex<HashMap<u32, ActiveDownload>>,
    completed: std::sync::Mutex<VecDeque<CompletedArtifact>>,
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

    /// Engine-only: records a successfully committed artifact for the
    /// signature-verification boundary. Called once per successful commit,
    /// right after [`commit_no_clobber`] returned the final path.
    ///
    /// A newer completion of the same canonical path replaces the earlier
    /// record (the old file it described was either consumed or is no
    /// longer reachable under that path - the newest commit is the
    /// truthful one). The queue is FIFO-capped so a long session cannot
    /// grow it without bound.
    pub(crate) fn record_completed_artifact(
        &self,
        id: u32,
        path: &Path,
        url: &str,
        checksum_verified: Option<bool>,
    ) {
        // Best effort: the file was just committed and still exists, but a
        // canonicalization hiccup must never fail a finished download. The
        // fallback keeps the raw path, and the verifier's fresh
        // canonicalization comparison stays sound (fail closed) for it.
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let mut completed = self
            .completed
            .lock()
            .expect("completed-artifact registry poisoned");
        completed.retain(|a| a.canonical != canonical);
        while completed.len() >= COMPLETED_RECORD_CAP {
            completed.pop_front();
        }
        completed.push_back(CompletedArtifact {
            id,
            path: path.to_path_buf(),
            canonical,
            size,
            url: url.to_string(),
            checksum_verified,
        });
    }

    /// Boundary lookup for the signature verifier: the completed-artifact
    /// record for `path`, if any. The primary match is the exact reported
    /// path (the frontend echoes the completion event's path verbatim);
    /// the fallback matches by freshly canonicalized path so a caller
    /// carrying a normalized/`..`-folded variant of the same location is
    /// still recognized. Both outcomes return the record; every rejection
    /// upstream renders the SAME generic refusal, so this lookup leaks no
    /// filesystem information about unregistered paths.
    pub(crate) fn completed_artifact_for_path(&self, path: &Path) -> Option<CompletedArtifact> {
        let completed = self
            .completed
            .lock()
            .expect("completed-artifact registry poisoned");
        if let Some(record) = completed.iter().find(|a| a.path == path) {
            return Some(record.clone());
        }
        let canonical = std::fs::canonicalize(path).ok()?;
        completed.iter().find(|a| a.canonical == canonical).cloned()
    }

    /// Directories that hold at least one completed artifact this session,
    /// canonicalized and deduplicated. The open boundary admits a DIRECTORY
    /// target when it is the platform default download folder, one of these
    /// parents, or a folder the user picked in the native dialog this
    /// session - the three cases where "Show in folder" / "Open folder" is
    /// legitimately the user acting on their own downloaded content.
    pub(crate) fn completed_parent_dirs(&self) -> Vec<PathBuf> {
        let completed = self
            .completed
            .lock()
            .expect("completed-artifact registry poisoned");
        let mut dirs: Vec<PathBuf> = completed
            .iter()
            .filter_map(|a| a.canonical.parent().map(|p| p.to_path_buf()))
            .collect();
        dirs.sort();
        dirs.dedup();
        dirs
    }

    /// Test-only view of the completed queue length (cap regression tests,
    /// and the registry-immutability assertion in lib.rs's boundary tests).
    #[cfg(test)]
    pub(crate) fn completed_len(&self) -> usize {
        self.completed
            .lock()
            .expect("completed-artifact registry poisoned")
            .len()
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
    // Windows filename parity: the OS drops trailing dots and spaces when it
    // materializes a name ("readme." and "readme. " both land as "readme"),
    // so a recorded path that still carried them would not describe the file
    // actually on disk (and CreateFile can refuse "..." outright). Stripping
    // here keeps the finalize path honest about what was written; an
    // all-dots name - "." ".." "..." and every longer dot-run - strips to
    // nothing and collapses to the safe default like any other empty result
    // (the old code only caught the two-dot forms, so a server-supplied
    // "..." finalized as a broken Windows name).
    let stripped = trimmed.trim_end_matches(['.', ' ']);
    if stripped.is_empty() {
        return "download.bin".to_string();
    }
    // Windows reserve device names: "CON", "NUL", "COM1".."COM9",
    // "LPT1".."LPT9" cannot be file names. The rule applies to the name up
    // to the FIRST dot ("NUL.tar.gz" is reserved just like "NUL"), and a
    // server-supplied Content-Disposition must never be able to trigger a
    // finalize-time failure, so they collapse to the safe default too.
    let first_segment = stripped
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
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
    stripped.to_string()
}

pub(crate) fn filename_from_headers(
    url: &reqwest::Url,
    headers: &reqwest::header::HeaderMap,
) -> Option<String> {
    // Every branch funnels through sanitize_filename() before returning:
    // the value is joined onto the download directory, so a server-supplied
    // name like "../../something" (or its percent-encoded form - the RFC
    // 5987 branch decodes first) must never be able to escape the folder.
    // sanitize_filename also collapses empty/all-dots names (and Windows
    // trailing-dot forms) to a safe name.
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
pub(crate) fn percent_decode(input: &str) -> String {
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
    use tokio::io::AsyncReadExt as _;
    // The sidecar is our own tiny JSON document (a URL plus two header
    // strings). The size bound keeps even a tampered or corrupted sidecar
    // from being buffered without limit; a sidecar that is truncated by
    // the bound fails the JSON parse below and reads as "no validators",
    // which fail-closes the resume into a discard.
    let file = tokio::fs::File::open(meta_path_for(part)).await.ok()?;
    let mut raw = String::new();
    file.take(64 * 1024).read_to_string(&mut raw).await.ok()?;
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
// Staging write seam (production: direct filesystem access, unchanged)
// ---------------------------------------------------------------------------

/// How a staging file is (re)opened for one attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StagingOpenMode {
    /// Continue our own `.part` with a verified 206 tail.
    Append,
    /// The server ignored the Range and resent the whole body: truncate
    /// and restart in place.
    Truncate,
    /// Fresh download: atomic `create_new` reservation.
    CreateNew,
}

/// The write end of a staging file. The three operations are exactly the
/// ones the streaming loop needs; production implements this for
/// [`tokio::fs::File`], delegating to the same calls the engine used
/// inline before the seam existed.
trait PartWriter {
    async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>;
    async fn flush(&mut self) -> io::Result<()>;
    async fn sync_all(&mut self) -> io::Result<()>;
}

impl PartWriter for tokio::fs::File {
    async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        tokio::io::AsyncWriteExt::write_all(self, bytes).await
    }
    async fn flush(&mut self) -> io::Result<()> {
        tokio::io::AsyncWriteExt::flush(self).await
    }
    async fn sync_all(&mut self) -> io::Result<()> {
        // `sync_all` is an inherent async method of tokio::fs::File (not
        // part of AsyncWriteExt), so it is called as UFCS on the type.
        tokio::fs::File::sync_all(self).await
    }
}

/// The staging seam: opens the write end of a `.part` file in one of the
/// three modes above. Production always uses [`DiskStaging`], so the
/// production stream path is byte-for-byte what it was before the seam
/// existed. The seam's purpose is testability with zero dependencies: a
/// mid-write disk failure (ENOSPC) cannot be simulated portably against a
/// real filesystem, but a test sink that accepts exactly N bytes and then
/// fails like a full disk drives the REAL write loop, the REAL error
/// categorization, and the REAL cleanup policy deterministically.
trait StagingSink: Sync {
    type Writer: PartWriter;
    async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer>;
}

/// Production staging sink: plain tokio filesystem access, the same three
/// open shapes the engine used inline.
struct DiskStaging;

impl StagingSink for DiskStaging {
    type Writer = tokio::fs::File;
    async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer> {
        match mode {
            StagingOpenMode::Append => tokio::fs::OpenOptions::new().append(true).open(part).await,
            StagingOpenMode::Truncate => tokio::fs::File::create(part).await,
            StagingOpenMode::CreateNew => {
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(part)
                    .await
            }
        }
    }
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
/// file: `evaluate_response` maps every validation failure to
/// `DiscardAndFail`, so the staging bytes AND the response's validators are
/// deleted rather than retained as resumable state (an impossible range has
/// forfeited the byte accounting; keeping a poisoned tail resumable would
/// let a later byte-identity resume glue it into a final file).
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
    // The promised length must itself be representable: a hostile
    // `end == u64::MAX` with `start == 0` would otherwise overflow
    // `end - start + 1` (a panic under overflow-checks, a silent wrap to 0
    // without). Either shape poisons every downstream length decision, so
    // the header is refused as malformed instead.
    (end - start)
        .checked_add(1)
        .ok_or_else(|| "Content-Range byte range is too large".to_string())
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
        other => {
            // Transient server-side conditions: the same request answers
            // differently seconds later, and the retry loop exists for
            // exactly these. Nothing was written yet (this gate precedes
            // the staging reservation), so the fresh attempt simply
            // re-requests. Every other status is deterministic (404,
            // 403, 500, ...) and stays final: retrying it can only
            // reproduce it.
            let kind = matches!(other, 429 | 502 | 503 | 504).then(|| "network".to_string());
            ResponsePlan::Fail {
                message: format!("Server returned HTTP {}", other),
                kind,
            }
        }
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
        // Qualified: PartWriter is also implemented for File in this
        // module, which would make the plain method call ambiguous.
        tokio::io::AsyncWriteExt::flush(&mut out).await?;
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

/// How long one attempt may wait for the server to ANSWER (response line
/// plus headers on an established connection). The policy client's connect
/// timeout bounds TCP/TLS setup; this bounds the silent wait after it.
/// Without it, a server that accepted and never replied held the download
/// in `Downloading` forever, and cancellation - which was only observed in
/// the body loop and the retry backoff - could not stop it. Same policy as
/// the body stall window, applied one phase earlier.
const FIRST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);

/// How long one attempt may stream no body bytes before the connection is
/// declared dead and the attempt fails as a retryable network stall.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Classify one initial-send failure.
///
/// Redirect-policy refusals (scheme downgrade, allowlist miss, loop, hop
/// budget, credentials on a hop) are DETERMINISTIC: the same redirect
/// chain fails the same way on every attempt, so burning the automatic
/// retry budget on them only delays the honest error - and the old
/// "Connection failed" wording misread a security refusal as a network
/// blip. They are final, and the message names the refusal. Everything
/// else (DNS, connect, TLS, reset while waiting) stays transient.
fn classify_send_error(e: reqwest::Error) -> (String, Option<String>) {
    if e.is_redirect() {
        (format!("Insecure redirect refused: {}", e), None)
    } else {
        (
            format!("Connection failed: {}", e),
            Some("network".to_string()),
        )
    }
}

/// Event outlet the engine reports through. The Tauri layer maps these to
/// the `download-progress` / `download-retrying` events; tests collect
/// them in memory. Keeping emission behind this trait is what makes the
/// whole engine runnable without an AppHandle.
pub(crate) trait ProgressSink: Send + Sync {
    fn progress(&self, payload: ProgressPayload);
    fn retrying(&self, payload: RetryPayload);
}

/// Everything one download attempt needs, bundled so the runner keeps a
/// readable signature and new knobs don't grow the parameter list forever.
#[derive(Clone)]
pub(crate) struct DownloadPlan {
    /// Admitted by `network_policy::UrlPolicy::executable_download()` in
    /// `start_download` before this plan could ever exist. The engine never
    /// re-validates: it cannot construct one of these itself, and every
    /// request it makes goes through [`DownloadPlan::client`], which is the
    /// policy-built client (validated per-hop redirects, public-address-only
    /// connections, no whole-request timeout).
    pub(crate) url: crate::network_policy::ValidatedUrl,
    /// The HTTP client for every request of this download chain (initial
    /// attempt, automatic retries, resumes). Built once by the Tauri layer
    /// from the executable-download policy; the engine's own tests inject a
    /// plain loopback client so the mock-server suite can run.
    pub(crate) client: reqwest::Client,
    pub(crate) requested_name: Option<String>,
    pub(crate) dir: PathBuf,
    pub(crate) resume: bool,
    pub(crate) expected_sha256: Option<String>,
    /// Same contract for vendors that publish SHA-512 instead (Signal
    /// desktop's electron-updater manifests, Proton's version.json). At
    /// most one of the two is supplied per asset by any honest vendor;
    /// if both arrive, both must hold for the file to be trusted.
    pub(crate) expected_sha512: Option<String>,
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
/// The staging sink is always [`DiskStaging`] in production; the seam is
/// injected only by tests, to drive the mid-write disk-failure branch
/// deterministically (see `DiskFullAfter` in the test module).
///
/// Error kinds returned in the `(message, kind)` pair:
/// - `Some("network")` - transient, the retry loop may re-attempt
///   (connection failures, a silent server, stalls, short transfers, and
///   the transient server statuses 429/502/503/504);
/// - `Some("checksum")` / `Some("resume-invalid")` - final, staging bytes
///   were discarded, never retried automatically;
/// - `None` - final (disk, protocol, refused-redirect, or deterministic
///   server-status errors);
/// - the [`CANCEL_SENTINEL`] message - cancelled, staging bytes kept.
async fn run_download_on<E: ProgressSink, S: StagingSink>(
    events: &E,
    session: &DownloadSession,
    id: u32,
    plan: DownloadPlan,
    cancel_rx: &mut mpsc::Receiver<()>,
    staging_out: &mut Option<PathBuf>,
    // Named `sink` to stay distinct from the plan's `staging` field (the
    // path of a previous attempt), which this function destructures.
    sink: &S,
) -> Result<CompletePayload, (String, Option<String>)> {
    let DownloadPlan {
        url,
        client,
        requested_name,
        dir,
        resume,
        expected_sha256,
        expected_sha512,
        staging,
    } = plan;
    // The out-param describes THIS attempt only.
    *staging_out = None;

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
                if m.url == url.as_str() {
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
            // assembled file anyway (expected_sha256 / expected_sha512,
            // which catch the mixture at completion), the only sound move
            // is to discard the staging bytes and start over.
            let checksum_will_verify = expected_sha256
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_some()
                || expected_sha512
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

    let mut request = client.get(url.raw().clone());
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
    // The wait for the response is cancellable and bounded. The policy
    // client's connect timeout bounds TCP/TLS setup, but the wait for the
    // response line + headers on an established connection used to be
    // unbounded: a server that accepted and never answered held the
    // download in Downloading forever, and cancellation - observed only in
    // the body loop and the retry backoff - could not stop it. The window
    // is the same 60 s policy as the body stall below, one phase earlier.
    let first: reqwest::Response = tokio::select! {
        biased;
        _ = cancel_rx.recv() => {
            // Deliberate stop before a single byte moved: the response
            // gate precedes the staging reservation, so there is nothing
            // on disk to clean up.
            let _ = session.advance(DownloadState::Cancelled).await;
            return Err((CANCEL_SENTINEL.to_string(), None));
        }
        answer = tokio::time::timeout(FIRST_RESPONSE_TIMEOUT, request.send()) => match answer {
            Ok(result) => result.map_err(classify_send_error)?,
            Err(_) => {
                return Err((
                    "No response from the server for 60s; the connection was given up"
                        .to_string(),
                    Some("network".to_string()),
                ))
            }
        },
    };

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
            sink.open(p, StagingOpenMode::Append)
                .await
                .map_err(|e| (format!("Cannot reopen partial download: {}", e), None))?
        } else {
            sink.open(p, StagingOpenMode::Truncate)
                .await
                .map_err(|e| (format!("Cannot write file: {}", e), None))?
        };
        (candidate.clone(), p.clone(), f)
    } else {
        // Fresh download: atomically reserve a staging file for ourselves.
        let mut reserved: Option<(PathBuf, PathBuf, S::Writer)> = None;
        for i in 0..10_000u32 {
            let candidate = dir.join(numbered_name(&name, i));
            let p = part_path_for(&candidate);
            match sink.open(&p, StagingOpenMode::CreateNew).await {
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
    write_part_meta(&part, url.as_str(), &headers).await;

    let mut hasher = Sha256::new();
    let mut hasher512 = Sha512::new();
    // Seed the digests with the bytes from the earlier attempt so the final
    // hashes cover the complete file, not just the resumed tail.
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
            hasher512.update(&buf[..n]);
        }
    }

    let mut stream = first.bytes_stream();
    let mut downloaded: u64 = already_have;
    // Display-only total (progress/ETA): a hostile Content-Length near
    // u64::MAX must not overflow the sum; saturating keeps the bar honest
    // without any panic surface. The COMPLETION decision below uses the
    // exact promise, never this display value.
    let total = if remote_len > 0 {
        remote_len.saturating_add(already_have)
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
            // instead of restarting from zero. The bytes this attempt
            // accepted are flushed FIRST: the sink buffers, and a
            // background drop-flush could still be pending when the next
            // attempt (or the user's Resume) measures the file - a resume
            // from a stale length would duplicate or drop bytes nothing
            // can account for. Same invariant as the disk-error path.
            let _ = file.flush().await;
            drop(file);
            let _ = session.advance(DownloadState::Cancelled).await;
            return Err((CANCEL_SENTINEL.to_string(), None));
        }
        chunk = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => {
            match chunk {
                Ok(c) => c,
                Err(_) => {
                    // No bytes for a full minute: treat the connection as
                    // dead. The .part stays on disk for the Resume button
                    // - and for the automatic retry that follows within
                    // seconds, so the accepted bytes are flushed before
                    // this attempt reports the stall (same invariant as
                    // the disk-error path).
                    let _ = file.flush().await;
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
                // The connection died mid-body; the transfer continues on
                // the next attempt from the .part file. Flush the accepted
                // bytes first so the retry's resume probe reads the true
                // received length (same invariant as the disk-error path).
                let _ = file.flush().await;
                drop(file);
                return Err((
                    format!("Download interrupted: {}", e),
                    Some("network".to_string()),
                ));
            }
        };
        hasher.update(&bytes);
        hasher512.update(&bytes);
        if let Err(e) = file.write_all(&bytes).await {
            // A local disk failure is FINAL: `kind` stays None so the
            // retry loop can never misread it as a transient server
            // problem. The OS reason travels with the message (an ENOSPC
            // "No space left on device" is actionable; a bare "failed"
            // is not). The staging file is intentionally KEPT: a full
            // disk is recoverable, and the .part resumes from exactly
            // the bytes that made it to disk (see the cleanup policy).
            // The bytes the sink already accepted must be ON DISK when
            // this returns: tokio::fs::File buffers, and its drop-flush
            // runs asynchronously in the background, so a caller that
            // inspects the .part right after the failure could observe a
            // shorter file and compute a wrong resume offset. Flushing
            // here only persists bytes the sink ACCEPTED; a flush that
            // cannot land (disk genuinely full) keeps the original error.
            let _ = file.flush().await;
            drop(file);
            return Err((format!("Disk write failed: {}", e), None));
        }
        // The running byte count must stay representable like every other
        // server-reachable sum: a wrapped counter would poison the exact
        // completion equality check below. No real transfer can overflow
        // u64 here (the 60 s stall window and disk-bound writes make an
        // 18-exabyte stream physically impossible), so an overflow is a
        // broken counter, not a bandwidth event - refuse the attempt.
        let Some(new_downloaded) = downloaded.checked_add(bytes.len() as u64) else {
            drop(file);
            return Err((
                "Byte count overflowed; the download was refused".to_string(),
                None,
            ));
        };
        downloaded = new_downloaded;

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
        // Cancellation wins the completion decision; the accepted bytes
        // are flushed so the .part the user will Resume from holds the
        // full received length (same invariant as the other stop paths).
        let _ = file.flush().await;
        drop(file);
        let _ = session.advance(DownloadState::Cancelled).await;
        return Err((CANCEL_SENTINEL.to_string(), None));
    }

    file.flush()
        .await
        .map_err(|e| (format!("Disk write failed: {}", e), None))?;
    // Durability: the bytes reach the disk before the file is committed
    // under its final name, so a power cut cannot leave a truncated file
    // behind a completed-looking name. ENOSPC regularly surfaces HERE
    // rather than at write time, so the same final, non-retryable
    // categorization applies.
    file.sync_all()
        .await
        .map_err(|e| (format!("Disk write failed: {}", e), None))?;
    drop(file);

    // EOF is not completion: a connection that closed early used to look
    // exactly like a finished download ("server said 10MB, delivered 7MB,
    // Fress said done"). Compare what arrived against what the response
    // promised - the Content-Range tail for a 206, the Content-Length for
    // a full 200 body - and refuse to finalize a truncated file. The
    // .part survives so Resume can fetch exactly the missing bytes.
    let expected_downloaded: Option<u64> = match expected_range_len {
        Some(range_len) => {
            // The sum must be representable: a hostile `Content-Range` end
            // near u64::MAX validated against a large staging prefix could
            // overflow here. That is a protocol violation, not a length -
            // refuse the transfer instead of wrapping (release) or panicking
            // (overflow-checks builds).
            match already_have.checked_add(range_len) {
                Some(sum) => Some(sum),
                None => {
                    // The refusal fires AFTER this attempt's tail bytes were
                    // appended to the staging file and this response's
                    // validators were recorded, so the .part currently holds
                    // an honest prefix plus a tail the server's own header
                    // makes unaccountable. Keeping it (resumable, with those
                    // validators) would let a later byte-identity resume glue
                    // the poisoned tail into a final file; a server that
                    // announces an impossible range has forfeited the byte
                    // accounting this design trusts. Discard the staging
                    // files entirely - the next attempt starts clean (the
                    // 416 path below discards for the same reason), and the
                    // error stays final (kind None) because there is nothing
                    // left to resume.
                    discard_staging(&part).await;
                    return Err((
                        "Server announced an impossible byte range; the download was refused"
                            .to_string(),
                        None,
                    ));
                }
            }
        }
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
    let digest512 = hasher512.finalize();
    let sha512_hex: String = digest512.iter().map(|b| format!("{:02x}", b)).collect();

    // Verification is a comparison against a trusted published value, not a
    // mere calculation. A mismatching file is rejected and removed: it must
    // never sit in the downloads folder looking finished.
    let mut verified: Option<bool> = match verify_digest(expected_sha256.as_deref(), &sha_hex) {
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

    // SHA-512 vendors (Signal desktop, Proton): same contract, second
    // algorithm. A vendor publishes at most one of the two per asset; if
    // both are published, both must hold. A mismatch here is exactly as
    // fatal as a SHA-256 mismatch - the staging bytes are gone.
    match verify_digest(expected_sha512.as_deref(), &sha512_hex) {
        Verification::TrustedMatch => verified = Some(true),
        Verification::Unverified => {}
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
    }

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

    // The commit is real: hand the verification boundary the record it
    // will scope the updater's signature check against (see the module
    // docs, "Completed-artifact registry"). Nothing after this point can
    // un-report the completion - the file is committed under its final
    // name and every exit from here returns Ok.
    session
        .registry
        .record_completed_artifact(id, &committed, url.as_str(), verified);

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
    plan: DownloadPlan,
    cancel_rx: mpsc::Receiver<()>,
    backoff: Duration,
) -> Result<CompletePayload, (String, Option<String>)> {
    execute_with_retries_on(events, session, id, plan, cancel_rx, backoff, &DiskStaging).await
}

/// [`execute_with_retries`] with the staging seam injected (test entry).
async fn execute_with_retries_on<E: ProgressSink, S: StagingSink>(
    events: &E,
    session: &DownloadSession,
    id: u32,
    mut plan: DownloadPlan,
    mut cancel_rx: mpsc::Receiver<()>,
    backoff: Duration,
    sink: &S,
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
        match run_download_on(
            events,
            session,
            id,
            plan.clone(),
            &mut cancel_rx,
            &mut resolved_staging,
            sink,
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

    fn sha512_hex(bytes: &[u8]) -> String {
        let mut h = Sha512::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn plan_for(url: &str, dir: &Path, name: Option<&str>) -> DownloadPlan {
        DownloadPlan {
            url: crate::network_policy::ValidatedUrl::for_tests(
                reqwest::Url::parse(url).expect("test url parses"),
            ),
            // A plain client, deliberately NOT the policy-built one: the
            // mock servers live on loopback, which the policy refuses by
            // design. The tests exercise transport behavior, not admission.
            client: reqwest::Client::new(),
            requested_name: name.map(str::to_string),
            dir: dir.to_path_buf(),
            resume: false,
            expected_sha256: None,
            expected_sha512: None,
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

    #[tokio::test]
    async fn an_oversized_part_meta_sidecar_reads_as_no_validators() {
        // The 64 KiB take() bound on read_part_meta: a corrupted or
        // tampered sidecar larger than the bound is truncated mid-JSON,
        // fails the parse, and reads as "no validators" - the same
        // fail-closed shape as a missing sidecar (the resume then discards
        // the staging unless a trusted checksum exists).
        let tmp = TempDir::new("meta-oversize");
        let part = tmp.path().join("f.bin.part");
        std::fs::write(&part, b"staged").unwrap();
        let meta = meta_path_for(&part);
        // Kill-test note: the oversized sidecar must be VALID JSON - a
        // malformed one would fail the parse with or without the take()
        // bound, and the assertion would pass for the wrong reason. A
        // well-formed document larger than the bound (an 80 KiB etag
        // value) is exactly the shape the bound exists to refuse: the
        // truncation cuts the string mid-value, the parse fails, and the
        // sidecar reads as "no validators". Removing the bound makes this
        // test fail (the huge-but-valid document parses and yields
        // validators) - verified by kill-test this round.
        let mut huge = String::from("{\"url\":\"https://example.com/f\",\"etag\":\"");
        huge.push_str(&"x".repeat(80 * 1024)); // > 64 KiB, still valid JSON when closed
        huge.push_str("\"}");
        std::fs::write(&meta, huge).unwrap();
        assert!(
            read_part_meta(&part).await.is_none(),
            "an oversized sidecar must read as no validators"
        );
        // A normal sidecar still reads fine.
        write_part_meta(&part, "https://example.com/f", &Default::default()).await;
        let read = read_part_meta(&part).await.expect("small meta reads");
        assert_eq!(read.url, "https://example.com/f");
    }

    #[test]
    fn a_hostile_u64_max_range_is_refused_not_wrapped_or_panicked() {
        // Regression: `end - start + 1` overflows when a hostile server
        // sends `end == u64::MAX`. The only header shape that reaches the
        // arithmetic is an unknown total (`/*`): an explicit total must be
        // strictly larger than the end, which no u64 can be. Under
        // overflow-checks builds this used to panic; without them the length
        // silently wrapped to 0 and poisoned the completion decision. The
        // header is now refused as malformed instead - a named error, in
        // both profiles.
        let err = validate_resume_content_range("bytes 0-18446744073709551615/*", 0)
            .expect_err("a u64::MAX range must be refused");
        assert!(err.contains("too large"), "unexpected error: {err}");
        // A start offset inside the range keeps the length representable
        // here - the poisoned SUM (`already_have + range_len`) is refused by
        // the second checked layer in run_download_on, pinned end to end by
        // `a_hostile_u64_max_content_range_fails_named_without_completing`.
        assert!(validate_resume_content_range("bytes 5-18446744073709551615/*", 5).is_ok());
        // An explicit total equal to the end is refused by the pre-existing
        // sanity check before the arithmetic is ever reached.
        assert!(validate_resume_content_range(
            "bytes 0-18446744073709551615/18446744073709551615",
            0
        )
        .is_err());
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
        // empty file. Every other status must fail as well. (429/502/503/
        // 504 also fail the ATTEMPT, but as RETRYABLE failures - see
        // transient_server_statuses_are_retryable.)
        for status in [201, 202, 203, 204, 205, 226, 301, 302, 403, 404, 500, 501] {
            match evaluate_response(status, None, 0) {
                ResponsePlan::Fail { message, kind } => {
                    assert_eq!(message, format!("Server returned HTTP {}", status));
                    assert_eq!(kind, None);
                }
                other => panic!("expected Fail for {}, got {:?}", status, other),
            }
        }
    }

    #[test]
    fn transient_server_statuses_are_retryable_and_deterministic_ones_are_not() {
        // 429 and the 5xx gateway/overload family answer differently
        // seconds later: the retry loop exists for exactly these, so the
        // failure must carry kind "network". Every other status is
        // deterministic and stays final - retrying a 404 can only
        // reproduce it.
        for status in [429u16, 502, 503, 504] {
            match evaluate_response(status, None, 0) {
                ResponsePlan::Fail { message, kind } => {
                    assert_eq!(message, format!("Server returned HTTP {}", status));
                    assert_eq!(kind, Some("network".to_string()));
                }
                other => panic!("expected retryable Fail for {}, got {:?}", status, other),
            }
        }
        for status in [400u16, 403, 404, 408, 410, 418, 500, 501, 505] {
            match evaluate_response(status, None, 0) {
                ResponsePlan::Fail { kind, .. } => {
                    assert_eq!(kind, None, "{} must stay final", status);
                }
                other => panic!("expected final Fail for {}, got {:?}", status, other),
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

    #[tokio::test]
    async fn a_validator_less_resume_never_sends_a_range_request_or_glues_a_tail() {
        // Kill-test closure for the byte-identity rule (round 3 audit). The
        // sibling test above drives the 200-answer shape, where the truncate
        // path ALSO removes the unprovable prefix - so disabling the rule
        // does NOT fail that test (found by executing the kill-test this
        // round: the guard was deleted and the named test still passed). The
        // dangerous shape is a server that answers the resume's `Range` with
        // a 206: only the rule's discard-BEFORE-request prevents an
        // unprovable prefix from being glued to a hostile tail and
        // finalized. This test pins that exact ordering: after the discard,
        // the request must go out with NO Range header, the 206 must be
        // refused as a partial body for a range-less request, and the
        // poisoned hybrid must exist nowhere - not as a staging file, not as
        // a completed artifact, not as a registry record.
        let tmp = TempDir::new("no-validator-206");
        let part = tmp.path().join("file.bin.part");
        tokio::fs::write(&part, b"12345").await.unwrap();
        let headers = reqwest::header::HeaderMap::new(); // no validators
        write_part_meta(&part, "https://example.com/file.bin", &headers).await;
        assert!(read_part_meta(&part).await.is_some());

        // Hostile/broken origin: answers ANY request with a 206 continuing
        // exactly from the staged length (5) - the glue shape a full-200
        // server can never produce.
        let server = spawn_mock(vec![MockReply::partial_206("bytes 5-14/15", &pattern(10))]);
        let plan = DownloadPlan {
            resume: true,
            ..plan_for(&server.url, tmp.path(), Some("file.bin"))
        };
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let result = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff()).await;

        // Fail closed: the 206 is refused (a partial body for a request
        // that asked for no range).
        assert!(
            result.is_err(),
            "a 206 to a range-less request must be refused"
        );
        // The discard happened BEFORE the request: no staging byte or
        // sidecar survived.
        assert!(
            !part.exists(),
            "validator-less staging must be discarded before the resume request"
        );
        assert!(!meta_path_for(&part).exists());
        // The poisoned hybrid never reached a completed file...
        assert!(
            !tmp.path().join("file.bin").exists(),
            "an unprovable prefix plus a hostile tail must never be committed"
        );
        // ...and the one request the server saw carried NO Range header.
        let head = request_head(&server, 0);
        assert!(
            !head.contains("range:"),
            "the request must not carry a Range header after the discard: {head:?}"
        );
        // No completed-artifact record for a download that never committed.
        assert_eq!(session.registry.completed_len(), 0);
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
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
        /// After the hold, write the REST of the body and close: the
        /// transfer pauses mid-stream and resumes on the SAME connection.
        /// Used to prove a cancel signalled while the tail is provably
        /// still in flight wins over the completion decision.
        resume_body_after_hold: bool,
        /// Validator-aware replies: when set, the request's `If-Range`
        /// header is compared against the validator the origin currently
        /// serves and the matching or mismatching scripted reply is sent.
        /// This is how a conforming origin behaves: an unchanged resource
        /// answers a range request with 206, a REPLACED one falls back to
        /// a full 200 so the client never glues an old prefix onto a new
        /// suffix.
        if_range: Option<Box<IfRangeSwitch>>,
    }

    struct IfRangeSwitch {
        /// The validator (ETag / Last-Modified, quoted as on the wire) the
        /// origin currently serves.
        current: String,
        on_match: Box<MockReply>,
        on_mismatch: Box<MockReply>,
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
                resume_body_after_hold: false,
                if_range: None,
            }
        }

        /// Serve `on_match` when the request's If-Range equals `current`,
        /// `on_mismatch` otherwise (a changed resource must answer with a
        /// fresh full body, never a 206 tail of the old one).
        fn switch_on_if_range(current: &str, on_match: MockReply, on_mismatch: MockReply) -> Self {
            MockReply {
                if_range: Some(Box::new(IfRangeSwitch {
                    current: current.to_string(),
                    on_match: Box::new(on_match),
                    on_mismatch: Box::new(on_mismatch),
                })),
                ..MockReply::raw("HTTP/1.1 302 Found", Vec::new(), Vec::new())
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
        /// Number of responses fully written onto the wire. The request
        /// log alone does not prove the response bytes left the server:
        /// paused-clock tests must wait for this counter BEFORE advancing
        /// virtual time, or a response-window deadline can outrun the
        /// real-time socket write.
        served: Arc<std::sync::atomic::AtomicUsize>,
    }

    fn spawn_mock(replies: Vec<MockReply>) -> MockServer {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let requests: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let req_log = Arc::clone(&requests);
        let served_log = Arc::clone(&served);
        std::thread::spawn(move || {
            for reply in replies {
                let (stream, _) = match listener.accept() {
                    Ok(x) => x,
                    Err(_) => return,
                };
                serve_one(stream, &reply, &req_log, &served_log);
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
            served,
        }
    }

    fn serve_one(
        mut stream: std::net::TcpStream,
        reply: &MockReply,
        req_log: &StdMutex<Vec<String>>,
        served: &std::sync::atomic::AtomicUsize,
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

        // If-Range-aware serving: pick the reply this request earned
        // before any header/body bytes go out. Nested switches are not
        // evaluated (the sub-replies are plain scripted replies).
        let request_head_lower = String::from_utf8_lossy(&buf).to_ascii_lowercase();
        let effective: &MockReply = match &reply.if_range {
            Some(sw) => {
                let sent = request_head_lower
                    .split("if-range:")
                    .nth(1)
                    .and_then(|rest| rest.lines().next())
                    .map(str::trim)
                    .unwrap_or("");
                let current = sw.current.to_ascii_lowercase();
                if sent.eq_ignore_ascii_case(&current) {
                    &sw.on_match
                } else {
                    &sw.on_mismatch
                }
            }
            None => reply,
        };

        let mut head = String::new();
        head.push_str(effective.status_line);
        head.push_str("\r\n");
        for (k, v) in &effective.headers {
            head.push_str(&format!("{}: {}\r\n", k, v));
        }
        head.push_str("Connection: close\r\n\r\n");
        let _ = stream.write_all(head.as_bytes());
        let limit = effective
            .send_body_bytes
            .unwrap_or(effective.body.len())
            .min(effective.body.len());
        let _ = stream.write_all(&effective.body[..limit]);
        let _ = stream.flush();
        // The response bytes are on the wire. Paused-clock tests wait for
        // this marker before they advance virtual time (see
        // wait_until_served).
        served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if effective.hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(effective.hold_ms));
        }
        if effective.resume_body_after_hold && limit < effective.body.len() {
            // Release the held tail onto the same connection, then close.
            let _ = stream.write_all(&effective.body[limit..]);
            let _ = stream.flush();
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

    /// Wait (in REAL time, via scheduler yields) until the mock has fully
    /// written `n` responses onto the wire. A paused-clock test must call
    /// this before it advances virtual time: once the response bytes sit
    /// in the client's socket buffer, send() completes on its next poll
    /// and no response-window deadline can outrun them - the clock only
    /// governs timers, never the socket data already delivered.
    async fn wait_until_served(server: &MockServer, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.served.load(std::sync::atomic::Ordering::SeqCst) < n {
            assert!(
                Instant::now() < deadline,
                "mock did not write {n} responses in real time"
            );
            tokio::task::yield_now().await;
        }
    }

    /// Wait (in REAL time, via scheduler yields) until `path` exists.
    /// Companion to `wait_until_served`: bytes on the wire still need the
    /// engine to be POLLED before they turn into a response + a staging
    /// file, and on a slower scheduler (macOS arm64 runners) the paused
    /// clock can fire the response window before those polls happen -
    /// the attempt then fails as no-response with nothing on disk, which
    /// is a different shape than the test under the pause intends to
    /// exercise. Waiting for the staging open pins the ordering every
    /// file-level assertion below assumes.
    async fn wait_until_exists(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if tokio::fs::metadata(path).await.is_ok() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{path:?} never appeared in real time"
            );
            tokio::task::yield_now().await;
        }
    }

    /// A loopback server that accepts connections and NEVER answers: the
    /// pure hung-server shape the response window and the cancellable
    /// initial request exist for. Each connection is held open in a
    /// background thread; the threads die with the test process.
    fn spawn_silent_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        std::thread::spawn(move || {
            while let Ok((stream, _)) = listener.accept() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(120));
                    drop(stream);
                });
            }
        });
        format!("http://{}/silent.bin", addr)
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
    async fn a_hostile_u64_max_content_range_fails_named_without_completing() {
        // End-to-end regression for the hostile-`Content-Range` overflow:
        // a resumed download whose server answers a verified-offset 206
        // with `end == u64::MAX`. The representable-but-poisoned length
        // (`600 + range_len` overflows u64) is refused at the completion
        // decision with a named protocol error - never a panic (overflow-
        // checks builds), never a silent wrap into a completion, no
        // destination file and no completed-artifact record.
        let tmp = TempDir::new("e2e-hostile-range");
        let server = spawn_mock(vec![MockReply::partial_206(
            "bytes 600-18446744073709551615/*",
            b"tail-bytes",
        )]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &pattern(600)).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let err = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect_err("a u64::MAX Content-Range must fail the attempt");
        assert!(
            err.0.contains("impossible byte range"),
            "unexpected: {err:?}"
        );
        // A named protocol violation is final - no automatic retry.
        assert_eq!(err.1, None, "unexpected: {err:?}");
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(!tmp.path().join("setup.exe").exists());
        // No completed-artifact record either: a refused transfer never
        // reaches the commit path.
        assert_eq!(session.registry.completed_len(), 0);
        // And the staging files are GONE: the refusal fires after the
        // hostile tail was appended and the response's validators were
        // recorded, so what is on disk is honest-prefix + unaccountable
        // tail. Keeping it would let a later byte-identity resume glue the
        // poisoned tail into the final file; the discard leaves the next
        // attempt a clean start (pinned since the staging-poison fix).
        assert!(!part.exists(), "the poisoned .part must be discarded");
        assert!(
            !meta_path_for(&part).exists(),
            "the poisoned sidecar must be discarded"
        );
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
    async fn a_mismatched_start_content_range_discards_the_staged_bytes() {
        // End-to-end filesystem pin for the THIRD hostile-resume shape: a
        // server that answers the bytes=600- request with a 206 claiming a
        // DIFFERENT offset (bytes 999-...). evaluate_response refuses it
        // before any byte of the hostile body is written, and the discard
        // must leave NOTHING resumable on disk - neither the staged bytes
        // nor the validator sidecar (the plan-level decision is pinned by
        // evaluate_206_mismatched_start_discards_staging; this proves the
        // engine's side effect, like the u64::MAX and 416 tests above).
        let tmp = TempDir::new("e2e-mismatched-start");
        let server = spawn_mock(vec![MockReply::partial_206(
            "bytes 999-1099/1100",
            b"hostile-tail",
        )]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &pattern(600)).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let err = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect_err("a mismatched resume offset must fail the attempt");
        assert!(
            err.0.contains("resumed at offset"),
            "the offset mismatch must be named: {err:?}"
        );
        assert_eq!(err.1.as_deref(), Some("resume-invalid"));
        // Final error, no destination, no completed record, nothing on disk.
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(!tmp.path().join("setup.exe").exists());
        assert_eq!(session.registry.completed_len(), 0);
        assert!(!part.exists(), "the staged bytes must be discarded");
        assert!(
            !meta_path_for(&part).exists(),
            "the validator sidecar must be discarded"
        );
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
    async fn sha512_mismatch_deletes_the_artifact_exactly_like_sha256() {
        let tmp = TempDir::new("e2e-checksum512");
        let body = pattern(400);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);

        let mut plan = plan_for(&server.url, tmp.path(), Some("app.exe"));
        plan.expected_sha512 = Some(sha512_hex(b"not the payload"));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a SHA-512 mismatch must fail");
        assert_eq!(kind.as_deref(), Some("checksum"));
        assert!(message.contains("Integrity check failed"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(!tmp.path().join("app.exe").exists());
        assert!(!tmp.path().join("app.exe.part").exists());
        assert!(!tmp.path().join("app.exe.part.meta").exists());
    }

    #[tokio::test]
    async fn sha512_match_reports_verified_without_any_sha256_reference() {
        let tmp = TempDir::new("e2e-checksum512-ok");
        let body = pattern(400);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);

        let mut plan = plan_for(&server.url, tmp.path(), Some("app.exe"));
        // Uppercase on purpose: normalization must be algorithm-agnostic.
        plan.expected_sha512 = Some(sha512_hex(&body).to_uppercase());
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a matching trusted SHA-512 must complete");
        assert_eq!(payload.verified, Some(true));
    }

    #[tokio::test]
    async fn both_checksums_supplied_means_both_must_hold() {
        let tmp = TempDir::new("e2e-checksum-both");
        let body = pattern(400);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);

        let mut plan = plan_for(&server.url, tmp.path(), Some("app.exe"));
        plan.expected_sha256 = Some(sha256_hex(&body));
        // The SHA-256 matches but the SHA-512 does not: the file is a lie
        // no matter which single digest it satisfies.
        plan.expected_sha512 = Some(sha512_hex(b"different payload"));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a SHA-512 mismatch must fail even with a matching SHA-256");
        assert_eq!(kind.as_deref(), Some("checksum"));
        assert!(message.contains("Integrity check failed"));
        assert!(!tmp.path().join("app.exe").exists());
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

        // Cancel once the staging file provably holds the first sent
        // chunk (4 KiB) ON DISK. Cancelling on the first progress EVENT
        // races the stream itself: reqwest may deliver the 4096 sent
        // bytes as several smaller chunks, so the first event can fire
        // long before 4096 bytes are staged, which made the assertion
        // below flaky. Bytes on disk are the thing this test cares about.
        let watcher_part = tmp.path().join("big.bin.part");
        let watcher_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let staged = tokio::fs::metadata(&watcher_part)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                if staged >= 4096 || Instant::now() > deadline {
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

    // -----------------------------------------------------------------------
    // Adversarial additions (Agent 3 hardening round)
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn a_transfer_with_no_data_for_the_stall_window_is_not_finalized() {
        // The mock promises 100 KB, delivers 1 KiB, then holds the socket.
        // Paused time lets the 60s stall window fire deterministically: the
        // attempt must fail as a RETRYABLE network stall (the .part stays
        // resumable), the retry names the stall, and after the retry budget
        // is spent the download lands in Failed - never a partial file.
        let tmp = TempDir::new("e2e-stall");
        let mut first = MockReply::full_200(&pattern(100_000));
        first.send_body_bytes = Some(1024);
        first.hold_ms = 30_000; // real-time hold; the paused clock is ours
        let server = spawn_mock(vec![first]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let task_session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());
        let task_log = Arc::clone(&log);
        let plan = plan_for(&server.url, tmp.path(), Some("stall.bin"));

        let task = tokio::spawn(async move {
            execute_with_retries(&task_log, &task_session, 1, plan, cancel_rx, test_backoff()).await
        });

        // The response (head + 1 KiB of body) must be on the wire before
        // the clock starts: the attempt registers its 60s windows when it
        // is first polled, and virtual time must not outrun the real
        // socket write. After the stall window fires, the retries run to
        // their final state against the exhausted mock.
        wait_until_served(&server, 1).await;
        tokio::time::advance(Duration::from_secs(61)).await;
        for _ in 0..4000 {
            tokio::time::advance(Duration::from_millis(50)).await;
            if task.is_finished() {
                break;
            }
        }
        let result = task.await.expect("retry loop must finish");
        assert!(result.is_err(), "a stalled download must never complete");
        assert_eq!(result.unwrap_err().1.as_deref(), Some("network"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));

        // The retries are the stall itself, named as such, followed by the
        // retry's connection failure against the exhausted mock.
        let retries = log.retries.lock().unwrap();
        assert_eq!(retries.len(), 2);
        assert!(
            retries[0].message.contains("Connection stalled"),
            "the first retry must name the stall, got: {}",
            retries[0].message
        );
        assert!(
            tmp.path().join("stall.bin.part").exists(),
            "the staging file must survive a stall (resumable)"
        );
        assert!(!tmp.path().join("stall.bin").exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_server_is_abandoned_after_the_response_window_and_retried() {
        // A server that accepts the connection but never sends a response
        // must not wedge the download: the wait for the response head is
        // bounded by the same 60 s policy as the body stall. On the paused
        // clock every attempt burns exactly one window, so all three
        // attempts fail as RETRYABLE network timeouts and the download
        // lands in Failed with the named reason - never a hang, never a
        // partial file (the response gate precedes the staging
        // reservation, so nothing was ever written).
        let tmp = TempDir::new("e2e-response-window");
        let silent = spawn_silent_server();
        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let task_session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());
        let task_log = Arc::clone(&log);
        let plan = plan_for(&silent, tmp.path(), Some("silent.bin"));

        let task = tokio::spawn(async move {
            execute_with_retries(&task_log, &task_session, 1, plan, cancel_rx, test_backoff()).await
        });

        // Cross the first response window, then keep advancing: each
        // retry burns one more 60 s window before the budget is spent.
        tokio::time::advance(Duration::from_secs(61)).await;
        for _ in 0..8000 {
            tokio::time::advance(Duration::from_millis(50)).await;
            if task.is_finished() {
                break;
            }
        }
        let result = task.await.expect("retry loop must finish");
        assert!(result.is_err(), "a silent server must never complete");
        assert_eq!(result.unwrap_err().1.as_deref(), Some("network"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));

        let retries = log.retries.lock().unwrap();
        assert_eq!(
            retries.len(),
            2,
            "both automatic retries must fire against the silent server"
        );
        assert!(
            retries[0].message.contains("No response from the server"),
            "the retry must name the silent server, got: {}",
            retries[0].message
        );
        // Nothing was ever written: the response gate precedes the
        // staging reservation.
        assert!(!tmp.path().join("silent.bin.part").exists());
        assert!(!tmp.path().join("silent.bin").exists());
    }

    #[tokio::test]
    async fn a_cancel_while_waiting_for_the_response_stops_the_download() {
        // Cancellation used to be observed only once the body started
        // streaming; a cancel signalled while the attempt was still
        // waiting for the response was invisible (and against a hung
        // server it was invisible FOREVER). The wait is now a select arm:
        // a signal latched before the request even starts must win
        // without the response ever arriving.
        let tmp = TempDir::new("e2e-cancel-silent-server");
        let silent = spawn_silent_server();
        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        registry.request_cancel(id).await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = EventLog::default();
        let plan = plan_for(&silent, tmp.path(), Some("silent.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a cancelled download must not complete");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));
        assert!(!tmp.path().join("silent.bin").exists());
        assert!(!tmp.path().join("silent.bin.part").exists());
    }

    #[tokio::test]
    async fn a_transient_503_is_retried_and_the_download_completes() {
        // 502/503/504/429 are transient server-side conditions: the
        // engine's retry loop exists for exactly these. Two overload
        // answers followed by the real body must complete the download -
        // they used to be final failures the user had to retry by hand.
        let tmp = TempDir::new("e2e-503-retry");
        let body = pattern(2_000);
        let unavailable = || {
            MockReply::raw(
                "HTTP/1.1 503 Service Unavailable",
                vec![("Content-Length", "0".to_string())],
                Vec::new(),
            )
        };
        let server = spawn_mock(vec![
            unavailable(),
            unavailable(),
            MockReply::full_200(&body),
        ]);

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("flaky.bin"));

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("transient 503s must be retried, not fatal");
        assert_eq!(payload.bytes, body.len() as u64);
        assert_eq!(
            tokio::fs::read(tmp.path().join("flaky.bin")).await.unwrap(),
            body
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));
        let retries = log.retries.lock().unwrap();
        assert_eq!(retries.len(), 2);
        assert!(
            retries[0].message.contains("503"),
            "the retry must name the server status, got: {}",
            retries[0].message
        );
    }

    #[tokio::test]
    async fn a_deterministic_404_is_never_retried() {
        // The transient-status classification must not leak into
        // deterministic statuses: a 404 answers identically on every
        // attempt, so the retry budget must not be burned on it.
        let tmp = TempDir::new("e2e-404-final");
        let server = spawn_mock(vec![MockReply::raw(
            "HTTP/1.1 404 Not Found",
            vec![("Content-Length", "0".to_string())],
            Vec::new(),
        )]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("gone.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a 404 is deterministic and final");
        assert_eq!(kind, None);
        assert!(message.contains("404"));
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "a deterministic status must not burn retry attempts"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(!tmp.path().join("gone.bin").exists());
    }

    #[tokio::test]
    async fn a_redirect_policy_refusal_is_final_and_named_not_retried() {
        // The download client's redirect policy refuses hops with
        // attempt.error(...) (network_policy's decisions), which reqwest
        // surfaces as an error with is_redirect() == true. The refusal is
        // DETERMINISTIC - the same chain fails the same way every time -
        // so the attempt must fail FINALLY (no retry budget burned, no
        // second request) and the message must name the redirect refusal
        // instead of the generic "Connection failed" of a network blip.
        let tmp = TempDir::new("e2e-redirect-refusal");
        let server = spawn_mock(vec![MockReply::raw(
            "HTTP/1.1 302 Found",
            vec![
                ("Location", "http://127.0.0.1:9/elsewhere.bin".to_string()),
                ("Content-Length", "0".to_string()),
            ],
            Vec::new(),
        )]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let mut plan = plan_for(&server.url, tmp.path(), Some("hop.bin"));
        plan.client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                attempt.error(std::io::Error::other(
                    "redirect downgraded to non-https scheme \"http\"",
                ))
            }))
            .build()
            .expect("test client builds");

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a refused redirect must fail the attempt");
        assert_eq!(
            kind, None,
            "a deterministic refusal must not be classified as transient"
        );
        assert!(
            message.contains("redirect"),
            "the message must name the redirect refusal, got: {message}"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "a refused redirect must not be retried"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
    }

    #[tokio::test]
    async fn a_cancel_signalled_before_the_transfer_cannot_report_success() {
        // The cancellation channel is latched BEFORE the engine runs. The
        // biased select sees the pending signal on the very first loop
        // iteration, so no byte is processed and the final checkpoint
        // (try_recv) would catch it even then: the download must land in
        // Cancelled with nothing at the final name.
        let tmp = TempDir::new("e2e-pre-cancel");
        let mut first = MockReply::full_200(&pattern(10_000));
        first.send_body_bytes = Some(2048);
        first.hold_ms = 800;
        let server = spawn_mock(vec![first]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        registry.request_cancel(id).await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("early.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a pre-cancelled download must not complete");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));
        assert!(!tmp.path().join("early.bin").exists());
    }

    #[tokio::test]
    async fn a_corrupted_sidecar_is_discarded_instead_of_trusted() {
        // "{not json" parses to nothing: no validator is carried into the
        // resume request, and (without a trusted checksum) the byte-identity
        // rule refuses to resume staging bytes whose origin cannot be
        // proven. The download restarts cleanly from zero.
        let tmp = TempDir::new("e2e-bad-sidecar");
        let full = pattern(500);
        let server = spawn_mock(vec![MockReply::full_200(&full)]);
        let part = tmp.path().join("file.bin.part");
        tokio::fs::write(&part, b"UNPROVABLE-PREFIX").await.unwrap();
        tokio::fs::write(meta_path_for(&part), "{not json")
            .await
            .unwrap();

        let mut plan = plan_for(&server.url, tmp.path(), Some("file.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a corrupted sidecar must degrade to a fresh download");
        assert_eq!(payload.bytes, full.len() as u64);
        assert_eq!(
            tokio::fs::read(tmp.path().join("file.bin")).await.unwrap(),
            full
        );
        assert_eq!(payload.verified, None);
        let head = request_head(&server, 0);
        assert!(!head.contains("range:"), "must restart from byte zero");
        assert!(
            !head.contains("if-range:"),
            "a corrupted sidecar must not produce a validator"
        );
    }

    #[tokio::test]
    async fn a_sidecar_from_another_url_is_never_trusted_for_the_resume() {
        // The staging file belongs to a DIFFERENT resource than the one now
        // requested: its ETag is meaningless here, so it must neither be
        // sent as If-Range nor keep the staging bytes alive.
        let tmp = TempDir::new("e2e-sidecar-url");
        let full = pattern(500);
        let server = spawn_mock(vec![MockReply::full_200(&full)]);
        let part = tmp.path().join("file.bin.part");
        seed_staging(
            &part,
            "https://other.example/file.bin",
            Some("\"someone-elses-etag\""),
            b"FOREIGN-PREFIX",
        )
        .await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("file.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let _payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a foreign sidecar must degrade to a fresh download");
        assert_eq!(
            tokio::fs::read(tmp.path().join("file.bin")).await.unwrap(),
            full,
            "the assembled file must be exactly the requested resource"
        );
        // The foreign validator was neither sent as If-Range nor allowed to
        // keep the staging bytes alive: the request restarted from zero.
        let head = request_head(&server, 0);
        assert!(!head.contains("if-range:"));
        assert!(!head.contains("range:"));
        assert!(!part.exists(), "unprovable staging bytes must be discarded");
    }

    #[tokio::test]
    async fn resume_preserves_the_trusted_digest_and_reports_verified() {
        // The trusted digest travels through the resume path (and the
        // automatic retry loop, via the cloned plan) unchanged: a resumed
        // download that satisfies it completes as verified, not unverified.
        let tmp = TempDir::new("e2e-resume-digest");
        let full = pattern(1000);
        let server = spawn_mock(vec![MockReply::partial_206(
            "bytes 600-999/1000",
            &full[600..],
        )]);
        let part = tmp.path().join("setup.exe.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..600]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.resume = true;
        plan.expected_sha256 = Some(sha256_hex(&full));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a resumed download with a trusted digest must complete");
        assert_eq!(payload.verified, Some(true));
        assert_eq!(payload.sha256, sha256_hex(&full));
    }

    #[tokio::test]
    async fn an_auto_retry_keeps_the_trusted_digest_for_the_final_verdict() {
        // Truncated first attempt (retryable) + a trusted digest: the
        // retried attempt must still be judged against the SAME digest,
        // and the assembled file must complete as verified.
        let tmp = TempDir::new("e2e-retry-digest");
        let full = pattern(1000);
        let mut first = MockReply::full_200(&full);
        first.send_body_bytes = Some(400);
        let second = MockReply::partial_206("bytes 400-999/1000", &full[400..]);
        let server = spawn_mock(vec![first, second]);

        let mut plan = plan_for(&server.url, tmp.path(), Some("retry.bin"));
        plan.expected_sha256 = Some(sha256_hex(&full));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("the retry must complete the download");
        assert_eq!(payload.bytes, full.len() as u64);
        assert_eq!(payload.verified, Some(true));
        assert_eq!(log.retries.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_chunked_response_without_content_length_completes_at_eof() {
        // Real chunked framing: hyper decodes the chunks; the engine sees
        // the decoded stream and finalizes exactly the delivered bytes.
        let tmp = TempDir::new("e2e-chunked");
        let expected: Vec<u8> = pattern(512);
        let mut raw = Vec::new();
        for chunk in [&expected[..300], &expected[300..]] {
            raw.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            raw.extend_from_slice(chunk);
            raw.extend_from_slice(b"\r\n");
        }
        raw.extend_from_slice(b"0\r\n\r\n");
        let server = spawn_mock(vec![MockReply::raw(
            "HTTP/1.1 200 OK",
            vec![("Transfer-Encoding", "chunked".to_string())],
            raw,
        )]);

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("chunked.bin"));

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a chunked body must complete at the terminal chunk");
        assert_eq!(payload.bytes, expected.len() as u64);
        assert_eq!(
            tokio::fs::read(tmp.path().join("chunked.bin"))
                .await
                .unwrap(),
            expected
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unwritable_directory_fails_without_creating_artifacts() {
        // Permission errors surface as a final (non-retryable) failure
        // naming the problem, and leave NOTHING behind - not at the final
        // name, not as a staging file. Skips itself when running with
        // filesystem privileges that ignore directory permissions.
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("e2e-unwritable");
        let body = pattern(100);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        tokio::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o500))
            .await
            .unwrap();
        let probe = tmp.path().join(".probe");
        if std::fs::write(&probe, b"x").is_ok() {
            // Privileged environment (root): permissions don't apply.
            let _ = tokio::fs::remove_file(&probe).await;
            tokio::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
            return;
        }

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("denied.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("an unwritable directory must fail the download");
        assert!(
            message.contains("Cannot write file"),
            "unexpected error: {message}"
        );
        assert_eq!(kind, None, "a disk/permission error is final, not retried");
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(!tmp.path().join("denied.bin").exists());
        assert!(!tmp.path().join("denied.bin.part").exists());
        tokio::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
    }

    #[test]
    fn sidecars_cannot_carry_or_alter_the_trusted_digest() {
        // The .part.meta contract is exactly {url, etag, last_modified}.
        // There is no digest-shaped field: verification input comes ONLY
        // from the caller's DownloadPlan on every attempt, so no sidecar
        // (and no stale persisted state that survives in one) can ever
        // downgrade a trusted checksum to unverified or upgrade a plain
        // calculation to a verified match.
        let meta = PartMeta {
            url: "https://example.com/a".to_string(),
            etag: Some("\"e\"".to_string()),
            last_modified: None,
        };
        let json = serde_json::to_value(&meta).expect("sidecar serializes");
        let keys: Vec<String> = json
            .as_object()
            .expect("sidecar is an object")
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 3, "the sidecar shape is fixed: {keys:?}");
        for key in ["url", "etag", "last_modified"] {
            assert!(keys.iter().any(|k| k == key), "missing {key}");
        }
        for key in &keys {
            assert!(
                !key.to_ascii_lowercase().contains("sha"),
                "sidecar key {key} must never carry digest material"
            );
        }
        // Hand-edited or future sidecars with extra fields deserialize
        // harmlessly: unknown fields are ignored and cannot inject a
        // verification verdict.
        let extra = r#"{"url":"https://x/a","etag":"\"e\"","last_modified":null,"sha256":"00","verified":true}"#;
        let parsed: PartMeta = serde_json::from_str(extra).expect("unknown fields are ignored");
        assert_eq!(parsed.etag.as_deref(), Some("\"e\""));
        assert!(parsed.last_modified.is_none());
    }

    // -----------------------------------------------------------------------
    // Mid-write disk failure (injected write-failure point)
    // -----------------------------------------------------------------------

    /// Test-only staging sink that accepts exactly `budget` bytes across
    /// all its writes and then fails like a full disk. The bytes accepted
    /// BEFORE the failure are real bytes in the real `.part` file, so the
    /// filesystem assertions see exactly what a mid-write ENOSPC leaves
    /// behind: a truncated staging file and nothing at the final name.
    ///
    /// This is the "small injected writer" the disk-full gap needs - no
    /// dependency, no fabricated filesystem, and the production write
    /// loop, error categorization and cleanup policy are the ones being
    /// exercised.
    struct DiskFullAfter {
        budget: u64,
    }

    struct BudgetedWriter {
        inner: tokio::fs::File,
        remaining: u64,
    }

    impl PartWriter for BudgetedWriter {
        async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            let len = bytes.len() as u64;
            if len > self.remaining {
                // A real full disk accepts a partial write before failing,
                // so the budget is filled to the last byte first.
                let room = self.remaining as usize;
                if room > 0 {
                    // Qualified: PartWriter is also implemented for File,
                    // which would make the plain method call ambiguous.
                    tokio::io::AsyncWriteExt::write_all(&mut self.inner, &bytes[..room]).await?;
                    self.remaining = 0;
                }
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            tokio::io::AsyncWriteExt::write_all(&mut self.inner, bytes).await?;
            self.remaining -= len;
            Ok(())
        }
        async fn flush(&mut self) -> io::Result<()> {
            tokio::io::AsyncWriteExt::flush(&mut self.inner).await
        }
        async fn sync_all(&mut self) -> io::Result<()> {
            tokio::fs::File::sync_all(&self.inner).await
        }
    }

    impl StagingSink for DiskFullAfter {
        type Writer = BudgetedWriter;
        async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer> {
            let inner = match mode {
                StagingOpenMode::Append => {
                    tokio::fs::OpenOptions::new()
                        .append(true)
                        .open(part)
                        .await?
                }
                StagingOpenMode::Truncate => tokio::fs::File::create(part).await?,
                StagingOpenMode::CreateNew => {
                    tokio::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(part)
                        .await?
                }
            };
            Ok(BudgetedWriter {
                inner,
                remaining: self.budget,
            })
        }
    }

    /// Test-only staging sink that models exactly what the flush
    /// invariant is about: a writer whose accepted bytes are NOT on disk
    /// until flush() runs. tokio::fs::File behaves the same way (it
    /// buffers, and its drop-flush runs asynchronously in the
    /// background), so this sink turns "the next attempt must read the
    /// true received length" into a deterministic assertion: whatever the
    /// engine accepted is visible in the .part file right after the
    /// failure returns, or the invariant is broken.
    struct DeferredFlushSink;

    struct DeferredWriter {
        inner: tokio::fs::File,
        pending: Vec<u8>,
    }

    impl PartWriter for DeferredWriter {
        async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.pending.extend_from_slice(bytes);
            Ok(())
        }
        async fn flush(&mut self) -> io::Result<()> {
            if !self.pending.is_empty() {
                // Qualified: PartWriter is also implemented for File in
                // this module, which would make the plain call ambiguous.
                tokio::io::AsyncWriteExt::write_all(&mut self.inner, &self.pending).await?;
                self.pending.clear();
            }
            tokio::io::AsyncWriteExt::flush(&mut self.inner).await
        }
        async fn sync_all(&mut self) -> io::Result<()> {
            self.flush().await?;
            tokio::fs::File::sync_all(&self.inner).await
        }
    }

    impl StagingSink for DeferredFlushSink {
        type Writer = DeferredWriter;
        async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer> {
            let inner = match mode {
                StagingOpenMode::Append => {
                    tokio::fs::OpenOptions::new()
                        .append(true)
                        .open(part)
                        .await?
                }
                StagingOpenMode::Truncate => tokio::fs::File::create(part).await?,
                StagingOpenMode::CreateNew => {
                    tokio::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(part)
                        .await?
                }
            };
            Ok(DeferredWriter {
                inner,
                pending: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn a_disk_full_failure_is_final_never_retryable_and_leaves_a_resumable_partial() {
        // The staging writer accepts exactly 400 of the promised 1000
        // bytes, then fails with ENOSPC-class StorageFull, exactly like a
        // disk that fills mid-write. The failure must be FINAL (never
        // mistaken for a transient server problem), leave the truncated
        // file ONLY under the staging name, and keep that staging file
        // resumable - which the second phase proves by finishing the
        // download from exactly those 400 bytes.
        let tmp = TempDir::new("e2e-disk-full");
        let body = pattern(1_000);
        let tail = MockReply::partial_206(
            &format!("bytes 400-{}/{}", body.len() - 1, body.len()),
            &body[400..],
        );
        let server = spawn_mock(vec![MockReply::full_200(&body), tail]);

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let mut plan = plan_for(&server.url, tmp.path(), Some("full.bin"));
        plan.expected_sha256 = Some(sha256_hex(&body));
        let sink = DiskFullAfter { budget: 400 };

        let (message, kind) =
            execute_with_retries_on(&log, &session, 1, plan, cancel_rx, test_backoff(), &sink)
                .await
                .expect_err("a full disk must fail the download");
        assert!(
            message.starts_with("Disk write failed"),
            "the failure must be categorized as a disk-write failure, got: {message}"
        );
        assert_eq!(
            kind, None,
            "a local disk failure is final - never the retryable network kind"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(
            log.retries.lock().unwrap().is_empty(),
            "a disk-full failure must never trigger the automatic retry"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "no second attempt may be started against the server"
        );

        // Nothing truncated at the destination name...
        assert!(!tmp.path().join("full.bin").exists());
        // ...but the staging file is retained as the documented recoverable
        // condition: exactly the bytes that made it to disk, with its
        // validator sidecar for a later resume.
        let part = tmp.path().join("full.bin.part");
        assert_eq!(
            tokio::fs::metadata(&part).await.unwrap().len(),
            400,
            "the partial write must have landed exactly the budgeted bytes"
        );
        assert!(
            read_part_meta(&part).await.is_some(),
            "the validator sidecar must survive for the resume"
        );

        // Recovery: with the failure point removed (space freed), the
        // retained partial resumes EXACTLY where the disk filled and
        // completes with the trusted digest intact.
        let mut plan2 = plan_for(&server.url, tmp.path(), Some("full.bin"));
        plan2.resume = true;
        plan2.staging = Some(part.clone());
        plan2.expected_sha256 = Some(sha256_hex(&body));
        let (session2, cancel_rx2) = test_session().await;
        let payload = execute_with_retries(&log, &session2, 1, plan2, cancel_rx2, test_backoff())
            .await
            .expect("freeing space and resuming must complete the download");
        assert_eq!(payload.bytes, 1_000);
        assert_eq!(payload.verified, Some(true));
        assert_eq!(
            tokio::fs::read(tmp.path().join("full.bin")).await.unwrap(),
            body
        );
    }

    // -----------------------------------------------------------------------
    // The bytes-accepted-are-on-disk invariant on every stop path
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn an_interrupted_transfer_flushes_its_accepted_bytes_before_returning() {
        // The mock promises 2000 bytes and closes the connection after
        // 512 (a mid-body reset). The attempt fails as a retryable
        // network error, and - because the automatic retry re-probes the
        // .part within seconds - every byte the engine ACCEPTED must
        // already be on disk when the error returns. With a buffering
        // writer this is directly observable: a missing flush loses
        // exactly the buffered tail, and a resume from the stale length
        // would duplicate or drop bytes nothing can account for.
        let tmp = TempDir::new("e2e-flush-interrupt");
        let body = pattern(2_000);
        let mut first = MockReply::full_200(&body);
        first.send_body_bytes = Some(512);
        // The retry attempts find an exhausted mock and fail fast; what
        // they must NOT find is a staging file that lies about its length.
        let server = spawn_mock(vec![first]);

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("flushed.bin"));

        let (_message, kind) = execute_with_retries_on(
            &log,
            &session,
            1,
            plan,
            cancel_rx,
            test_backoff(),
            &DeferredFlushSink,
        )
        .await
        .expect_err("a mid-body reset must fail the attempt");
        assert_eq!(kind, Some("network".to_string()));

        let part = tokio::fs::read(tmp.path().join("flushed.bin.part"))
            .await
            .unwrap();
        assert_eq!(
            part,
            body[..512],
            "the staging file must hold exactly the bytes the engine accepted"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_transfer_flushes_its_accepted_bytes_before_returning() {
        // Same invariant as the interrupted variant, driven through the
        // stall path: the mock delivers 1 KiB and then holds the socket.
        // The 60s stall window fires on the paused clock, the attempt
        // fails as a retryable network stall, and the accepted bytes must
        // be on disk before the error is reported.
        let tmp = TempDir::new("e2e-flush-stall");
        let body = pattern(100_000);
        let mut first = MockReply::full_200(&body);
        first.send_body_bytes = Some(1024);
        first.hold_ms = 30_000; // real-time hold; the paused clock is ours
        let server = spawn_mock(vec![first]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let task_session = DownloadSession::new(Arc::clone(&registry), id);
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("stalled.bin"));

        let task = tokio::spawn(async move {
            execute_with_retries_on(
                &log,
                &task_session,
                1,
                plan,
                cancel_rx,
                test_backoff(),
                &DeferredFlushSink,
            )
            .await
        });

        // The response (head + 1 KiB) must be on the wire before the
        // clock starts, so the stall - not the response window - is what
        // fires. After the stall window, the retries run to their final
        // state (each retry fails fast against the exhausted mock).
        wait_until_served(&server, 1).await;
        // The engine must have consumed the response and opened the
        // staging file BEFORE the clock moves: on a slow scheduler the
        // paused clock could otherwise fire the response window first and
        // the attempt would die as no-response with nothing on disk -
        // a different shape than the stall path this test exercises.
        wait_until_exists(&tmp.path().join("stalled.bin.part")).await;
        tokio::time::advance(Duration::from_secs(61)).await;
        for _ in 0..4000 {
            tokio::time::advance(Duration::from_millis(50)).await;
            if task.is_finished() {
                break;
            }
        }
        let result = task.await.expect("retry loop must finish");
        assert!(result.is_err(), "a stalled download must never complete");
        assert_eq!(result.unwrap_err().1.as_deref(), Some("network"));
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));

        let part = tokio::fs::read(tmp.path().join("stalled.bin.part"))
            .await
            .unwrap();
        assert_eq!(
            part,
            body[..1024],
            "the staging file must hold exactly the bytes the engine accepted"
        );
    }

    // -----------------------------------------------------------------------
    // Cancellation boundaries
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_cancel_signalled_while_the_tail_is_in_flight_wins_over_completion() {
        // The mock sends the first 60,000 bytes, holds, and (after the
        // hold) releases the remaining 40,000 on the SAME connection. The
        // cancel is latched the moment the first 60,000 are provably on
        // disk - i.e. before any tail byte can be processed. The engine
        // must observe the cancel at its next checkpoint (biased select,
        // then the final try_recv drain) and land in Cancelled with
        // EXACTLY the staged bytes: no tail processing, no completion
        // decision, nothing at the final name.
        let tmp = TempDir::new("e2e-cancel-tail");
        let full = pattern(100_000);
        let mut first = MockReply::full_200(&full);
        first.send_body_bytes = Some(60_000);
        first.hold_ms = 1_500;
        first.resume_body_after_hold = true;
        let server = spawn_mock(vec![first]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());

        let watcher_part = tmp.path().join("tail.bin.part");
        let watcher_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let staged = tokio::fs::metadata(&watcher_part)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                if staged >= 60_000 || Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            watcher_registry.request_cancel(id).await;
        });

        let plan = plan_for(&server.url, tmp.path(), Some("tail.bin"));
        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a cancel signalled before the tail is processed must win");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));

        // Exactly the bytes staged before the tail arrived: the cancel
        // preempted the completion decision, so the in-flight tail was
        // never processed.
        let part = tmp.path().join("tail.bin.part");
        assert_eq!(
            tokio::fs::metadata(&part).await.unwrap().len(),
            60_000,
            "no tail byte may be processed after the cancel was signalled"
        );
        assert!(!tmp.path().join("tail.bin").exists());
    }

    #[tokio::test]
    async fn a_cancel_racing_verification_cannot_contradict_the_completed_outcome() {
        // The cancel is signalled the moment the engine is observed in
        // Verifying - or, if that window is missed (it is short by
        // design), right after completion. BOTH interleavings are legal
        // under the documented rule ("from Verifying on, the engine always
        // reaches exactly one terminal state; cancellation is no longer
        // honored"), and this test asserts the outcome is IDENTICAL in
        // both: a completed file with the right bytes, a Completed state,
        // and no contradictory error anywhere.
        let tmp = TempDir::new("e2e-cancel-verify");
        let body = pattern(300_000);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let task_session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());

        let watcher_session = DownloadSession::new(Arc::clone(&registry), id);
        let watcher_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let state = watcher_session.snapshot().await;
                if state == Some(DownloadState::Verifying)
                    || state == Some(DownloadState::Completed)
                    || Instant::now() > deadline
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
            watcher_registry.request_cancel(id).await;
        });

        let plan = plan_for(&server.url, tmp.path(), Some("verify.bin"));
        let task_log = Arc::clone(&log);
        let payload = tokio::spawn(async move {
            execute_with_retries(
                &task_log,
                &task_session,
                id,
                plan,
                cancel_rx,
                test_backoff(),
            )
            .await
        })
        .await
        .expect("the engine task must not panic")
        .expect("a cancel racing verification must never produce a failure");
        assert_eq!(payload.bytes, 300_000);
        assert_eq!(
            payload.path,
            tmp.path().join("verify.bin").to_string_lossy().to_string()
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));
        assert_eq!(
            tokio::fs::read(tmp.path().join("verify.bin"))
                .await
                .unwrap(),
            body
        );
        assert!(
            !tmp.path().join("verify.bin.part").exists(),
            "a committed download leaves no staging file behind"
        );
        assert!(log.retries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_cancel_during_the_retry_request_itself_never_completes() {
        // Attempt 1 is truncated (retryable). While the RETRY REQUEST is
        // provably in flight (its response holds the connection open), the
        // cancel arrives. The retry attempt - not just the backoff - must
        // observe the signal, stop, and keep the staging file resumable.
        let tmp = TempDir::new("e2e-cancel-retry-request");
        let full = pattern(2_000);
        let mut first = MockReply::full_200(&full);
        first.send_body_bytes = Some(400);
        let mut second = MockReply::full_200(&full);
        second.send_body_bytes = Some(512);
        second.hold_ms = 5_000;
        let server = spawn_mock(vec![first, second]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let log = Arc::new(EventLog::default());

        // The watcher cancels only when the RETRY REQUEST is provably in
        // flight: the server thread records every request head before it
        // answers, so seeing 2 recorded requests means attempt 2's GET
        // has been sent (its response holds the connection open). The
        // cancel must interrupt THAT attempt - whether the engine observes
        // it while waiting for the response or while the tail streams.
        let watcher_registry = Arc::clone(&registry);
        let watcher_requests = Arc::clone(&server.requests);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            while watcher_requests.lock().unwrap().len() < 2 {
                if Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            watcher_registry.request_cancel(id).await;
        });

        let plan = plan_for(&server.url, tmp.path(), Some("retry.bin"));
        let (message, kind) =
            execute_with_retries(&log, &session, id, plan, cancel_rx, test_backoff())
                .await
                .expect_err("the cancelled retry attempt must not complete");
        assert_eq!(message, CANCEL_SENTINEL);
        assert_eq!(kind, None);
        assert_eq!(session.snapshot().await, Some(DownloadState::Cancelled));
        assert_eq!(
            log.retries.lock().unwrap().len(),
            1,
            "exactly the automatic retry - the cancel must not schedule another"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            2,
            "the cancel interrupted the retry request itself"
        );
        // Attempt 2 reopened the staging file (a 200 to a resume request
        // truncates it) and delivered 512 bytes before holding. How many
        // of those bytes were already written when the cancel was OBSERVED
        // is a legal interleaving (0..=512) - what matters is that the
        // transfer stopped, nothing more than the delivered 512 was ever
        // staged, and nothing sits at the final name.
        let part = tmp.path().join("retry.bin.part");
        let staged = tokio::fs::metadata(&part).await.unwrap().len();
        assert!(
            staged <= 512,
            "no more than the delivered bytes may be staged, got {staged}"
        );
        assert!(!tmp.path().join("retry.bin").exists());
    }

    #[tokio::test]
    async fn a_cancelled_download_leaves_its_same_name_neighbor_untouched() {
        // Two downloads race for the same destination name. A reserves
        // "clash.bin.part" and stalls mid-stream; B moves to the next
        // staging candidate, completes, and claims "clash (1).bin".
        // Cancelling A afterwards must not touch B's artifact in any way -
        // and A must keep its own staging file, cancelled cleanly.
        let tmp = TempDir::new("e2e-cancel-neighbor");
        let body_a = pattern(1_000);
        // Deliberately different bytes from body_a everywhere.
        let body_b: Vec<u8> = (0..2_000u32).map(|i| ((i + 7) % 251) as u8).collect();
        let mut reply_a = MockReply::full_200(&body_a);
        reply_a.send_body_bytes = Some(400);
        reply_a.hold_ms = 5_000;
        let server_a = spawn_mock(vec![reply_a]);
        let server_b = spawn_mock(vec![MockReply::full_200(&body_b)]);

        let registry = Arc::new(DownloadRegistry::default());
        let (id_a, cancel_rx_a) = registry.register().await;
        let (id_b, cancel_rx_b) = registry.register().await;
        let session_a = DownloadSession::new(Arc::clone(&registry), id_a);
        let task_session_a = DownloadSession::new(Arc::clone(&registry), id_a);
        let session_b = DownloadSession::new(Arc::clone(&registry), id_b);
        let log = EventLog::default();

        let dir = tmp.path().to_path_buf();
        let url_a = server_a.url.clone();
        let task_log = EventLog::default();
        let task_a = tokio::spawn(async move {
            let plan = plan_for(&url_a, &dir, Some("clash.bin"));
            execute_with_retries(
                &task_log,
                &task_session_a,
                id_a,
                plan,
                cancel_rx_a,
                test_backoff(),
            )
            .await
        });

        // Wait until A provably holds "clash.bin.part", then start B.
        let a_part = tmp.path().join("clash.bin.part");
        let deadline = Instant::now() + Duration::from_secs(5);
        while tokio::fs::metadata(&a_part).await.is_err() {
            assert!(
                Instant::now() <= deadline,
                "download A never reserved its staging file"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let plan_b = plan_for(&server_b.url, tmp.path(), Some("clash.bin"));
        let payload_b =
            execute_with_retries(&log, &session_b, id_b, plan_b, cancel_rx_b, test_backoff())
                .await
                .expect("the neighbor download must complete");
        assert_eq!(
            payload_b.path,
            tmp.path()
                .join("clash (1).bin")
                .to_string_lossy()
                .to_string(),
            "B must land on the next candidate: A holds candidate 0's staging file"
        );

        registry.request_cancel(id_a).await;
        let result_a = task_a.await.expect("download A's task must not panic");
        assert_eq!(result_a.unwrap_err().0, CANCEL_SENTINEL);
        assert_eq!(session_a.snapshot().await, Some(DownloadState::Cancelled));

        // B's artifact is byte-perfect and untouched; A's staging file is
        // exactly what A staged; nothing sits at the never-committed
        // candidate 0 name.
        assert_eq!(
            tokio::fs::read(tmp.path().join("clash (1).bin"))
                .await
                .unwrap(),
            body_b
        );
        assert!(!tmp.path().join("clash (1).bin.part").exists());
        assert_eq!(
            tokio::fs::metadata(&a_part).await.unwrap().len(),
            400,
            "A's staging file must hold exactly A's staged bytes"
        );
        assert!(!tmp.path().join("clash.bin").exists());
    }

    // -----------------------------------------------------------------------
    // Final hardening round: disk failures at every write boundary, the
    // remaining lifecycle edges, validator-tied resume, filename limits
    // -----------------------------------------------------------------------

    /// Test-only staging sink whose WRITES always succeed but whose
    /// `sync_all` fails like a full disk once `budget` bytes have been
    /// written. ENOSPC famously surfaces at fsync time (the dirty pages
    /// cannot be written back), and the engine routes that error through
    /// the same final, non-retryable disk-write classification as a
    /// mid-write failure.
    struct SyncFailsAfter {
        budget: u64,
    }

    struct SyncFlakyWriter {
        inner: tokio::fs::File,
        written: u64,
        budget: u64,
    }

    impl PartWriter for SyncFlakyWriter {
        async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            tokio::io::AsyncWriteExt::write_all(&mut self.inner, bytes).await?;
            self.written += bytes.len() as u64;
            Ok(())
        }
        async fn flush(&mut self) -> io::Result<()> {
            tokio::io::AsyncWriteExt::flush(&mut self.inner).await
        }
        async fn sync_all(&mut self) -> io::Result<()> {
            if self.written >= self.budget {
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            tokio::fs::File::sync_all(&self.inner).await
        }
    }

    impl StagingSink for SyncFailsAfter {
        type Writer = SyncFlakyWriter;
        async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer> {
            let inner = DiskStaging.open(part, mode).await?;
            Ok(SyncFlakyWriter {
                inner,
                written: 0,
                budget: self.budget,
            })
        }
    }

    #[tokio::test]
    async fn a_disk_full_failure_during_a_resume_tail_is_final_and_keeps_the_prefix_resumable() {
        // First attempt staged 400 bytes, then the disk filled (see the
        // fresh-download variant below). After freeing space the user
        // resumes and the 206 TAIL write hits the still-full disk after
        // 300 tail bytes. The failure must stay final and non-retryable,
        // keep prefix + partial tail under the staging name only, and the
        // recovered download must resume from exactly those 700 bytes.
        let tmp = TempDir::new("e2e-diskfull-resume");
        let full = pattern(1_000);
        let tail = MockReply::partial_206(
            &format!("bytes 400-{}/{}", full.len() - 1, full.len()),
            &full[400..],
        );
        let server = spawn_mock(vec![tail]);
        let part = tmp.path().join("full.bin.part");
        seed_staging(&part, &server.url, Some("\"test-etag\""), &full[..400]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("full.bin"));
        plan.resume = true;
        plan.staging = Some(part.clone());
        plan.expected_sha256 = Some(sha256_hex(&full));

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        // The 600-byte tail gets 300 bytes of disk room: the writer fails
        // with a typed full-disk error on the second half of the tail.
        let sink = DiskFullAfter { budget: 300 };

        let (message, kind) =
            execute_with_retries_on(&log, &session, 1, plan, cancel_rx, test_backoff(), &sink)
                .await
                .expect_err("a full disk during the tail write must fail the download");
        assert!(
            message.starts_with("Disk write failed"),
            "the failure must be categorized as a local disk-write failure, got: {message}"
        );
        assert_eq!(
            kind, None,
            "a local disk failure is final - never the retryable network kind"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(
            log.retries.lock().unwrap().is_empty(),
            "a disk-full failure must never consume the automatic retry budget"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "no second attempt may be started against the server"
        );
        // Finalization cannot occur while the transfer is incomplete: no
        // destination file, and the staged bytes are exactly prefix plus
        // the tail bytes that made it to disk - nothing more, nothing
        // truncated-looking at the final name.
        assert!(!tmp.path().join("full.bin").exists());
        assert_eq!(
            tokio::fs::metadata(&part).await.unwrap().len(),
            700,
            "the prefix and exactly the budgeted tail bytes must survive"
        );
        assert_eq!(
            tokio::fs::read(&part).await.unwrap(),
            [&full[..400], &full[400..700]].concat()
        );
        assert!(
            read_part_meta(&part).await.is_some(),
            "the validator sidecar must survive for the resume"
        );

        // Recovery: with the disk condition corrected, the retained 700
        // bytes are the resume base - the request asks for exactly their
        // offset and the download completes with the trusted digest.
        let recovery = MockReply::partial_206(
            &format!("bytes 700-{}/{}", full.len() - 1, full.len()),
            &full[700..],
        );
        let server2 = spawn_mock(vec![recovery]);
        let mut plan2 = plan_for(&server2.url, tmp.path(), Some("full.bin"));
        plan2.resume = true;
        plan2.staging = Some(part.clone());
        plan2.expected_sha256 = Some(sha256_hex(&full));
        let (session2, cancel_rx2) = test_session().await;
        let payload = execute_with_retries(&log, &session2, 1, plan2, cancel_rx2, test_backoff())
            .await
            .expect("recovery after freeing space must complete the download");
        assert_eq!(payload.bytes, 1_000);
        assert_eq!(payload.verified, Some(true));
        assert!(request_head(&server2, 0).contains("range: bytes=700-"));
        assert_eq!(
            tokio::fs::read(tmp.path().join("full.bin")).await.unwrap(),
            full
        );
        assert!(!part.exists());
    }

    #[tokio::test]
    async fn a_disk_failure_at_the_sync_boundary_is_final_and_never_finalizes() {
        // ENOSPC regularly surfaces at fsync rather than at write time.
        // Every write succeeds, then the sync fails: the same final
        // disk-write classification must apply, nothing may be finalized,
        // and the staged bytes stay exactly what was written - never a
        // hybrid. Recovery goes through the documented policy chain: the
        // complete-looking .part is not blindly committed, the resume
        // learns from the 416 that nothing is missing and discards the
        // staging bytes, and a fresh attempt finishes the job.
        let tmp = TempDir::new("e2e-diskfull-sync");
        let body = pattern(1_000);
        let server = spawn_mock(vec![
            MockReply::full_200(&body),
            MockReply::range_not_satisfiable(),
            MockReply::full_200(&body),
        ]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let mut plan = plan_for(&server.url, tmp.path(), Some("sync.bin"));
        plan.expected_sha256 = Some(sha256_hex(&body));
        let sink = SyncFailsAfter { budget: 700 };

        let (message, kind) =
            execute_with_retries_on(&log, &session, 1, plan, cancel_rx, test_backoff(), &sink)
                .await
                .expect_err("a failed fsync must fail the download");
        assert!(message.starts_with("Disk write failed"), "got: {message}");
        assert_eq!(kind, None, "a disk failure is final, never retryable");
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(log.retries.lock().unwrap().is_empty());
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(!tmp.path().join("sync.bin").exists());
        let part = tmp.path().join("sync.bin.part");
        assert_eq!(
            tokio::fs::metadata(&part).await.unwrap().len(),
            1_000,
            "every written byte is retained under the staging name"
        );
        assert!(read_part_meta(&part).await.is_some());

        // Resuming a complete-length .part is refused by the origin (the
        // range is unsatisfiable) and the staging bytes are discarded by
        // policy - the engine never commits from an unverifiable state.
        let mut plan2 = plan_for(&server.url, tmp.path(), Some("sync.bin"));
        plan2.resume = true;
        plan2.staging = Some(part.clone());
        let (session2, cancel_rx2) = test_session().await;
        let (message2, kind2) =
            execute_with_retries(&log, &session2, 1, plan2, cancel_rx2, test_backoff())
                .await
                .expect_err("the unsatisfiable range must discard the staging bytes");
        assert_eq!(kind2.as_deref(), Some("resume-invalid"), "{message2}");
        assert!(
            !part.exists(),
            "the discard policy must have removed the .part"
        );
        assert!(!tmp.path().join("sync.bin").exists());

        // A fresh attempt with the disk corrected completes verified.
        let mut plan3 = plan_for(&server.url, tmp.path(), Some("sync.bin"));
        plan3.expected_sha256 = Some(sha256_hex(&body));
        let (session3, cancel_rx3) = test_session().await;
        let payload = execute_with_retries(&log, &session3, 1, plan3, cancel_rx3, test_backoff())
            .await
            .expect("the fresh attempt must complete");
        assert_eq!(payload.verified, Some(true));
        assert_eq!(
            tokio::fs::read(tmp.path().join("sync.bin")).await.unwrap(),
            body
        );
    }

    #[tokio::test]
    async fn a_failure_after_the_part_is_created_but_before_any_byte_streams_is_survivable() {
        // The server promises 1000 bytes and closes before delivering a
        // single one. The .part already exists (it is created between the
        // response gate and the stream loop): the attempt must fail as a
        // RETRYABLE network error, spend the automatic retry budget
        // against the dead server, and never leave anything at the final
        // name. A later resume from the empty staging file is a plain
        // fresh download that completes byte-exactly.
        let tmp = TempDir::new("e2e-zero-body");
        let full = pattern(1_000);
        let mut dead = MockReply::full_200(&full);
        dead.send_body_bytes = Some(0);
        let server = spawn_mock(vec![dead]);

        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("zero.bin"));

        let (message, kind) =
            execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a zero-byte body against a promised length must fail");
        assert_eq!(
            kind.as_deref(),
            Some("network"),
            "a short transfer is retryable, got: {message}"
        );
        assert_eq!(
            log.retries.lock().unwrap().len(),
            2,
            "the retry budget (2) must be spent on the dead transfer"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "only the scripted attempt is served; the retries hit the exhausted mock"
        );
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        // The staging file was created before the failure and is kept;
        // neither the requested name nor any candidate name exists.
        let part = tmp.path().join("zero.bin.part");
        assert!(part.exists());
        assert_eq!(tokio::fs::metadata(&part).await.unwrap().len(), 0);
        assert!(!tmp.path().join("zero.bin").exists());
        assert!(!tmp.path().join("zero (1).bin").exists());

        // Recovery: resuming the empty staging file reuses the same .part
        // (truncate + rewrite) and completes exactly.
        let server2 = spawn_mock(vec![MockReply::full_200(&full)]);
        let mut plan2 = plan_for(&server2.url, tmp.path(), Some("zero.bin"));
        plan2.resume = true;
        plan2.staging = Some(part.clone());
        let (session2, cancel_rx2) = test_session().await;
        let payload = execute_with_retries(&log, &session2, 1, plan2, cancel_rx2, test_backoff())
            .await
            .expect("recovery from a zero-byte staging file must complete");
        assert_eq!(payload.bytes, 1_000);
        assert_eq!(
            tokio::fs::read(tmp.path().join("zero.bin")).await.unwrap(),
            full
        );
        assert!(!part.exists());
    }

    /// Test-only sink whose staging file disappears between the last
    /// written byte and the final commit (a vanished mount, an external
    /// cleaner). Drives the REAL finalize boundary into its failure arm.
    struct VanishOnSync;

    struct VanishingWriter {
        inner: tokio::fs::File,
        part: PathBuf,
    }

    impl PartWriter for VanishingWriter {
        async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            tokio::io::AsyncWriteExt::write_all(&mut self.inner, bytes).await
        }
        async fn flush(&mut self) -> io::Result<()> {
            tokio::io::AsyncWriteExt::flush(&mut self.inner).await
        }
        async fn sync_all(&mut self) -> io::Result<()> {
            let _ = tokio::fs::remove_file(&self.part).await;
            tokio::fs::File::sync_all(&self.inner).await
        }
    }

    impl StagingSink for VanishOnSync {
        type Writer = VanishingWriter;
        async fn open(&self, part: &Path, mode: StagingOpenMode) -> io::Result<Self::Writer> {
            let inner = DiskStaging.open(part, mode).await?;
            Ok(VanishingWriter {
                inner,
                part: part.to_path_buf(),
            })
        }
    }

    #[tokio::test]
    async fn a_failure_at_the_finalization_boundary_never_leaves_a_file_behind() {
        // Every byte was delivered and hashed, but the staging file is
        // gone when the commit runs. The finalize boundary must fail the
        // download as a FINAL error, leave nothing at the destination
        // (including no half-made reservation from the create_new
        // fallback), and never report success.
        let tmp = TempDir::new("e2e-finalize-fail");
        let body = pattern(600);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("gone.bin"));

        let (message, kind) = execute_with_retries_on(
            &log,
            &session,
            1,
            plan,
            cancel_rx,
            test_backoff(),
            &VanishOnSync,
        )
        .await
        .expect_err("a vanished staging file must fail the commit");
        assert!(
            message.starts_with("Cannot finalize the download"),
            "got: {message}"
        );
        assert_eq!(kind, None, "a finalize failure is final, never retryable");
        assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
        assert!(log.retries.lock().unwrap().is_empty());
        assert!(
            !tmp.path().join("gone.bin").exists(),
            "the destination name must never appear for a failed commit"
        );
        assert!(!tmp.path().join("gone.bin.part").exists());
    }

    #[tokio::test]
    async fn a_panicking_engine_task_releases_the_registry_and_reports_failure() {
        // Mirrors the bridge contract implemented in lib.rs
        // (catch_unwind_result + session.release()): an unexpected panic
        // inside the engine must NOT be swallowed into a success or an
        // ordinary error result. The wrapper observes the panic, reports
        // the failure, and releases the registry entry so no
        // forever-active download is left behind.
        let tmp = TempDir::new("e2e-panic");
        let server = spawn_mock(vec![MockReply::full_200(&pattern(100_000))]);

        struct PanickingSink;
        impl ProgressSink for PanickingSink {
            fn progress(&self, _payload: ProgressPayload) {
                panic!("unexpected engine fault");
            }
            fn retrying(&self, _payload: RetryPayload) {}
        }

        let registry = Arc::new(DownloadRegistry::default());
        let (id, cancel_rx) = registry.register().await;
        let session = DownloadSession::new(Arc::clone(&registry), id);
        let plan = plan_for(&server.url, tmp.path(), Some("panic.bin"));

        use futures_util::FutureExt;
        let outcome = FutureExt::catch_unwind(std::panic::AssertUnwindSafe(execute_with_retries(
            &PanickingSink,
            &session,
            id,
            plan,
            cancel_rx,
            test_backoff(),
        )))
        .await;
        assert!(
            outcome.is_err(),
            "the panic must propagate out of the engine, got {:?}",
            outcome.map(|r| r.map(|p| p.bytes))
        );
        // What the bridge does next: release the entry. The registry must
        // be empty afterwards - no active download, no stale state.
        session.release().await;
        assert_eq!(session.snapshot().await, None);
        assert!(
            !tmp.path().join("panic.bin").exists(),
            "a panicking task must never claim the final name"
        );
        // A panic leaves the transfer exactly like a crash: the staging
        // file survives untouched (still resumable by a later attempt),
        // nothing completed-looking is left behind.
        assert!(tmp.path().join("panic.bin.part").exists());
    }

    /// Asserts that `session` sits in a terminal state with no legal
    /// successor - the runtime half of `terminal_states_have_no_exits`.
    async fn assert_terminal_has_no_exits(label: &str, session: &DownloadSession) {
        use DownloadState::*;
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
                session.advance(to).await.is_err(),
                "{label}: no edge may leave the terminal state via {to:?}"
            );
        }
    }

    #[tokio::test]
    async fn session_walks_every_documented_edge_and_rejects_the_rest() {
        // Runtime walk of the full transition table through the real
        // session layer: every documented edge succeeds somewhere, and
        // once a terminal state is reached NO edge leaves it.
        use DownloadState::*;

        // Queued -> Downloading -> Verifying -> Completed.
        let (s, _) = test_session().await;
        assert!(s.advance(Downloading).await.is_ok());
        assert!(s.advance(Verifying).await.is_ok());
        assert!(s.advance(Completed).await.is_ok());
        assert_terminal_has_no_exits("Completed", &s).await;

        // The Verifying -> Failed edge (e.g. checksum mismatch).
        let (s, _) = test_session().await;
        s.advance(Downloading).await.unwrap();
        s.advance(Verifying).await.unwrap();
        s.advance(Failed).await.unwrap();
        assert_terminal_has_no_exits("Failed", &s).await;

        // The full automatic-retry cycle.
        let (s, _) = test_session().await;
        s.advance(Downloading).await.unwrap();
        s.advance(Retrying).await.unwrap();
        s.advance(Downloading).await.unwrap();
        s.advance(Retrying).await.unwrap();
        s.advance(Downloading).await.unwrap();
        s.advance(Verifying).await.unwrap();
        s.advance(Completed).await.unwrap();

        // Cancellation is reachable from Queued (no step), Downloading and
        // Retrying (each path starts at Queued).
        for walk in [
            Vec::new() as Vec<DownloadState>,
            vec![Downloading],
            vec![Downloading, Retrying],
        ] {
            let (s, _) = test_session().await;
            for step in walk {
                s.advance(step).await.unwrap();
            }
            s.advance(Cancelled).await.unwrap();
            assert_terminal_has_no_exits("Cancelled", &s).await;
        }

        // Failure is reachable from Downloading and Retrying.
        for walk in [vec![Downloading], vec![Downloading, Retrying]] {
            let (s, _) = test_session().await;
            for step in walk {
                s.advance(step).await.unwrap();
            }
            s.advance(Failed).await.unwrap();
            assert_terminal_has_no_exits("Failed(walk)", &s).await;
        }

        // The rejected shapes the table forbids: skipping states and
        // entering non-terminals from terminals are already covered by
        // the 7x7 matrix; here the two most dangerous skips are pinned at
        // the session layer.
        let (s, _) = test_session().await;
        assert!(
            s.advance(Completed).await.is_err(),
            "Queued -> Completed must not happen"
        );
        assert!(
            s.advance(Verifying).await.is_err(),
            "Queued -> Verifying must not happen"
        );
        assert_eq!(
            s.snapshot().await,
            Some(Queued),
            "rejections leave the state alone"
        );
    }

    #[tokio::test]
    async fn a_changed_remote_resource_is_never_glued_onto_the_staged_prefix() {
        // The staging file holds a prefix of the OLD resource (validator
        // "v1"); the origin now serves "v2". A conforming server refuses
        // the If-Range and answers with a full 200 of the NEW body. The
        // engine must replace the staging content - never append - and
        // the final file must be byte-exactly the new resource.
        let tmp = TempDir::new("e2e-ifrange-changed");
        let old = pattern(1_000);
        let new: Vec<u8> = (0..900u32).map(|i| ((i + 13) % 251) as u8).collect();
        let server = spawn_mock(vec![MockReply::switch_on_if_range(
            "\"v2\"",
            // Served only if the stale validator were (wrongly) accepted.
            MockReply::partial_206("bytes 400-999/1000", &old[400..]),
            MockReply::full_200(&new),
        )]);
        let part = tmp.path().join("res.bin.part");
        seed_staging(&part, &server.url, Some("\"v1\""), &old[..400]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("res.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a replaced resource must be re-fetched in full");
        let head = request_head(&server, 0);
        assert!(
            head.contains("range: bytes=400-"),
            "the resume request must ask for the tail"
        );
        assert!(
            head.contains("if-range: \"v1\""),
            "the stale validator must travel as If-Range"
        );
        assert_eq!(payload.bytes, 900, "the new body alone, never prefix+tail");
        assert_eq!(
            tokio::fs::read(tmp.path().join("res.bin")).await.unwrap(),
            new,
            "the final file must be exactly the new resource"
        );
        assert_eq!(payload.sha256, sha256_hex(&new));
        assert_eq!(session.snapshot().await, Some(DownloadState::Completed));
    }

    #[tokio::test]
    async fn an_unchanged_resource_resumes_its_tail_when_the_validator_still_matches() {
        // The positive half of the If-Range contract: same validator, so
        // the origin serves the 206 tail and the staged prefix + tail are
        // one byte-exact file.
        let tmp = TempDir::new("e2e-ifrange-match");
        let full = pattern(1_000);
        let server = spawn_mock(vec![MockReply::switch_on_if_range(
            "\"v2\"",
            MockReply::partial_206("bytes 400-999/1000", &full[400..]),
            // Served only if the valid resume were (wrongly) refused.
            MockReply::full_200(&full),
        )]);
        let part = tmp.path().join("res.bin.part");
        seed_staging(&part, &server.url, Some("\"v2\""), &full[..400]).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("res.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("an unchanged resource must resume its tail");
        let head = request_head(&server, 0);
        assert!(head.contains("range: bytes=400-"));
        assert!(head.contains("if-range: \"v2\""));
        assert_eq!(payload.bytes, 1_000);
        assert_eq!(payload.sha256, sha256_hex(&full));
        assert_eq!(
            tokio::fs::read(tmp.path().join("res.bin")).await.unwrap(),
            full
        );
    }

    #[tokio::test]
    async fn a_last_modified_only_sidecar_still_ties_the_resume_to_the_resource() {
        // Some vendors never send ETags; Last-Modified is then the only
        // validator. It must be carried as If-Range exactly like an ETag:
        // a matching value resumes the tail, a changed one would force
        // the 200 replacement path.
        let tmp = TempDir::new("e2e-ifrange-lm");
        let full = pattern(800);
        let server = spawn_mock(vec![MockReply::switch_on_if_range(
            "Tue, 06 Oct 2026 09:00:00 GMT",
            MockReply::partial_206("bytes 300-799/800", &full[300..]),
            MockReply::full_200(&pattern(999)),
        )]);
        let part = tmp.path().join("lm.bin.part");
        write_file(&part, &full[..300]).await;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "last-modified",
            "Tue, 06 Oct 2026 09:00:00 GMT"
                .parse()
                .expect("header value"),
        );
        write_part_meta(&part, &server.url, &headers).await;

        let mut plan = plan_for(&server.url, tmp.path(), Some("lm.bin"));
        plan.resume = true;
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a Last-Modified validator must drive the resume");
        let head = request_head(&server, 0);
        assert!(head.contains("range: bytes=300-"));
        assert!(
            head.contains("if-range: tue, 06 oct 2026 09:00:00 gmt"),
            "the Last-Modified validator must travel as If-Range, got: {head}"
        );
        assert_eq!(payload.bytes, 800);
        assert_eq!(
            tokio::fs::read(tmp.path().join("lm.bin")).await.unwrap(),
            full
        );
    }

    #[tokio::test]
    async fn an_over_long_filename_fails_cleanly_without_artifacts() {
        // A 300+ character name exceeds the 255-byte per-name limit of
        // mainstream filesystems (or the classic Windows MAX_PATH budget,
        // which the .part suffix and directory prefix also eat into). The
        // engine must refuse with a FINAL error and leave the directory
        // untouched - never panic, never truncate, never rename silently.
        // Self-calibrating: if this filesystem does accept such a name
        // (long paths enabled), the portable claim is "no panic, no
        // corruption" instead.
        let tmp = TempDir::new("e2e-long-name");
        let body = pattern(64);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let long = format!("{}.bin", "x".repeat(300));

        let probe = tmp.path().join(&long);
        match std::fs::write(&probe, b"x") {
            Err(_) => {
                let _ = std::fs::remove_file(&probe);
                let (session, cancel_rx) = test_session().await;
                let log = EventLog::default();
                let plan = plan_for(&server.url, tmp.path(), Some(&long));
                let (message, kind) =
                    execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                        .await
                        .expect_err("an unrepresentable name must fail the download");
                assert_eq!(
                    kind, None,
                    "a local filesystem limit is final, got: {message}"
                );
                assert_eq!(session.snapshot().await, Some(DownloadState::Failed));
                assert!(
                    log.retries.lock().unwrap().is_empty(),
                    "a filesystem limit must not consume the retry budget"
                );
                assert!(!tmp.path().join(&long).exists());
                assert!(!tmp.path().join(format!("{long}.part")).exists());
                assert_eq!(
                    std::fs::read_dir(tmp.path()).unwrap().count(),
                    0,
                    "no artifact of any kind may remain"
                );
            }
            Ok(()) => {
                let _ = std::fs::remove_file(&probe);
                let (session, cancel_rx) = test_session().await;
                let log = EventLog::default();
                let plan = plan_for(&server.url, tmp.path(), Some(&long));
                let payload =
                    execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
                        .await
                        .expect("a filesystem that accepts the name must download fine");
                assert_eq!(payload.bytes, 64);
            }
        }
    }

    #[tokio::test]
    async fn a_long_but_representable_filename_downloads_end_to_end() {
        // 176 characters plus extension: inside every mainstream per-name
        // limit and the classic Windows MAX_PATH budget together with the
        // temp prefix. Guards against overzealous refusal of legitimate
        // long names anywhere in sanitize/stage/commit.
        let tmp = TempDir::new("e2e-long-ok");
        let body = pattern(300);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let name = format!("{}.bin", "a".repeat(172));
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some(&name));

        let payload = execute_with_retries(&log, &session, 1, plan, cancel_rx, test_backoff())
            .await
            .expect("a representable long name must download end to end");
        assert_eq!(
            payload.path,
            tmp.path().join(&name).to_string_lossy().to_string()
        );
        assert_eq!(tokio::fs::read(tmp.path().join(&name)).await.unwrap(), body);
        assert!(!tmp.path().join(format!("{name}.part")).exists());
    }

    // -----------------------------------------------------------------------
    // Completed-artifact registry (the signature-verification boundary)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_completed_download_is_recorded_for_the_signature_boundary() {
        let tmp = TempDir::new("e2e-completed-record");
        let body = pattern(9_000);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        std::fs::create_dir_all(tmp.path().join("sub")).expect("sub dir for the path variant");
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));

        let payload = execute_with_retries(&log, &session, 7, plan, cancel_rx, test_backoff())
            .await
            .expect("download must complete");

        // The exact path the completion event carried is the lookup key.
        let record = session
            .registry
            .completed_artifact_for_path(Path::new(&payload.path))
            .expect("the committed artifact must be registered");
        assert_eq!(record.id, 7);
        assert_eq!(record.url, server.url);
        assert_eq!(record.size, body.len() as u64);
        assert_eq!(
            record.canonical,
            std::fs::canonicalize(&payload.path).expect("artifact canonicalizable")
        );

        // A path variant of the same location that textual path equality
        // does NOT collapse ("sub/.." stays in the components) must still
        // be recognized through the canonical fallback.
        let folded = tmp.path().join("sub").join("..").join("setup.exe");
        assert_ne!(
            folded.components().count(),
            Path::new(&payload.path).components().count(),
            "the variant must differ textually to reach the fallback"
        );
        assert!(session
            .registry
            .completed_artifact_for_path(&folded)
            .is_some());

        // An unrelated path in the same directory has no record.
        assert!(session
            .registry
            .completed_artifact_for_path(&tmp.path().join("other.exe"))
            .is_none());
    }

    #[tokio::test]
    async fn a_cancelled_download_never_leaves_a_completed_record() {
        // A cancelled transfer keeps its staging file for the Resume
        // button - and must keep it UNVERIFIABLE: no completion record may
        // exist for the .part or for the destination name it would have
        // taken.
        let tmp = TempDir::new("e2e-cancel-record");
        let body = pattern(70_000);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));

        // Cancel the session's REAL registry id (test_session hands out
        // ids from a fresh registry; the engine's id parameter is only a
        // label for events, exactly like the bridge passes its own).
        session.registry.request_cancel(session.id).await;
        let err = execute_with_retries(&log, &session, 7, plan, cancel_rx, test_backoff())
            .await
            .expect_err("a pre-signalled cancel must fail the download");
        assert_eq!(err.0, CANCEL_SENTINEL);

        let dest = tmp.path().join("setup.exe");
        let part = part_path_for(&dest);
        assert!(session
            .registry
            .completed_artifact_for_path(&dest)
            .is_none());
        assert!(session
            .registry
            .completed_artifact_for_path(&part)
            .is_none());
    }

    #[tokio::test]
    async fn a_checksum_failure_leaves_no_completed_record() {
        let tmp = TempDir::new("e2e-checksum-record");
        let body = pattern(1_000);
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let log = EventLog::default();
        let mut plan = plan_for(&server.url, tmp.path(), Some("setup.exe"));
        plan.expected_sha256 = Some(sha256_hex(b"not the downloaded bytes"));

        let (message, kind) =
            execute_with_retries(&log, &session, 3, plan, cancel_rx, test_backoff())
                .await
                .expect_err("a checksum mismatch must fail the download");
        assert_eq!(kind.as_deref(), Some("checksum"), "{message}");

        // The artifact was deleted AND never registered: the stale
        // record scenario the verification boundary must refuse.
        assert!(!tmp.path().join("setup.exe").exists());
        assert!(session
            .registry
            .completed_artifact_for_path(&tmp.path().join("setup.exe"))
            .is_none());
    }

    #[test]
    fn the_completed_record_queue_is_fifo_capped() {
        let registry = DownloadRegistry::default();
        for i in 0..(COMPLETED_RECORD_CAP + 8) {
            // Paths that do not exist: canonicalization falls back to the
            // raw path, which is exactly what makes this test portable
            // (no filesystem needed for queue mechanics).
            registry.record_completed_artifact(
                i as u32,
                &PathBuf::from(format!("/nonexistent/artifact-{i}.bin")),
                "https://example.com/a.bin",
                None,
            );
        }
        assert_eq!(
            registry.completed_len(),
            COMPLETED_RECORD_CAP,
            "the queue must never grow past the cap"
        );
        // Oldest evicted, newest retained.
        assert!(registry
            .completed_artifact_for_path(Path::new("/nonexistent/artifact-0.bin"))
            .is_none());
        let last = COMPLETED_RECORD_CAP + 7;
        let newest = registry
            .completed_artifact_for_path(Path::new(&format!("/nonexistent/artifact-{last}.bin")))
            .expect("the newest record must survive");
        assert_eq!(newest.id as usize, last);
    }

    #[test]
    fn a_recommit_of_the_same_path_replaces_the_stale_record() {
        // If a path completes twice (the user deleted the first artifact
        // and re-downloaded; no-clobber still holds per-download), the
        // verification boundary must judge the MOST RECENT commit, never
        // the stale record with its old size.
        let tmp = TempDir::new("e2e-recommit-record");
        let path = tmp.path().join("setup.exe");
        std::fs::write(&path, vec![0u8; 10]).unwrap();
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(1, &path, "https://example.com/a.bin", Some(true));

        std::fs::write(&path, vec![1u8; 20]).unwrap();
        registry.record_completed_artifact(2, &path, "https://example.com/a.bin", None);

        assert_eq!(
            registry.completed_len(),
            1,
            "one canonical path, one record"
        );
        let record = registry
            .completed_artifact_for_path(&path)
            .expect("record present");
        assert_eq!(record.id, 2);
        assert_eq!(record.size, 20, "the stale size must not survive");
    }

    #[tokio::test]
    async fn the_completed_record_carries_the_engines_checksum_verdict() {
        // "Expected checksum status" leg of the record contract: the record
        // must say what the ENGINE proved about the bytes at completion -
        // Some(true) only when a publisher-supplied trusted digest matched,
        // None when no trusted digest existed. A download without a trusted
        // reference must never look checksummed, and a checksummed one must
        // never look unverified.
        let tmp = TempDir::new("e2e-record-verdict");
        let body = pattern(2_500);

        // (a) Trusted digest supplied and matching -> Some(true).
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let mut plan = plan_for(&server.url, tmp.path(), Some("verified-setup.exe"));
        plan.expected_sha256 = Some(sha256_hex(&body));
        let payload = execute_with_retries(
            &EventLog::default(),
            &session,
            1,
            plan,
            cancel_rx,
            test_backoff(),
        )
        .await
        .expect("matching trusted digest must complete");
        assert_eq!(payload.verified, Some(true), "the event must say verified");
        // Filesystem state: the committed artifact exists at the reported
        // path with the exact bytes, and no staging file survived.
        let final_a = tmp.path().join("verified-setup.exe");
        assert_eq!(std::fs::read(&final_a).unwrap(), body);
        assert!(!tmp.path().join("verified-setup.exe.part").exists());
        assert_eq!(payload.path, final_a.to_string_lossy().to_string());
        let record = session
            .registry
            .completed_artifact_for_path(final_a.as_path())
            .expect("verified completion must be registered");
        assert_eq!(
            record.checksum_verified,
            Some(true),
            "the record must carry the engine's checksum verdict"
        );

        // (b) No trusted digest supplied -> None. The artifact completed
        // (it is a legitimate record), but nothing about its bytes was
        // PROVEN - the record must say exactly that.
        let server = spawn_mock(vec![MockReply::full_200(&body)]);
        let (session, cancel_rx) = test_session().await;
        let plan = plan_for(&server.url, tmp.path(), Some("plain-setup.exe"));
        let payload = execute_with_retries(
            &EventLog::default(),
            &session,
            2,
            plan,
            cancel_rx,
            test_backoff(),
        )
        .await
        .expect("an unchecksummed download must still complete");
        assert_eq!(
            payload.verified, None,
            "no trusted reference means no verdict"
        );
        // Filesystem state: same guarantee, no staging file survived.
        let final_b = tmp.path().join("plain-setup.exe");
        assert_eq!(std::fs::read(&final_b).unwrap(), body);
        assert!(!tmp.path().join("plain-setup.exe.part").exists());
        let record = session
            .registry
            .completed_artifact_for_path(final_b.as_path())
            .expect("unverified completion must still be registered");
        assert_eq!(
            record.checksum_verified, None,
            "the record must NOT claim a checksum the engine never made"
        );
    }

    #[tokio::test]
    async fn two_completed_downloads_never_cross_their_boundary_records() {
        // Cross-download ID confusion: with two completed artifacts in the
        // registry, the verifier's lookup is keyed by the file's path and
        // must hand back the id/url/checksum verdict of EXACTLY the
        // download that committed that file - never a sibling's. The
        // refusal diagnostics (which quote the record's id and url) would
        // otherwise misattribute a failure to the wrong download.
        let tmp = TempDir::new("e2e-cross-record");
        let body_a = pattern(1_200);
        let body_b = pattern(3_400);

        // Two sessions over ONE registry - exactly the shape the Tauri
        // bridge produces for two concurrent downloads.
        let registry = Arc::new(DownloadRegistry::default());
        let (id_a, cancel_rx_a) = registry.register().await;
        let session_a = DownloadSession::new(Arc::clone(&registry), id_a);
        let (id_b, cancel_rx_b) = registry.register().await;
        let session_b = DownloadSession::new(Arc::clone(&registry), id_b);

        let server_a = spawn_mock(vec![MockReply::full_200(&body_a)]);
        let mut plan_a = plan_for(&server_a.url, tmp.path(), Some("alpha.exe"));
        plan_a.expected_sha256 = Some(sha256_hex(&body_a));
        let payload_a = execute_with_retries(
            &EventLog::default(),
            &session_a,
            11,
            plan_a,
            cancel_rx_a,
            test_backoff(),
        )
        .await
        .expect("download A must complete");

        let server_b = spawn_mock(vec![MockReply::full_200(&body_b)]);
        let mut plan_b = plan_for(&server_b.url, tmp.path(), Some("beta.exe"));
        plan_b.expected_sha512 = Some(sha512_hex(&body_b));
        let payload_b = execute_with_retries(
            &EventLog::default(),
            &session_b,
            12,
            plan_b,
            cancel_rx_b,
            test_backoff(),
        )
        .await
        .expect("download B must complete");

        let path_a = PathBuf::from(&payload_a.path);
        let path_b = PathBuf::from(&payload_b.path);
        assert_ne!(
            path_a, path_b,
            "the two downloads must sit at distinct paths"
        );

        // Filesystem state: both artifacts exist with THEIR OWN bytes (not
        // a sibling's), and no staging files survived either commit.
        assert_eq!(std::fs::read(&path_a).unwrap(), body_a);
        assert_eq!(std::fs::read(&path_b).unwrap(), body_b);
        assert!(!path_a.with_extension("exe.part").exists());
        assert!(!path_b.with_extension("exe.part").exists());

        let record_a = registry
            .completed_artifact_for_path(&path_a)
            .expect("A's record present");
        let record_b = registry
            .completed_artifact_for_path(&path_b)
            .expect("B's record present");

        // Every correlation leg points at its own download, both ways.
        assert_eq!(record_a.id, 11, "A's path must resolve to A's id");
        assert_eq!(
            record_a.url, server_a.url,
            "A's path must resolve to A's url"
        );
        assert_eq!(record_a.size, body_a.len() as u64);
        assert_eq!(record_a.checksum_verified, Some(true));
        assert_eq!(record_b.id, 12, "B's path must resolve to B's id");
        assert_eq!(
            record_b.url, server_b.url,
            "B's path must resolve to B's url"
        );
        assert_eq!(record_b.size, body_b.len() as u64);
        assert_eq!(record_b.checksum_verified, Some(true));

        // The association is exclusive in the other direction too: the two
        // canonical paths are distinct, and two completions leave exactly
        // two records - no third, no merge.
        assert_ne!(record_a.canonical, record_b.canonical);
        assert_eq!(
            registry.completed_len(),
            2,
            "two distinct completions, two records"
        );
    }
}
