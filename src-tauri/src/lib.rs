// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::FutureExt;
// `Manager` powers the Android-only app-data path lookup below.
#[cfg_attr(not(target_os = "android"), allow(unused_imports))]
use tauri::{AppHandle, Emitter, Manager, State};

// The download engine owns everything between "user clicked download" and
// "a complete, verified file exists on disk": the lifecycle state machine,
// staging (.part) files and their validator sidecars, resume correctness,
// integrity verification and the no-clobber final commit. Its module docs
// double as the state-transition and cleanup specification. This file keeps
// only the Tauri command surface and the event mapping. The module
// registration here is the coordination point between the download-engine
// work and the URL/HTTP-client work (Agent 1's sections below are untouched).
mod download_finalize;
use download_finalize::{
    execute_with_retries, sanitize_filename, DownloadPlan, DownloadRegistry, DownloadSession,
    ErrorPayload, ProgressSink, CANCEL_SENTINEL,
};

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
async fn fetch_recent_releases(
    repo: String,
    count: Option<u32>,
    include_flagged: Option<bool>,
) -> Result<Vec<GhRelease>, String> {
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
    // from entries the caller marks stable, so filter them out at the
    // source. An app entry may vouch for a repo that flags its own stable
    // builds as prereleases (DevToys has never shipped an unflagged
    // release) - include_flagged bypasses the filter for that repo only.
    let include_flagged = include_flagged.unwrap_or(false);
    Ok(list
        .iter()
        .filter(|r| include_flagged || r.get("prerelease").and_then(|v| v.as_bool()) != Some(true))
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

/// Allowlisted hosts the official download resolvers may read.
///
/// Every app in the catalog whose downloads do NOT live on GitHub resolves
/// through a small manifest or directory index on the project's own
/// infrastructure (KDE's mirror router, Tor's update manifests, Signal's
/// electron-updater feeds, Proton's version.json, ...). This list names
/// exactly those hosts, so the generic text fetch can never be turned into
/// an open proxy: anything not listed is refused before a request is made.
const FETCH_TEXT_ALLOWED_HOSTS: &[&str] = &[
    "get.videolan.org",
    "www.videolan.org",
    "download.blender.org",
    "download.kde.org",
    "download.documentfoundation.org",
    "www.gimp.org",
    "download.gimp.org",
    "inkscape.org",
    "media.inkscape.org",
    "www.zotero.org",
    "download.zotero.org",
    "updates.signal.org",
    "aus1.torproject.org",
    "dist.torproject.org",
    "proton.me",
    "packages.element.io",
    "download.nextcloud.com",
    "gitlab.com",
    "www.sumatrapdfreader.org",
    "api.github.com",
    "raw.githubusercontent.com",
];

/// Reads a small text document (manifest, directory index, YAML feed) from a
/// vendor host. Returns the final URL after redirects so callers that only
/// need the redirect TARGET (Zotero's dl endpoint) can skip parsing entirely.
///
/// Safety rails: https only, host allowlisted, response body capped at 2 MB.
/// A body larger than the cap is NOT read - the caller gets the final URL and
/// the content length instead, which is exactly what a redirect-to-file
/// endpoint requires without ever pulling a 200 MB installer into memory.
#[derive(Serialize, Clone)]
struct TextFetch {
    status: u16,
    final_url: String,
    content_length: Option<u64>,
    body: String,
    truncated: bool,
}

const FETCH_TEXT_BODY_CAP: u64 = 2 * 1024 * 1024;

#[tauri::command]
async fn fetch_text(url: String) -> Result<TextFetch, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "Not a valid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https URLs are allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .to_ascii_lowercase();
    if !FETCH_TEXT_ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("Host {} is not on the resolver allowlist", host));
    }
    let client = api_client()?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
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
        let mut resp = resp;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() as u64 > FETCH_TEXT_BODY_CAP {
                        buf.truncate(FETCH_TEXT_BODY_CAP as usize);
                        truncated = true;
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => return Err(format!("Bad response: {}", e)),
            }
        }
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

