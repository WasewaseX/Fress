use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
// `Manager` powers the Android-only app-data path lookup below.
#[cfg_attr(not(target_os = "android"), allow(unused_imports))]
use tauri::{AppHandle, Emitter, Manager, State};
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
}

#[derive(Serialize, Deserialize, Clone)]
struct ErrorPayload {
    id: u32,
    message: String,
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
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '(' || c == ')' {
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

fn filename_from_headers(url: &reqwest::Url, headers: &reqwest::header::HeaderMap) -> Option<String> {
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

fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
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

#[tauri::command]
async fn start_download(
    app: AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
    url: String,
    filename: Option<String>,
    directory: Option<String>,
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
    registry.cancels.lock().await.insert(id, CancelEntry(cancel_tx));

    let app_handle = app.clone();
    let registry_map = Arc::clone(registry.inner());

    tokio::spawn(async move {
        let result = run_download(
            app_handle.clone(),
            id,
            url.clone(),
            requested_name,
            dir,
            &mut cancel_rx,
        )
        .await;

        // Remove from the cancel registry
        registry_map.cancels.lock().await.remove(&id);

        match result {
            Ok(payload) => {
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
    cancel_rx: &mut mpsc::Receiver<()>,
) -> Result<CompletePayload, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Fress/{} (+https://github.com/WasewaseX/Fress)", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(8))
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

    let headers = first.headers().clone();
    let final_url = first.url().clone();
    let total = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let name = requested_name
        .or_else(|| filename_from_headers(&final_url, &headers))
        .unwrap_or_else(|| format!("fress-download-{}.bin", id));
    let dest = unique_path(&dir, &name);

    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("Cannot write file: {}", e))?;

    let mut stream = first.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    while let Some(chunk) = tokio::select! {
        biased;
        _ = cancel_rx.recv() => {
            drop(file);
            let _ = tokio::fs::remove_file(&dest).await;
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

    Ok(CompletePayload {
        id,
        path: dest.to_string_lossy().to_string(),
        bytes: downloaded,
        sha256: sha_hex,
    })
}

#[tauri::command]
async fn cancel_download(id: u32, registry: State<'_, Arc<DownloadRegistry>>) -> Result<(), String> {
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
        .or_else(|| dirs::home_dir())
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
            fetch_fdroid_package,
            host_arch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
