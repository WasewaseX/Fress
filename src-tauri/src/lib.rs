// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
// `Manager` powers the Android-only app-data path lookup below.
#[cfg_attr(not(target_os = "android"), allow(unused_imports))]
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

#[derive(Serialize, Deserialize, Clone)]
struct ProgressPayload {
    id: u32,
    downloaded: u64,
    total: u64,
    speed_bps: f64,
    eta_secs: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct CompletePayload {
    id: u32,
    path: String,
    bytes: u64,
    sha256: String,
    /// Some(true) = compared against the publisher's trusted hash and it
    /// matched. Some(false)/None = no trusted reference hash was supplied,
    /// so the digest was computed but NOT verified. The UI must never show
    /// "verified" for a hash that was only calculated.
    verified: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ErrorPayload {
    id: u32,
    message: String,
    /// "checksum" marks a failed integrity verification (the file has been
    /// deleted); absent for ordinary network/disk errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
}

#[derive(Serialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    download_url: String,
}

#[derive(Serialize, Clone)]
struct GhRelease {
    tag: String,
    name: String,
    published_at: String,
    html_url: String,
    assets: Vec<GhAsset>,
}

#[derive(Serialize, Clone)]
struct FdroidPackage {
    package: String,
    version: String,
    version_code: i64,
    apk_url: String,
    page_url: String,
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!(
            "Fress/{} (+https://github.com/WasewaseX/Fress)",
            env!("CARGO_PKG_VERSION")
        ))
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/// Resolves the LATEST STABLE release of a GitHub repository.
/// The /releases/latest endpoint already excludes drafts and prereleases,
/// so beta/RC versions are never offered here.
#[tauri::command]
async fn fetch_latest_release(repo: String) -> Result<GhRelease, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.is_empty() {
        return Err("No GitHub repository configured".into());
    }
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let client = api_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("No stable release found for this project".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err("GitHub rate limit reached; try again in a few minutes".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Bad response: {}", e))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad response: {}", e))?;
    parse_gh_release(&body, &repo).ok_or_else(|| "Unexpected GitHub response".to_string())
}

/// Lists the most recent stable releases of a repository, newest first.
///
/// Some projects publish several release streams from one repo (a desktop
/// tag, a mobile tag, a server tag - Obsidian, Tuta, Ente). The single
/// /releases/latest answer is then often the WRONG stream for the platform
/// the user wants, and every download resolves to nothing. This command
/// hands back enough recent releases for the frontend to scan them in order
/// and find the stream that actually carries the platform's installer.
#[tauri::command]
async fn fetch_recent_releases(repo: String, count: Option<u32>) -> Result<Vec<GhRelease>, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.is_empty() {
        return Err("No GitHub repository configured".into());
    }
    let per_page = count.unwrap_or(20).clamp(1, 30);
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page={}",
        repo, per_page
    );
    let client = api_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err("GitHub rate limit reached; try again in a few minutes".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Bad response: {}", e))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad response: {}", e))?;
    let list = body
        .as_array()
        .ok_or_else(|| "Unexpected GitHub response".to_string())?;
    // GitHub returns prereleases here too; the frontend picks assets only
    // from entries the caller marks stable, so filter them out at the source.
    Ok(list
        .iter()
        .filter(|r| r.get("prerelease").and_then(|v| v.as_bool()) != Some(true))
        .filter_map(|r| parse_gh_release(r, &repo))
        .collect())
}

/// Shared parser for one GitHub release JSON object.
fn parse_gh_release(body: &serde_json::Value, repo: &str) -> Option<GhRelease> {
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.is_empty() {
        return None;
    }
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tag.clone());
    let published_at = body
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = match body.get("html_url").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => format!("https://github.com/{}/releases", repo),
    };
    let mut assets = Vec::new();
    if let Some(list) = body.get("assets").and_then(|v| v.as_array()) {
        for a in list {
            let aname = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let dl = a
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            if aname.is_empty() || dl.is_empty() {
                continue;
            }
            assets.push(GhAsset {
                name: aname.to_string(),
                size,
                download_url: dl.to_string(),
            });
        }
    }
    Some(GhRelease {
        tag,
        name,
        published_at,
        html_url,
        assets,
    })
}