/// The architecture of the MACHINE, not of this process, on Windows.
///
/// `std::env::consts::ARCH` is decided at compile time: an x64 Fress build
/// running under emulation on a Windows-on-ARM device reports "x86_64", and
/// every downstream picker (self-updater, catalog resolver) then treats the
/// whole machine as x64 - ARM64 users kept getting x64 installers even for
/// apps that ship native ARM builds. GetNativeSystemInfo reports the native
/// machine even when the process is emulated, which is exactly what the
/// pickers need. Kernel32 is linked by the C runtime anyway, so this adds
/// no dependency.
#[cfg(target_os = "windows")]
fn windows_machine_arch() -> Option<&'static str> {
    #[repr(C)]
    struct SystemInfo {
        w_processor_architecture: u16,
        w_reserved: u16,
        dw_page_size: u32,
        lp_minimum_application_address: *mut core::ffi::c_void,
        lp_maximum_application_address: *mut core::ffi::c_void,
        dw_active_processor_mask: usize,
        dw_number_of_processors: u32,
        dw_processor_type: u32,
        dw_allocation_granularity: u32,
        w_processor_level: u16,
        w_processor_revision: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetNativeSystemInfo(lp_system_info: *mut SystemInfo);
    }
    const PROCESSOR_ARCHITECTURE_INTEL: u16 = 0;
    const PROCESSOR_ARCHITECTURE_AMD64: u16 = 9;
    const PROCESSOR_ARCHITECTURE_ARM64: u16 = 12;
    let mut si: SystemInfo = unsafe { core::mem::zeroed() };
    // Always succeeds; the architecture field is filled from the native
    // machine, never from the emulated process view.
    unsafe { GetNativeSystemInfo(&mut si) };
    match si.w_processor_architecture {
        PROCESSOR_ARCHITECTURE_ARM64 => Some("aarch64"),
        PROCESSOR_ARCHITECTURE_AMD64 => Some("x86_64"),
        PROCESSOR_ARCHITECTURE_INTEL => Some("x86"),
        _ => None,
    }
}

/// Host CPU architecture ("x86_64" or "aarch64"), used to pick the right asset.
#[tauri::command]
fn host_arch() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(arch) = windows_machine_arch() {
            return arch.to_string();
        }
    }
    std::env::consts::ARCH.to_string()
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

    // Direct untrusted names to safe names
    let requested_name = filename.map(|n| sanitize_filename(&n));

    // Registering hands out the download id, latches the cancellation
    // channel and puts the download into the Queued state; from here on the
    // engine's state machine owns the lifecycle and every terminal outcome
    // is guaranteed to release the entry again.
    let (id, cancel_rx) = registry.register().await;
    let session = DownloadSession::new(Arc::clone(registry.inner()), id);

    let app_handle = app.clone();
    tokio::spawn(async move {
        // Maps engine callbacks onto the frontend events. Keeping this as a
        // trait impl is what lets the engine run (and be tested) without an
        // AppHandle.
        struct AppSink {
            app: AppHandle,
        }
        impl ProgressSink for AppSink {
            fn progress(&self, payload: download_finalize::ProgressPayload) {
                let _ = self.app.emit("download-progress", payload);
            }
            fn retrying(&self, payload: download_finalize::RetryPayload) {
                let _ = self.app.emit("download-retrying", payload);
            }
        }
        let sink = AppSink {
            app: app_handle.clone(),
        };

        // catch_unwind so a panicking engine still releases the registry
        // entry and reports a failure instead of leaving a forever-active
        // download behind. The plan is built inside so every owned value
        // moves as one unit.
        let result = catch_unwind_result(
            &sink,
            &session,
            id,
            DownloadPlan {
                url,
                requested_name,
                dir,
                resume: resume.unwrap_or(false),
                expected_sha256,
                staging: None,
            },
            cancel_rx,
        )
        .await;

        // The download is terminal in every outcome; drop it from the
        // active set before the event tells the UI so.
        session.release().await;

        match result {
            Ok(payload) => {
                let _ = app_handle.emit("download-complete", payload);
            }
            Err((msg, kind)) => {
                let cancelled = msg == CANCEL_SENTINEL;
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

/// Runs the engine's retry loop, converting an unexpected panic into a
/// failed download. (A plain async wrapper so the spawned task above stays
/// readable; panics are aborted in release builds anyway.)
async fn catch_unwind_result(
    sink: &impl ProgressSink,
    session: &DownloadSession,
    id: u32,
    plan: DownloadPlan,
    cancel_rx: tokio::sync::mpsc::Receiver<()>,
) -> Result<download_finalize::CompletePayload, (String, Option<String>)> {
    match FutureExt::catch_unwind(std::panic::AssertUnwindSafe(execute_with_retries(
        sink,
        session,
        id,
        plan,
        cancel_rx,
        std::time::Duration::from_secs(2),
    )))
    .await
    {
        Ok(result) => result,
        Err(_panic) => Err(("Download failed unexpectedly".to_string(), None)),
    }
}

#[tauri::command]
async fn cancel_download(
    id: u32,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    // Only signals the engine; the engine observes the signal, keeps the
    // staging file and drives its own state to Cancelled. A cancel arriving
    // after the transfer completed is a harmless no-op.
    registry.request_cancel(id).await;
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
            fetch_text,
            host_arch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
