// Bounded response-body readers shared by every native command that
// buffers a response in memory.
//
// Two rails bound every buffered read, and this module exists so the two
// cannot drift apart or silently substitute for each other:
//
//   1. A SIZE CAP on the whole body. Text documents (vendor manifests, the
//      self-update atom feed, SHA256SUMS.txt) are truncated at the cap and
//      the truncation is REPORTED (`truncated: true`) - a caller that
//      needs the complete document fail-closes on the flag. JSON API
//      bodies are REFUSED past the cap: a truncated JSON answer must never
//      be parsed as if it were complete.
//   2. A TIMEOUT on the whole request carried by the reqwest client
//      (`network_policy`: 20 s whole-request + 15 s connect for every
//      short-lived client; the download engine instead enforces a 60 s
//      inter-chunk stall window). The timeout bounds how long a slow body
//      may hold the connection open; the cap bounds how much a fast body
//      may buffer. The tests at the bottom pin BOTH rails so neither can
//      be quietly removed as a "replacement" for the other.
//
// The module is deliberately Tauri-free (plain reqwest + serde types) so
// the readers and their loopback regression tests compile and run
// everywhere the workspace's test suite runs, including the audit harness
// for machines without the Tauri system libraries.

use serde::Serialize;

/// Whole-body cap for text documents read by `fetch_text` and
/// `fetch_self_update_text` (manifests, directory indexes, the atom feed,
/// SHA256SUMS.txt). A body larger than the cap is NOT read past it - the
/// caller gets the final URL and the content length instead, which is
/// exactly what a redirect-to-file endpoint requires without ever pulling
/// a 200 MB installer into memory.
pub(crate) const FETCH_TEXT_BODY_CAP: u64 = 2 * 1024 * 1024;

/// Whole-body cap for the JSON API commands (`fetch_latest_release`,
/// `fetch_recent_releases`, `fetch_fdroid_package`). Generous by design: a
/// `per_page=30` release list is order-of-megabytes, so the cap can only be
/// hit by a hostile or broken pinned host. Unlike the text commands (which
/// truncate and report), these bodies are parsed as JSON, so a truncation
/// could never be interpreted - past the cap the response is refused with a
/// named error instead of being read into memory without bound (an unbounded
/// `resp.text()` on a pinned host would let a multi-gigabyte body balloon
/// the app's RSS until the process dies).
pub(crate) const API_BODY_CAP: u64 = 10 * 1024 * 1024;

/// A small text document fetched through the bounded readers: status,
/// redirect-resolved URL, advertised length, the capped body and whether
/// the body was cut at [`FETCH_TEXT_BODY_CAP`].
#[derive(Serialize, Clone, Debug)]
pub(crate) struct TextFetch {
    pub(crate) status: u16,
    pub(crate) final_url: String,
    pub(crate) content_length: Option<u64>,
    pub(crate) body: String,
    pub(crate) truncated: bool,
}