/// Resolves the suggested stable package version from the F-Droid index.
#[tauri::command]
async fn fetch_fdroid_package(pkg: String) -> Result<FdroidPackage, String> {
    let pkg = pkg.trim().to_string();
    if pkg.is_empty() {
        return Err("No F-Droid package configured".into());
    }
    let url = format!("https://f-droid.org/api/v1/packages/{}", pkg);
    let client = api_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Package not found on F-Droid".into());
    }
    if !resp.status().is_success() {
        return Err(format!("F-Droid returned HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Bad response: {}", e))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad response: {}", e))?;

    let mut max_code: i64 = 0;
    if let Some(list) = body.get("packages").and_then(|v| v.as_array()) {
        for p in list {
            if let Some(vc) = p.get("versionCode").and_then(|v| v.as_i64()) {
                if vc > max_code {
                    max_code = vc;
                }
            }
        }
    }
    let version_code = body
        .get("suggestedVersionCode")
        .and_then(|v| v.as_i64())
        .filter(|vc| *vc > 0 && (max_code == 0 || *vc <= max_code))
        .unwrap_or(max_code);
    if version_code <= 0 {
        return Err("No package versions found on F-Droid".into());
    }
    let version = body
        .get("packages")
        .and_then(|v| v.as_array())
        .and_then(|list| {
            list.iter()
                .find(|p| p.get("versionCode").and_then(|v| v.as_i64()) == Some(version_code))
        })
        .and_then(|p| p.get("versionName").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    Ok(FdroidPackage {
        apk_url: format!("https://f-droid.org/repo/{}_{}.apk", pkg, version_code),
        page_url: format!("https://f-droid.org/packages/{}", pkg),
        package: pkg,
        version,
        version_code,
    })
}

/// Host CPU architecture ("x86_64" or "aarch64"), used to pick the right asset.
#[tauri::command]
fn host_arch() -> String {
    std::env::consts::ARCH.to_string()
}

struct CancelEntry(mpsc::Sender<()>);

#[derive(Default)]
struct DownloadRegistry {
    next_id: AtomicU32,
    cancels: Mutex<HashMap<u32, CancelEntry>>,
}

fn sanitize_filename(name: &str) -> String {
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
        "download.bin".to_string()
    } else {
        trimmed
    }
}

fn filename_from_headers(
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

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for i in 1..10_000u32 {
        candidate = dir.join(numbered_name(name, i));
        if !candidate.exists() {
            break;
        }
    }
    candidate
}

