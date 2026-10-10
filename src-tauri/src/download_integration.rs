// Deterministic integration tests for Fress's download and resolver rails.
//
// These tests run in CI on every PR (`cargo test`) and were added so that
// important security and download regressions BLOCK merging instead of
// merely compiling. Ground rules:
//
//   - No external network. The only HTTP endpoints touched are a loopback
//     server spawned on 127.0.0.1 for the redirect-policy test.
//   - No AppHandle. `run_download` is tightly coupled to a live Tauri
//     runtime (it emits progress events), which cannot be constructed
//     inside a unit test process; everything reachable without one is
//     exercised here. See CONTRIBUTING.md for the coverage this leaves.
//   - Temp directories are per-test and removed best-effort afterwards.

use std::path::{Path, PathBuf};

use super::download_finalize::{
    commit_no_clobber, dest_for_part, filename_from_headers, numbered_name, part_path_for,
    percent_decode, read_part_meta, write_part_meta, PartMeta,
};
use super::sanitize_filename;
use super::{
    fetch_fdroid_package, fetch_latest_release, fetch_recent_releases, fetch_text,
    parse_gh_release, FETCH_TEXT_BODY_CAP,
};

// ---------------------------------------------------------------------------
// temp dir helper
// ---------------------------------------------------------------------------

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fress-test-{}-{}-{}",
        std::process::id(),
        tag,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// sanitize_filename — the path-traversal and reserved-name rail
// ---------------------------------------------------------------------------

#[test]
fn traversal_and_separators_never_survive_sanitize() {
    // Every result must be joinable onto the download directory without
    // escaping it: no '/' or '\' anywhere.
    for hostile in [
        "../../etc/passwd",
        "..\\..\\windows\\system32\\evil.exe",
        "/abs/path.exe",
        "C:\\temp\\evil.exe",
        "a/b/c.bin",
    ] {
        let out = sanitize_filename(hostile);
        // The security property is join-safety: the result must be a single
        // path component with no separator left anywhere. (".." segments do
        // survive the character filter as literal dots - e.g. ".._.._etc" -
        // but joined onto the download directory they stay INSIDE it.)
        assert!(!out.contains('/'), "{hostile} -> {out}");
        assert!(!out.contains('\\'), "{hostile} -> {out}");
        assert_eq!(
            Path::new(&out).components().count(),
            1,
            "{hostile} -> {out}"
        );
    }
}

#[test]
fn dot_dot_and_empty_collapse_to_the_safe_default() {
    assert_eq!(sanitize_filename(""), "download.bin");
    assert_eq!(sanitize_filename(".."), "download.bin");
    assert_eq!(sanitize_filename("."), "download.bin");
    assert_eq!(sanitize_filename("   "), "download.bin");
    assert_eq!(sanitize_filename("___"), "download.bin");
}

#[test]
fn windows_reserved_device_names_collapse_to_the_safe_default() {
    // The rule applies up to the first dot and is case-insensitive.
    for reserved in ["CON", "nul", "NUL.tar.gz", "com1", "COM9.exe", "lpt4"] {
        assert_eq!(
            sanitize_filename(reserved),
            "download.bin",
            "{reserved} must collapse"
        );
    }
    // Not reserved: longer words that merely start with the letters.
    assert_eq!(sanitize_filename("controls.txt"), "controls.txt");
    assert_eq!(sanitize_filename("null.pdf"), "null.pdf");
}

#[test]
fn unicode_names_survive_sanitize() {
    // RFC 5987 decoding means any script can arrive; the name must stay
    // readable instead of collapsing to underscores.
    assert_eq!(sanitize_filename("レポート.pdf"), "レポート.pdf");
    assert_eq!(sanitize_filename("گزارش.apk"), "گزارش.apk");
}

#[test]
fn junk_characters_become_underscores_then_trim() {
    assert_eq!(
        sanitize_filename("  app setup (final).exe  "),
        "app_setup_(final).exe"
    );
    assert_eq!(sanitize_filename("a*b?c<de|.zip"), "a_b_c_de_.zip");
    assert_eq!(sanitize_filename("app:1.2.3.exe"), "app_1.2.3.exe");
}