/// Streams a JSON API response body under `cap`. An oversized advertised
/// content-length refuses the body outright; a body that grows past the cap
/// mid-stream is refused the moment it crosses the line. Named so callers
/// can surface the reason instead of a confusing JSON parse failure.
pub(crate) async fn read_capped_api_text_with_cap(
    mut resp: reqwest::Response,
    cap: u64,
) -> Result<String, String> {
    if resp.content_length().is_some_and(|n| n > cap) {
        return Err("Response body too large".to_string());
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Bad response: {}", e))?
    {
        // Check-before-extend: the buffer never exceeds the cap, even
        // briefly. The addition is done in u64 (both operands are usize on
        // every supported target) so a 32-bit host cannot alias the sum.
        if buf.len() as u64 + chunk.len() as u64 > cap {
            return Err("Response body too large".to_string());
        }
        buf.extend_from_slice(&chunk);
    }
    // API JSON is UTF-8 by RFC 8259; a body that is not is a broken answer
    // (reqwest's text() would silently replace invalid bytes, moving the
    // failure into a less explicable JSON parse error).
    String::from_utf8(buf).map_err(|_| "Response body is not UTF-8".to_string())
}

/// Production cap for [`read_capped_api_text_with_cap`].
pub(crate) async fn read_capped_api_text(resp: reqwest::Response) -> Result<String, String> {
    read_capped_api_text_with_cap(resp, API_BODY_CAP).await
}

/// Streams a response body into a `TextFetch` under the shared 2 MiB cap:
/// an oversized content-length refuses the body outright, and a body that
/// grows past the cap mid-stream is truncated and reported. Shared by every
/// text-fetching command (`fetch_text`, `fetch_self_update_text`) so the
/// cap cannot drift between them.
pub(crate) async fn read_capped_text(mut resp: reqwest::Response) -> Result<TextFetch, String> {
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_length = resp.content_length();
    let mut truncated = false;
    let body = if content_length.is_some_and(|n| n > FETCH_TEXT_BODY_CAP) {
        truncated = true;
        String::new()
    } else {
        // Stream at most the cap even without a content-length header.
        // resp.chunk() is reqwest's own streaming API - no extra dep needed.
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    // Check-before-extend: never hold more than the cap,
                    // even briefly (extend-then-truncate could overshoot
                    // by one transport chunk). The observable semantics
                    // are unchanged - the first cap bytes are kept and
                    // `truncated` reports the loss.
                    let room = (FETCH_TEXT_BODY_CAP - buf.len() as u64) as usize;
                    if chunk.len() > room {
                        buf.extend_from_slice(&chunk[..room]);
                        truncated = true;
                        break;
                    }
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => return Err(format!("Bad response: {}", e)),
            }
        }
        // Text documents are decoded lossily on purpose: a manifest with a
        // stray non-UTF-8 byte in a comment must still resolve. This is
        // the deliberate contrast with the JSON readers, which refuse.
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(TextFetch {
        status,
        final_url,
        content_length,
        body,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Regression tests: real loopback HTTP, real reqwest client, real readers.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::time::Duration;

    /// Loopback HTTP server serving ONE scripted raw response, then closing.
    /// Returns the base URL and joins the writer thread on drop of the guard.
    fn spawn_raw_http(reply: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Drain the request head (GET has no body).
                let mut buf = [0u8; 2048];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let _ = stream.write_all(&reply);
                let _ = stream.flush();
                // Closing the socket ends the response (close-delimited when no
                // Content-Length is present).
            }
        });
        (format!("http://{addr}/payload"), handle)
    }

    /// Loopback server that writes `head`, then drips `body` one byte at a
    /// time with `per_byte` between writes - the slow-drip shape a size cap
    /// alone cannot stop and only the request timeout may kill.
    fn spawn_drip_http(
        head: Vec<u8>,
        body: &'static [u8],
        per_byte: Duration,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let _ = stream.write_all(&head);
                let _ = stream.flush();
                for b in body {
                    let _ = stream.write_all(&[*b]);
                    let _ = stream.flush();
                    std::thread::sleep(per_byte);
                }
                // Closed without finish: the client must hit the timeout
                // first either way (the body is tiny and under the cap).
            }
        });
        (format!("http://{addr}/payload"), handle)
    }

    async fn api_get(url: &str) -> reqwest::Response {
        reqwest::Client::new()
            .get(reqwest::Url::parse(url).expect("loopback url"))
            .send()
            .await
            .expect("loopback request succeeds")
    }

    #[tokio::test]
    async fn api_text_reads_accept_a_body_under_the_cap() {
        let mut reply = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n".to_vec();
        reply.extend_from_slice(b"[1,2]");
        let (url, _join) = spawn_raw_http(reply);
        let body = read_capped_api_text_with_cap(api_get(&url).await, 16)
            .await
            .expect("an under-cap body must be read");
        assert_eq!(body, "[1,2]");
    }

    #[tokio::test]
    async fn api_text_reads_refuse_an_oversized_content_length_before_the_body() {
        // An honestly advertised oversized body is refused on the header - no
        // body bytes are pulled into memory at all.
        let reply =
            b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\nonly-a-few-bytes-sent-anyway".to_vec();
        let (url, _join) = spawn_raw_http(reply);
        let err = read_capped_api_text_with_cap(api_get(&url).await, 16)
            .await
            .expect_err("an oversized advertised body must be refused");
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn api_text_reads_refuse_a_body_that_grows_past_the_cap_midstream() {
        // The lying-server case: no Content-Length (close-delimited), the body
        // grows past the cap while streaming. The read stops at the cap line
        // and refuses instead of buffering an unbounded body.
        let mut reply = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        reply.extend_from_slice(&[b'x'; 4096]);
        let (url, _join) = spawn_raw_http(reply);
        let err = read_capped_api_text_with_cap(api_get(&url).await, 16)
            .await
            .expect_err("a body growing past the cap must be refused");
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn api_text_reads_refuse_a_non_utf8_body_with_a_named_error() {
        // The API JSON readers must not silently lossy-decode: a broken
        // pinned host cannot turn garbage bytes into a confusing JSON parse
        // error - the failure is named as the encoding it is.
        let mut reply = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n".to_vec();
        reply.extend_from_slice(&[0xFF, 0xFE, 0xC3, 0x28]); // invalid UTF-8
        let (url, _join) = spawn_raw_http(reply);
        let err = read_capped_api_text_with_cap(api_get(&url).await, 1024)
            .await
            .expect_err("a non-UTF-8 API body must be refused");
        assert!(err.contains("not UTF-8"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn api_text_reads_accept_a_content_length_of_exactly_the_cap() {
        // Boundary pin: both checks use a strict `>` - a body of exactly
        // `cap` bytes (advertised honestly) is accepted.
        let body = vec![b'a'; 16];
        let mut reply =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        reply.extend_from_slice(&body);
        let (url, _join) = spawn_raw_http(reply);
        let text = read_capped_api_text_with_cap(api_get(&url).await, 16)
            .await
            .expect("an exactly-cap advertised body must be accepted");
        assert_eq!(text.len(), 16);
    }

    #[tokio::test]
    async fn api_text_reads_accept_a_close_delimited_body_of_exactly_the_cap() {
        // Boundary pin for the streaming check: a close-delimited body that
        // reaches exactly `cap` bytes must complete without the refusal.
        let mut reply = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        reply.extend_from_slice(&[b'b'; 16]);
        let (url, _join) = spawn_raw_http(reply);
        let text = read_capped_api_text_with_cap(api_get(&url).await, 16)
            .await
            .expect("an exactly-cap streamed body must be accepted");
        assert_eq!(text.len(), 16);
    }

    #[tokio::test]
    async fn a_slow_drip_body_is_killed_by_the_timeout_not_the_cap() {
        // Independence pin, time rail: a body that stays far under the cap
        // but drips slowly must be killed by the client's request timeout -
        // the cap must NOT fire for it (and the fast-oversized tests above
        // show the cap firing long before any plausible timeout). Neither
        // rail substitutes for the other.
        //
        // The assertion uses the typed reqwest error (`is_timeout`) rather
        // than the reader's string mapping on purpose: the reader wraps any
        // body error as "Bad response: {e}" and the top-level Display of a
        // timed-out body read is reqwest's generic decode-error text - the
        // typed check is what actually distinguishes the time rail.
        //
        // Timing budget (CI-load tolerance): the timeout (1 s) must fire
        // WELL BEFORE the server would close on its own (per_byte x count),
        // or a slow runner sees a clean EOF instead of a timeout - the
        // invariant is per_byte * count > timeout + margin.
        const HEAD: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n";
        const BODY: &[u8] = b"abcdef";
        let (url, _join) = spawn_drip_http(HEAD.to_vec(), BODY, Duration::from_millis(300));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("timeout client builds");
        let mut resp = client
            .get(reqwest::Url::parse(&url).expect("loopback url"))
            .send()
            .await
            .expect("headers arrive well inside the timeout");
        let started = std::time::Instant::now();
        let mut received = 0usize;
        let err = loop {
            match resp.chunk().await {
                Ok(Some(b)) => received += b.len(),
                Ok(None) => {
                    panic!("the drip server closed before the timeout fired (got {received} bytes)")
                }
                Err(e) => break e,
            }
        };
        assert!(err.is_timeout(), "expected the time rail, got: {err}");
        // The first drip byte arrived; the timeout killed the rest.
        assert!(received >= 1, "expected at least the first drip byte");
        // Fired at the configured timeout, not after a stall-scale wait.
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "the timeout must fire promptly, took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn text_reads_return_a_body_under_the_cap_intact() {
        let mut reply = b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\n".to_vec();
        reply.extend_from_slice(b"hello manifest");
        let (url, _join) = spawn_raw_http(reply);
        let fetched = read_capped_text(api_get(&url).await)
            .await
            .expect("an under-cap text body must be read");
        assert_eq!(fetched.status, 200);
        assert_eq!(fetched.body, "hello manifest");
        assert!(!fetched.truncated);
        assert_eq!(fetched.content_length, Some(14));
    }

    #[tokio::test]
    async fn text_reads_refuse_an_oversized_advertised_body_without_reading_it() {
        // The truncate-and-report rail: an honestly advertised oversized
        // manifest is NOT read - the caller gets an empty body with
        // `truncated: true` and the advertised length.
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\nsmall-anyway",
            3 * 1024 * 1024
        )
        .into_bytes();
        let (url, _join) = spawn_raw_http(reply);
        let fetched = read_capped_text(api_get(&url).await)
            .await
            .expect("the response itself is readable");
        assert!(fetched.truncated);
        assert!(fetched.body.is_empty());
        assert_eq!(fetched.content_length, Some(3 * 1024 * 1024));
    }

    #[tokio::test]
    async fn text_reads_truncate_a_close_delimited_body_at_exactly_the_cap() {
        // The lying-server case for the text rail: no Content-Length, the
        // body grows past 2 MiB while streaming. Exactly the first cap
        // bytes are kept - no more - and the truncation is reported.
        let mut reply = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        reply.extend_from_slice(&[b'x'; 3 * 1024 * 1024]);
        let (url, _join) = spawn_raw_http(reply);
        let fetched = read_capped_text(api_get(&url).await)
            .await
            .expect("the response itself is readable");
        assert!(fetched.truncated);
        assert_eq!(fetched.body.len() as u64, FETCH_TEXT_BODY_CAP);
        assert!(fetched.body.bytes().all(|b| b == b'x'));
    }

    #[tokio::test]
    async fn text_reads_accept_a_close_delimited_body_at_exactly_the_cap() {
        // Boundary pin for the text rail's streaming check: a body of
        // exactly `FETCH_TEXT_BODY_CAP` bytes (close-delimited, so only the
        // streaming check guards it) completes WITHOUT the truncation flag.
        // `room` equals the remaining bytes for the last chunk, so the
        // strict `>` keeps it - the same exactly-at-cap semantics the API
        // reader pins above.
        let mut reply = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        reply.extend_from_slice(&[b'x'; 2 * 1024 * 1024]);
        let (url, _join) = spawn_raw_http(reply);
        let fetched = read_capped_text(api_get(&url).await)
            .await
            .expect("an exactly-cap streamed text body must be accepted");
        assert!(!fetched.truncated, "exactly-cap is not a truncation");
        assert_eq!(fetched.body.len() as u64, FETCH_TEXT_BODY_CAP);
    }

    #[tokio::test]
    async fn text_reads_accept_an_advertised_body_at_exactly_the_cap() {
        // Boundary pin for the text rail's advertised-length check: the
        // strict `>` accepts Content-Length == cap and reads the body
        // normally (never the empty-body + truncated shape reserved for
        // bodies OVER the cap).
        let body = vec![b'm'; 2 * 1024 * 1024];
        let mut reply =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        reply.extend_from_slice(&body);
        let (url, _join) = spawn_raw_http(reply);
        let fetched = read_capped_text(api_get(&url).await)
            .await
            .expect("an exactly-cap advertised text body must be accepted");
        assert!(!fetched.truncated);
        assert_eq!(fetched.body.len() as u64, FETCH_TEXT_BODY_CAP);
        assert_eq!(fetched.content_length, Some(FETCH_TEXT_BODY_CAP));
    }

    #[test]
    fn body_cap_is_the_documented_two_megabytes() {
        // The cap bounds how much of a vendor manifest can ever be buffered.
        assert_eq!(FETCH_TEXT_BODY_CAP, 2 * 1024 * 1024);
    }

    #[test]
    fn api_body_cap_is_the_documented_ten_megabytes() {
        // Generous enough that no legitimate release list or F-Droid package
        // answer can hit it; small enough that a hostile pinned host cannot
        // balloon the app's memory.
        assert_eq!(API_BODY_CAP, 10 * 1024 * 1024);
    }
}
