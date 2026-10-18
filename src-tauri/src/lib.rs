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

// The resilience layer behind every catalog source lookup: transient-error
// retries, Retry-After honoring, ETag conditional requests against a small
// persistent cache (304s spend no GitHub quota) and stale-while-error
// serving. Module docs carry the full root-cause story.
mod api_resilience;
use api_resilience::ApiFetchError;

// The download engine owns everything between "user clicked download" and
// "a complete, verified file exists on disk": the lifecycle state machine,
// staging (.part) files and their validator sidecars, resume correctness,
// integrity verification and the no-clobber final commit. Its module docs
// double as the state-transition and cleanup specification. This file keeps
// only the Tauri command surface and the event mapping. The module
// registration here is the coordination point between the download-engine
// work and the URL/HTTP-client work (Agent 1's sections below are untouched).
mod artifact_open;
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

/// Resolves the app-cache directory the lookup caches live in. A missing
/// directory resolution degrades to a memory-only store: every resilience
/// feature except the persistent 304/stale answers still works.
fn resolver_cache_store(app: &AppHandle) -> api_resilience::CacheStore {
    api_resilience::CacheStore::open(
        app.path()
            .app_cache_dir()
            .ok()
            .map(|d| d.join("api-responses")),
    )
}

/// Maps the resilience layer's typed failure onto the command-level error
/// strings the frontend already classifies ("rate limit" wording included).
fn api_fetch_error_message(err: ApiFetchError, label: &str, not_found: &str) -> String {
    match err {
        ApiFetchError::Status(msg) => {
            // The deterministic 404s keep their long-standing command
            // wording ("No stable release found..." / "Package not found
            // on F-Droid") - the resolvers special-case them as honest
            // answers, not failures.
            if msg == format!("{label} returned HTTP 404") {
                not_found.to_string()
            } else {
                msg
            }
        }
        ApiFetchError::Transient(msg) => msg,
    }
}

/// Resolves the LATEST STABLE release of a GitHub repository.
/// The /releases/latest endpoint already excludes drafts and prereleases,
/// so beta/RC versions are never offered here.
/// Core of `fetch_latest_release`, AppHandle-free so the integration
/// harness can drive the exact production path (pass `cache: None`).
async fn gh_latest_release(
    repo: String,
    cache: Option<&api_resilience::CacheStore>,
) -> Result<GhRelease, String> {
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
    let resolved = api_resilience::get_json_resilient(
        &client,
        url.raw(),
        "GitHub",
        &api_resilience::Timing::production(),
        cache,
    )
    .await
    .map_err(|e| {
        api_fetch_error_message(e, "GitHub", "No stable release found for this project")
    })?;
    let body: serde_json::Value =
        serde_json::from_str(&resolved.body).map_err(|e| format!("Bad response: {}", e))?;
    parse_gh_release(&body, &repo).ok_or_else(|| "Unexpected GitHub response".to_string())
}

#[tauri::command]
async fn fetch_latest_release(app: AppHandle, repo: String) -> Result<GhRelease, String> {
    let cache = resolver_cache_store(&app);
    gh_latest_release(repo, Some(&cache)).await
}

