// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

//! Root-cause resilience layer for the catalog's source lookups.
//!
//! The "No download was started: the download sources could not be
//! reached" toast used to have three independent roots, each of which
//! turned a healthy-enough network into a failed lookup:
//!
//!   1. SINGLE-SHOT HTTP. `fetch_latest_release`, `fetch_recent_releases`,
//!      `fetch_fdroid_package` and `fetch_text` each sent exactly one
//!      request. One DNS hiccup, one connection reset, one slow TLS
//!      handshake - routine on throttled or censored networks - failed the
//!      whole lookup instantly.
//!   2. UNBOUNDED QUOTA DRAIN. GitHub's unauthenticated API allows 60
//!      requests/hour per IP, and every lookup spent 2-3 of them even when
//!      NOTHING had changed upstream. A catalog browse could exhaust the
//!      hour's budget, after which every lookup failed until the window
//!      reset.
//!   3. NO MEMORY OF SUCCESS. A failed fresh lookup threw away every
//!      previously known answer and surfaced an error even when the same
//!      machine had resolved the same repository minutes earlier.
//!
//! This module closes all three roots for every API lookup:
//!
//!   - Transient failures (network errors, 408/429/5xx) are retried with
//!     exponentially growing, jittered backoff; `Retry-After` is honored
//!     and capped. Deterministic answers (404, policy refusals, oversized
//!     bodies) are never retried.
//!   - Successful 200 bodies and their `ETag`s are kept in a small
//!     persistent cache; every repeat request is conditional
//!     (`If-None-Match`). A 304 Not Modified answer is served from the
//!     cache and - per GitHub's API semantics - does NOT count against
//!     the rate limit, so steady-state browsing spends almost no quota.
//!   - If every attempt still fails, a cached body younger than
//!     [`STALE_MAX_AGE`] is served as a stale fallback instead of an
//!     error: a slightly old release list still names real, downloadable
//!     files, and a working download always beats an honest toast.
//!
//! Security posture is unchanged: this layer never constructs URLs, never
//! chooses hosts, and never sees a credential. Admission, redirects and
//! the public-address-only resolver stay in `network_policy`; callers pass
//! an already-validated URL built from an already-validated policy client.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{ETAG, IF_NONE_MATCH, RETRY_AFTER};

/// Total attempts per lookup: 1 initial + 3 retries for transient failures.
pub(crate) const MAX_ATTEMPTS: u32 = 4;

/// A cached answer may stand in for a failed fresh lookup for at most this
/// long. Old releases stay downloadable on GitHub's CDN for years, but a
/// week-old list is old enough that the honest failure is the better
/// answer (the frontend's own retry seam and the curated fallbacks remain
/// available to the user).
pub(crate) const STALE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Per-entry body cap for the persistent cache. `per_page=20` release
/// lists are order-of-a-megabyte; 2 MiB covers every legitimate body the
/// 10 MiB API reader would otherwise admit without letting one huge entry
/// dominate the store.
pub(crate) const CACHE_ENTRY_CAP: u64 = 2 * 1024 * 1024;

/// Entry-count cap. The catalog is a few dozen repositories, two URLs
/// each, plus F-Droid package ids - 256 entries are never exhausted by
/// legitimate use, and the count bound keeps the JSON file small even if
/// the byte budget below is met by many tiny entries.
pub(crate) const CACHE_MAX_ENTRIES: usize = 256;

/// Whole-file byte budget for cached bodies. Crossing it evicts
/// oldest-first until the store fits again.
pub(crate) const CACHE_TOTAL_BUDGET: u64 = 16 * 1024 * 1024;

/// Injectable timing knobs. Production grows waits exponentially with
/// jitter; tests run with zero waits so the retry paths are exercised in
/// milliseconds.
#[derive(Clone, Copy)]
pub(crate) struct Timing {
    pub(crate) max_attempts: u32,
    pub(crate) backoff_base: Duration,
    pub(crate) backoff_cap: Duration,
    pub(crate) retry_after_cap: Duration,
}