// ---------------------------------------------------------------------------
// percent_decode — RFC 5987 companion
// ---------------------------------------------------------------------------

#[test]
fn percent_decode_turns_escapes_into_bytes() {
    assert_eq!(percent_decode("%E6%97%A5"), "\u{65e5}");
    assert_eq!(percent_decode("app%20setup.exe"), "app setup.exe");
    assert_eq!(percent_decode("plain.exe"), "plain.exe");
}

#[test]
fn percent_decode_keeps_invalid_or_truncated_escapes_literally() {
    // "E6" is a complete BYTE-wise escape: it decodes to the byte 0xE6,
    // which is not valid UTF-8 on its own, so the documented lossy
    // conversion turns it into U+FFFD. The decoder works on bytes, not
    // characters - exactly what RFC 5987 ext-values need.
    assert_eq!(percent_decode("%E6"), "\u{FFFD}");
    // A TRUNCATED escape (not enough hex digits) is kept literally.
    assert_eq!(percent_decode("%E"), "%E");
    assert_eq!(percent_decode("%ZZ"), "%ZZ"); // not hex
    assert_eq!(percent_decode("100%"), "100%"); // dangling percent
    assert_eq!(percent_decode("%2"), "%2"); // short escape
}

// ---------------------------------------------------------------------------
// filename_from_headers — Content-Disposition and URL fallback
// ---------------------------------------------------------------------------

fn header_map(cd: Option<&str>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    if let Some(value) = cd {
        map.insert(
            reqwest::header::CONTENT_DISPOSITION,
            reqwest::header::HeaderValue::from_str(value).expect("valid header value"),
        );
    }
    map
}

#[test]
fn content_disposition_plain_filename_is_used_and_sanitized() {
    let url: reqwest::Url = "https://example.com/path/ignored.bin".parse().unwrap();
    let name = filename_from_headers(
        &url,
        &header_map(Some("attachment; filename=\"app-1.2.exe\"")),
    )
    .expect("name from CD");
    assert_eq!(name, "app-1.2.exe");
}

#[test]
fn content_disposition_traversal_is_sanitized() {
    let url: reqwest::Url = "https://example.com/x.bin".parse().unwrap();
    let name = filename_from_headers(
        &url,
        &header_map(Some("attachment; filename=\"../../evil.exe\"")),
    )
    .expect("name from CD");
    // Separators became underscores; the leading dots survive as literal
    // characters but the name is still one component inside the folder.
    assert_eq!(name, ".._.._evil.exe");
    assert_eq!(Path::new(&name).components().count(), 1);
    // …but a pure ".." payload collapses to the safe default.
    let name = filename_from_headers(&url, &header_map(Some("attachment; filename=\"..\"")))
        .expect("name from CD");
    assert_eq!(name, "download.bin");
}

#[test]
fn rfc5987_ext_values_are_decoded_before_sanitize() {
    let url: reqwest::Url = "https://example.com/x".parse().unwrap();
    let name = filename_from_headers(
        &url,
        &header_map(Some("attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf")),
    )
    .expect("name from CD");
    assert_eq!(name, "\u{65e5}\u{672c}.pdf");
}

#[test]
fn url_last_segment_is_the_fallback_and_needs_an_extension() {
    let url: reqwest::Url = "https://example.com/downloads/My%20App%20Setup.exe"
        .parse()
        .unwrap();
    let name = filename_from_headers(&url, &header_map(None)).expect("name from URL");
    assert_eq!(name, "My_App_Setup.exe"); // space decoded then sanitized

    // No dot in the last segment -> no name.
    let url: reqwest::Url = "https://example.com/downloads/latest".parse().unwrap();
    assert!(filename_from_headers(&url, &header_map(None)).is_none());
}

// ---------------------------------------------------------------------------
// numbered_name / commit_no_clobber — concurrent-collision primitives
// ---------------------------------------------------------------------------