/// Lists the most recent stable releases of a repository, newest first.
///
/// Some projects publish several release streams from one repo (a desktop
/// tag, a mobile tag, a server tag - Obsidian, Tuta, Ente). The single
/// /releases/latest answer is then often the WRONG stream for the platform
/// the user wants, and every download resolves to nothing. This command
/// hands back enough recent releases for the frontend to scan them in order
/// and find the stream that actually carries the platform's installer.
/// Core of `fetch_recent_releases`, AppHandle-free so the integration
/// harness can drive the exact production path (pass `cache: None`).
async fn gh_recent_releases(
    repo: String,
    count: Option<u32>,
    include_flagged: Option<bool>,
    cache: Option<&api_resilience::CacheStore>,
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
    let resolved = api_resilience::get_json_resilient(
        &client,
        url.raw(),
        "GitHub",
        &api_resilience::Timing::production(),
        cache,
    )
    .await
    .map_err(|e| {
        api_fetch_error_message(e, "GitHub", "No stable release found for this project")
    })?;
    let body: serde_json::Value =
        serde_json::from_str(&resolved.body).map_err(|e| format!("Bad response: {}", e))?;
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

#[tauri::command]
async fn fetch_recent_releases(
    app: AppHandle,
    repo: String,
    count: Option<u32>,
    include_flagged: Option<bool>,
) -> Result<Vec<GhRelease>, String> {
    let cache = resolver_cache_store(&app);
    gh_recent_releases(repo, count, include_flagged, Some(&cache)).await
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

// The bounded response-body readers (caps + the TextFetch document shape)
// live in their own Tauri-free module so their loopback regression tests
// compile and run everywhere - see the module docs for the two-rail design
// (size cap + request timeout) and its test matrix.
mod http_body;
use http_body::TextFetch;

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
#[tauri::command]
async fn fetch_text(url: String) -> Result<TextFetch, String> {
    let policy = network_policy::UrlPolicy::resolver_manifest();
    // Admission first: parse + allowlist + scheme/credential checks, so a
    // malformed or disallowed request is refused before any client exists.
    let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    // Retry-only resilience (no cache: manifest reads may be
    // redirect-to-file probes whose freshness is the contract). The same
    // transient contract as the API lookups - a vendor manifest behind one
    // dropped packet used to fail the whole official-resolver chain. The
    // loop itself is shared with the GitHub release-document and
    // self-update text commands in `api_resilience::get_text_resilient`,
    // where the loopback tests pin its schedule.
    api_resilience::get_text_resilient(
        &client,
        parsed.raw(),
        "Manifest host",
        &api_resilience::Timing::production(),
    )
    .await
}

/// Reads one of GitHub's quota-free release documents for the
/// rate-limit-proof release-lookup fallback (`releases.atom` and the
/// per-tag `expanded_assets` fragments).
///
/// Why a dedicated command instead of `fetch_text`: the resolver-manifest
/// allowlist deliberately pins the invariant "github.com stays off the
/// generic text policy" (that is what keeps the self-update checksum
/// document reachable only through the path-pinned self-update policy).
/// This command gets its own request class instead - github.com is
/// admitted for exactly the two release-document shapes, every redirect
/// hop re-checked, standard scheme/credential/private-address rules
/// unchanged (see `network_policy::ReleasesDocShape`).
#[tauri::command]
async fn fetch_github_release_doc(url: String) -> Result<TextFetch, String> {
    let policy = network_policy::UrlPolicy::github_releases_doc();
    let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    // The same retry-only resilience contract as every other text
    // transport: the quota-free fallback exists for the exact moment the
    // API path is already exhausted, so one dropped packet on the atom
    // feed or an expanded_assets fragment must not resurrect the very
    // failure this path exists to prevent.
    api_resilience::get_text_resilient(
        &client,
        parsed.raw(),
        "GitHub release document",
        &api_resilience::Timing::production(),
    )
    .await
}

/// The self-update repo pin: the only github.com documents the self-update
/// flow may read are this repository's atom feed and release assets. Shared
/// by the command and its admission tests so the tests drive the PRODUCTION
/// gate, not a copy of it (a regression in the gate must fail the tests).
/// The asset-CDN hosts have opaque token paths, so the pin applies to the
/// github.com origin only; redirect hops are pinned separately by the
/// policy's `PathPin`.
pub(crate) fn check_self_update_repo_path(url: &reqwest::Url) -> Result<(), String> {
    const REPO_PATH_PREFIX: &str = "/WasewaseX/Fress/";
    if url.host_str() == Some("github.com")
        && !url.path().starts_with(REPO_PATH_PREFIX)
        && url.path() != "/WasewaseX/Fress"
    {
        return Err(format!(
            "Only WasewaseX/Fress release documents are allowed, not {}",
            url.path()
        ));
    }
    Ok(())
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
///   - the `self_update_feed` policy pins the host to the three GitHub-owned
///     names (every redirect hop re-checked) and refuses private addresses;
///   - the path on `github.com` is pinned here to the Fress repository (and
///     to the same repository on every redirect hop, via the policy's
///     `PathPin`), so the command cannot be turned into a general github.com
///     reader even from a compromised WebView;
///   - the 2 MiB body cap shared with `fetch_text` bounds the response.
#[tauri::command]
async fn fetch_self_update_text(url: String) -> Result<TextFetch, String> {
    let policy = network_policy::UrlPolicy::self_update_feed();
    let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
    check_self_update_repo_path(parsed.raw())?;
    let client = policy.http_client()?;
    // Same retry-only contract as the other text transports: the update
    // check and the checksum reference rode the same one-dropped-packet
    // risk, and the TS caller degrades any failure to "no update info"
    // until the next poll - the retry only makes that outcome rarer.
    api_resilience::get_text_resilient(
        &client,
        parsed.raw(),
        "Self-update document",
        &api_resilience::Timing::production(),
    )
    .await
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

/// Same property, same channel, for the OPEN boundary (see
/// [`open_downloaded_file`]): every out-of-scope path produces exactly this
/// typed code - the shared `open-artifact/<code>` namespace the frontend's
/// `parseOpenError` switches on (the same taxonomy as `artifact_open.rs`) -
/// so a caller can never distinguish "does not exist" from "exists but is
/// not a registered download" from "registered but tampered".
const OPEN_NOT_REGISTERED_REFUSAL: &str = "open-artifact/not-registered";

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

/// Why [`resolve_completed_artifact`] refused a path. The two consumers (the
/// updater's signature-verification boundary and the open boundary) map these
/// onto their own uniform wordings - [`verification_boundary_error`] and
/// [`open_boundary_error`] - so the shared checks can never drift apart while
/// each command keeps its own, shape-stable refusal language.
#[derive(Debug)]
enum ArtifactBoundaryError {
    /// Empty path, a staging (`.part`) name, or no registry record: the
    /// uniform refusal. Nothing about the filesystem was ever observed.
    NotInScope,
    /// A record exists but the artifact is no longer at its committed path.
    NotOnDisk {
        id: u32,
        url: String,
        provenance: &'static str,
    },
    /// The artifact still exists but no longer resolves to the canonical
    /// path recorded at completion (moved, renamed or re-homed).
    MovedOrReplaced { provenance: &'static str },
    /// Open/metadata I/O failure (message already fully worded - both
    /// boundaries use the same text for these).
    Io(String),
    /// The opened handle is not a regular file.
    NotARegularFile,
    /// The file's size no longer matches the committed size.
    SizeChanged { provenance: &'static str },
}

/// THE shared completed-artifact resolution used by every boundary that may
/// hand a download artifact to native code. Accepts ONLY a completed,
/// registered download: `file_path` must resolve to a record in the download
/// registry's completed-artifact queue (see `download_finalize.rs`,
/// "Completed-artifact registry"), which the engine populates exclusively on
/// a successful, full, hash-checked no-clobber commit. A frontend-provided
/// arbitrary filesystem path can therefore never reach a native
/// open/verify interaction: an unregistered path is refused before a single
/// byte of it is read.
///
/// The checks, in order:
///   1. Registry scope - exact reported-path match first (the frontend
///      echoes the completion event's `path` verbatim), then a
///      canonicalized fallback for a normalized variant of the same
///      location. Miss => [`ArtifactBoundaryError::NotInScope`], nothing
///      else observable.
///   2. Staging shapes - a `.part` / `.part.meta` name is refused by
///      construction (defense in depth; the engine never records one).
///   3. Canonical stability - the recorded path is re-canonicalized NOW
///      and must equal the canonical path recorded at completion. A file
///      swapped for a symlink, moved, or re-homed after completion is
///      refused even when its bytes would pass.
///   4. Regular file + committed size - the OPEN HANDLE's metadata must
///      be a regular file of the recorded size. A deleted, replaced or
///      truncated artifact is refused here instead of being used.
///
/// The returned file handle is the SAME handle the metadata checks passed
/// on, so each consumer's next read (a streamed signature, or nothing at
/// all) stays tied to the artifact that was judged. TOCTOU note: between
/// the checks and a later read the bytes could still be exchanged by
/// something with local disk access; consumers keep that window harmless
/// by construction (the signature verdict is computed over whatever the
/// handle actually yields, and the OS open of the path re-reads bytes that
/// at worst change which failure the next boundary reports).
fn resolve_completed_artifact(
    registry: &DownloadRegistry,
    file_path: &str,
) -> Result<
    (
        download_finalize::CompletedArtifact,
        std::path::PathBuf,
        std::fs::File,
    ),
    ArtifactBoundaryError,
> {
    let requested = std::path::PathBuf::from(file_path.trim());
    if requested.as_os_str().is_empty() {
        return Err(ArtifactBoundaryError::NotInScope);
    }
    // Staging files are never boundary candidates. The registry cannot
    // contain one (only commits are recorded), so this is pure defense in
    // depth - and it documents the intent for a future caller.
    let name = requested
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.ends_with(".part") || name.ends_with(".part.meta") {
        return Err(ArtifactBoundaryError::NotInScope);
    }
    // 1. Registry scope. Before this line passes, the command has touched
    //    nothing on disk under the caller's path.
    let Some(record) = registry.completed_artifact_for_path(&requested) else {
        return Err(ArtifactBoundaryError::NotInScope);
    };
    let provenance = checksum_provenance(record.checksum_verified);
    // 3. Canonical stability: the artifact must still sit where the engine
    //    committed it, not behind a symlink, bind mount or rename. The
    //    download id, source URL and the engine's own checksum verdict
    //    travel with the refusal: they describe the caller's own download
    //    (the frontend correlates id -> url before it calls), so they aid
    //    diagnosis without leaking anything.
    let current =
        std::fs::canonicalize(&record.path).map_err(|_| ArtifactBoundaryError::NotOnDisk {
            id: record.id,
            url: record.url.clone(),
            provenance,
        })?;
    if current != record.canonical {
        return Err(ArtifactBoundaryError::MovedOrReplaced { provenance });
    }
    // 4. Regular file of the committed size, judged through the SAME
    //    handle the consumer is then handed.
    let file = std::fs::File::open(&current)
        .map_err(|e| ArtifactBoundaryError::Io(format!("Cannot open the downloaded file: {e}")))?;
    let meta = file.metadata().map_err(|e| {
        ArtifactBoundaryError::Io(format!("Cannot inspect the downloaded file: {e}"))
    })?;
    if !meta.is_file() {
        return Err(ArtifactBoundaryError::NotARegularFile);
    }
    if meta.len() != record.size {
        return Err(ArtifactBoundaryError::SizeChanged { provenance });
    }
    Ok((record, current, file))
}

/// Maps the shared resolver's verdicts onto the verification boundary's
/// wordings. Byte-identical to the messages this command produced before the
/// resolver was extracted - the boundary's observable behavior is unchanged.
fn verification_boundary_error(err: ArtifactBoundaryError) -> String {
    match err {
        ArtifactBoundaryError::NotInScope => VERIFICATION_SCOPE_REFUSAL.to_string(),
        ArtifactBoundaryError::NotOnDisk { id, url, provenance } => format!(
            "Signature verification refused: the completed download artifact is no longer on disk (download #{}, originally from {}; {})",
            id, url, provenance
        ),
        ArtifactBoundaryError::MovedOrReplaced { provenance } => format!(
            "Signature verification refused: the completed download artifact was moved or replaced on disk ({})",
            provenance
        ),
        ArtifactBoundaryError::Io(message) => message,
        ArtifactBoundaryError::NotARegularFile => "Signature verification refused: the completed download artifact is not a regular file".to_string(),
        ArtifactBoundaryError::SizeChanged { provenance } => format!(
            "Signature verification refused: the file at the completed download's path has changed since completion ({})",
            provenance
        ),
    }
}

/// Maps the shared resolver's verdicts onto the open boundary's wordings:
/// the typed `open-artifact/<code>` namespace shared with the AppImage
/// launcher (`artifact_open.rs`), which the frontend's `parseOpenError`
/// classifies into the localized reasons. The failure SHAPES are the
/// verification boundary's, so an error can never become a filesystem
/// oracle: the three scope failures collapse into the one
/// [`OPEN_NOT_REGISTERED_REFUSAL`], and the registered-artifact diagnostics
/// carry the same provenance discipline in the code's DETAIL half (which
/// the UI logs to the console and never renders verbatim).
fn open_boundary_error(err: ArtifactBoundaryError) -> String {
    match err {
        ArtifactBoundaryError::NotInScope => OPEN_NOT_REGISTERED_REFUSAL.to_string(),
        ArtifactBoundaryError::NotOnDisk { id, url, provenance } => format!(
            "open-artifact/not-found: download #{}, originally from {}; {}",
            id, url, provenance
        ),
        ArtifactBoundaryError::MovedOrReplaced { provenance } => format!(
            "open-artifact/replaced: the completed download was moved or replaced on disk ({})",
            provenance
        ),
        // Plain OS-shaped text on purpose: parseOpenError classifies these
        // by the platform wordings (ENOENT -> missing, EACCES -> permission,
        // ...), the same path an opener-plugin failure takes.
        ArtifactBoundaryError::Io(message) => message,
        ArtifactBoundaryError::NotARegularFile => {
            "open-artifact/not-a-file".to_string()
        }
        ArtifactBoundaryError::SizeChanged { provenance } => format!(
            "open-artifact/replaced: the file at the completed download's path has changed since completion ({})",
            provenance
        ),
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
/// Checks 1-4 (registry scope, staging shapes, canonical stability,
/// regular file + committed size) run in [`resolve_completed_artifact`],
/// shared with the open boundary so the two boundaries can never drift.
/// What remains here is:
///   5. Byte verdict - the signature is streamed over the bytes of the
///      resolved handle. Whatever is on disk at verification time is
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
    let (_record, _canonical, mut file) =
        resolve_completed_artifact(registry, file_path).map_err(verification_boundary_error)?;
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

/// What the open boundary does with a validated artifact. The disposition
/// reads ONLY the extension of the registry-recorded path - never the file's
/// contents, which the boundary does not interpret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
enum OpenDisposition {
    /// Hand the APK to Android's normal package installer (via the
    /// fress-open plugin's FileProvider intent).
    ApkInstaller,
    /// Open with a capable viewer, or offer the share sheet.
    OpenOrShare,
}

/// Classifies a validated artifact path by its recorded extension. Pure and
/// case-insensitive ("APK", "Apk", "apk" are all install requests); anything
/// without an explicit apk extension is treated as a regular open - a
/// mislabeled file can only end up in the MORE conservative branch.
#[cfg(any(target_os = "android", test))]
fn open_disposition(path: &std::path::Path) -> OpenDisposition {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("apk") => OpenDisposition::ApkInstaller,
        _ => OpenDisposition::OpenOrShare,
    }
}

/// THE open boundary: opens (or, on Android, installs) a COMPLETED download
/// artifact.
///
/// This is the single native dispatch of the download-to-open contract
/// (docs/download-open-contract.md): the frontend's `openCompletedArtifact`
/// policy binds this command as its `openPath` dep on EVERY platform. The
/// webview holds no path-opening capability at all - the opener plugin's
/// blanket `open_path` / `reveal_item_in_dir` grants are deliberately
/// absent from the capability file - so the OS is only ever asked from the
/// Rust side, after validation. `path` must be the exact `path` a
/// download-complete event reported; it is resolved through the same
/// completed-artifact registry discipline as the updater's signature
/// verification ([`resolve_completed_artifact`]): session-scoped registry
/// match, no staging names, canonical stability, regular file, committed
/// size. Everything else gets the one uniform
/// [`OPEN_NOT_REGISTERED_REFUSAL`] typed code, so the command is not a
/// filesystem probe and cannot be pointed at arbitrary paths by a
/// compromised webview.
///
/// Per-platform dispatch of a VALIDATED path:
///   - Android: `.apk` artifacts are handed to the system package installer
///     through a FileProvider `content://` URI scoped to this app's
///     `files/Download` directory (`tauri-plugin-fress-open`, Kotlin side
///     `FressOpenPlugin`), with a temporary READ grant only. That intent is
///     Android's standard user-consented install flow - the installer, not
///     Fress, presents the package and enforces the unknown-sources
///     restrictions; nothing here bypasses them. Every other artifact goes
///     to the safe open/share fallback (viewer when one exists, share sheet
///     otherwise), also read-grant only.
///
/// The registry is intentionally in-memory and session-scoped: a panel row
/// restored after an app restart has no record here and is refused with the
/// typed `not-registered` code - persisted (webview-writable) state must
/// never feed a native open. The refusal is the same honest, retryable
/// failure the contract prescribes for every rejected open.
#[tauri::command]
async fn open_downloaded_file(
    app: AppHandle,
    path: String,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    let registry = Arc::clone(registry.inner());
    let (record, canonical, artifact_file) = tokio::task::spawn_blocking(move || {
        resolve_completed_artifact(&registry, &path).map_err(open_boundary_error)
    })
    .await
    .map_err(|e| format!("Open task failed: {e}"))??;
    // The handle proved regular-file + committed-size; the OS interaction
    // below re-reads the path itself, so the handle is released here.
    drop(artifact_file);

    #[cfg(target_os = "android")]
    {
        let disposition = open_disposition(&record.path);
        let target = canonical.to_string_lossy().into_owned();
        match disposition {
            OpenDisposition::ApkInstaller => {
                tauri_plugin_fress_open::FressOpenExt::fress_open(&app).open_apk(&target)
            }
            OpenDisposition::OpenOrShare => {
                tauri_plugin_fress_open::FressOpenExt::fress_open(&app).open_file(&target)
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        // Desktop dispatch of the SAME validated boundary: the opener
        // plugin's Rust API performs the OS-default-handler open. The
        // webview never calls the plugin directly - its capability grants
        // for path operations do not exist.
        let _ = record;
        let _ = &app;
        tauri_plugin_opener::open_path(&canonical, None::<&str>)
            .map_err(|e| format!("Cannot open the file: {e}"))
    }
}

/// Session-scoped set of download directories the user picked in the
/// native dialog this session (frontmost = newest, LRU-capped). In memory
/// only, and rebuilt by the next picker interaction every session: a
/// persisted admission set would let webview-influenced state outlive the
/// process that verified the pick, which the boundary refuses by design.
#[derive(Default)]
struct SessionDownloadDirs(std::sync::Mutex<Vec<PathBuf>>);

/// LRU cap of [`SessionDownloadDirs`]. Growth is bounded by the picker:
/// a folder enters only when the user explicitly picks it.
const SESSION_DIR_CAP: usize = 32;

/// The frontend calls this right after the native folder picker accepts a
/// directory, so "Open folder" and the reveal fallback work for a freshly
/// chosen folder before its first download lands there. Session-scoped
/// admission record - see [`SessionDownloadDirs`]. Every failure is the
/// same generic typed refusal: the command leaks nothing about the
/// filesystem.
#[tauri::command]
fn record_download_directory(
    dir: String,
    session: State<'_, SessionDownloadDirs>,
) -> Result<(), String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err(OPEN_NOT_REGISTERED_REFUSAL.to_string());
    }
    let canon =
        std::fs::canonicalize(trimmed).map_err(|_| OPEN_NOT_REGISTERED_REFUSAL.to_string())?;
    let mut dirs = session.0.lock().expect("session dirs poisoned");
    dirs.retain(|d| d != &canon);
    dirs.insert(0, canon);
    while dirs.len() > SESSION_DIR_CAP {
        dirs.pop();
    }
    Ok(())
}

/// Opens a DOWNLOAD-FOLDER directory - never an arbitrary path. The folder
/// must be the platform default download folder, the parent of a completed
/// artifact this session, or a folder the user picked in the native dialog
/// this session. This is the containing-folder fallback of the reveal
/// action and the "open download folder" affordance; every refusal is the
/// same generic typed code, so the command leaks nothing about
/// unregistered paths.
#[tauri::command]
fn open_download_dir(
    app: AppHandle,
    dir: String,
    registry: State<'_, Arc<DownloadRegistry>>,
    session: State<'_, SessionDownloadDirs>,
) -> Result<(), String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err(OPEN_NOT_REGISTERED_REFUSAL.to_string());
    }
    let canon =
        std::fs::canonicalize(trimmed).map_err(|_| OPEN_NOT_REGISTERED_REFUSAL.to_string())?;
    if !canon.is_dir() {
        return Err(OPEN_NOT_REGISTERED_REFUSAL.to_string());
    }
    let platform_dir = platform_download_dir(&app);
    let default_dir = std::fs::canonicalize(&platform_dir).unwrap_or(platform_dir);
    let admitted = canon == default_dir
        || registry.completed_parent_dirs().iter().any(|d| d == &canon)
        || session
            .0
            .lock()
            .expect("session dirs poisoned")
            .iter()
            .any(|d| d == &canon);
    if !admitted {
        return Err(OPEN_NOT_REGISTERED_REFUSAL.to_string());
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Err("open-artifact/unsupported-platform: revealing a folder is a desktop action".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        tauri_plugin_opener::open_path(canon, None::<&str>)
            .map_err(|e| format!("Cannot open the folder: {e}"))
    }
}

/// Reveals a COMPLETED download in the platform file manager, selected in
/// its folder. The SAME registry discipline as [`open_downloaded_file`]:
/// the exact completion-event path must resolve to a session registry
/// record (canonical stability, regular file, committed size) before the
/// OS is asked for anything. Desktop dispatch only - on Android the typed
/// unsupported-platform refusal keeps the taxonomy honest (the Android
/// adapter's open flow owns the device-side presentation).
#[tauri::command]
async fn reveal_download_file(
    app: AppHandle,
    path: String,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), String> {
    let registry = Arc::clone(registry.inner());
    let (record, canonical, artifact_file) = tokio::task::spawn_blocking(move || {
        resolve_completed_artifact(&registry, &path).map_err(open_boundary_error)
    })
    .await
    .map_err(|e| format!("Reveal task failed: {e}"))??;
    // The handle proved regular-file + committed-size; reveal re-reads the
    // path itself, so the handle is released here.
    drop(artifact_file);
    let _ = record;
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Err("open-artifact/unsupported-platform: revealing is a desktop action".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app;
        app.opener()
            .reveal_item_in_dir(&canonical)
            .map_err(|e| format!("Cannot reveal the file: {e}"))
    }
}

/// Core of `fetch_fdroid_package`, AppHandle-free so the integration
/// harness can drive the exact production path (pass `cache: None`).
async fn fdroid_package(
    pkg: String,
    cache: Option<&api_resilience::CacheStore>,
) -> Result<FdroidPackage, String> {
    let pkg = pkg.trim().to_string();
    if pkg.is_empty() {
        return Err("No F-Droid package configured".into());
    }
    let url = format!("https://f-droid.org/api/v1/packages/{}", pkg);
    let policy = network_policy::UrlPolicy::api_fdroid();
    let url = policy.validate(&url).map_err(|e| e.to_string())?;
    let client = policy.http_client()?;
    // Full resilience contract, cache included (F-Droid serves ETags): the
    // package index is a per-lookup network read on mobile networks, where
    // one dropped request used to fail the Android resolution outright.
    let resolved = api_resilience::get_json_resilient(
        &client,
        url.raw(),
        "F-Droid",
        &api_resilience::Timing::production(),
        cache,
    )
    .await
    .map_err(|e| api_fetch_error_message(e, "F-Droid", "Package not found on F-Droid"))?;
    let body: serde_json::Value =
        serde_json::from_str(&resolved.body).map_err(|e| format!("Bad response: {}", e))?;

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

/// Resolves the suggested stable package version from the F-Droid index.
#[tauri::command]
async fn fetch_fdroid_package(app: AppHandle, pkg: String) -> Result<FdroidPackage, String> {
    let cache = resolver_cache_store(&app);
    fdroid_package(pkg, Some(&cache)).await
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
// On Android the engine commits downloads to `filesDir/Download` - the
// app_data_dir's `files` subtree - because that is exactly the root the
// fress-open plugin's FileProvider scopes (`<files-path path="Download/">`),
// so a completed download can be handed to the installer/share sheet through
// a content:// URI. The `files/` hop matters: app_data_dir itself resolves
// to the app's dataDir root, which the FileProvider deliberately does NOT
// expose.
fn platform_download_dir(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            let downloads = dir.join("files").join("Download");
            if std::fs::create_dir_all(&downloads).is_ok() {
                return downloads;
            }
            // Download/ could not be created - fall back to the filesDir
            // root rather than leaving the app sandbox entirely.
            return dir.join("files");
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
        .plugin(tauri_plugin_fress_open::init())
        .manage(Arc::new(DownloadRegistry::default()))
        .manage(SessionDownloadDirs::default())
        .invoke_handler(tauri::generate_handler![
            start_download,
            cancel_download,
            default_download_dir,
            fetch_latest_release,
            fetch_recent_releases,
            fetch_github_release_doc,
            fetch_fdroid_package,
            fetch_text,
            fetch_self_update_text,
            verify_self_update_signature,
            open_downloaded_file,
            reveal_download_file,
            open_download_dir,
            record_download_directory,
            host_arch,
            artifact_open::launch_app_image_artifact
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
        let policy = network_policy::UrlPolicy::self_update_feed();
        let parsed = policy.validate(url.trim()).map_err(|e| e.to_string())?;
        check_self_update_repo_path(parsed.raw())?;
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
    fn refuses_github_paths_that_normalize_outside_the_repository() {
        // The pin compares the PARSED path, so shapes that normalize to a
        // path outside the repository are refused like any other. Pinned
        // one by one because each bypass was plausible on paper (audit
        // round 2026-10, N-7): what the url crate actually does with dot
        // segments and encoded slashes is load-bearing here.
        for url in [
            // Dot segments resolve during parsing: the prefix is lost.
            "https://github.com/WasewaseX/Fress/../evil/releases.atom",
            // An encoded slash stays encoded, so the literal prefix does
            // not match.
            "https://github.com/WasewaseX/Fress%2F..%2Fevil/releases.atom",
            // A double-slash prefix makes the path start "//WasewaseX",
            // which is not the pinned prefix.
            "https://github.com//WasewaseX/Fress/releases.atom",
            // The path is case-sensitive; a case variant of the repo pin
            // is refused (fail-closed).
            "https://github.com/wasewasex/fress/releases.atom",
        ] {
            assert!(admit(url).is_err(), "must refuse {url}");
        }
        // Positive control: a query or fragment on an in-repo document is
        // still the pinned path and stays admitted.
        admit("https://github.com/WasewaseX/Fress/releases.atom?cache=bust")
            .expect("a query on the pinned path must not refuse");
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

    /// The key id published in `docs/release-readiness.md` (and identical
    /// to the key embedded in `tauri.conf.json`).
    const PUBLISHED_KEY_ID: &str = "5638C68123FB633B";

    #[test]
    fn a_legacy_algorithm_tagged_signature_is_refused_not_accepted() {
        // The legacy (non-prehashed) minisign algorithm must be refused by
        // the boundary, never accepted. The refusal lives inside
        // minisign-verify itself (`verify(_, _, false)` returns
        // UnexpectedAlgorithm for the legacy "Ed" tag; `verify_stream`
        // refuses with UnsupportedLegacyMode), so a dependency upgrade or
        // an accidental allow-legacy could weaken the gate unnoticed.
        // Regression: the genuine fixture signature's prehashed "ED"
        // algorithm tag is flipped to the legacy "Ed" tag (bytes 0..2 of
        // the signature box) - the document stays structurally valid and
        // key-id-correct, and the boundary must still refuse it.
        use base64::Engine as _;
        let document = decode_document_b64(FIXTURE_SIG_B64).expect("fixture signature decodes");
        let lines: Vec<&str> = document.lines().collect();
        assert_eq!(lines.len(), 4, "unexpected fixture shape: {document:?}");
        let (untrusted, box_b64, trusted, global) = (lines[0], lines[1], lines[2], lines[3]);
        assert!(trusted.starts_with("trusted comment: "));
        let mut box_bytes = base64::engine::general_purpose::STANDARD
            .decode(box_b64.trim())
            .expect("the signature box decodes");
        assert_eq!(&box_bytes[0..2], b"ED", "the fixture must be prehashed");
        box_bytes[1] = b'd'; // "ED" -> "Ed": the legacy algorithm tag
        let legacy_box = base64::engine::general_purpose::STANDARD.encode(&box_bytes);
        let legacy_b64 = base64::engine::general_purpose::STANDARD
            .encode(format!("{untrusted}\n{legacy_box}\n{trusted}\n{global}\n").as_bytes());
        let err = verify_signature_document(FIXTURE_KEY_DOC_B64, &legacy_b64, FIXTURE_PAYLOAD)
            .expect_err("a legacy-tagged signature must be refused");
        assert!(
            err.contains("verification failed") && err.contains("algorithm"),
            "unexpected error: {err}"
        );
    }

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

        // A .sig sidecar is refused through the registry scope (no record
        // can ever exist for it - the engine only records committed
        // destinations), which is the same uniform refusal. Pinned so the
        // launcher's name gate and the verifier's scope stay aligned on the
        // full staging-shape set.
        let sig = dir.0.join("Fress-setup.exe.sig");
        std::fs::write(&sig, FIXTURE_SIG_B64).unwrap();
        let err = boundary_verify(&registry, sig.to_string_lossy().as_ref(), FIXTURE_SIG_B64)
            .expect_err("a .sig sidecar must be refused");
        assert!(err.contains(super::VERIFICATION_SCOPE_REFUSAL), "{err}");
    }

    #[test]
    fn a_legacy_algorithm_signature_fails_the_production_streaming_path() {
        // The byte-slice test in self_update_signature_tests proves the
        // non-streaming refusal ("Unexpected signature algorithm"); the
        // PRODUCTION gate is the streaming verifier, whose legacy refusal
        // is a DIFFERENT error on a different code path (verify_stream
        // returns UnsupportedLegacyMode before any byte is hashed). Pin
        // that path too: a structurally valid, key-id-correct document
        // tagged with the legacy "Ed" algorithm must be refused by the
        // registry-bound streaming verifier.
        use base64::Engine as _;
        let dir = TempDir::new("legacy-stream");
        let (registry, path) = registered_artifact(&dir, "Fress-setup.exe");
        let document = decode_document_b64(FIXTURE_SIG_B64).expect("fixture signature decodes");
        let lines: Vec<&str> = document.lines().collect();
        assert_eq!(lines.len(), 4, "unexpected fixture shape: {document:?}");
        let mut box_bytes = base64::engine::general_purpose::STANDARD
            .decode(lines[1].trim())
            .expect("the signature box decodes");
        assert_eq!(&box_bytes[0..2], b"ED", "the fixture must be prehashed");
        box_bytes[1] = b'd'; // "ED" -> "Ed": the legacy algorithm tag
        let legacy_box = base64::engine::general_purpose::STANDARD.encode(&box_bytes);
        let legacy_b64 = base64::engine::general_purpose::STANDARD.encode(
            format!("{}\n{}\n{}\n{}\n", lines[0], legacy_box, lines[2], lines[3]).as_bytes(),
        );
        let err = boundary_verify(&registry, path.to_string_lossy().as_ref(), &legacy_b64)
            .expect_err("the streaming verifier must refuse a legacy-tagged signature");
        assert!(
            err.contains("Cannot start updater signature verification"),
            "unexpected error: {err}"
        );
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

#[cfg(test)]
mod open_boundary_tests {
    // The open boundary shares [`resolve_completed_artifact`] with the
    // signature-verification boundary (whose accept/refuse matrix lives in
    // the self-update and integration tests). These tests pin what the OPEN
    // side adds on top: its own uniform refusal language, the artifact
    // conditions it must refuse before any OS interaction, and the APK
    // disposition classification that decides installer vs open/share.

    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn next_tmp(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fress-open-boundary-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir created");
        dir
    }

    /// Commits `bytes` under `name` and records it in a fresh registry, the
    /// same way the engine does at the end of a successful download.
    fn registered_artifact(
        tag: &str,
        name: &str,
        bytes: &[u8],
    ) -> (DownloadRegistry, PathBuf, PathBuf) {
        let dir = next_tmp(tag);
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("artifact written");
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(7, &path, "https://example.com/app.apk", Some(true));
        (registry, path, dir)
    }

    #[test]
    fn out_of_scope_paths_get_the_one_uniform_refusal() {
        // The three NotInScope shapes - empty, never-registered (missing or
        // present on disk), and staging names - must all render the SAME
        // string, so the refusal can never probe the filesystem for the
        // webview.
        let dir = next_tmp("out-of-scope");
        let unregistered_on_disk = dir.join("innocent.txt");
        std::fs::write(&unregistered_on_disk, b"hello").unwrap();
        let staging = dir.join("innocent.txt.part");
        std::fs::write(&staging, b"hello").unwrap();

        for path in [
            "",
            "/definitely/not/a/download.exe",
            staging.to_str().unwrap(),
            unregistered_on_disk.to_str().unwrap(),
        ] {
            let err = resolve_completed_artifact(&DownloadRegistry::default(), path)
                .expect_err("must refuse");
            assert_eq!(
                open_boundary_error(err),
                OPEN_NOT_REGISTERED_REFUSAL,
                "path: {path}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn registered_artifact_resolves_by_exact_and_folded_path() {
        let (registry, path, dir) =
            registered_artifact("resolve", "tool.apk", b"PK\x03\x04artifact");
        // Exact reported path...
        let (record, canonical, file) =
            resolve_completed_artifact(&registry, path.to_str().unwrap())
                .expect("exact path resolves");
        assert_eq!(record.id, 7);
        assert_eq!(record.url, "https://example.com/app.apk");
        assert_eq!(canonical, record.canonical);
        assert_eq!(file.metadata().unwrap().len(), record.size);
        // ...and the canonical fallback for a `..`-folded variant.
        let folded = dir.join(".").join("tool.apk");
        resolve_completed_artifact(&registry, folded.to_str().unwrap())
            .expect("folded path resolves");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn artifact_gone_from_disk_is_refused() {
        let (registry, path, dir) = registered_artifact("gone", "tool.apk", b"data");
        std::fs::remove_file(&path).unwrap();
        let err = open_boundary_error(
            resolve_completed_artifact(&registry, path.to_str().unwrap()).expect_err("must refuse"),
        );
        assert!(err.starts_with("open-artifact/not-found:"), "{err}");
        assert!(err.contains("download #7"), "{err}");
        assert!(
            err.contains("the download had completed checksum-verified"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn artifact_swapped_for_symlink_is_refused() {
        let (registry, path, dir) = registered_artifact("symlink", "tool.apk", b"data");
        // Re-home the bytes and put a symlink at the committed path: same
        // size, same content, different location - refused. Unix-only
        // because Windows symlinks need a privileged developer mode; the
        // canonical-stability arm is enforced on every platform through
        // resolve_completed_artifact itself, and the gone/replaced/size
        // refusals above carry the cross-platform matrix.
        #[cfg(unix)]
        {
            let elsewhere = dir.join("elsewhere.bin");
            std::fs::write(&elsewhere, b"data").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
            let err = open_boundary_error(
                resolve_completed_artifact(&registry, path.to_str().unwrap())
                    .expect_err("must refuse"),
            );
            assert!(err.starts_with("open-artifact/replaced:"), "{err}");
        }
        #[cfg(not(unix))]
        let _ = (registry, path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn size_change_after_completion_is_refused() {
        let (registry, path, dir) = registered_artifact("size", "tool.apk", b"data");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"-tampered");
        std::fs::write(&path, bytes).unwrap();
        let err = open_boundary_error(
            resolve_completed_artifact(&registry, path.to_str().unwrap()).expect_err("must refuse"),
        );
        assert!(err.starts_with("open-artifact/replaced:"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn non_regular_file_target_is_refused() {
        // A directory can be recorded (the registry stores what the caller
        // reported) but a directory is never an openable artifact. The
        // refusal shape is platform-honest: unix opens the directory and
        // refuses on the metadata (not-a-file); Windows refuses at the open
        // itself (access denied) - both fail closed before any OS
        // interaction, neither is the uniform scope refusal.
        let dir = next_tmp("not-regular");
        let target = dir.join("folder");
        std::fs::create_dir_all(&target).unwrap();
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(3, &target, "https://example.com/x", None);
        let err = open_boundary_error(
            resolve_completed_artifact(&registry, target.to_str().unwrap())
                .expect_err("must refuse"),
        );
        #[cfg(unix)]
        assert_eq!(err, "open-artifact/not-a-file");
        #[cfg(windows)]
        assert!(err.starts_with("Cannot open the downloaded file:"), "{err}");
        #[cfg(not(any(unix, windows)))]
        let _ = err;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apk_extension_selects_the_installer_disposition() {
        for name in ["app.apk", "APP.APK", "App.Apk"] {
            assert_eq!(
                open_disposition(Path::new(name)),
                OpenDisposition::ApkInstaller,
                "{name}"
            );
        }
        for name in [
            "app.apk.sig",
            "app.zip",
            "app.tar.gz",
            "app",
            "app.exe",
            "backup.apks",
        ] {
            assert_eq!(
                open_disposition(Path::new(name)),
                OpenDisposition::OpenOrShare,
                "{name}"
            );
        }
    }

    #[test]
    fn verification_boundary_wording_is_unchanged_through_the_shared_resolver() {
        // The extraction must not have moved the verification boundary's
        // observable behavior: an unregistered path still yields exactly
        // VERIFICATION_SCOPE_REFUSAL through the shared resolver.
        let dir = next_tmp("verify-wording");
        let unregistered = dir.join("tool.exe");
        std::fs::write(&unregistered, b"x").unwrap();
        for path in ["", unregistered.to_str().unwrap()] {
            let err = resolve_completed_artifact(&DownloadRegistry::default(), path)
                .expect_err("must refuse");
            assert_eq!(verification_boundary_error(err), VERIFICATION_SCOPE_REFUSAL);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