impl Timing {
    pub(crate) fn production() -> Self {
        Timing {
            max_attempts: MAX_ATTEMPTS,
            backoff_base: Duration::from_millis(500),
            backoff_cap: Duration::from_secs(4),
            retry_after_cap: Duration::from_secs(15),
        }
    }

    /// Zero-wait timing for loopback tests: every retry fires immediately,
    /// and a server-sent `Retry-After` is clamped to at most one second so
    /// a hostile value can never stall the suite.
    #[cfg(test)]
    pub(crate) fn instant() -> Self {
        Timing {
            max_attempts: MAX_ATTEMPTS,
            backoff_base: Duration::ZERO,
            backoff_cap: Duration::ZERO,
            retry_after_cap: Duration::from_secs(1),
        }
    }
}

/// Where a served body came from. Purely diagnostic today (the JSON shapes
/// the commands return are unchanged), but load-bearing in the tests that
/// prove each path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BodyProvenance {
    /// A fresh 200 answer from the origin.
    Fresh,
    /// A 304 Not Modified answered from the persistent cache - zero quota
    /// spent on GitHub.
    NotModified,
    /// Every fresh attempt failed; the cached answer stood in.
    StaleFallback,
}

/// A lookup's outcome body plus where it came from. The provenance is
/// diagnostic (the JSON shapes the commands return are unchanged); the
/// tests assert it to pin each serving path.
pub(crate) struct ResolvedApiBody {
    pub(crate) body: String,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) provenance: BodyProvenance,
}

impl std::fmt::Debug for ResolvedApiBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedApiBody")
            .field("body_len", &self.body.len())
            .field("provenance", &self.provenance)
            .finish()
    }
}

/// Why a lookup failed, phrased for the command layer's `Result<_, String>`.
#[derive(Debug)]
pub(crate) enum ApiFetchError {
    /// A deterministic answer the retry loop must never re-ask: 4xx
    /// statuses (404 "no stable release", policy refusals, unexpected 304)
    /// and structurally broken bodies (oversized, not UTF-8).
    Status(String),
    /// A transient failure that persisted past every attempt. The message
    /// is the last failure's user-facing wording.
    Transient(String),
}

/// A small persistent body+ETag store for API GET answers.
///
/// Deliberately minimal: one JSON file, one process-wide mutex, every I/O
/// error swallowed. The cache exists to SAVE quota and to serve stale
/// answers through outages - it must never become a new way for a lookup
/// to fail. Callers pass `None` (cache-less mode) when no cache directory
/// can be resolved; the resilience loop works identically without it.
pub(crate) struct CacheStore {
    inner: Mutex<Option<CacheFile>>,
    path: Option<PathBuf>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CacheEntry {
    etag: Option<String>,
    body: String,
    saved_at_ms: u64,
    /// Monotonic insertion counter. Entries stored within the same
    /// millisecond share saved_at_ms, so eviction needs this to evict in
    /// true insertion order instead of HashMap-survey order.
    seq: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, CacheEntry>,
}

impl Default for CacheFile {
    fn default() -> Self {
        // The schema version is stamped at CREATION, not left at the
        // integer default: the reload path filters on version == 1, and a
        // derived Default would have written version 0 files that every
        // reload then silently discarded (the on-disk cache would never
        // have survived a restart).
        CacheFile {
            version: 1,
            entries: HashMap::new(),
        }
    }
}

impl CacheStore {
    /// Opens (lazily loads) the store rooted at `dir`. `None` disables
    /// persistence; the in-memory map still serves within this call
    /// chain, so even a cache-less run gets 304-less correctness.
    pub(crate) fn open(dir: Option<PathBuf>) -> CacheStore {
        let path = dir.map(|d| d.join("api-cache-v1.json"));
        let inner = path
            .as_deref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<CacheFile>(&s).ok())
            .filter(|f| f.version == 1)
            .unwrap_or_default();
        CacheStore {
            inner: Mutex::new(Some(inner)),
            path,
        }
    }

    /// A store that never touches disk (loopback tests). Production
    /// callers pass a resolved directory - or `None` to [`Self::open`],
    /// which degrades to the same in-memory behavior.
    #[cfg(test)]
    pub(crate) fn memory_only() -> CacheStore {
        CacheStore {
            inner: Mutex::new(Some(CacheFile::default())),
            path: None,
        }
    }

