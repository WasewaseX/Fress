// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::FutureExt;
use serde::Serialize;
// `Manager` powers the Android-only app-data path lookup below.
#[cfg_attr(not(target_os = "android"), allow(unused_imports))]
use tauri::{AppHandle, Emitter, Manager, State};

// Self-update artifact authenticity: minisign verification of the release
// `.sig` sidecars against the public key embedded in this binary.
use minisign_verify::{PublicKey, Signature};

/// Authoritative URL admission, redirect rules and client construction for
/// every outbound request the native layer makes. The React side validates
/// for usability; THIS module is what the native commands actually trust.
pub mod network_policy;

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

/// Resolves the LATEST STABLE release of a GitHub repository.
/// The /releases/latest endpoint already excludes drafts and prereleases,
/// so beta/RC versions are never offered here.
#[tauri::command]
async fn fetch_latest_release(repo: String) -> Result<GhRelease, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.is_empty() {
        return Err("No GitHub repository configured".into());
    }
    let requested = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let policy = network_policy::UrlPolicy::api_github();
    // Admission happens before anything else: a slug that somehow formats
    // the request URL off the pinned API host is refused here, not sent.
    let url = policy.validate(&requested).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    let resp = client
        .get(url.raw().clone())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| network_policy::describe_network_error(&e))?;
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
    let requested = format!(
        "https://api.github.com/repos/{}/releases?per_page={}",
        repo, per_page
    );
    let policy = network_policy::UrlPolicy::api_github();
    let url = policy.validate(&requested).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    let resp = client
        .get(url.raw().clone())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| network_policy::describe_network_error(&e))?;
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

// Resolver hosts the official download resolvers may read are defined (and
// enforced per redirect hop) in `network_policy::RESOLVER_ALLOWED_HOSTS`.

/// Reads a small text document (manifest, directory index, YAML feed) from a
/// vendor host. Returns the final URL after redirects so callers that only
/// need the redirect TARGET (Zotero's dl endpoint) can skip parsing entirely.
///
/// Safety rails (enforced by `network_policy::UrlPolicy::resolver_manifest`):
/// https only, host allowlisted, every redirect hop re-checked against the
/// same rules, and the response body capped at 2 MB. A body larger than the
/// cap is NOT read - the caller gets the final URL and the content length
/// instead, which is exactly what a redirect-to-file endpoint requires
/// without ever pulling a 200 MB installer into memory.
#[derive(Serialize, Clone)]
struct TextFetch {
    status: u16,
    final_url: String,
    content_length: Option<u64>,
    body: String,
    truncated: bool,
}

const FETCH_TEXT_BODY_CAP: u64 = 2 * 1024 * 1024;

