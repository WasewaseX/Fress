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
/// plus the base64 key cryptobuf). Decode-then-parse is handled by
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
///
/// In-memory shape of the streaming verifier below: the production path
/// (`verify_self_update_signature`) always streams the artifact from disk,
/// so this byte-slice form is exercised only by the unit tests - which is
/// exactly where the documented accept/refuse matrix lives.
#[cfg(test)]
fn verify_signature_document(
    key_file_b64: &str,
    signature_b64: &str,
    data: &[u8],
) -> Result<(), String> {
    let pk = decode_updater_public_key(key_file_b64)?;
    let document = decode_document_b64(signature_b64)?;
    let sig = Signature::decode(&document)
        .map_err(|e| format!("Malformed updater signature document: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| format!("Updater signature verification failed: {e}"))
}

/// Streams the artifact at `file_path` through the verifier in 64 KiB
/// chunks so even the ~90 MB AppImage is verified in bounded memory - the
/// artifact verified is byte-for-byte the artifact on disk, not a re-read
/// or a copy.
///
/// Test-only convenience: production reaches the byte verdict through
/// [`verify_completed_self_update_signature_with_key`], which opens the
/// file itself and feeds [`verify_signature_over_open_file`] so its
/// metadata checks and its byte stream share one handle.
#[cfg(test)]
fn verify_signature_over_file(
    key_file_b64: &str,
    signature_b64: &str,
    file_path: &str,
) -> Result<(), String> {
    let mut file = std::fs::File::open(file_path)
        .map_err(|e| format!("Cannot open the downloaded file: {e}"))?;
    verify_signature_over_open_file(key_file_b64, signature_b64, &mut file)
}

/// [`verify_signature_over_file`] over an ALREADY-OPENED handle. The
/// verification boundary uses this form so the metadata checks (regular
/// file, committed size) and the byte stream come from the SAME open -
/// no second path lookup between "checked" and "verified".
fn verify_signature_over_open_file(
    key_file_b64: &str,
    signature_b64: &str,
    file: &mut std::fs::File,
) -> Result<(), String> {
    use std::io::Read;
    let pk = decode_updater_public_key(key_file_b64)?;
    let document = decode_document_b64(signature_b64)?;
    let sig = Signature::decode(&document)
        .map_err(|e| format!("Malformed updater signature document: {e}"))?;
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

/// One uniform refusal for every path that is not a completed download
/// artifact of this session. The sameness IS the security property: no
/// error-shape differences that could turn the boundary into a filesystem
/// probe for the webview (a path's existence, readability or type is never
/// distinguishable through this command).
const VERIFICATION_SCOPE_REFUSAL: &str =
    "Signature verification refused: this path is not a completed Fress download artifact";

/// One-line provenance suffix for the boundary's diagnostics about a
/// REGISTERED artifact: what the engine itself proved about the bytes when
/// it committed them (the record's checksum status). Only ever attached to
/// the caller's own download record - it says nothing about any other
/// filesystem path, so the uniform-refusal property is untouched.
fn checksum_provenance(checksum_verified: Option<bool>) -> &'static str {
    match checksum_verified {
        Some(true) => "the download had completed checksum-verified",
        _ => "the download had completed without a verified checksum",
    }
}

/// THE updater signature-verification boundary.
///
/// Accepts ONLY a completed, registered update artifact: `file_path` must
/// resolve to a record in the download registry's completed-artifact queue
/// (see `download_finalize.rs`, "Completed-artifact registry"), which the
/// engine populates exclusively on a successful, full, hash-checked
/// no-clobber commit. A frontend-provided arbitrary filesystem path can
/// therefore never become a general-purpose native file-verification API:
/// an unregistered path is refused before a single byte of it is read,
/// with the same generic refusal regardless of what exists on disk.
///
/// The checks, in order:
///   1. Registry scope - exact reported-path match first (the frontend
///      echoes the completion event's `path` verbatim), then a
///      canonicalized fallback for a normalized variant of the same
///      location. Miss => the uniform refusal, nothing else observable.
///   2. Staging shapes - a `.part` / `.part.meta` name is refused by
///      construction (defense in depth; the engine never records one).
///   3. Canonical stability - the recorded path is re-canonicalized NOW
///      and must equal the canonical path recorded at completion. A file
///      swapped for a symlink, moved, or re-homed after completion is
///      refused even when its bytes would verify.
///   4. Regular file + committed size - the OPEN HANDLE's metadata must
///      be a regular file of the recorded size. A deleted, replaced or
///      truncated artifact is refused here instead of verified.
///   5. Byte verdict - the signature is streamed over the bytes of that
///      same open handle. Whatever is on disk at verification time is
///      exactly what is judged: a same-size in-place edit is invisible to
///      metadata but always fails the signature, so any post-completion
///      modification can only produce a refusal, never a false "verified".
///
/// TOCTOU note: between the metadata checks and the streaming read the
/// bytes could still be exchanged by something with local disk access.
/// The design keeps that window harmless by construction - the verdict is
/// computed over whatever the handle actually yields, so an exchange can
/// only change WHICH failure is reported, never turn a failure into a
/// success (the exchanged bytes must also carry the embedded key's
/// signature to verify, in which case they are a genuine artifact).
///
/// Deliberately NOT promised here: binding the signature DOCUMENT to a
/// release version or asset filename. Minisign trusted comments are not
/// verifiable through the `minisign-verify` API, so "this .sig is the one
/// published for release vX's <name>" is enforced by the frontend
/// delivery plan, which matches the sidecar against the pinned release
/// feed before ever calling. A wrong-version document cannot forge an
/// outcome: it verifies only over bytes that genuinely carry the embedded
/// key's signature.
///
/// VERIFY-ONLY: the command returns ok/error, never file contents, and
/// never modifies, executes or exposes the artifact. `key_file_b64` is a
/// parameter only so the tests can drive the full boundary with the
/// fixture key; production passes the compile-time-embedded public key.
fn verify_completed_self_update_signature_with_key(
    registry: &DownloadRegistry,
    key_file_b64: &str,
    file_path: &str,
    signature_base64: &str,
) -> Result<(), String> {
    let requested = std::path::PathBuf::from(file_path.trim());
    if requested.as_os_str().is_empty() {
        return Err(VERIFICATION_SCOPE_REFUSAL.to_string());
    }
    // Staging files are never verification candidates. The registry cannot
    // contain one (only commits are recorded), so this is pure defense in
    // depth - and it documents the intent for a future caller.
    let name = requested
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.ends_with(".part") || name.ends_with(".part.meta") {
        return Err(VERIFICATION_SCOPE_REFUSAL.to_string());
    }
    // 1. Registry scope. Before this line passes, the command has touched
    //    nothing on disk under the caller's path.
    let Some(record) = registry.completed_artifact_for_path(&requested) else {
        return Err(VERIFICATION_SCOPE_REFUSAL.to_string());
    };
    // 3. Canonical stability: the artifact must still sit where the engine
    //    committed it, not behind a symlink, bind mount or rename. The
    //    download id, source URL and the engine's own checksum verdict
    //    travel with the refusal: they describe the caller's own download
    //    (the frontend correlates id -> url before it calls), so they aid
    //    diagnosis without leaking anything.
    let current = std::fs::canonicalize(&record.path).map_err(|_| {
        format!(
            "Signature verification refused: the completed download artifact is no longer on disk (download #{}, originally from {}; {})",
            record.id,
            record.url,
            checksum_provenance(record.checksum_verified)
        )
    })?;
    if current != record.canonical {
        return Err(format!(
            "Signature verification refused: the completed download artifact was moved or replaced on disk ({})",
            checksum_provenance(record.checksum_verified)
        ));
    }
    // 4. Regular file of the committed size, judged through the SAME
    //    handle the bytes are then read from.
    let mut file = std::fs::File::open(&current)
        .map_err(|e| format!("Cannot open the downloaded file: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Cannot inspect the downloaded file: {e}"))?;
    if !meta.is_file() {
        return Err(
            "Signature verification refused: the completed download artifact is not a regular file"
                .to_string(),
        );
    }
    if meta.len() != record.size {
        return Err(format!(
            "Signature verification refused: the file at the completed download's path has changed since completion ({})",
            checksum_provenance(record.checksum_verified)
        ));
    }
    // 5. The actual bytes.
    verify_signature_over_open_file(key_file_b64, signature_base64, &mut file)
}

/// Verifies the minisign signature of a COMPLETED self-update download
/// against the public key embedded in this binary.
///
/// Inputs:
///   - `file_path`: the path of the downloaded artifact on disk - the
///     exact `path` the download engine reported on the download-complete
///     event. It is validated against the native download registry's
///     completed-artifact records (see
///     [`verify_completed_self_update_signature_with_key`]); it is NOT an
///     arbitrary filesystem API.
///   - `signature_base64`: the EXACT content of the matching `.sig`
///     sidecar from the SAME release (base64 of the minisign signature
///     document, which is also what `latest.json` carries in its
///     signature field).
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
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    let registry = Arc::clone(registry.inner());
    tokio::task::spawn_blocking(move || {
        verify_completed_self_update_signature_with_key(
            &registry,
            UPDATER_PUBLIC_KEY_FILE_B64,
            &file_path,
            &signature_base64,
        )
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
    pub(crate) const FIXTURE_PAYLOAD: &[u8] = b"Fress updater signature fixture payload v1\n";

    /// Throwaway keypair public key in the Tauri .pub document format
    /// (single-line base64 of "untrusted comment" + key cryptobuf).
    pub(crate) const FIXTURE_KEY_DOC_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU5OTY3QkUwM0Q0Q0EwMTMKUldRVG9Fdzk0SHVXV1pQc2dONGs5TSsvMy9VZmRpVm1kdDhZUkJkMTFYWTlaRkxZai9CMVNLQ0QK";

    /// `tauri signer sign` output over FIXTURE_PAYLOAD with the fixture key.
    pub(crate) const FIXTURE_SIG_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRVG9Fdzk0SHVXV1phVkViOUhjM2dJTjNsR0VsTzhURTZZWlZTUGcyaXdSNGdPcVUzK0hXbk9TTWkwbGFlTk9LREUrMlRMMEdvS3VNbmhxQjF3SVVGMUFZVWpyU1VqQlEwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNzQ3NjUzCWZpbGU6cGF5bG9hZC5iaW4KRis3Wkp1d1kyS1U4NTF3MFlSRTBaUFp6VHU3UnJHVlExNmRsajNMNkhDRlFNWmVicEVlRWhVNFNTcFQyNXJvY2JkaTFBU1p1VXpNMUJyb0dqMEVWQnc9PQo=";

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
        assert!(
            verify_signature_document(FIXTURE_KEY_DOC_B64, FIXTURE_SIG_B64, truncated).is_err()
        );
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
        assert!(
            verify_signature_document("aGVsbG8gd29ybGQ=", FIXTURE_SIG_B64, FIXTURE_PAYLOAD)
                .is_err()
        );
        // Valid key document, garbage signature document.
        assert!(verify_signature_document(
            FIXTURE_KEY_DOC_B64,
            "aGVsbG8gd29ybGQ=",
            FIXTURE_PAYLOAD
        )
        .is_err());
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
        let ok = verify_signature_over_file(
            FIXTURE_KEY_DOC_B64,
            FIXTURE_SIG_B64,
            path.to_string_lossy().as_ref(),
        );
        std::fs::remove_file(&path).ok();
        ok.expect("streaming verification must accept the exact artifact bytes");

        // Tampered on-disk artifact: one extra byte.
        let mut path = std::env::temp_dir();
        path.push(format!("fress-sig-fixture-bad-{}.bin", std::process::id()));
        let mut bad = FIXTURE_PAYLOAD.to_vec();
        bad.extend_from_slice(b"x");
        std::fs::write(&path, &bad).expect("write tampered fixture file");
        let bad_result = verify_signature_over_file(
            FIXTURE_KEY_DOC_B64,
            FIXTURE_SIG_B64,
            path.to_string_lossy().as_ref(),
        );
        std::fs::remove_file(&path).ok();
        assert!(
            bad_result.is_err(),
            "a one-byte-append artifact must NOT verify"
        );
    }
}

#[cfg(test)]
mod verification_boundary_tests {
    // THE security regression matrix for the updater signature boundary
    // (`verify_self_update_signature`). The command is scoped to completed,
    // registered download artifacts; every test here drives the full
    // boundary function - registry lookup, canonical-stability check,
    // regular-file/size gate and the byte verdict - exactly as production
    // runs it (only the public key is the test fixture, since the real
    // private key never leaves CI).
    //
    // The hostile scenarios map 1:1 to the acceptance checklist:
    //   - arbitrary frontend path          -> refused (NOT a file-verification API)
    //   - staging .part / .part.meta       -> refused
    //   - tampered bytes after completion  -> signature fails, file untouched
    //   - replaced / truncated after completion -> size gate refuses
    //   - symlink swap after completion    -> canonical gate refuses
    //   - deleted after completion         -> canonical gate refuses
    //   - foreign key / malformed / truncated .sig -> verification fails
    //   - same-size in-place edit          -> signature fails (metadata-blind,
    //                                         signature-caught)

    use super::self_update_signature_tests::{
        FIXTURE_KEY_DOC_B64, FIXTURE_PAYLOAD, FIXTURE_SIG_B64,
    };
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "fress-verify-boundary-{}-{}-{}",
                tag,
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The fixture signature module lives one scope up.
    fn boundary_verify(
        registry: &DownloadRegistry,
        file_path: &str,
        signature_base64: &str,
    ) -> Result<(), String> {
        verify_completed_self_update_signature_with_key(
            registry,
            FIXTURE_KEY_DOC_B64,
            file_path,
            signature_base64,
        )
    }

    /// A registry holding one completed artifact at `<dir>/<name>` whose
    /// bytes are the fixture payload - the shape the engine produces on a
    /// successful commit.
    fn registered_artifact(dir: &TempDir, name: &str) -> (DownloadRegistry, PathBuf) {
        let path = dir.0.join(name);
        std::fs::write(&path, FIXTURE_PAYLOAD).expect("write artifact bytes");
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(
            42,
            &path,
            "https://github.com/WasewaseX/Fress/releases/download/v1.0.8-beta/app.exe",
            // The updater artifact is downloaded through the delivery plan
            // with the published SHA-256, so a real record would carry the
            // engine's checksum verdict; the fixture pins the same shape.
            Some(true),
        );
        (registry, path)
    }

    #[test]
    fn a_genuine_signature_verifies_on_the_registered_completed_artifact() {
        let dir = TempDir::new("ok");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect("the completed, registered artifact must verify");
    }

    #[test]
    fn an_arbitrary_filesystem_path_is_refused_even_when_its_bytes_would_verify() {
        // THE anti-generalization test: the SAME genuine bytes, the SAME
        // genuine signature - but the file was not completed by the
        // download engine, so the boundary refuses without reading it.
        // This is what keeps a compromised webview from using the command
        // as a native "verify any file" oracle.
        let dir = TempDir::new("unregistered");
        let path = dir.0.join("dropped-by-browser.exe");
        std::fs::write(&path, FIXTURE_PAYLOAD).expect("write unregistered file");
        let registry = DownloadRegistry::default();
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("an unregistered path must be refused");
        assert!(
            err.contains(super::VERIFICATION_SCOPE_REFUSAL),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn staging_part_files_are_never_verification_candidates() {
        let dir = TempDir::new("staging");
        let (registry, _) = registered_artifact(&dir, "Fress-setup.exe");
        let part = dir.0.join("Fress-setup.exe.part");
        std::fs::write(&part, FIXTURE_PAYLOAD).expect("write part bytes");
        let err = boundary_verify(&registry, part.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a .part file must be refused");
        assert!(err.contains(super::VERIFICATION_SCOPE_REFUSAL), "{err}");

        let meta = dir.0.join("Fress-setup.exe.part.meta");
        std::fs::write(&meta, b"url").unwrap();
        let err = boundary_verify(&registry, meta.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a .part.meta file must be refused");
        assert!(err.contains(super::VERIFICATION_SCOPE_REFUSAL), "{err}");
    }

    #[test]
    fn empty_and_whitespace_paths_are_refused() {
        let registry = DownloadRegistry::default();
        for p in ["", "   "] {
            let err = boundary_verify(&registry, p, FIXTURE_SIG_B64)
                .expect_err("an empty path must be refused");
            assert!(err.contains(super::VERIFICATION_SCOPE_REFUSAL), "{err}");
        }
    }

    #[test]
    fn a_same_size_tamper_after_completion_fails_closed_and_leaves_the_file_untouched() {
        let dir = TempDir::new("tampered");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        // Flip one byte IN PLACE - the size gate cannot see this; the
        // signature verdict must.
        let mut bytes = FIXTURE_PAYLOAD.to_vec();
        bytes[3] ^= 0x80;
        std::fs::write(&path, &bytes).expect("tamper in place");

        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("tampered completed bytes must NOT verify");
        assert!(err.contains("verification failed"), "unexpected: {err}");

        // The verifier is verify-only: the artifact is exactly as the
        // tamper left it - not deleted, not rewritten, not executed.
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn a_failed_verification_never_mutates_the_registry_record() {
        // "Must not leave it registered as successfully verified": the
        // registry has no verified flag to flip - the only honest shape -
        // and a failed verdict must not add, remove, or alter any record.
        // The record the engine wrote at commit time is exactly what a
        // later verification attempt still sees.
        let dir = TempDir::new("record-immutable");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        let before = registry
            .completed_artifact_for_path(&path)
            .expect("record present before the failed verification");

        // The same-size tamper: verification fails at the byte verdict.
        let mut bytes = FIXTURE_PAYLOAD.to_vec();
        bytes[2] ^= 0x01;
        std::fs::write(&path, &bytes).expect("tamper in place");
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("tampered bytes must NOT verify");
        assert!(err.contains("verification failed"), "unexpected: {err}");

        let after = registry
            .completed_artifact_for_path(&path)
            .expect("record must survive a failed verification");
        assert_eq!(before.id, after.id);
        assert_eq!(before.url, after.url);
        assert_eq!(before.size, after.size);
        assert_eq!(before.canonical, after.canonical);
        assert_eq!(before.path, after.path);
        assert_eq!(
            before.checksum_verified, after.checksum_verified,
            "the engine's checksum verdict must not be rewritten by the verifier"
        );
        // And nothing else appeared in the queue either.
        assert_eq!(
            registry.completed_len(),
            1,
            "a failed verification must not create records"
        );
    }

    #[test]
    fn a_file_replaced_after_completion_is_refused_at_the_boundary() {
        let dir = TempDir::new("replaced");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        // The classic "replaced between completion and verification":
        // delete, then write an attacker file under the same name.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"attacker payload, different length").unwrap();
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a replaced artifact must be refused");
        assert!(
            err.contains("changed since completion"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn a_deleted_artifact_is_refused_not_treated_as_unverifiable_success() {
        let dir = TempDir::new("deleted");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        std::fs::remove_file(&path).unwrap();
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a deleted artifact must be refused");
        assert!(err.contains("no longer on disk"), "unexpected: {err}");
    }

    #[test]
    fn the_boundary_diagnostics_carry_the_engines_checksum_verdict() {
        // The record's checksum status is the "expected checksum status"
        // leg of the contract, surfaced in the diagnostics for the
        // caller's OWN download - and only there.
        let dir = TempDir::new("provenance");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        std::fs::remove_file(&path).unwrap();
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a deleted artifact must be refused");
        assert!(
            err.contains("checksum-verified"),
            "a checksummed record must say so: {err}"
        );

        // A record the engine completed WITHOUT a trusted checksum must
        // never be described as checksum-verified.
        let dir = TempDir::new("provenance-none");
        let path = dir.0.join("Fress-setup.exe");
        std::fs::write(&path, FIXTURE_PAYLOAD).expect("write artifact bytes");
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(
            43,
            &path,
            "https://github.com/WasewaseX/Fress/releases/download/v1.0.8-beta/app.exe",
            None,
        );
        std::fs::remove_file(&path).unwrap();
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a deleted artifact must be refused");
        assert!(
            err.contains("without a verified checksum"),
            "an unchecksummed record must say so: {err}"
        );
        assert!(
            !err.contains("checksum-verified"),
            "the unchecksummed record must NOT claim a verdict: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_swap_is_refused_even_when_the_target_holds_verifiable_bytes() {
        // The strongest swap: the artifact path now points at a DIFFERENT
        // file whose bytes are byte-for-byte the genuine fixture payload.
        // The canonical-stability gate refuses it anyway - the boundary
        // verifies THE artifact the engine committed, at the location it
        // was committed to, never "whatever this path currently yields".
        let dir = TempDir::new("symlinked");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        let decoy = dir.0.join("decoy.bin");
        std::fs::write(&decoy, FIXTURE_PAYLOAD).expect("write decoy bytes");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&decoy, &path).expect("create symlink swap");

        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a symlink-swapped artifact must be refused");
        assert!(err.contains("moved or replaced"), "unexpected: {err}");
        // The decoy was never touched either.
        assert_eq!(std::fs::read(&decoy).unwrap(), FIXTURE_PAYLOAD);
    }

    #[test]
    fn foreign_key_and_broken_signature_documents_fail_on_a_registered_artifact() {
        let dir = TempDir::new("docs");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        let artifact = path.to_string_lossy().to_string();

        // A signature from a DIFFERENT key (the embedded production key
        // against the fixture signature): the streaming verifier refuses
        // at startup - a verification failure, not a panic and not a scope
        // refusal (the path IS registered).
        let err = verify_completed_self_update_signature_with_key(
            &registry,
            UPDATER_PUBLIC_KEY_FILE_B64,
            &artifact,
            FIXTURE_SIG_B64,
        )
        .expect_err("a foreign-key signature must NOT verify");
        assert!(
            err.contains("different key") || err.contains("verification failed"),
            "unexpected: {err}"
        );

        // Malformed base64 document.
        let err = boundary_verify(&registry, &artifact, "!!!not-base64!!!")
            .expect_err("malformed base64 must fail");
        assert!(err.contains("Malformed base64"), "unexpected: {err}");

        // Valid base64 that is not a minisign document.
        let err = boundary_verify(&registry, &artifact, "aGVsbG8gd29ybGQ=")
            .expect_err("a non-minisign document must fail");
        assert!(
            err.contains("Malformed updater signature document"),
            "unexpected: {err}"
        );

        // Truncated signature document (cut mid-base64).
        let truncated = &FIXTURE_SIG_B64[..FIXTURE_SIG_B64.len() - 8];
        let err = boundary_verify(&registry, &artifact, truncated)
            .expect_err("a truncated sidecar must fail");
        assert!(!err.is_empty());
    }

    #[test]
    fn the_boundary_refusal_is_identical_for_every_unregistered_path() {
        // The uniform-refusal contract: existence, readability and type of
        // an arbitrary path must NOT be distinguishable through the
        // boundary. One registry, three wildly different paths, one exact
        // same error.
        let dir = TempDir::new("uniform");
        let registry = DownloadRegistry::default();
        // (a) a path that does not exist
        let a = dir.0.join("does-not-exist.bin");
        // (b) a path that exists and is readable
        let b = dir.0.join("readable.txt");
        std::fs::write(&b, b"secret? no - just a file").unwrap();
        // (c) a directory
        let c = dir.0.join("a-directory");
        std::fs::create_dir_all(&c).unwrap();

        let err_a =
            boundary_verify(&registry, a.to_string_lossy().as_ref(), FIXTURE_SIG_B64).unwrap_err();
        let err_b =
            boundary_verify(&registry, b.to_string_lossy().as_ref(), FIXTURE_SIG_B64).unwrap_err();
        let err_c =
            boundary_verify(&registry, c.to_string_lossy().as_ref(), FIXTURE_SIG_B64).unwrap_err();
        assert_eq!(err_a, err_b);
        assert_eq!(err_b, err_c);
        assert!(err_a.contains(super::VERIFICATION_SCOPE_REFUSAL));
    }
}