#[test]
fn numbered_name_inserts_the_counter_before_the_extension() {
    assert_eq!(numbered_name("setup.exe", 3), "setup (3).exe");
    assert_eq!(numbered_name("archive.tar.gz", 2), "archive.tar (2).gz");
    assert_eq!(numbered_name("LICENSE", 4), "LICENSE (4)");
    assert_eq!(numbered_name("setup.exe", 0), "setup.exe");
}

#[tokio::test]
async fn commit_no_clobber_skips_taken_names() {
    let dir = temp_dir("commit-no-clobber");
    std::fs::write(dir.join("file.txt"), b"x").unwrap();

    // A finished staging file whose first candidate name is taken must not
    // clobber it: the commit lands on the next free candidate instead.
    let part = dir.join("file.txt.part");
    std::fs::write(&part, b"new").unwrap();
    let committed = commit_no_clobber(&part, &dir, "file.txt").await.unwrap();
    assert_eq!(
        committed.file_name().unwrap().to_string_lossy(),
        "file (1).txt"
    );
    assert_eq!(std::fs::read(dir.join("file.txt")).unwrap(), b"x");
    assert_eq!(std::fs::read(dir.join("file (1).txt")).unwrap(), b"new");
    // A successful commit consumes the staging file.
    assert!(!part.exists());

    // A free name is committed untouched.
    let part2 = dir.join("other.txt.part");
    std::fs::write(&part2, b"y").unwrap();
    let free = commit_no_clobber(&part2, &dir, "other.txt").await.unwrap();
    assert_eq!(free.file_name().unwrap().to_string_lossy(), "other.txt");
    cleanup(&dir);
}

// ---------------------------------------------------------------------------
// staging-file path helpers and the .meta sidecar
// ---------------------------------------------------------------------------

#[test]
fn part_and_dest_paths_round_trip() {
    let dest = PathBuf::from("/downloads").join("setup.exe");
    let part = part_path_for(&dest);
    assert_eq!(
        part.file_name().unwrap().to_string_lossy(),
        "setup.exe.part"
    );
    assert_eq!(dest_for_part(&part).as_deref(), Some(dest.as_path()));
    // A file that is not a staging file has no destination.
    assert!(dest_for_part(&dest).is_none());
}

#[tokio::test]
async fn part_meta_round_trips_http_validators() {
    let dir = temp_dir("part-meta");
    let part = dir.join("setup.exe.part");

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ETAG,
        reqwest::header::HeaderValue::from_static("\"abc123\""),
    );
    headers.insert(
        reqwest::header::LAST_MODIFIED,
        reqwest::header::HeaderValue::from_static("Tue, 10 Sep 2026 00:00:00 GMT"),
    );
    write_part_meta(&part, "https://example.com/a.exe", &headers).await;

    let meta: PartMeta = read_part_meta(&part).await.expect("sidecar readable");
    assert_eq!(meta.url, "https://example.com/a.exe");
    assert_eq!(meta.etag.as_deref(), Some("\"abc123\""));
    assert_eq!(
        meta.last_modified.as_deref(),
        Some("Tue, 10 Sep 2026 00:00:00 GMT")
    );
    cleanup(&dir);
}

#[tokio::test]
async fn part_meta_without_validators_is_still_written_and_readable() {
    let dir = temp_dir("part-meta-empty");
    let part = dir.join("a.bin.part");
    write_part_meta(
        &part,
        "https://example.com/a.bin",
        &reqwest::header::HeaderMap::new(),
    )
    .await;
    let meta = read_part_meta(&part).await.expect("sidecar readable");
    assert_eq!(meta.url, "https://example.com/a.bin");
    assert!(meta.etag.is_none() && meta.last_modified.is_none());
    // A validator-less sidecar is exactly the case the byte-identity rule
    // in run_download refuses to resume from - the sidecar existing is not
    // itself proof of resumability.
    cleanup(&dir);
}

// ---------------------------------------------------------------------------
// parse_gh_release — release JSON trust boundary
// ---------------------------------------------------------------------------