    fn with_file<T>(&self, f: impl FnOnce(&mut CacheFile) -> T) -> Option<T> {
        let mut guard = self.inner.lock().ok()?;
        let file = guard.as_mut()?;
        Some(f(file))
    }

    /// The ETag to revalidate with, if a previous 200 stored one.
    pub(crate) fn etag_for(&self, url: &str) -> Option<String> {
        self.with_file(|file| {
            file.entries
                .get(url)
                .and_then(|e| e.etag.clone())
                .filter(|e| !e.is_empty())
        })?
    }

    /// The stored body for `url`, with its age. Used for 304 answers and
    /// stale fallbacks alike.
    pub(crate) fn body_for(&self, url: &str) -> Option<(String, u64)> {
        self.with_file(|file| {
            file.entries
                .get(url)
                .map(|e| (e.body.clone(), e.saved_at_ms))
        })?
    }

    /// Records a fresh 200 answer (and its ETag) under `url`, enforcing
    /// the per-entry, entry-count and total-byte budgets. Disk I/O is
    /// best-effort: a full disk must not fail a lookup that just
    /// succeeded.
    pub(crate) fn store(&self, url: &str, etag: Option<&str>, body: &str) {
        let Some(etag) = etag.map(str::to_string).filter(|e| !e.is_empty()) else {
            return self.store_body_only(url, body);
        };
        self.upsert(url, Some(etag), body);
    }

    fn store_body_only(&self, url: &str, body: &str) {
        self.upsert(url, None, body);
    }

    fn upsert(&self, url: &str, etag: Option<String>, body: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let write_to_disk = self.with_file(|file| {
            if body.len() as u64 > CACHE_ENTRY_CAP {
                return false;
            }
            // Continue the insertion sequence across reloads so eviction
            // order is stable even for same-millisecond writes.
            let next_seq = file
                .entries
                .values()
                .map(|e| e.seq)
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            file.entries.insert(
                url.to_string(),
                CacheEntry {
                    etag,
                    body: body.to_string(),
                    saved_at_ms: now,
                    seq: next_seq,
                },
            );
            evict_over_budget(&mut file.entries);
            true
        });
        if write_to_disk == Some(true) {
            self.flush();
        }
    }

    /// Refreshes the saved-at stamp of an existing entry (a 304 means the
    /// stored body is exactly what the origin would send today). A missing
    /// entry is a no-op - the caller handles that as an error.
    pub(crate) fn touch(&self, url: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let touched = self.with_file(|file| {
            if let Some(e) = file.entries.get_mut(url) {
                e.saved_at_ms = now;
                true
            } else {
                false
            }
        });
        if touched == Some(true) {
            self.flush();
        }
    }

    /// Best-effort atomic persistence: write sibling temp file, rename
    /// over the live one. Any failure is swallowed by contract.
    fn flush(&self) {
        let Some(path) = &self.path else { return };
        let Some(guard) = self.inner.lock().ok() else {
            return;
        };
        let Some(file) = guard.as_ref() else { return };
        if let Some(dir) = path.parent().map(std::path::Path::to_path_buf) {
            let _ = std::fs::create_dir_all(&dir);
        }
        if let Ok(json) = serde_json::to_string(file) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// Oldest-first eviction until the store fits both budgets. "Oldest" is
/// (saved_at_ms, seq): the millisecond stamp plus the insertion sequence,
/// so same-millisecond writes evict in true insertion order.
fn evict_over_budget(entries: &mut HashMap<String, CacheEntry>) {
    while entries.len() > CACHE_MAX_ENTRIES || total_bytes(entries) > CACHE_TOTAL_BUDGET {
        let oldest = entries
            .iter()
            .min_by_key(|(_, e)| (e.saved_at_ms, e.seq))
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                entries.remove(&k);
            }
            None => break,
        }
    }
}

fn total_bytes(entries: &HashMap<String, CacheEntry>) -> u64 {
    entries.values().map(|e| e.body.len() as u64).sum()
}

