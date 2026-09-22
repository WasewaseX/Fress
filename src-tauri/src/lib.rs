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
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '(' || c == ')'
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_').trim().to_string();
    if trimmed.is_empty() {
        "download.bin".to_string()
    } else {
        trimmed
    }
}

fn filename_from_headers(
    url: &reqwest::Url,
    headers: &reqwest::header::HeaderMap,
) -> Option<String> {
    if let Some(cd) = headers.get(reqwest::header::CONTENT_DISPOSITION) {
        let cd = cd.to_str().ok()?;
        // attachment; filename="app.apk" or filename*=UTF-8''app.apk
        if let Some(pos) = cd.find("filename*=") {
            let rest = &cd[pos + 10..];
            if let Some(name) = rest.split("''").nth(1) {
                let name = name.trim_matches('"').trim_end_matches(';');
                // RFC 5987 ext-values are percent-encoded; without decoding,
                // a Japanese PDF would land on disk as a literal "%E6%97%A5...".
                return Some(percent_decode(name));
            }
        }
        if let Some(pos) = cd.find("filename=") {
            let rest = &cd[pos + 9..];
            let end = rest.find(';').unwrap_or(rest.len());
            return Some(rest[..end].trim_matches('"').to_string());
        }
    }
    // Fall back to the last URL path segment
    let segment = url.path_segments()?.next_back()?.to_string();
    if segment.is_empty() || !segment.contains('.') {
        None
    } else {
        Some(segment)
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
    let stem = PathBuf::from(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    // The extension carries no leading dot here; the format string below adds
    // its own, so "MyApp (1).exe" keeps a single dot and extension-less files
    // become "MyApp (1)" without a stray trailing dot.
    let ext = PathBuf::from(name)
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for i in 1..10_000u32 {
        let candidate_name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        candidate = dir.join(candidate_name);
        if !candidate.exists() {
            break;
        }
    }
    candidate
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
        };
        let mut attempt: u32 = 0;
        let result = loop {
            let r = run_download(app_handle.clone(), id, plan.clone(), &mut cancel_rx).await;
            match r {
                Err((msg, kind))
                    if kind.as_deref() == Some("network") && attempt < MAX_AUTO_RETRIES =>
                {
                    attempt += 1;
                    plan.resume = true; // pick up from the .part file
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
) -> Result<CompletePayload, (String, Option<String>)> {
    let DownloadPlan {
        url,
        requested_name,
        dir,
        resume,
        expected_sha256,
    } = plan;
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

    // Plan the resume before the first request: only when the caller named
    // the file (a retry always does) and a matching .part already exists.
    let mut planned_resume_len: u64 = 0;
    if resume {
        if let Some(name) = requested_name.as_ref() {
            let candidate = unique_path(&dir, name);
            if let Ok(meta) = tokio::fs::metadata(part_path_for(&candidate)).await {
                planned_resume_len = meta.len();
            }
        }
    }

    let mut request = client.get(&url);
    if planned_resume_len > 0 {
        request = request.header(
            reqwest::header::RANGE,
            format!("bytes={}-", planned_resume_len),
        );
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
    // ignored the range (or there was nothing to resume) and we start over.
    let resuming = first.status() == reqwest::StatusCode::PARTIAL_CONTENT && planned_resume_len > 0;
    let already_have = if resuming { planned_resume_len } else { 0 };

    let name = requested_name
        .or_else(|| filename_from_headers(&final_url, &headers))
        .unwrap_or_else(|| format!("fress-download-{}.bin", id));
    let dest = unique_path(&dir, &name);
    let part = part_path_for(&dest);

    let mut file = if resuming {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(|e| (format!("Cannot reopen partial download: {}", e), None))?
    } else {
        tokio::fs::File::create(&part)
            .await
            .map_err(|e| (format!("Cannot write file: {}", e), None))?
    };

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

    // Only now does the file appear under its real name.
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| (format!("Cannot finalize the download: {}", e), None))?;

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
