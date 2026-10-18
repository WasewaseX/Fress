// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

//! Tests for the resolver resilience layer: the pure decision helpers, the
//! persistent cache store, and - over real loopback HTTP with a scripted
//! origin - every serving path of `get_json_resilient` (fresh 200, the
//! quota-free 304, transient retries, deterministic refusals, and the
//! stale fallback that keeps a failed lookup from ever reaching the user
//! as an error toast).

use super::*;
use std::io::{Read as _, Write as _};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Scripted loopback origin: accepts N sequential connections, records every
// request head it sees, answers each with the next scripted raw response.
// ---------------------------------------------------------------------------

fn spawn_scripted_http(replies: Vec<Vec<u8>>, observed: Arc<Mutex<Vec<String>>>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buf = [0u8; 4096];
            let mut head = Vec::new();
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        head.extend_from_slice(&buf[..n]);
                        if head.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            observed
                .lock()
                .expect("observed lock")
                .push(String::from_utf8_lossy(&head).into_owned());
            let _ = stream.write_all(&reply);
            let _ = stream.flush();
            // Dropping the socket closes the connection; the client opens
            // a fresh one for the next attempt.
        }
    });
    format!("http://{addr}/payload")
}

fn raw_response(status_line: &str, headers: &[&str], body: &[u8]) -> Vec<u8> {
    let mut out = format!("{status_line}\r\nContent-Length: {}\r\n", body.len());
    for h in headers {
        out.push_str(h);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn json_body(tag: &str) -> String {
    format!(r#"{{"tag_name":"{tag}","assets":[]}}"#)
}

async fn get(
    url: &str,
    timing: &Timing,
    cache: Option<&CacheStore>,
) -> Result<ResolvedApiBody, ApiFetchError> {
    // Connection pooling disabled: the scripted origin closes every
    // connection after its reply, and a pooled stale-keepalive reconnect
    // would make per-request connection counts nondeterministic.
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .expect("loopback client");
    let parsed = reqwest::Url::parse(url).expect("loopback url");
    get_json_resilient(&client, &parsed, "GitHub", timing, cache).await
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn retryable_statuses_are_exactly_the_transient_family() {
    let empty = reqwest::header::HeaderMap::new();
    for status in [408, 429, 500, 502, 503, 504] {
        assert!(is_retryable_status(status, &empty), "{status} must retry");
    }
    for status in [400, 401, 403, 404, 409, 410, 418, 422] {
        assert!(
            !is_retryable_status(status, &empty),
            "{status} is deterministic"
        );
    }
}

#[test]
fn a_403_is_retryable_only_with_a_rate_limit_signature() {
    // Primary rate limit: the remaining budget is exactly zero.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-ratelimit-remaining",
        reqwest::header::HeaderValue::from_static("0"),
    );
    assert!(is_retryable_status(403, &headers));
    // Secondary rate limit: an explicit Retry-After.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::RETRY_AFTER,
        reqwest::header::HeaderValue::from_static("30"),
    );
    assert!(is_retryable_status(403, &headers));
    // A plain forbidden answer is a real no.
    let empty = reqwest::header::HeaderMap::new();
    assert!(!is_retryable_status(403, &empty));
    // Budget remaining (even 1) means the 403 is a genuine refusal.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-ratelimit-remaining",
        reqwest::header::HeaderValue::from_static("1"),
    );
    assert!(!is_retryable_status(403, &headers));
}

#[test]
fn retry_after_parses_seconds_and_ignores_other_forms() {
    assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));
    assert_eq!(parse_retry_after(" 30 "), Some(Duration::from_secs(30)));
    assert_eq!(parse_retry_after("soon"), None);
    // The HTTP-date form is deliberately unsupported (falls back to backoff).
    assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None);
}

#[test]
fn backoff_grows_exponentially_and_stays_under_the_cap() {
    let timing = Timing {
        max_attempts: 4,
        backoff_base: Duration::from_millis(500),
        backoff_cap: Duration::from_secs(4),
        retry_after_cap: Duration::from_secs(15),
    };
    // The unjittered progression 0.5s -> 1s -> 2s stays within the +-40%
    // jitter window at every attempt.
    for attempt in 0u32..3 {
        let d = backoff_delay(&timing, attempt);
        let base = timing.backoff_base * (1u32 << attempt);
        assert!(
            d >= base * 6 / 10,
            "attempt {attempt}: {d:?} below -40% of {base:?}"
        );
        assert!(
            d <= base * 14 / 10,
            "attempt {attempt}: {d:?} above +40% of {base:?}"
        );
    }
    // Attempt 3 would be 4s unjittered; the cap keeps the delay at or
    // below the cap itself.
    let d = backoff_delay(&timing, 3);
    assert!(d <= Duration::from_secs(4), "cap violated: {d:?}");
}