/// "setup.exe", 3 -> "setup (3).exe"; extension-less names keep no dot.
fn numbered_name(name: &str, i: u32) -> String {
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

/// Staging file for an in-flight download. The final name only appears when
/// the download finished (and verified, when a trusted hash was supplied),
/// so a dropped connection can never leave a half-written "installer.exe"
/// behind that a retry would then call "installer (1).exe".
fn part_path_for(dest: &Path) -> PathBuf {
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
fn dest_for_part(part: &Path) -> Option<PathBuf> {
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
fn meta_path_for(part: &Path) -> PathBuf {
    PathBuf::from(format!("{}.meta", part.to_string_lossy()))
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct PartMeta {
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

async fn read_part_meta(part: &Path) -> Option<PartMeta> {
    let raw = tokio::fs::read_to_string(meta_path_for(part)).await.ok()?;
    serde_json::from_str(&raw).ok()
}

/// Persist the validators from `headers` for the staging file `part`.
/// Failures are deliberately silent: a missing sidecar only means the next
/// resume cannot send If-Range and behaves like before.
async fn write_part_meta(part: &Path, url: &str, headers: &reqwest::header::HeaderMap) {
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
/// Any violation refuses the resume instead of appending to the staging
/// file; the download fails with a clear reason and the .part survives so
/// a corrected server (or a fresh start) can still recover.
fn validate_resume_content_range(header: &str, expected_start: u64) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
    url: String,
    filename: Option<String>,
    directory: Option<String>,
    // Trusted SHA-256 to verify against (hex). When given, a mismatching
    // download is deleted and reported as an integrity failure instead of
    // being handed to the user as a finished file.
    expected_sha256: Option<String>,
    // Continue an interrupted download from its .part file. The caller
    // passes the same filename it saw before; without a matching .part the
    // download simply starts over.
    resume: Option<bool>,
) -> Result<u32, String> {
    let dir: PathBuf = match directory {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => platform_download_dir(&app),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create download folder: {}", e))?;

    let id = registry.next_id.fetch_add(1, Ordering::SeqCst);

    // Direct untrusted names to safe names
    let requested_name = filename.map(|n| sanitize_filename(&n));

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    registry
        .cancels
        .lock()
        .await
        .insert(id, CancelEntry(cancel_tx));

    let app_handle = app.clone();
    let registry_map = Arc::clone(registry.inner());

    tokio::spawn(async move {
        // Transient network failures (stall, dropped connection) are retried
        // automatically: the .part file is already on disk, so a resume costs
        // nothing and most Wi-Fi/VPN blips heal within seconds. What the user
        // used to see was an error toast + a manual Resume click; now the
        // same recovery happens on its own. Deliberate cancels, checksum
        // failures and HTTP-status errors are never retried.
        const MAX_AUTO_RETRIES: u32 = 2;
        let mut plan = DownloadPlan {
            url: url.clone(),
            requested_name,
            dir,
            resume: resume.unwrap_or(false),
            expected_sha256,
            staging: None,
        };
        let mut attempt: u32 = 0;
        // The staging file the last attempt opened, if any. An automatic
        // retry continues THAT exact file instead of re-deriving a candidate
        // name (which can drift onto a concurrent download's .part).
        let mut resolved_staging: Option<PathBuf> = None;
        let result = loop {
            let r = run_download(
                app_handle.clone(),
                id,
                plan.clone(),
                &mut cancel_rx,
                &mut resolved_staging,
            )
            .await;
            match r {
                Err((msg, kind))
                    if kind.as_deref() == Some("network") && attempt < MAX_AUTO_RETRIES =>
                {
                    attempt += 1;
                    plan.resume = true; // pick up from the .part file
                    plan.staging = resolved_staging.clone(); // ...the exact one we opened
                    tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
                    let _ = app_handle.emit(
                        "download-retrying",
                        RetryPayload {
                            id,
                            attempt,
                            message: msg.clone(),
                        },
                    );
                }
                other => break other,
            }
        };

        // Remove from the cancel registry
        registry_map.cancels.lock().await.remove(&id);

        match result {
            Ok(payload) => {
                let _ = app_handle.emit("download-complete", payload);
            }
            Err((msg, kind)) => {
                let cancelled = msg == "__cancelled__";
                let _ = app_handle.emit(
                    "download-error",
                    ErrorPayload {
                        id,
                        message: if cancelled { "Cancelled".into() } else { msg },
                        kind: if cancelled { None } else { kind },
                    },
                );
            }
        }
    });

    Ok(id)
}

/// Everything one download attempt needs, bundled so the runner keeps a
/// readable signature and new knobs don't grow the parameter list forever.
#[derive(Clone)]
struct DownloadPlan {
    url: String,
    requested_name: Option<String>,
    dir: PathBuf,
    resume: bool,
    expected_sha256: Option<String>,
    /// Exact staging (.part) path opened by the PREVIOUS attempt of this
    /// download chain. Set by the retry loop in start_download so an
    /// automatic retry reopens its own file instead of re-deriving a
    /// candidate name; None on a fresh start_download call.
    staging: Option<PathBuf>,
}

#[derive(Serialize, Clone)]
struct RetryPayload {
    id: u32,
    /// 1-based count of automatic retries so far.
    attempt: u32,
    message: String,
}

async fn run_download(
    app: AppHandle,
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
    // NOTE: no whole-request timeout here. reqwest's Client::timeout covers
    // the entire body stream, so the old 30s limit killed every download
    // that took longer than half a minute (a slow 100MB installer). The
    // stream loop below instead fails when no bytes arrive for 60s.
    let client = reqwest::Client::builder()
        .user_agent(format!(
            "Fress/{} (+https://github.com/WasewaseX/Fress)",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| (e.to_string(), None))?;

    // Resolve the resume target BEFORE the first request, in priority order:
    //   1. the exact staging file the previous attempt of this download
    //      chain opened (an automatic in-task retry),
    //   2. the canonical <name>.part for the requested name (a deliberate
    //      stop + manual Resume: the first attempt of a download always
    //      reserves candidate 0's .part through create_new, so the mapping
    //      name -> name.part is the ownership record itself).
    // unique_path() must NOT be used here: it skips taken FINAL names, so
    // when e.g. setup.exe already exists on disk a resumed download would
    // drift onto "setup (1).exe.part" - possibly a concurrent download's
    // staging file - instead of its own .part.
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
    let first = request
        .send()
        .await
        .map_err(|e| (format!("Connection failed: {}", e), None))?;

    if !first.status().is_success() {
        return Err((format!("Server returned HTTP {}", first.status()), None));
    }

    let headers = first.headers().clone();
    let final_url = first.url().clone();
    let remote_len = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    // 206 = the server honored the Range and we append; a plain 200 means it
    // ignored the range (or the If-Range validator no longer matches - the
    // remote file changed) and we start over.
    let resuming = first.status() == reqwest::StatusCode::PARTIAL_CONTENT && planned_resume_len > 0;
    let already_have = if resuming { planned_resume_len } else { 0 };

    // A single-range 206 MUST carry a verifiable `Content-Range` (RFC 9110
    // section 15.3.7). The old check only rejected an explicit WRONG offset:
    // a missing or malformed header was silently trusted, so a broken or
    // hostile server could append bytes from an unknown position onto the
    // staging file. Validation is now strict - header present, unit bytes,
    // start equal to the staging length, end and total sane - and any
    // violation fails the download instead of appending.
    if resuming {
        let verdict = match headers
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
        {
            Some(h) => validate_resume_content_range(h, planned_resume_len),
            None => Err(
                "Server answered a partial body without Content-Range; the byte offset cannot be verified"
                    .to_string(),
            ),
        };
        if let Err(reason) = verdict {
            return Err((
                format!("{}; the partial download cannot be continued", reason),
                None,
            ));
        }
    }

    let name = requested_name
        .or_else(|| filename_from_headers(&final_url, &headers))
        .unwrap_or_else(|| format!("fress-download-{}.bin", id));

    // Staging-file ownership. Two downloads racing on the same filename must
    // never share one .part: both used to observe "setup.exe is free", both
    // picked setup.exe.part, and both streamed bytes into the same staging
    // file (batch downloads made this reachable). `create_new` is an atomic
    // reservation - the winner keeps the name, the loser moves on to
    // "name (1).part". The final filename is only claimed by the rename at
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
    // continues this exact file (see the staging carry in start_download).
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
            return Err(("__cancelled__".to_string(), None));
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
            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    id,
                    downloaded,
                    total,
                    speed_bps: speed,
                    eta_secs: eta,
                },
            );
            last_emit = Instant::now();
        }
    }

    file.flush().await.map_err(|e| (e.to_string(), None))?;
    drop(file);

    let digest = hasher.finalize();
    let sha_hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();

    // Verification is a comparison against a trusted published value, not a
    // mere calculation. A mismatching file is rejected and removed: it must
    // never sit in the downloads folder looking finished.
    let verified: Option<bool> = match expected_sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(expected) => {
            let expected_norm = expected.trim_start_matches("0x").to_lowercase();
            if expected_norm != sha_hex {
                let _ = tokio::fs::remove_file(&part).await;
                let _ = tokio::fs::remove_file(meta_path_for(&part)).await;
                return Err((
                    format!(
                        "Integrity check failed: the file hashes to {} but the publisher published {}. It was deleted. Re-download from the official source.",
                        sha_hex, expected_norm
                    ),
                    Some("checksum".to_string()),
                ));
            }
            Some(true)
        }
        None => None,
    };

    // Only now does the file appear under its real name. Re-check for a late
    // collision: another file with this exact name may have appeared while
    // the bytes were streaming, and rename silently replaces on Unix.
    let dest = if dest.exists() {
        unique_path(&dir, &name)
    } else {
        dest
    };
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| (format!("Cannot finalize the download: {}", e), None))?;
    // The staging file is gone; its validator sidecar has no reason to
    // outlive it.
    let _ = tokio::fs::remove_file(meta_path_for(&part)).await;

    Ok(CompletePayload {
        id,
        path: dest.to_string_lossy().to_string(),
        bytes: downloaded,
        sha256: sha_hex,
        verified,
    })
}

#[tauri::command]
async fn cancel_download(
    id: u32,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    if let Some(entry) = registry.cancels.lock().await.remove(&id) {
        let _ = entry.0.send(()).await;
    }
    Ok(())
}

#[tauri::command]
fn default_download_dir(app: AppHandle) -> String {
    // Default is each platform's own download location, like any other app.
    platform_download_dir(&app).to_string_lossy().to_string()
}

// Per-OS default download location. Desktop platforms get the user's real
// Downloads folder (Windows FOLDERID_Downloads including OneDrive
// redirection, macOS ~/Downloads, Linux XDG download dir). Android does not
// let apps write a shared Downloads folder without storage permissions, so
// the app's private directory is used instead; the UI explains this.
fn platform_download_dir(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            let downloads = dir.join("Download");
            if std::fs::create_dir_all(&downloads).is_ok() {
                return downloads;
            }
            return dir;
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app; // only needed for the Android path
    }
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(DownloadRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            start_download,
            cancel_download,
            default_download_dir,
            app_version,
            fetch_latest_release,
            fetch_recent_releases,
            fetch_fdroid_package,
            host_arch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::validate_resume_content_range;

    #[test]
    fn accepts_a_well_formed_range_at_the_right_offset() {
        assert!(validate_resume_content_range("bytes 1024-2047/8192", 1024).is_ok());
    }

    #[test]
    fn accepts_a_case_insensitive_unit() {
        assert!(validate_resume_content_range("BYTES 1024-2047/8192", 1024).is_ok());
    }

    #[test]
    fn accepts_an_unknown_total() {
        // RFC 9110: the complete-length may be "*" when unknown.
        assert!(validate_resume_content_range("bytes 0-0/*", 0).is_ok());
    }

    #[test]
    fn accepts_a_single_byte_range() {
        assert!(validate_resume_content_range("bytes 4095-4095/8192", 4095).is_ok());
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
}
