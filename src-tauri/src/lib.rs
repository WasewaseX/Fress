use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
// Desktop-only: the folder picker API does not exist on mobile.
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
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
    /// True when the file was compared against the publisher's own checksum.
    verified: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct ErrorPayload {
    id: u32,
    message: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    download_url: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct GhRelease {
    tag: String,
    name: String,
    published_at: String,
    html_url: String,
    assets: Vec<GhAsset>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FdroidPackage {
    package: String,
    version: String,
    version_code: i64,
    apk_url: String,
    page_url: String,
}

/// Ceiling for a single download. Real release assets never come close; the
/// cap exists so a hostile or misconfigured host cannot silently fill the disk.
const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Sustained-rate gate for the JSON APIs: calls are paced a few hundred
/// milliseconds apart no matter how feverishly the renderer invokes, so
/// casual browsing cannot burn the user's IP-wide GitHub quota (60
/// requests/hour unauthenticated). The disk cache below is what really keeps
/// repeat browsing off the network; this only smooths cold bursts.
async fn api_throttle() {
    static LAST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let last = LAST.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = last.lock().await;
    if let Some(t) = *guard {
        let min_interval = Duration::from_millis(350);
        let elapsed = t.elapsed();
        if elapsed < min_interval {
            tokio::time::sleep(min_interval - elapsed).await;
        }
    }
    *guard = Some(Instant::now());
}

// ---- disk cache for release lookups -------------------------------------
// GitHub's unauthenticated API allows 60 requests per hour per IP. Without a
// durable cache, every app restart re-fetches every release and heavy browsing
// ends in 403s — exactly where the app is weakest. Entries are kept fresh for
// a TTL, and on network failure the last known good data is served instead of
// dead-ending the download section.

const RELEASE_TTL_SECS: u64 = 6 * 3600;
const FDROID_TTL_SECS: u64 = 24 * 3600;

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("release-cache"))
}