/// True when a status code is worth one more attempt. 408 (request
/// timeout), 429 (too many requests) and the 5xx family are transient by
/// nature; 403 is transient ONLY when GitHub's headers say it is a rate
/// limit (primary: `x-ratelimit-remaining: 0`; secondary: a `Retry-After`
/// header) - every other 403 is a real refusal and re-asking is waste.
pub(crate) fn is_retryable_status(status: u16, headers: &reqwest::header::HeaderMap) -> bool {
    match status {
        408 | 429 | 500 | 502 | 503 | 504 => true,
        403 => {
            headers
                .get("x-ratelimit-remaining")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.trim() == "0")
                .unwrap_or(false)
                || headers.contains_key(RETRY_AFTER)
        }
        _ => false,
    }
}

/// Parses a numeric `Retry-After` (seconds). The HTTP-date form is
/// deliberately unsupported: it is rare, and misparsing it into a wrong
/// wait is worse than falling back to the backoff schedule.
pub(crate) fn parse_retry_after(value: &str) -> Option<Duration> {
    value.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Backoff for attempt `attempt` (0-based): base * 2^attempt with roughly
/// +-40% full jitter, THEN capped - the cap is a hard bound, so a jittered
/// value must never exceed it (jittering after capping once let a 4 s cap
/// surface as 5.6 s). The jitter source is a nanosecond-seeded LCG - not
/// cryptographic, only de-synchronization.
pub(crate) fn backoff_delay(timing: &Timing, attempt: u32) -> Duration {
    if timing.backoff_base.is_zero() {
        return Duration::ZERO;
    }
    let exp = attempt.min(16);
    let raw = timing.backoff_base.saturating_mul(1u32 << exp);
    jitter(raw).min(timing.backoff_cap)
}

fn jitter(d: Duration) -> Duration {
    if d.is_zero() {
        return d;
    }
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.subsec_nanos() as u64 ^ (t.as_secs() << 20))
        .unwrap_or(0x9E3779B97F4A7C15)
        | 1;
    let unit = lcg_next(seed) % 10_000;
    // 0.6 ..= 1.4 multiplier in 1/10000 steps.
    let scaled = d.as_millis() as u64 * (6_000 + 8_000 * unit / 10_000) / 10_000;
    Duration::from_millis(scaled)
}

fn lcg_next(seed: u64) -> u64 {
    // Minimal 64-bit LCG (Numerical Recipes constants); fine for jitter.
    seed.wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407)
}

/// Whether a reqwest send error is worth one more attempt. Timeout and
/// connect failures are the classic transient pair; request-phase errors
/// (connection reset mid-handshake, H2 GOAWAY) join them. Redirect-policy
/// refusals are the native layer's OWN decision - a deterministic no that
/// retrying would only re-derive.
pub(crate) fn is_transient_send_error(e: &reqwest::Error) -> bool {
    !(e.is_redirect()) && (e.is_timeout() || e.is_connect() || e.is_request() || e.is_body())
}

/// Whether a body-read error is worth one more attempt. The capped
/// readers' named refusals ("too large", "not UTF-8") are deterministic
/// answers; "Bad response: {transport}" means the stream died mid-read,
/// which is as transient as a failed send.
pub(crate) fn is_transient_body_error(msg: &str) -> bool {
    msg.starts_with("Bad response:")
}

/// The rate-limit exhaustion message, matching the wording the commands
/// used before this module existed (the frontend's failure classifier
/// recognizes "rate limit" verbatim).
pub(crate) fn rate_limit_message(label: &str) -> String {
    format!("{label} rate limit reached; try again in a few minutes")
}

/// The wait the server itself suggested for the next attempt after a
/// retryable status: its numeric `Retry-After` (capped). `None` - no
/// header, or the deliberately unsupported HTTP-date form - hands the
/// decision back to the caller's backoff schedule, so a retryable status
/// that arrives WITHOUT a `Retry-After` is still spaced by the
/// exponential backoff and never retried back-to-back.
fn retry_after_delay(timing: &Timing, headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after)
        .map(|d| d.min(timing.retry_after_cap))
}