#[test]
fn parse_gh_release_reads_a_full_shape() {
    let body = serde_json::json!({
        "tag_name": "v1.2.3",
        "name": "  Release 1.2.3  ",
        "published_at": "2026-01-01T00:00:00Z",
        "html_url": "https://github.com/owner/repo/releases/tag/v1.2.3",
        "assets": [
            {"name": "app.exe", "size": 100, "browser_download_url": "https://example.com/app.exe"},
            {"name": "", "size": 1, "browser_download_url": "https://example.com/junk"},   // no name -> skipped
            {"name": "nosig", "size": 1, "browser_download_url": ""},                      // no url  -> skipped
            {"name": "b.zip", "browser_download_url": "https://example.com/b.zip"}         // size optional
        ]
    });
    let release = parse_gh_release(&body, "owner/repo").expect("parsed");
    assert_eq!(release.tag, "v1.2.3");
    assert_eq!(release.name, "Release 1.2.3"); // trimmed
    assert_eq!(release.assets.len(), 2);
    assert_eq!(release.assets[0].name, "app.exe");
    assert_eq!(release.assets[0].size, 100);
    assert_eq!(release.assets[1].size, 0); // absent size -> 0
}

#[test]
fn parse_gh_release_refuses_entries_without_a_tag() {
    let body = serde_json::json!({ "name": "no tag here", "assets": [] });
    assert!(parse_gh_release(&body, "owner/repo").is_none());
    let body = serde_json::json!({ "tag_name": "", "assets": [] });
    assert!(parse_gh_release(&body, "owner/repo").is_none());
}

#[test]
fn parse_gh_release_falls_back_for_missing_name_and_url() {
    let body = serde_json::json!({
        "tag_name": "v9",
        "assets": []
    });
    let release = parse_gh_release(&body, "owner/repo").expect("parsed");
    assert_eq!(release.name, "v9"); // tag becomes the display name
    assert_eq!(release.html_url, "https://github.com/owner/repo/releases");
    assert_eq!(release.published_at, "");
}

// ---------------------------------------------------------------------------
// command input validation — the branches that must fail BEFORE any network
// ---------------------------------------------------------------------------

/// Extract the Err side of a Result without requiring the Ok type to
/// implement Debug (TextFetch is not Debug and must not become one just for
/// the tests - the implementation stays untouched).
fn err_of<T>(r: Result<T, String>) -> String {
    match r {
        Err(e) => e,
        Ok(_) => panic!("expected Err, got Ok"),
    }
}

#[tokio::test]
async fn release_commands_reject_empty_repositories_before_network() {
    for repo in ["", "   ", " / ", "//"] {
        assert!(
            fetch_latest_release(repo.to_string()).await.is_err(),
            "empty repo {repo:?} must be rejected"
        );
        assert!(
            fetch_recent_releases(repo.to_string(), None, None)
                .await
                .is_err(),
            "empty repo {repo:?} must be rejected"
        );
    }
    assert!(fetch_fdroid_package(String::new()).await.is_err());
    assert!(fetch_fdroid_package("   ".to_string()).await.is_err());
}

#[tokio::test]
async fn fetch_text_enforces_https_and_the_host_allowlist_before_any_request() {
    // Not a URL at all.
    let err = err_of(fetch_text("not a url".to_string()).await);
    // The policy error message may append explanatory detail after the
    // colon; the stable contract is the prefix.
    assert!(
        err.starts_with("Not a valid URL"),
        "unexpected error: {err}"
    );

    // Plain http is refused even for allowlisted hosts.
    let err = err_of(fetch_text("http://get.videolan.org/ftpsites.txt".to_string()).await);
    assert!(
        err.starts_with("Only https URLs are allowed"),
        "unexpected error: {err}"
    );

    // A https URL on a non-allowlisted host is refused before a request.
    let err = err_of(fetch_text("https://evil.example.com/manifest.yml".to_string()).await);
    assert!(
        err.contains("not on the resolver allowlist"),
        "unexpected error: {err}"
    );
    assert!(err.contains("evil.example.com"));
}

#[test]
fn body_cap_is_the_documented_two_megabytes() {
    // The cap bounds how much of a vendor manifest can ever be buffered.
    assert_eq!(FETCH_TEXT_BODY_CAP, 2 * 1024 * 1024);
}