async fn cache_read_fresh(app: &AppHandle, key: &str, ttl_secs: u64) -> Option<serde_json::Value> {
    let raw = tokio::fs::read_to_string(cache_dir(app)?.join(format!("{}.json", key)))
        .await
        .ok()?;
    let entry: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let saved_at = entry.get("saved_at").and_then(|v| v.as_u64()).unwrap_or(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if now.saturating_sub(saved_at) < ttl_secs {
        entry.get("payload").cloned()
    } else {
        None
    }
}

async fn cache_read_stale(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    let raw = tokio::fs::read_to_string(cache_dir(app)?.join(format!("{}.json", key)))
        .await
        .ok()?;
    let entry: serde_json::Value = serde_json::from_str(&raw).ok()?;
    entry.get("payload").cloned()
}

async fn cache_write(app: &AppHandle, key: &str, payload: &serde_json::Value) {
    let Some(dir) = cache_dir(app) else { return };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = serde_json::json!({ "saved_at": now, "payload": payload });
    if tokio::fs::create_dir_all(&dir).await.is_ok() {
        let _ = tokio::fs::write(dir.join(format!("{}.json", key)), entry.to_string()).await;
        // Bound the cache: the catalog is ~57 apps, so anything beyond a few
        // hundred entries is stale drift (removed apps, old experiments).
        if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
            let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();
            while let Ok(Some(e)) = rd.next_entry().await {
                if let Ok(meta) = e.metadata().await {
                    files.push((e.path(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
                }
            }
            if files.len() > 256 {
                files.sort_by_key(|(_, m)| *m);
                for (path, _) in files.into_iter().take(files.len() - 256) {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
        }
    }
}

fn fetch_client(redirect_policy: reqwest::redirect::Policy) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!(
            "Fress/{} (+https://github.com/WasewaseX/Fress)",
            env!("CARGO_PKG_VERSION")
        ))
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(15))
        .redirect(redirect_policy)
        .build()
        .map_err(|e| e.to_string())
}

/// Resolves the LATEST STABLE release of a GitHub repository.
/// The /releases/latest endpoint already excludes drafts and prereleases,
/// so beta/RC versions are never offered here. Results are cached on disk
/// (fresh for 6h, stale-served on network failure).
#[tauri::command]
async fn fetch_latest_release(app: AppHandle, repo: String) -> Result<GhRelease, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    // Renderer-supplied input is formatted into a URL: pin it to the shape of
    // an owner/repo pair so no path tricks can reach other API endpoints.
    if !is_repo_slug(&repo) {
        return Err("Invalid GitHub repository".into());
    }
    // Percent-encoding keeps the key bijective: "a-b/c" and "a/b-c" would
    // otherwise collapse to the same cache file and cross-poison releases.
    let key = format!("gh-{}", urlencoding::encode(&repo));
    if let Some(cached) = cache_read_fresh(&app, &key, RELEASE_TTL_SECS).await {
        if let Ok(rel) = serde_json::from_value::<GhRelease>(cached) {
            return Ok(rel);
        }
    }
    match fetch_latest_release_inner(&repo).await {
        Ok(rel) => {
            if let Ok(value) = serde_json::to_value(&rel) {
                cache_write(&app, &key, &value).await;
            }
            Ok(rel)
        }
        Err(e) => {
            // Offline or rate-limited: serve the last known good release
            // rather than dead-ending the download section.
            if let Some(stale) = cache_read_stale(&app, &key).await {
                if let Ok(rel) = serde_json::from_value::<GhRelease>(stale) {
                    return Ok(rel);
                }
            }
            Err(e)
        }
    }
}

async fn fetch_latest_release_inner(repo: &str) -> Result<GhRelease, String> {
    api_throttle().await;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let client = fetch_client(reqwest::redirect::Policy::limited(5))?;
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
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN {
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
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.is_empty() {
        return Err("Unexpected GitHub response".into());
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
    Ok(GhRelease {
        tag,
        name,
        published_at,
        html_url,
        assets,
    })
}

/// Resolves the suggested stable package version from the F-Droid index.
/// Cached on disk like the GitHub lookups (24h TTL, stale-served on failure).
#[tauri::command]
async fn fetch_fdroid_package(app: AppHandle, pkg: String) -> Result<FdroidPackage, String> {
    let pkg = pkg.trim().to_string();
    if !is_fdroid_pkg_id(&pkg) {
        return Err("Invalid F-Droid package id".into());
    }
    let key = format!("fdroid-{}", urlencoding::encode(&pkg));
    if let Some(cached) = cache_read_fresh(&app, &key, FDROID_TTL_SECS).await {
        if let Ok(pkg) = serde_json::from_value::<FdroidPackage>(cached) {
            return Ok(pkg);
        }
    }
    match fetch_fdroid_package_inner(&pkg).await {
        Ok(pkg) => {
            if let Ok(value) = serde_json::to_value(&pkg) {
                cache_write(&app, &key, &value).await;
            }
            Ok(pkg)
        }
        Err(e) => {
            if let Some(stale) = cache_read_stale(&app, &key).await {
                if let Ok(pkg) = serde_json::from_value::<FdroidPackage>(stale) {
                    return Ok(pkg);
                }
            }
            Err(e)
        }
    }
}

async fn fetch_fdroid_package_inner(pkg: &str) -> Result<FdroidPackage, String> {
    api_throttle().await;
    let url = format!("https://f-droid.org/api/v1/packages/{}", pkg);
    let client = fetch_client(reqwest::redirect::Policy::limited(5))?;
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

/// GitHub repository metadata for the "Add a tool" inspector. Routed through
/// Rust so the renderer never talks to the API directly: the slug is pinned
/// to owner/repo shape and the response is trimmed to the fields the UI uses.
#[tauri::command]
async fn fetch_github_repo_details(repo: String) -> Result<serde_json::Value, String> {
    let repo = repo.trim().trim_matches('/').trim_end_matches(".git").to_string();
    if !is_repo_slug(&repo) {
        return Err("Invalid GitHub repository".into());
    }
    api_throttle().await;
    let url = format!("https://api.github.com/repos/{}", repo);
    let client = fetch_client(reqwest::redirect::Policy::limited(5))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Repository not found (is it public?)".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN {
        return Err("GitHub rate limit reached; try again in a few minutes".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status));
    }
    let body: serde_json::Value = serde_json::from_str(
        &resp.text().await.map_err(|e| format!("Bad response: {}", e))?,
    )
    .map_err(|e| format!("Bad response: {}", e))?;
    Ok(serde_json::json!({
        "name": body.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "description": body.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "stars": body.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0),
        "homepage": body.get("homepage").and_then(|v| v.as_str()).unwrap_or(""),
        "license": body.pointer("/license/spdx_id").and_then(|v| v.as_str()).unwrap_or(""),
        "topics": body.get("topics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
        "htmlUrl": body.get("html_url").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// Live GitHub repository search for the Live Search modal. The query is
/// length-capped and passed as a single URL-encoded parameter; results are
/// trimmed server-side (Rust-side) to the fields the UI maps.
#[tauri::command]
async fn search_github_repos(query: String) -> Result<serde_json::Value, String> {
    let q = query.trim();
    if q.is_empty() || q.len() > 120 {
        return Err("Invalid search query".into());
    }
    api_throttle().await;
    let url = format!(
        "https://api.github.com/search/repositories?q={}+is:public&sort=stars&order=desc&per_page=12",
        urlencoding::encode(q)
    );
    let client = fetch_client(reqwest::redirect::Policy::limited(5))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN {
        return Err("GitHub rate limit reached; try again in a few minutes".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status));
    }
    let body: serde_json::Value = serde_json::from_str(
        &resp.text().await.map_err(|e| format!("Bad response: {}", e))?,
    )
    .map_err(|e| format!("Bad response: {}", e))?;
    let items: Vec<serde_json::Value> = (body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default())
        .into_iter()
        .map(|repo| {
            serde_json::json!({
                "id": repo.get("id").cloned().unwrap_or(serde_json::json!(0)),
                "name": repo.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "description": repo.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "stars": repo.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0),
                "homepage": repo.get("homepage").and_then(|v| v.as_str()).unwrap_or(""),
                "license": repo.pointer("/license/spdx_id").and_then(|v| v.as_str()).unwrap_or(""),
                "topics": repo.get("topics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                "htmlUrl": repo.get("html_url").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();
    Ok(serde_json::json!({ "items": items }))
}

/// Mobile: no native folder picker — downloads always use the system folder.
#[tauri::command]
#[cfg(not(desktop))]
async fn pick_download_dir() -> Result<Option<String>, String> {
    Err("Folder picking is only available on desktop".into())
}

/// Fetches a small checksum file from an official release host so a download
/// can be verified against the hash the publisher itself shipped (a sibling
/// *.sha256 file or a SHA256SUMS manifest). Capped at 256 KiB — checksum
/// files are tiny; anything bigger is not one.
#[tauri::command]
async fn fetch_checksum_text(url: String) -> Result<String, String> {
    let url = is_allowed_download_url(&url)?;
    api_throttle().await;
    let client = fetch_client(download_redirect_policy())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Checksum fetch returned HTTP {}", resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Bad response: {}", e))?;
        if buf.len() + bytes.len() > 262_144 {
            return Err("Checksum file is unexpectedly large".into());
        }
        buf.extend_from_slice(&bytes);
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Revokes every approved download folder (Settings "Reset to default").
#[tauri::command]
async fn revoke_approved_dirs(
    app: AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    // One lock across clear AND file removal so a concurrent pick cannot
    // re-persist a folder the user just revoked.
    let _guard = registry.approval_file_lock.lock().await;
    registry.approved_dirs.lock().await.clear();
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = tokio::fs::remove_file(dir.join("approved-download-dirs.json")).await;
    }
    Ok(())
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
    /// Folders approved through the native dialog (Rust-side picker only).
    approved_dirs: Mutex<HashSet<String>>,
    /// Exact file paths the engine itself wrote — the only paths the
    /// open/reveal commands will touch. Oldest entries evicted first.
    completed_paths: Mutex<VecDeque<String>>,
    /// Simple bound on concurrent engine downloads (renderer DoS guard).
    active_downloads: AtomicU32,
    /// Native folder picker is open (anti dialog-spam guard). std::sync
    /// mutex: never held across an await, so Drop can always clear it.
    picker_in_flight: std::sync::Mutex<bool>,
    /// Last time the picker closed — re-opens are refused for a moment so a
    /// scripted renderer cannot harass the user with dialog loops. std::sync
    /// mutex: only touched in trivial critical sections (and from Drop, which
    /// cannot await), never held across an await point.
    picker_last_close: std::sync::Mutex<Option<Instant>>,
    /// Serializes pick/revoke against the approved-dirs JSON: held across the
    /// whole snapshot/write (or clear/remove) section. tokio guard is Send.
    approval_file_lock: Mutex<()>,
}

fn is_repo_slug(repo: &str) -> bool {
    if repo.len() > 128 {
        return false;
    }
    let mut parts = repo.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(o), Some(r), None) => {
            let ok = |seg: &str| {
                !seg.is_empty()
                    && seg != "."
                    && seg != ".."
                    && seg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            };
            ok(o) && ok(r)
        }
        _ => false,
    }
}

fn is_fdroid_pkg_id(pkg: &str) -> bool {
    if pkg.len() > 128 {
        return false;
    }
    !pkg.is_empty()
        && pkg.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        && pkg.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn sanitize_filename(name: &str) -> String {
    // Never produce a name in our temp-file namespace: a hostile or unlucky
    // Content-Disposition ending in ".fress-part" would be swept on the next
    // launch. Rename the suffix away before anything else.
    let name = {
        let mut n = name;
        while let Some(stripped) = n.strip_suffix(".fress-part") {
            n = stripped;
        }
        n
    };
    // Unicode letters/digits survive (Persian/Arabic/CJK users get real
    // names); everything else — separators, control chars, symbols — maps
    // to '_'. The charset also guarantees no path separators survive.
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric()
                || c.is_alphanumeric()
                || c == '.'
                || c == '-'
                || c == '_'
                || c == '('
                || c == ')'
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut trimmed = cleaned.trim_matches(|c| c == '_' || c == '.' || c == ' ').to_string();
    // Trimming trailing dots/spaces can resurrect the temp-file suffix we
    // stripped ("x.fress-part." → "x.fress-part"); strip to a fixpoint so no
    // finished download can ever be swept on the next launch.
    while let Some(stripped) = trimmed.strip_suffix(".fress-part") {
        trimmed = stripped
            .trim_matches(|c| c == '_' || c == '.' || c == ' ')
            .to_string();
    }

    // Cap the FINAL assembled byte length (180) on char boundaries: take
    // whole chars only, keep the extension (last dot) when reasonable.
    let clamp = |s: &str, max: usize| -> String {
        if s.len() <= max {
            return s.to_string();
        }
        let mut out = String::new();
        for ch in s.chars() {
            if out.len() + ch.len_utf8() > max {
                break;
            }
            out.push(ch);
        }
        out
    };

    let mut result = if trimmed.len() > 180 {
        let dot = trimmed.rfind('.');
        match dot {
            Some(p) if trimmed.len() - p <= 20 && p > 0 => {
                let ext = clamp(&trimmed[p..], 20);
                let stem = clamp(&trimmed[..p], 180 - ext.len());
                format!("{stem}{ext}")
            }
            _ => clamp(&trimmed, 180),
        }
    } else {
        trimmed
    };

    // Windows reserves a handful of device names regardless of extension.
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem_upper = result
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if reserved.iter().any(|r| *r == stem_upper) {
        result = format!("file-{result}");
    }
    // Dot-only or stem-less results (".exe") would resolve to directories or
    // lose the name entirely — fall back to something always valid. A plain
    // extensionless name ("README") is perfectly fine and stays as-is.
    let stemless = result
        .rsplit_once('.')
        .map(|(stem, _)| stem.is_empty())
        .unwrap_or(false);
    if result.is_empty() || result.chars().all(|c| c == '.') || stemless {
        result = format!("download-{}.bin", std::process::id());
    }
    result
}

fn decode_percent(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = bytes.get(i + 1..i + 3);
            if let Some(hex) = hex {
                if let Ok(v) = u8::from_str_radix(std::str::from_utf8(hex).unwrap_or(""), 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn filename_from_headers(url: &reqwest::Url, headers: &reqwest::header::HeaderMap) -> Option<String> {
    if let Some(cd) = headers.get(reqwest::header::CONTENT_DISPOSITION) {
        let cd = cd.to_str().ok()?;
        // attachment; filename="app.apk" or filename*=UTF-8''app%2Eapk
        if let Some(pos) = cd.find("filename*=") {
            let rest = &cd[pos + 10..];
            if let Some(raw) = rest.split("''").nth(1) {
                let end = raw.find(';').unwrap_or(raw.len());
                let raw = raw[..end].trim_matches('"').trim();
                if !raw.is_empty() {
                    return Some(decode_percent(raw));
                }
            }
        }
        if let Some(pos) = cd.find("filename=") {
            let rest = &cd[pos + 9..];
            let end = rest.find(';').unwrap_or(rest.len());
            let decoded = decode_percent(rest[..end].trim_matches('"').trim());
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    // Fall back to the last URL path segment (percent-decoded)
    let segment = url.path_segments()?.next_back()?.to_string();
    let segment = decode_percent(&segment);
    if segment.is_empty() || !segment.contains('.') {
        None
    } else {
        Some(segment)
    }
}

/// Windows canonicalize() returns \\?\ verbatim paths; those work for I/O but
/// look hostile in the UI ("\\?\C:\Users\..."). The verbatim wrapper is
/// stripped AFTER the security comparisons are done on canonical form.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", rest))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        p
    }
}

fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = PathBuf::from(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let ext = PathBuf::from(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..10_000u32 {
        // ext already carries its dot; appending another produced files like
        // "README (1)." for extensionless names.
        candidate = dir.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            break;
        }
    }
    candidate
}

// Downloads are only ever meant to come from the official release hosts that
// the catalog itself links to. The webview is not trusted to point the engine
// at arbitrary URLs (a compromised renderer must not turn Fress into a
// generic downloader), and the scheme must be https.
const ALLOWED_HOSTS: [&str; 7] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
    "f-droid.org",
    "download.mozilla.org",
    // The real final hop of download.mozilla.org links:
    "download-installer.cdn.mozilla.net",
];

fn is_allowed_host(host: &str) -> bool {
    ALLOWED_HOSTS.contains(&host.to_ascii_lowercase().as_str())
}

fn is_allowed_download_url(raw: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https downloads are supported".into());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if is_allowed_host(&host) {
        Ok(parsed)
    } else {
        Err(format!(
            "Downloads are restricted to official release hosts (got \"{}\")",
            host
        ))
    }
}

/// Every redirect hop is validated too — a 302 from an allowed host to an
/// arbitrary host must not turn the engine into an open downloader.
fn download_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 8 {
            return attempt.error("too many redirects");
        }
        match attempt.url().host_str() {
            Some(h) if attempt.url().scheme() == "https" && is_allowed_host(h) => attempt.follow(),
            _ => attempt.error("redirect target is not an official release host"),
        }
    })
}

/// True when a requested filename already carries a real file extension.
/// Hint names without one (e.g. a UI label like "F-Droid .apk (direct)" —
/// which actually ends in "(direct)") must not override the server's
/// Content-Disposition name, or the saved file loses its extension.
fn has_known_ext(name: &str) -> bool {
    const KNOWN: [&str; 18] = [
        "exe", "msi", "dmg", "pkg", "apk", "appimage", "deb", "rpm", "zip", "tar", "gz",
        "xz", "zst", "bz2", "tgz", "txz", "tzst", "tbz2",
    ];
    match name.rfind('.') {
        // A dot at position 0 (or none) means the name carries no real
        // extension — a hint like "zip" must not override the server name.
        Some(p) if p > 0 => KNOWN.contains(&name[p + 1..].to_ascii_lowercase().as_str()),
        _ => false,
    }
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
    url: String,
    filename: Option<String>,
    directory: Option<String>,
    expected_sha256: Option<String>,
) -> Result<u32, String> {
    // Validate BEFORE spawning anything the user could observe.
    let url = is_allowed_download_url(&url)?;
    let url = url.to_string();

    // A publisher checksum turns "trust TLS" into "trust the hash the
    // publisher published": the finished file is compared byte-for-byte and
    // discarded on any mismatch.
    let expected_sha256 = match expected_sha256
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
    {
        Some(s) if !s.is_empty() => {
            if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(s)
            } else {
                return Err("Invalid checksum".into());
            }
        }
        _ => None,
    };

    // When the real Downloads dir cannot be located (broken XDG setup), the
    // home dir is only a WRITE fallback — it must NOT silently become a
    // containment root, or everything under ~ would be writable.
    let (default_base, downloads_dir_resolved) = match dirs::download_dir() {
        Some(d) => (d, true),
        None => (dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), false),
    };

    // The renderer may not aim the engine at arbitrary directories. A folder
    // is accepted when it is the system Downloads folder (or something inside
    // it) or when it was approved by the user through OUR native picker.
    let (dir, approved_by_picker): (PathBuf, bool) = match directory {
        Some(d) if !d.trim().is_empty() => {
            let requested = PathBuf::from(d.trim());
            // `Path::starts_with` is a lexical component-prefix check and does
            // NOT resolve "..", so `Downloads\\..\\Startup` would pass it.
            // Reject any relative navigation components outright, then compare.
            let has_navigation = requested
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
            let under_downloads = downloads_dir_resolved
                && !has_navigation
                && requested.starts_with(&default_base);
            let approved = !has_navigation
                && registry
                    .approved_dirs
                    .lock()
                    .await
                    .contains(&d.trim().to_string());
            if !under_downloads && !approved {
                return Err(
                    "Download folder was not approved. Pick it again in Settings.".into(),
                );
            }
            (requested, approved)
        }
        _ => (default_base.clone(), false),
    };
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Cannot create download folder: {}", e))?;

    // Symlinks are resolved once, here: a folder that only LOOKED like it is
    // inside Downloads (a junction/symlink planted inside it) is rejected when
    // the RESOLVED path leaves the real Downloads tree. Picker-approved
    // folders may live anywhere — the user chose them in our dialog.
    let dir_canonical = tokio::fs::canonicalize(&dir)
        .await
        .map_err(|e| format!("Cannot resolve download folder: {}", e))?;
    if !approved_by_picker && downloads_dir_resolved {
        let base_canonical = tokio::fs::canonicalize(&default_base)
            .await
            .map_err(|e| format!("Cannot resolve download folder: {}", e))?;
        if !dir_canonical.starts_with(&base_canonical) {
            return Err("Download folder is not inside the Downloads folder".into());
        }
    }
    let dir = strip_verbatim(dir_canonical.clone());

    // Renderer-DoS guard: a handful of parallel engine downloads is plenty.
    // compare_exchange so N simultaneous invokes cannot all slip past the cap.
    loop {
        let current = registry.active_downloads.load(Ordering::SeqCst);
        if current >= 3 {
            return Err("Too many downloads running at once — wait for one to finish.".into());
        }
        match registry.active_downloads.compare_exchange(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => break,
            Err(_) => continue,
        }
    }
    let id = registry.next_id.fetch_add(1, Ordering::SeqCst);

    // Direct untrusted names to safe names
    let requested_name = filename.map(|n| sanitize_filename(&n));

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    registry.cancels.lock().await.insert(id, CancelEntry(cancel_tx));

    let app_handle = app.clone();
    let registry_map = Arc::clone(registry.inner());
    let dir_canonical_for_task = dir_canonical.clone();

    // The concurrency slot is released by a Drop guard, so even a panic in
    // the download future cannot permanently brick the engine.
    struct SlotGuard {
        registry: Arc<DownloadRegistry>,
    }
    impl Drop for SlotGuard {
        fn drop(&mut self) {
            self.registry.active_downloads.fetch_sub(1, Ordering::SeqCst);
        }
    }

    tokio::spawn(async move {
        let _slot = SlotGuard { registry: Arc::clone(&registry_map) };
        let result = run_download(
            app_handle.clone(),
            id,
            url.clone(),
            requested_name,
            dir,
            dir_canonical_for_task,
            expected_sha256.clone(),
            &mut cancel_rx,
        )
        .await;

        // Remove from the cancel registry (the slot is freed by SlotGuard)
        registry_map.cancels.lock().await.remove(&id);

        match result {
            Ok(payload) => {
                // Remember exactly where the engine wrote, so the open/reveal
                // commands can allowlist by path.
                {
                    let mut paths = registry_map.completed_paths.lock().await;
                    // Bounded memory, oldest entries evicted first: a scripted
                    // renderer cannot grow this forever, and earlier downloads
                    // stay openable for as long as possible.
                    if paths.len() >= 512 {
                        paths.pop_front();
                    }
                    if !paths.contains(&payload.path) {
                        paths.push_back(payload.path.clone());
                    }
                }
                let _ = app_handle.emit("download-complete", payload);
            }
            Err(msg) => {
                let cancelled = msg == "__cancelled__";
                let _ = app_handle.emit(
                    "download-error",
                    ErrorPayload {
                        id,
                        message: if cancelled { "Cancelled".into() } else { msg },
                    },
                );
            }
        }
    });

    Ok(id)
}

async fn run_download(
    app: AppHandle,
    id: u32,
    url: String,
    requested_name: Option<String>,
    dir: PathBuf,
    dir_canonical: PathBuf,
    expected_sha256: Option<String>,
    cancel_rx: &mut mpsc::Receiver<()>,
) -> Result<CompletePayload, String> {
    // NOTE: no overall request timeout here — a large APK over a slow line can
    // legitimately take minutes. `read_timeout` only aborts when the stream is
    // IDLE for too long, which is what we actually want.
    let client = reqwest::Client::builder()
        .user_agent(format!("Fress/{} (+https://github.com/WasewaseX/Fress)", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .redirect(download_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;

    let first = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !first.status().is_success() {
        return Err(format!("Server returned HTTP {}", first.status()));
    }

    // Belt and braces: the redirect policy already validates each hop, but the
    // final URL is re-checked here so the invariant holds even if the client
    // is ever reconfigured.
    if !is_allowed_download_url(first.url().as_str()).is_ok() {
        return Err("Final download host is not an official release host".into());
    }

    let headers = first.headers().clone();
    let final_url = first.url().clone();
    let total = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err("File is larger than the 4 GiB download limit".into());
    }

    // EVERY name that reaches the disk — requested, header-derived, or
    // URL-derived — goes through the same sanitizer, so a hostile
    // Content-Disposition header can never escape the download directory.
    // A requested hint only wins when it carries a real file extension;
    // otherwise the server's own name (which installers always have) is used.
    let header_name = filename_from_headers(&final_url, &headers);
    let requested_usable = requested_name
        .as_ref()
        .map(|n| has_known_ext(n))
        .unwrap_or(false);
    let name = sanitize_filename(&match (&requested_name, &header_name) {
        (Some(req), _) if requested_usable => req.clone(),
        (_, Some(hdr)) => hdr.clone(),
        (Some(req), None) => req.clone(),
        (None, None) => format!("fress-download-{}.bin", id),
    });
    let dest = unique_path(&dir, &name);

    // Stream into a .part file first: the final name only appears once the
    // download is really complete, and failed runs never leave a corrupt file
    // masquerading as a finished download. The id suffix keeps concurrent
    // downloads of the same filename from writing into one shared .part file.
    let part_path = dir.join(format!("{}.{}.fress-part", name, id));

    let result = stream_to_file(app, id, first, &part_path, total, cancel_rx).await;

    match result {
        Ok((bytes, sha_hex)) => {
            // The folder must still be the folder that was verified at the
            // start: a symlink/junction swapped in mid-flight would otherwise
            // redirect the final write.
            match tokio::fs::canonicalize(&dir).await {
                Ok(now) if now == dir_canonical => {}
                _ => {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    return Err("Download folder changed during the download".into());
                }
            }
            // Publisher checksum: a mismatch discards the file — the user
            // never keeps bytes the publisher would not sign off on.
            if let Some(expected) = &expected_sha256 {
                if &sha_hex != expected {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    return Err(
                        "Checksum mismatch — the file did not match the publisher's checksum and was discarded."
                            .into(),
                    );
                }
            }
            // Another download (or the user) may have created the target in
            // the meantime; never silently overwrite — pick a fresh name.
            // Finalize WITHOUT any chance of clobbering: hard_link fails with
            // AlreadyExists if the target appeared in the meantime (rename(2)
            // would silently replace it on Unix). Retry with a fresh unique
            // name, then drop the part file.
            let mut final_dest = if dest.exists() { unique_path(&dir, &name) } else { dest.clone() };
            let mut linked = tokio::fs::hard_link(&part_path, &final_dest).await;
            let mut attempts = 0;
            while linked.is_err() && attempts < 100 {
                final_dest = unique_path(&dir, &name);
                linked = tokio::fs::hard_link(&part_path, &final_dest).await;
                attempts += 1;
            }
            let linked = match linked {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    Ok(())
                }
                Err(hard_link_err) => {
                    // Filesystems without hard links (exFAT/FAT USB sticks and
                    // SD cards are common picker targets) must not lose a fully
                    // downloaded, checksum-verified file. Copy instead — the
                    // no-clobber guarantee comes from unique_path above.
                    match tokio::fs::copy(&part_path, &final_dest).await {
                        Ok(_) => {
                            let _ = tokio::fs::remove_file(&part_path).await;
                            Ok(())
                        }
                        Err(_) => {
                            let _ = tokio::fs::remove_file(&part_path).await;
                            Err(format!("Could not finalize the file: {}", hard_link_err))
                        }
                    }
                }
            };
            if let Err(msg) = linked {
                return Err(msg);
            }
            Ok(CompletePayload {
                id,
                path: final_dest.to_string_lossy().to_string(),
                bytes,
                sha256: sha_hex,
                verified: expected_sha256.is_some(),
            })
        }
        Err(msg) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Err(msg)
        }
    }
}

async fn stream_to_file(
    app: AppHandle,
    id: u32,
    response: reqwest::Response,
    part_path: &std::path::Path,
    total: u64,
    cancel_rx: &mut mpsc::Receiver<()>,
) -> Result<(u64, String), String> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        // create_new refuses to follow a pre-planted symlink or clobber an
        // existing part file — the write can only ever land on an entry the
        // engine itself just created.
        .create_new(true)
        .open(part_path)
        .await
        .map_err(|e| format!("Cannot write file: {}", e))?;

    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    while let Some(chunk) = tokio::select! {
        biased;
        _ = cancel_rx.recv() => {
            drop(file);
            return Err("__cancelled__".to_string());
        }
        chunk = stream.next() => chunk,
    } {
        let bytes = chunk.map_err(|e| format!("Download interrupted: {}", e))?;
        hasher.update(&bytes);
        if file.write_all(&bytes).await.is_err() {
            return Err("Disk write failed".to_string());
        }
        downloaded += bytes.len() as u64;
        // Mid-stream ceiling: Content-Length can lie (chunked responses have
        // none), so the cap is enforced against the bytes actually received.
        if downloaded > MAX_DOWNLOAD_BYTES {
            drop(file);
            return Err("File exceeds the 4 GiB download limit".to_string());
        }

        // Emit progress at most ~10x per second
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
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

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let digest = hasher.finalize();
    let sha_hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    Ok((downloaded, sha_hex))
}

#[tauri::command]
async fn cancel_download(id: u32, registry: State<'_, Arc<DownloadRegistry>>) -> Result<(), String> {
    if let Some(entry) = registry.cancels.lock().await.remove(&id) {
        let _ = entry.0.send(()).await;
    }
    Ok(())
}

/// Native folder picker. Rust owns the dialog so the chosen path can be
/// registered as an approved download root — the webview never gets to
/// declare one on its own.
async fn persist_approved_dirs(app: &AppHandle, registry: &DownloadRegistry) {
    // One lock across snapshot AND write so a concurrent revoke can interleave
    // between them and resurrect a revoked folder in the JSON.
    let _guard = registry.approval_file_lock.lock().await;
    let list: Vec<String> = {
        let dirs = registry.approved_dirs.lock().await;
        dirs.iter().cloned().collect()
    };
    let payload = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    if let Ok(dir) = app.path().app_data_dir() {
        if tokio::fs::create_dir_all(&dir).await.is_ok() {
            let path = dir.join("approved-download-dirs.json");
            // Create-or-truncate directly with the restrictive mode: the file
            // is never even briefly world-readable between write and chmod.
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                match tokio::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&path)
                    .await
                {
                    Ok(mut f) => {
                        use tokio::io::AsyncWriteExt;
                        let _ = f.write_all(payload.as_bytes()).await;
                    }
                    Err(_) => {
                        let _ = tokio::fs::write(&path, payload).await;
                    }
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::fs::write(&path, payload).await;
            }
        }
    }
}

fn load_approved_dirs(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    std::fs::read_to_string(dir.join("approved-download-dirs.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
#[cfg(desktop)]
async fn pick_download_dir(
    app: AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<Option<String>, String> {
    // One picker at a time, plus a short cooldown after close: a scripted
    // renderer can neither run two dialogs nor loop them for harassment.
    let guard = PickerGuard::acquire(&registry).await?;
    let result = do_pick_download_dir(app.clone(), registry.inner()).await;
    // The close time is stamped by PickerGuard::drop, so even an invoke that
    // is dropped mid-dialog starts a fresh cooldown.
    drop(guard);
    result
}

struct PickerGuard {
    registry: Arc<DownloadRegistry>,
    acquired: bool,
}

impl PickerGuard {
    async fn acquire(registry: &State<'_, Arc<DownloadRegistry>>) -> Result<Self, String> {
        let arc = Arc::clone(registry.inner());
        // Cooldown first, THEN the flag — both std mutexes, neither held
        // across an await, so the future stays Send.
        let last = *arc.picker_last_close.lock().expect("picker clock poisoned");
        if let Some(last) = last {
            if last.elapsed() < Duration::from_secs(2) {
                return Err("Please wait a moment before reopening the folder picker".into());
            }
        }
        {
            let mut picking = arc
                .picker_in_flight
                .lock()
                .expect("picker flag poisoned");
            if *picking {
                return Err("Folder picker is already open".into());
            }
            *picking = true;
        }
        Ok(Self { registry: arc, acquired: true })
    }
}

impl Drop for PickerGuard {
    fn drop(&mut self) {
        if self.acquired {
            if let Ok(mut flag) = self.registry.picker_in_flight.lock() {
                *flag = false;
            }
            // The cooldown starts when the picker CLOSES — however it closed
            // (cancel, error, dropped future), a queued invoke must never be
            // able to loop the dialog deterministically.
            if let Ok(mut last) = self.registry.picker_last_close.lock() {
                *last = Some(Instant::now());
            }
        }
    }
}

#[cfg(desktop)]
async fn do_pick_download_dir(
    app: AppHandle,
    registry: &DownloadRegistry,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog()
        .file()
        .set_title("Choose download folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    let Some(p) = picked else { return Ok(None) };
    // into_path() returns the contained PathBuf for FilePath::Path and runs
    // Url::to_file_path() for FilePath::Url — unresolvable URIs (Android
    // content://) fail closed instead of inventing a path.
    let dir_str = match p.into_path() {
        Ok(pb) => pb.to_string_lossy().to_string(),
        Err(_) => return Ok(None),
    };
    if dir_str.trim().is_empty() {
        return Ok(None);
    }
    registry
        .approved_dirs
        .lock()
        .await
        .insert(dir_str.clone());
    persist_approved_dirs(&app, registry).await;
    Ok(Some(dir_str))
}

async fn require_engine_path(path: &str, registry: &DownloadRegistry) -> Result<(), String> {
    if registry.completed_paths.lock().await.iter().any(|p| p == path) {
        Ok(())
    } else {
        Err("Only files downloaded by Fress can be opened this way".into())
    }
}

/// "Open file" for a completed download — restricted to paths the engine
/// itself wrote, so a compromised renderer cannot launch arbitrary binaries.
#[tauri::command]
#[cfg(desktop)]
async fn open_downloaded_file(
    path: String,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    require_engine_path(&path, &registry).await?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// "Show in folder" — same restriction as open_downloaded_file.
#[tauri::command]
#[cfg(desktop)]
async fn reveal_downloaded_file(
    path: String,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    require_engine_path(&path, &registry).await?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Open the current download folder in the file manager. Only approved or
/// default folders can be opened.
#[tauri::command]
#[cfg(desktop)]
async fn open_download_folder(
    dir: Option<String>,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    let (default_base, downloads_dir_resolved) = match dirs::download_dir() {
        Some(d) => (d, true),
        None => (dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), false),
    };
    let target = match dir {
        Some(d) if !d.trim().is_empty() => {
            let requested = PathBuf::from(d.trim());
            // Same predicate as start_download: `..` must fail on BOTH
            // branches — `starts_with` is lexical and would happily accept
            // "Downloads/../.." .
            let has_navigation = requested
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
            let under_downloads = downloads_dir_resolved
                && !has_navigation
                && requested.starts_with(&default_base);
            let approved = !has_navigation
                && registry.approved_dirs.lock().await.contains(&d.trim().to_string());
            if !under_downloads && !approved {
                return Err("Folder is not an approved download location".into());
            }
            if !requested.is_dir() {
                return Err("That path is not a folder".into());
            }
            // Same symlink discipline as start_download: only the RESOLVED
            // path decides. A junction planted inside Downloads must not aim
            // the file manager at an arbitrary target.
            let requested_canonical = match std::fs::canonicalize(&requested) {
                Ok(c) => strip_verbatim(c),
                Err(_) => requested.clone(),
            };
            if under_downloads && !approved && downloads_dir_resolved {
                if let Ok(base_canonical) = std::fs::canonicalize(&default_base) {
                    let base_canonical = strip_verbatim(base_canonical);
                    if !requested_canonical.starts_with(&base_canonical) {
                        return Err("Folder is not inside the Downloads folder".into());
                    }
                }
            }
            requested_canonical
        }
        _ => default_base,
    };
    tauri_plugin_opener::open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Mobile stubs: opener path APIs are desktop-only; the panel hides these
/// actions behind graceful errors there.
#[tauri::command]
#[cfg(not(desktop))]
async fn open_downloaded_file() -> Result<(), String> {
    Err("Opening files is only available on desktop".into())
}

#[tauri::command]
#[cfg(not(desktop))]
async fn reveal_downloaded_file() -> Result<(), String> {
    Err("Showing files is only available on desktop".into())
}

#[tauri::command]
#[cfg(not(desktop))]
async fn open_download_folder() -> Result<(), String> {
    Err("Opening folders is only available on desktop".into())
}

#[tauri::command]
fn default_download_dir() -> String {
    // Default is the user's normal Downloads folder, like any other app.
    let base = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.to_string_lossy().to_string()
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
        .setup(|app| {
            // Approved download roots survive restarts, so a folder picked in
            // Settings keeps working after relaunch.
            let registry = Arc::new(DownloadRegistry::default());
            {
                let mut approved = registry.approved_dirs.blocking_lock();
                for d in load_approved_dirs(app.handle()) {
                    approved.insert(d);
                }
            }
            // Best-effort cleanup of OUR interrupted temp files (distinctive
            // *.fress-part suffix — never touches other apps' .part files).
            let mut sweep_roots: Vec<PathBuf> = Vec::new();
            if let Some(base) = dirs::download_dir() {
                sweep_roots.push(base);
            }
            for d in registry.approved_dirs.blocking_lock().iter() {
                sweep_roots.push(PathBuf::from(d));
            }
            for root in sweep_roots {
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.ends_with(".fress-part") {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
            app.manage(registry);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_download,
            cancel_download,
            default_download_dir,
            app_version,
            fetch_latest_release,
            fetch_fdroid_package,
            fetch_checksum_text,
            host_arch,
            #[cfg(desktop)]
            pick_download_dir,
            #[cfg(desktop)]
            open_downloaded_file,
            #[cfg(desktop)]
            reveal_downloaded_file,
            #[cfg(desktop)]
            open_download_folder,
            fetch_github_repo_details,
            search_github_repos,
            revoke_approved_dirs,
            #[cfg(not(desktop))]
            pick_download_dir,
            #[cfg(not(desktop))]
            open_downloaded_file,
            #[cfg(not(desktop))]
            reveal_downloaded_file,
            #[cfg(not(desktop))]
            open_download_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