/// One conditional GET with the full resilience contract.
///
/// Never panics, never loops forever, never retries a deterministic
/// answer. On success the body is cached (with ETag) when a store is
/// present; on 304 the cached body is served; on exhausted attempts any
/// cache entry younger than [`STALE_MAX_AGE`] stands in.
///
/// The wait before each retry is per-call state (`planned_delay`): a
/// server-suggested `Retry-After` is consumed once on the iteration after
/// the status that carried it, and the backoff schedule fills every other
/// gap. No static or shared state - concurrent commands each own their
/// schedule.
pub(crate) async fn get_json_resilient(
    client: &reqwest::Client,
    url: &reqwest::Url,
    label: &'static str,
    timing: &Timing,
    cache: Option<&CacheStore>,
) -> Result<ResolvedApiBody, ApiFetchError> {
    let url_str = url.as_str().to_string();
    let mut last_transient: Option<String> = None;
    let mut planned_delay: Option<Duration> = None;

    for attempt in 0..timing.max_attempts {
        if attempt > 0 {
            let delay = planned_delay
                .take()
                .unwrap_or_else(|| backoff_delay(timing, attempt - 1));
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
        }

        let mut request = client.get(url.clone());
        if let Some(etag) = cache.and_then(|c| c.etag_for(&url_str)) {
            request = request.header(IF_NONE_MATCH, etag);
        }
        match request.send().await {
            Err(e) => {
                if is_transient_send_error(&e) {
                    last_transient = Some(crate::network_policy::describe_network_error(&e));
                    planned_delay = None;
                    continue;
                }
                return Err(ApiFetchError::Status(
                    crate::network_policy::describe_network_error(&e),
                ));
            }
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() && status != reqwest::StatusCode::NOT_MODIFIED {
                    // Copy the ETag out before the response is consumed by
                    // the capped reader.
                    let etag: Option<String> = resp
                        .headers()
                        .get(ETAG)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    return match crate::http_body::read_capped_api_text(resp).await {
                        Ok(body) => {
                            if let Some(c) = cache {
                                c.store(&url_str, etag.as_deref(), &body);
                            }
                            Ok(ResolvedApiBody {
                                body,
                                provenance: BodyProvenance::Fresh,
                            })
                        }
                        Err(msg) => {
                            if is_transient_body_error(&msg) {
                                last_transient = Some(msg);
                                planned_delay = None;
                                continue;
                            }
                            Err(ApiFetchError::Status(msg))
                        }
                    };
                }
                if status == reqwest::StatusCode::NOT_MODIFIED {
                    // A 304 is only meaningful for a conditional request;
                    // the cached body is by definition what the origin
                    // would send now, so refresh its stamp. No quota was
                    // spent on this answer.
                    if let Some(c) = cache {
                        if let Some((body, _age)) = c.body_for(&url_str) {
                            c.touch(&url_str);
                            return Ok(ResolvedApiBody {
                                body,
                                provenance: BodyProvenance::NotModified,
                            });
                        }
                    }
                    return Err(ApiFetchError::Status(format!(
                        "{label} returned an unexpected HTTP 304"
                    )));
                }
                let headers = resp.headers().clone();
                if is_retryable_status(status.as_u16(), &headers) {
                    last_transient = Some(if status.as_u16() == 403 || status.as_u16() == 429 {
                        rate_limit_message(label)
                    } else {
                        format!("{label} returned HTTP {}", status.as_u16())
                    });
                    planned_delay = retry_after_delay(timing, &headers);
                    continue;
                }
                return Err(ApiFetchError::Status(format!(
                    "{label} returned HTTP {}",
                    status.as_u16()
                )));
            }
        }
    }

    // Every attempt failed. A young-enough cached answer stands in - the
    // stale body names real files that still download, which beats an
    // error toast by every measure the user cares about.
    if let Some(c) = cache {
        if let Some((body, saved_at_ms)) = c.body_for(&url_str) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now.saturating_sub(saved_at_ms) <= STALE_MAX_AGE.as_millis() as u64 {
                return Ok(ResolvedApiBody {
                    body,
                    provenance: BodyProvenance::StaleFallback,
                });
            }
        }
    }
    Err(ApiFetchError::Transient(
        last_transient.unwrap_or_else(|| format!("{label} could not be reached")),
    ))
}

#[cfg(test)]
mod tests;