/// Streams a response body into a `TextFetch` under the shared 2 MiB cap:
/// an oversized content-length refuses the body outright, and a body that
/// grows past the cap mid-stream is truncated and reported. Shared by every
/// text-fetching command (`fetch_text`, `fetch_self_update_text`) so the
/// cap cannot drift between them.
async fn read_capped_text(mut resp: reqwest::Response) -> Result<TextFetch, String> {
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

#[tauri::command]
async fn fetch_text(url: String) -> Result<TextFetch, String> {
    let policy = network_policy::UrlPolicy::resolver_manifest();
    // Admission first: parse + allowlist + scheme/credential checks, so a
    // malformed or disallowed request is refused before any client exists.
    let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    let resp = client
        .get(parsed.raw().clone())
        .send()
        .await
        .map_err(|e| network_policy::describe_network_error(&e))?;
    read_capped_text(resp).await
}

/// Reads one small text document from Fress's own GitHub release feed:
/// `releases.atom` (the rate-limit-proof update-check fallback) and
/// `SHA256SUMS.txt` (the checksum reference the self-update verification
/// compares the downloaded installer against).
///
/// Why a native command: github.com and its release-asset CDN do not answer
/// CORS, so the WebView cannot read either document (see the now-resolved
/// "known limitation" in docs/security/tauri-security.md) - every shipped
/// release silently degraded to unverified self-updates. Routing the two
/// reads through the native layer fixes that without loosening anything.
///
/// Admission is deliberately NARROWER than the other text command:
///   - the `self_update_feed` policy pins the host to the two GitHub-owned
///     names (every redirect hop re-checked) and refuses private addresses;
///   - the path on `github.com` is pinned here to the Fress repository, so
///     the command cannot be turned into a general github.com reader even
///     from a compromised WebView;
///   - the 2 MiB body cap shared with `fetch_text` bounds the response.
#[tauri::command]
async fn fetch_self_update_text(url: String) -> Result<TextFetch, String> {
    const REPO_PATH_PREFIX: &str = "/WasewaseX/Fress/";
    let policy = network_policy::UrlPolicy::self_update_feed();
    let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
    // Repo pin: the only github.com documents the self-update flow ever
    // needs are this repository's atom feed and release assets. The asset
    // CDN hosts have opaque token paths, so the pin applies to the
    // github.com origin only.
    if parsed.raw().host_str() == Some("github.com")
        && !parsed.raw().path().starts_with(REPO_PATH_PREFIX)
        && parsed.raw().path() != "/WasewaseX/Fress"
    {
        return Err(format!(
            "Only WasewaseX/Fress release documents are allowed, not {}",
            parsed.raw().path()
        ));
    }
    let client = policy.http_client()?;
    let resp = client
        .get(parsed.raw().clone())
        .send()
        .await
        .map_err(|e| network_policy::describe_network_error(&e))?;
    read_capped_text(resp).await
}

// ---------------------------------------------------------------------------
// Self-update artifact authenticity (minisign verification)
// ---------------------------------------------------------------------------

/// The minisign public key every Fress updater artifact signature must
/// verify against, embedded at COMPILE TIME from the repository-root file
/// `fress-updater.key.pub` (the key CI signs release artifacts with, and
/// the one published verbatim in CODE_SIGNING.md). Embedding it in the
/// binary is the "public verification key embedded in the app" contract:
/// a config value on disk could be edited between releases, the binary's
/// copy cannot change without a rebuild.
///
/// File format (the `tauri signer` convention): the file is ONE base64
/// line that decodes to a minisign key document ("untrusted comment:" line
/// + the base64 key cryptobuf). Decode-then-parse is handled by
/// [`decode_updater_public_key`]; do NOT feed the outer base64 straight to
/// `PublicKey::from_base64` - that expects the inner cryptobuf line only.
const UPDATER_PUBLIC_KEY_FILE_B64: &str = include_str!("../../fress-updater.key.pub");

/// Outer-layer base64 decode for Tauri-format key/signature documents.
fn decode_document_b64(document_b64: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(document_b64.trim())
        .map_err(|e| format!("Malformed base64 document: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("Key/signature document is not UTF-8: {e}"))
}

/// Parses the Tauri-format public key document (outer base64 -> minisign
/// key document -> `PublicKey`).
fn decode_updater_public_key(key_file_b64: &str) -> Result<PublicKey, String> {
    let document = decode_document_b64(key_file_b64)?;
    PublicKey::decode(&document).map_err(|e| format!("Malformed updater public key document: {e}"))
}

/// Verifies a Tauri/minisign artifact signature (the base64 signature
/// document, i.e. the exact content of a release `.sig` sidecar) over the
/// exact bytes in `data`, using a key in the same Tauri document format.
/// Legacy (non-prehashed) minisign signatures are refused: Tauri's signer
/// emits prehashed signatures, and accepting both modes would widen the
/// verification surface for no reason.
fn verify_signature_document(
    key_file_b64: &str,
    signature_b64: &str,
    data: &[u8],
) -> Result<(), String> {
    let pk = decode_updater_public_key(key_file_b64)?;
    let document = decode_document_b64(signature_b64)?;
    let sig =
        Signature::decode(&document).map_err(|e| format!("Malformed updater signature document: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| format!("Updater signature verification failed: {e}"))
}

/// Streams `file_path` through the verifier in 64 KiB chunks so even the
/// ~90 MB AppImage is verified in bounded memory - the artifact verified
/// is byte-for-byte the artifact on disk, not a re-read or a copy.
fn verify_signature_over_file(
    key_file_b64: &str,
    signature_b64: &str,
    file_path: &str,
) -> Result<(), String> {
    use std::io::Read;
    let pk = decode_updater_public_key(key_file_b64)?;
    let document = decode_document_b64(signature_b64)?;
    let sig =
        Signature::decode(&document).map_err(|e| format!("Malformed updater signature document: {e}"))?;
    let mut file = std::fs::File::open(file_path)
        .map_err(|e| format!("Cannot open the downloaded file: {e}"))?;
    let mut verifier = pk
        .verify_stream(&sig)
        .map_err(|e| format!("Cannot start updater signature verification: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Cannot read the downloaded file: {e}"))?;
        if n == 0 {
            break;
        }
        verifier.update(&buf[..n]);
    }
    verifier
        .finalize()
        .map_err(|_| "Updater signature verification failed: the downloaded file does not match the release signature".to_string())
}

/// Verifies the minisign signature of a COMPLETED self-update download
/// against the public key embedded in this binary.
///
/// Inputs:
///   - `file_path`: the path of the downloaded artifact on disk (the path
///     the download engine reports on completion).
///   - `signature_base64`: the EXACT content of the matching `.sig` sidecar
///     from the SAME release (base64 of the minisign signature document,
///     which is also what `latest.json` carries in its signature field).
///     "Verify the exact artifact that will be delivered, do not sign one
///     file and verify another" is enforced here: the signature document
///     must come from the release the artifact was selected from, and the
///     bytes verified are the bytes on disk.
///
/// The command is deliberately VERIFY-ONLY: it returns ok/error and never
/// the file contents, so it cannot be abused as a file reader. It runs on
/// a blocking thread (multi-hundred-MB installers) and is available to the
/// update flow; wiring it into the delivery UI is tracked in
/// CODE_SIGNING.md ("current platform limitations").
#[tauri::command]
async fn verify_self_update_signature(
    file_path: String,
    signature_base64: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        verify_signature_over_file(UPDATER_PUBLIC_KEY_FILE_B64, &signature_base64, file_path.trim())
    })
    .await
    .map_err(|e| format!("Signature verification task failed: {e}"))?
}

/// Resolves the suggested stable package version from the F-Droid index.
#[tauri::command]
async fn fetch_fdroid_package(pkg: String) -> Result<FdroidPackage, String> {
    let pkg = pkg.trim().to_string();
    if pkg.is_empty() {
        return Err("No F-Droid package configured".into());
    }
    let url = format!("https://f-droid.org/api/v1/packages/{}", pkg);
    let policy = network_policy::UrlPolicy::api_fdroid();
    let url = policy.validate(&url).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    let resp = client
        .get(url.raw().clone())
        .send()
        .await
        .map_err(|e| network_policy::describe_network_error(&e))?;
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

// The command arguments ARE the wire contract with the React invoke call,
// so the trusted-hash knobs cannot be bundled into a struct without
// changing the payload shape on the other side. Eight explicit args is the
// honest shape of this boundary.
#[allow(clippy::too_many_arguments)]
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
    // Same contract for vendors that publish SHA-512 instead (Signal
    // desktop's electron-updater manifests, Proton's version.json).
    expected_sha512: Option<String>,
    // Continue an interrupted download from its .part file. The caller
    // passes the same filename it saw before; without a matching .part the
    // download simply starts over.
    resume: Option<bool>,
) -> Result<u32, String> {
    // THE native gate. The React layer validates for usability; this is the
    // authoritative enforcement: the URL is admitted under the
    // executable-download policy BEFORE any filesystem side effect (no
    // directory created, no staging file reserved, no task scheduled).
    // Malformed URLs, cleartext http, embedded credentials, private/
    // loopback address literals and localhost names are refused here.
    let policy = network_policy::UrlPolicy::executable_download();
    let validated_url = policy.validate(&url).map_err(|e| e.to_string())?;
    // The engine's HTTP client is the policy-built one: per-hop validated
    // redirects and public-address-only connections for every request the
    // engine makes, including the resume and retry attempts.
    let client = policy.http_client().map_err(|e| e.to_string())?;

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
                url: validated_url,
                client,
                requested_name,
                dir,
                resume: resume.unwrap_or(false),
                expected_sha256,
                expected_sha512,
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
            fetch_latest_release,
            fetch_recent_releases,
            fetch_fdroid_package,
            fetch_text,
            fetch_self_update_text,
            verify_self_update_signature,
            host_arch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
// Integration tests for the download/resolver rails. AppHandle-free by
// design (see the module's header comment); compiled only under `cargo test`.
#[cfg(test)]
mod download_integration;

#[cfg(test)]
mod self_update_text_tests {
    // Admission tests for `fetch_self_update_text`'s URL gate: the exact
    // documents the self-update flow may read, and the shapes it must
    // refuse. The redirect-hop rules live in network_policy's own tests;
    // this module pins the repo-path pin and the host allowlist as seen
    // from the command layer.

    use super::*;

    fn admit(url: &str) -> Result<reqwest::Url, String> {
        const REPO_PATH_PREFIX: &str = "/WasewaseX/Fress/";
        let policy = network_policy::UrlPolicy::self_update_feed();
        let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
        if parsed.raw().host_str() == Some("github.com")
            && !parsed.raw().path().starts_with(REPO_PATH_PREFIX)
            && parsed.raw().path() != "/WasewaseX/Fress"
        {
            return Err(format!(
                "Only WasewaseX/Fress release documents are allowed, not {}",
                parsed.raw().path()
            ));
        }
        Ok(parsed.raw().clone())
    }

    #[test]
    fn admits_the_atom_feed_and_checksum_documents() {
        for url in [
            "https://github.com/WasewaseX/Fress/releases.atom",
            "https://github.com/WasewaseX/Fress/releases/download/v1.0.6-beta/SHA256SUMS.txt",
            "https://github.com/WasewaseX/Fress/releases/download/v1.0.6-beta/latest.json",
        ] {
            assert!(admit(url).is_ok(), "must admit {url}");
        }
    }

    #[test]
    fn refuses_github_paths_outside_the_fress_repository() {
        for url in [
            "https://github.com/someone-else/Other/releases.atom",
            "https://github.com/WasewaseX/Other/releases/download/v1/SHA256SUMS.txt",
            "https://github.com/",
        ] {
            assert!(admit(url).is_err(), "must refuse {url}");
        }
    }

    #[test]
    fn refuses_non_github_and_non_https_documents() {
        for url in [
            "https://evil.example/WasewaseX/Fress/releases.atom",
            "http://github.com/WasewaseX/Fress/releases.atom",
            "https://api.github.com/repos/WasewaseX/Fress/releases",
            "https://raw.githubusercontent.com/WasewaseX/Fress/main/SHA256SUMS.txt",
        ] {
            assert!(admit(url).is_err(), "must refuse {url}");
        }
    }

    #[test]
    fn refuses_lookalike_hosts_and_embedded_credentials() {
        for url in [
            "https://github.com.evil.example/WasewaseX/Fress/releases.atom",
            "https://user:pw@github.com/WasewaseX/Fress/releases.atom",
            "https://release-assets.githubusercontent.com.evil.example/x",
        ] {
            assert!(admit(url).is_err(), "must refuse {url}");
        }
    }
}

#[cfg(test)]
mod self_update_signature_tests {
    // Tests for the artifact-authenticity contract: the embedded public key
    // must be THE published key, a genuine minisign signature must verify
    // over the exact artifact bytes, and any deviation (tampered artifact,
    // foreign key, malformed document) must fail closed. The signature
    // fixtures below were produced by `tauri signer sign` with a throwaway
    // keypair over the exact payload constant - the same Tauri document
    // format the release .sig sidecars use.

    use super::*;

    /// The fixture payload the fixture signature was generated over.
    const FIXTURE_PAYLOAD: &[u8] = b"Fress updater signature fixture payload v1\n";

    /// Throwaway keypair public key in the Tauri .pub document format
    /// (single-line base64 of "untrusted comment" + key cryptobuf).
    const FIXTURE_KEY_DOC_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU5OTY3QkUwM0Q0Q0EwMTMKUldRVG9Fdzk0SHVXV1pQc2dONGs5TSsvMy9VZmRpVm1kdDhZUkJkMTFYWTlaRkxZai9CMVNLQ0QK";

    /// `tauri signer sign` output over FIXTURE_PAYLOAD with the fixture key.
    const FIXTURE_SIG_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRVG9Fdzk0SHVXV1phVkViOUhjM2dJTjNsR0VsTzhURTZZWlZTUGcyaXdSNGdPcVUzK0hXbk9TTWkwbGFlTk9LREUrMlRMMEdvS3VNbmhxQjF3SVVGMUFZVWpyU1VqQlEwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNzQ3NjUzCWZpbGU6cGF5bG9hZC5iaW4KRis3Wkp1d1kyS1U4NTF3MFlSRTBaUFp6VHU3UnJHVlExNmRsajNMNkhDRlFNWmVicEVlRWhVNFNTcFQyNXJvY2JkaTFBU1p1VXpNMUJyb0dqMEVWQnc9PQo=";

    /// The key id published in CODE_SIGNING.md and on every release page.
    const PUBLISHED_KEY_ID: &str = "5638C68123FB633B";

    #[test]
    fn the_embedded_public_key_is_the_published_fress_key() {
        // The binary's trust anchor must be the key the docs publish - a
        // drifted key would silently verify against nobody.
        let document = decode_document_b64(UPDATER_PUBLIC_KEY_FILE_B64)
            .expect("the embedded key document must decode");
        assert!(
            document.contains(PUBLISHED_KEY_ID),
            "embedded key document must carry the published key id {PUBLISHED_KEY_ID}, got: {document}"
        );
        decode_updater_public_key(UPDATER_PUBLIC_KEY_FILE_B64)
            .expect("the embedded key must parse as a minisign public key");
    }

    #[test]
    fn a_genuine_signature_verifies_over_the_exact_artifact_bytes() {
        verify_signature_document(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, FIXTURE_PAYLOAD)
            .expect("a genuine Tauri-format signature must verify");
    }

    #[test]
    fn a_single_flipped_bit_in_the_artifact_fails_verification() {
        let mut tampered = FIXTURE_PAYLOAD.to_vec();
        tampered[0] ^= 0x01;
        let err = verify_signature_document(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, &tampered)
            .expect_err("tampered artifact bytes must NOT verify");
        assert!(
            err.contains("verification failed"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn a_truncated_artifact_fails_verification() {
        let truncated = &FIXTURE_PAYLOAD[..FIXTURE_PAYLOAD.len() - 1];
        assert!(verify_signature_document(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, truncated).is_err());
    }

    #[test]
    fn a_signature_from_a_different_key_fails_against_the_embedded_key() {
        // The embedded Fress key is used as the WRONG key here: it must
        // reject the fixture signature (and the fixture key must not have
        // drifted into the binary).
        let err = verify_signature_document(
            UPDATER_PUBLIC_KEY_FILE_B64,
            FIXTURE_SIG_B64,
            FIXTURE_PAYLOAD,
        )
        .expect_err("a foreign-key signature must NOT verify against the embedded key");
        assert!(!err.is_empty());
    }

    #[test]
    fn malformed_documents_are_rejected_not_panicked_on() {
        // Garbage base64.
        assert!(decode_document_b64("!!!not-base64!!!").is_err());
        // Valid base64 that is not a minisign document.
        assert!(verify_signature_document(
            "aGVsbG8gd29ybGQ=",
            FIXTURE_SIG_B64,
            FIXTURE_PAYLOAD
        )
        .is_err());
        // Valid key document, garbage signature document.
        assert!(verify_signature_document(FIXTURE_KEY_DOC_B64, "aGVsbG8gd29ybGQ=", FIXTURE_PAYLOAD).is_err());
        // Truncated signature document (cut mid-base64).
        assert!(verify_signature_document(
            FIXTURE_KEY_DOC_B64,
            &FIXTURE_SIG_B64[..FIXTURE_SIG_B64.len() - 8],
            FIXTURE_PAYLOAD
        )
        .is_err());
    }

    #[test]
    fn streaming_verification_accepts_the_real_file_and_refuses_a_tampered_one() {
        // The command path verifies the file ON DISK in chunks; exercise it
        // end to end with a temp file carrying the exact fixture bytes.
        let mut path = std::env::temp_dir();
        path.push(format!("fress-sig-fixture-{}.bin", std::process::id()));
        std::fs::write(&path, FIXTURE_PAYLOAD).expect("write fixture file");
        let ok = verify_signature_over_file(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, path.to_string_lossy().as_ref());
        std::fs::remove_file(&path).ok();
        ok.expect("streaming verification must accept the exact artifact bytes");

        // Tampered on-disk artifact: one extra byte.
        let mut path = std::env::temp_dir();
        path.push(format!("fress-sig-fixture-bad-{}.bin", std::process::id()));
        let mut bad = FIXTURE_PAYLOAD.to_vec();
        bad.extend_from_slice(b"x");
        std::fs::write(&path, &bad).expect("write tampered fixture file");
        let bad_result =
            verify_signature_over_file(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, path.to_string_lossy().as_ref());
        std::fs::remove_file(&path).ok();
        assert!(bad_result.is_err(), "a one-byte-append artifact must NOT verify");
    }
}