#[test]
fn zero_base_backoff_is_immediate() {
    let timing = Timing::instant();
    for attempt in 0u32..4 {
        assert_eq!(backoff_delay(&timing, attempt), Duration::ZERO);
    }
}

#[test]
fn body_error_classification_matches_the_capped_readers() {
    assert!(is_transient_body_error("Bad response: connection reset"));
    assert!(!is_transient_body_error("Response body too large"));
    assert!(!is_transient_body_error("Response body is not UTF-8"));
}

#[test]
fn rate_limit_message_keeps_the_frontend_classifier_wording() {
    let m = rate_limit_message("GitHub");
    assert!(m.starts_with("GitHub rate limit reached"), "{m}");
}

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

fn temp_cache_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "fress-api-resilience-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp cache dir");
    dir
}

#[test]
fn cache_roundtrips_body_and_etag_on_disk() {
    let root = temp_cache_root("roundtrip");
    let url = "https://api.github.com/repos/x/y/releases/latest";
    {
        let store = CacheStore::open(Some(root.clone()));
        assert_eq!(store.etag_for(url), None);
        store.store(url, Some("\"abc123\""), r#"{"tag_name":"v1"}"#);
    }
    // A fresh process (new store over the same directory) sees the entry.
    let store = CacheStore::open(Some(root.clone()));
    assert_eq!(store.etag_for(url).as_deref(), Some("\"abc123\""));
    let (body, _) = store.body_for(url).expect("entry survives reload");
    assert_eq!(body, r#"{"tag_name":"v1"}"#);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn cache_skips_entries_over_the_per_entry_cap() {
    let store = CacheStore::memory_only();
    let big = "x".repeat(CACHE_ENTRY_CAP as usize + 1);
    store.store("https://host/big", Some("\"e\""), &big);
    assert_eq!(store.body_for("https://host/big"), None);
}

#[test]
fn cache_evicts_oldest_first_across_both_budgets() {
    let store = CacheStore::memory_only();
    // More entries than the count cap: oldest saved_at goes first.
    for i in 0..(CACHE_MAX_ENTRIES + 8) {
        let url = format!("https://host/e{i}");
        store.store(&url, None, &format!(r#"{{"i":{i}}}"#));
    }
    let guard = store.inner.lock().expect("lock");
    let file = guard.as_ref().expect("file");
    assert!(file.entries.len() <= CACHE_MAX_ENTRIES);
    // The first-inserted entries are gone; the newest survive.
    assert!(!file.entries.contains_key("https://host/e0"));
    assert!(file
        .entries
        .contains_key(&format!("https://host/e{}", CACHE_MAX_ENTRIES + 7)));
}

#[test]
fn cache_touch_refreshes_the_stamp_without_touching_the_body() {
    let store = CacheStore::memory_only();
    let url = "https://host/t";
    store.store(url, Some("\"e\""), r#"{"a":1}"#);
    let (_, before) = store.body_for(url).expect("entry");
    std::thread::sleep(std::time::Duration::from_millis(5));
    store.touch(url);
    let (body, after) = store.body_for(url).expect("entry");
    assert_eq!(body, r#"{"a":1}"#);
    assert!(after >= before + 5);
    // Touching a missing entry is a no-op, never a panic.
    store.touch("https://host/missing");
}

#[test]
fn a_corrupt_cache_file_degrades_to_an_empty_store() {
    let root = temp_cache_root("corrupt");
    std::fs::write(root.join("api-cache-v1.json"), b"{not json").expect("corrupt file");
    let store = CacheStore::open(Some(root.clone()));
    assert_eq!(store.etag_for("https://host/x"), None);
    // And the store still works afterwards.
    store.store("https://host/x", None, r#"{"ok":true}"#);
    assert!(store.body_for("https://host/x").is_some());
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// get_json_resilient over real loopback HTTP
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_fresh_200_is_served_and_cached_with_its_etag() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let body = json_body("v1.2.3");
    let url = spawn_scripted_http(
        vec![raw_response(
            "HTTP/1.1 200 OK",
            &[r#"ETag: "e1""#],
            body.as_bytes(),
        )],
        observed.clone(),
    );
    let store = CacheStore::memory_only();
    let r = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect("fresh 200");
    assert_eq!(r.provenance, BodyProvenance::Fresh);
    assert_eq!(r.body, body);
    assert_eq!(store.etag_for(&url).as_deref(), Some("\"e1\""));
    assert_eq!(observed.lock().expect("lock").len(), 1);
}

#[tokio::test]
async fn a_304_is_served_from_the_cache_without_spending_quota() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let body = json_body("v1.2.3");
    // First connection answers 200 + ETag; the second MUST carry
    // If-None-Match and gets the quota-free 304.
    let url = spawn_scripted_http(
        vec![
            raw_response("HTTP/1.1 200 OK", &[r#"ETag: "e1""#], body.as_bytes()),
            raw_response("HTTP/1.1 304 Not Modified", &[], b""),
        ],
        observed.clone(),
    );
    let store = CacheStore::memory_only();
    let first = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect("fresh 200");
    assert_eq!(first.provenance, BodyProvenance::Fresh);

    let second = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect("304 served from cache");
    assert_eq!(second.provenance, BodyProvenance::NotModified);
    assert_eq!(second.body, body);

    let requests = observed.lock().expect("lock");
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1].to_lowercase().contains("if-none-match: \"e1\""),
        "second request must revalidate with the stored ETag: {}",
        requests[1]
    );
}

#[tokio::test]
async fn transient_5xx_is_retried_until_the_origin_answers() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let body = json_body("v2.0.0");
    let url = spawn_scripted_http(
        vec![
            raw_response("HTTP/1.1 503 Service Unavailable", &[], b""),
            raw_response("HTTP/1.1 502 Bad Gateway", &[], b""),
            raw_response("HTTP/1.1 200 OK", &[r#"ETag: "e2""#], body.as_bytes()),
        ],
        observed.clone(),
    );
    let r = get(&url, &Timing::instant(), None)
        .await
        .expect("third attempt succeeds");
    assert_eq!(r.provenance, BodyProvenance::Fresh);
    assert_eq!(r.body, body);
    assert_eq!(observed.lock().expect("lock").len(), 3);
}

#[tokio::test]
async fn a_404_is_deterministic_and_never_retried() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let url = spawn_scripted_http(
        vec![raw_response("HTTP/1.1 404 Not Found", &[], b"{}")],
        observed.clone(),
    );
    let err = get(&url, &Timing::instant(), None)
        .await
        .expect_err("404 is a deterministic status");
    match err {
        ApiFetchError::Status(msg) => {
            assert_eq!(msg, "GitHub returned HTTP 404");
        }
        ApiFetchError::Transient(m) => panic!("404 must not be transient: {m}"),
    }
    assert_eq!(
        observed.lock().expect("lock").len(),
        1,
        "a 404 must be answered exactly once - retrying cannot help"
    );
}

#[tokio::test]
async fn a_plain_403_is_deterministic_and_never_retried() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let url = spawn_scripted_http(
        vec![raw_response("HTTP/1.1 403 Forbidden", &[], b"{}")],
        observed.clone(),
    );
    let err = get(&url, &Timing::instant(), None)
        .await
        .expect_err("403 without rate-limit headers is deterministic");
    match err {
        ApiFetchError::Status(msg) => assert_eq!(msg, "GitHub returned HTTP 403"),
        ApiFetchError::Transient(m) => panic!("plain 403 must not be transient: {m}"),
    }
    assert_eq!(observed.lock().expect("lock").len(), 1);
}

#[tokio::test]
async fn a_rate_limited_lookup_serves_the_stale_cache_instead_of_failing() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let body = json_body("v1.0.0");
    let url = spawn_scripted_http(
        vec![
            // First lookup: healthy.
            raw_response("HTTP/1.1 200 OK", &[r#"ETag: "e3""#], body.as_bytes()),
            // Second lookup: rate-limited on EVERY attempt (GitHub's
            // primary limit: remaining budget zero). Retry-After: 0 keeps
            // the retry schedule instant for the test.
            raw_response(
                "HTTP/1.1 403 Forbidden",
                &["x-ratelimit-remaining: 0", "Retry-After: 0"],
                b"{}",
            ),
            raw_response(
                "HTTP/1.1 403 Forbidden",
                &["x-ratelimit-remaining: 0", "Retry-After: 0"],
                b"{}",
            ),
            raw_response(
                "HTTP/1.1 403 Forbidden",
                &["x-ratelimit-remaining: 0", "Retry-After: 0"],
                b"{}",
            ),
            raw_response(
                "HTTP/1.1 403 Forbidden",
                &["x-ratelimit-remaining: 0", "Retry-After: 0"],
                b"{}",
            ),
        ],
        observed.clone(),
    );
    let store = CacheStore::memory_only();
    let first = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect("healthy lookup");
    assert_eq!(first.provenance, BodyProvenance::Fresh);

    let second = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect("stale fallback must serve the cached answer");
    assert_eq!(second.provenance, BodyProvenance::StaleFallback);
    assert_eq!(second.body, body);
    // 1 healthy + 4 exhausted attempts = 5 connections.
    assert_eq!(observed.lock().expect("lock").len(), 5);
}

#[tokio::test]
async fn an_exhausted_rate_limit_without_a_cache_is_an_honest_rate_limit_error() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let url = spawn_scripted_http(
        vec![
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
        ],
        observed.clone(),
    );
    let err = get(&url, &Timing::instant(), None)
        .await
        .expect_err("no cache, no stale answer");
    match err {
        ApiFetchError::Transient(msg) => {
            assert_eq!(msg, rate_limit_message("GitHub"));
        }
        ApiFetchError::Status(m) => panic!("rate-limit exhaustion is transient: {m}"),
    }
    assert_eq!(observed.lock().expect("lock").len(), 4);
}

#[tokio::test]
async fn an_ancient_cache_entry_is_never_served_stale() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let url = spawn_scripted_http(
        vec![
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
            raw_response("HTTP/1.1 429 Too Many Requests", &["Retry-After: 0"], b"{}"),
        ],
        observed.clone(),
    );
    let store = CacheStore::memory_only();
    // Prime the cache, then backdate the entry past the stale window.
    store.store(&url, None, &json_body("v0.9.0"));
    {
        let mut guard = store.inner.lock().expect("lock");
        let file = guard.as_mut().expect("file");
        if let Some(e) = file.entries.get_mut(&url) {
            e.saved_at_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
                .saturating_sub(STALE_MAX_AGE.as_millis() as u64 + 1);
        }
    }
    let err = get(&url, &Timing::instant(), Some(&store))
        .await
        .expect_err("an ancient answer must not stand in");
    match err {
        ApiFetchError::Transient(msg) => assert_eq!(msg, rate_limit_message("GitHub")),
        ApiFetchError::Status(m) => panic!("rate-limit exhaustion is transient: {m}"),
    }
}

#[tokio::test]
async fn a_redirect_policy_refusal_is_never_retried() {
    // The native layer's clients are built with redirect policies that
    // ERROR on a disallowed hop (scheme/host/path rules). Mirror that
    // shape here with a custom policy that refuses every redirect: the
    // resulting send error has is_redirect() true, which the resilience
    // layer must classify as a DETERMINISTIC refusal - exactly once, no
    // retry (the origin here accepts connections forever, so a retrying
    // caller would spin).
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let reply = raw_response("HTTP/1.1 302 Found", &["Location: /elsewhere"], b"");
            let _ = stream.write_all(&reply);
        }
    });
    let url = format!("http://{addr}/start");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            attempt.error("insecure redirect refused")
        }))
        .build()
        .expect("strict client");
    let parsed = reqwest::Url::parse(&url).expect("loopback url");
    let err = get_json_resilient(&client, &parsed, "GitHub", &Timing::instant(), None)
        .await
        .expect_err("a policy-refused redirect is deterministic");
    match err {
        ApiFetchError::Status(msg) => {
            assert!(
                msg.contains("redirect"),
                "expected the redirect refusal to be named: {msg}"
            );
        }
        ApiFetchError::Transient(m) => panic!("redirect refusals must not be retried: {m}"),
    }
    drop(handle);
}
