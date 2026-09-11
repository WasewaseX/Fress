// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
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
                return Some(name.trim_matches('"').trim_end_matches(';').to_string());
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

fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
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
        candidate = dir.join(format!("{} ({}).{}", stem, i, ext));
        if !candidate.exists() {
            break;
        }
    }
    candidate
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    registry: State<'_, DownloadRegistry>,
    url: String,
    filename: Option<String>,
    directory: Option<String>,
) -> Result<u32, String> {
    let dir: PathBuf = match directory {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => {
            let base = dirs::download_dir()
                .or_else(|| dirs::home_dir())
                .unwrap_or_else(|| PathBuf::from("."));
            base.join("Fress")
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create download folder: {}", e))?;

    let id = registry.next_id.fetch_add(1, Ordering::SeqCst);

    // Direct untrusted names to safe names
    let requested_name = filename.map(|n| sanitize_filename(&n));

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    registry.cancels.lock().await.insert(id, CancelEntry(cancel_tx));

    let app_handle = app.clone();
    let registry_map = Arc::new(registry.inner().cancels.clone());

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
        registry_map.lock().await.remove(&id);

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
async fn cancel_download(id: u32, registry: State<'_, DownloadRegistry>) -> Result<(), String> {
    if let Some(entry) = registry.cancels.lock().await.remove(&id) {
        let _ = entry.0.send(()).await;
    }
    Ok(())
}

#[tauri::command]
fn default_download_dir() -> String {
    let base = dirs::download_dir()
        .or_else(|| dirs::home_dir())
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Fress").to_string_lossy().to_string()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DownloadRegistry::default())
        .invoke_handler(tauri::generate_handler![
            start_download,
            cancel_download,
            default_download_dir,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
