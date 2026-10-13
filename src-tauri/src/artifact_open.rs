// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
//! The one desktop behavior the opener plugin cannot provide: launching a
//! completed Linux AppImage.
//!
//! The download manager's "Open" action hands the finished file to the host
//! OS through the opener plugin's `open_path` FIRST - the OS association is
//! the correct authority for Windows exe/msi/zip, macOS dmg/pkg and Linux
//! deb/rpm, and it keeps Gatekeeper/UAC/package-manager checks in force.
//! Stock Linux desktops, however, ship no AppImage MIME handler, and a
//! freshly downloaded AppImage carries no execute bit - so for that ONE
//! class the plugin's open is refused, and THIS command is the fallback the
//! frontend retries with. The command deliberately refuses everything else:
//! it is not a general-purpose "launch arbitrary local programs" API and it
//! never constructs a shell command.
//!
//! Android needs a different native adaptation (FileProvider content URIs
//! and the APK handoff to the system package installer). That lives in the
//! Android adapter's own native source, BELOW the same `open_path` boundary
//! the frontend calls - this module contains nothing platform-Android.
//!
//! # The boundary
//!
//! 1. **Staging shapes are never openable** - a `.part` staging file, its
//!    `.part.meta` validator sidecar, or a `.sig` signature document is
//!    refused by name before anything touches the filesystem (defense in
//!    depth: the engine never records one as completed).
//! 2. **Traversal targets are refused** - any path with a `..` component is
//!    rejected regardless of what exists there.
//! 3. **Existence + shape at action time** - the artifact must currently be
//!    a regular file (`symlink_metadata`, so an unexpected symbolic link is
//!    refused rather than followed) - a deleted, moved, replaced or
//!    never-finished download is a typed refusal, not a launch.
//! 4. **The privileged launch is registry-bound** - the path must match a
//!    completed-artifact record left by the engine's commit path (see
//!    `download_finalize.rs`, "Completed-artifact registry") AND the
//!    record's download id must be the id the caller claims, AND the file
//!    must still sit at the canonical location the engine committed and
//!    keep the committed size. A restored-after-restart row (which has no
//!    engine id and no registry record) can still be revealed in the
//!    folder, but it is never auto-launched: that request cannot prove it
//!    refers to bytes the engine finished, so it fails closed with a typed
//!    refusal.
//!
//! The frontend correlation (which row's Open was pressed) is preserved
//! end to end: the action is invoked with the download id AND the exact
//! final path the completion event delivered for THAT id, and the registry
//! comparison refuses a cross-wired pair.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::download_finalize::DownloadRegistry;

// ---------------------------------------------------------------------------
// Typed rejections
// ---------------------------------------------------------------------------

/// Every refusal the boundary can produce. The frontend maps each code to a
/// localized message; the optional detail (a short native sentence - never a
/// stack trace) is for developer diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenRejection {
    /// Staging file, validator sidecar, signature document, empty name or a
    /// traversal target: not a completed artifact by construction.
    NotArtifact,
    /// The file is gone (deleted, moved, or never finished committing).
    NotFound { detail: String },
    /// The path exists but is not a regular file (directory, socket, ...).
    NotAFile,
    /// The path is a symbolic link - never followed by the opening layer.
    Symlink,
    /// Privileged AppImage launch without a matching completed-artifact
    /// record (unregistered path, or a restored-after-restart row).
    NotRegistered,
    /// The registered record belongs to a DIFFERENT download id: the call
    /// tried to cross-wire two downloads.
    IdMismatch,
    /// The artifact changed after completion (moved or resized).
    ReplacedOnDisk,
    /// The request is not this command's business (a non-AppImage artifact
    /// stays with the opener plugin's OS-associated open).
    UnsupportedPlatform,
    /// Unexpected internal failure (never leaks file contents).
    Internal(String),
}

impl OpenRejection {
    /// The machine-readable code the frontend switches on.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            OpenRejection::NotArtifact => "not-artifact",
            OpenRejection::NotFound { .. } => "not-found",
            OpenRejection::NotAFile => "not-a-file",
            OpenRejection::Symlink => "symlink",
            OpenRejection::NotRegistered => "not-registered",
            OpenRejection::IdMismatch => "id-mismatch",
            OpenRejection::ReplacedOnDisk => "replaced",
            OpenRejection::UnsupportedPlatform => "unsupported-platform",
            OpenRejection::Internal(_) => "internal",
        }
    }

    /// Short diagnostic sentence (or empty). One line, no paths of OTHER
    /// downloads, no stack traces.
    pub(crate) fn detail(&self) -> String {
        match self {
            OpenRejection::NotFound { detail } => detail.clone(),
            OpenRejection::Internal(e) => e.clone(),
            _ => String::new(),
        }
    }

    /// The error string the frontend receives: `open-artifact/<code>` plus
    /// the optional detail. The prefix makes the typed parsing unambiguous
    /// next to the opener plugin's plain error strings.
    pub(crate) fn render(&self) -> String {
        let detail = self.detail();
        if detail.is_empty() {
            format!("open-artifact/{}", self.code())
        } else {
            format!("open-artifact/{}: {}", self.code(), detail)
        }
    }
}

// ---------------------------------------------------------------------------
// The launch plan
// ---------------------------------------------------------------------------

/// What the boundary decided should happen to the validated artifact. The
/// only route this command serves is the direct, registry-validated
/// AppImage launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenRoute {
    /// Launch the registry-validated AppImage directly (chmod +x restricted
    /// to this file, then exec, no shell). The expected canonical location
    /// and committed size travel with the plan so [`launch_app_image`] can
    /// re-check them at the instant of the spawn - plan and launch are two
    /// instants, and the file must be the engine's bytes at BOTH.
    LaunchAppImage {
        path: PathBuf,
        expected_size: u64,
        expected_canonical: PathBuf,
    },
}

/// Name gates shared by every request. Returns `Err` for anything that is
/// not a plausible completed artifact by construction.
fn reject_unopenable_name(path: &Path) -> Result<String, OpenRejection> {
    let trimmed = path.to_string_lossy().trim().to_string();
    if trimmed.is_empty() {
        return Err(OpenRejection::NotArtifact);
    }
    let checked = Path::new(&trimmed);
    // Directory traversal targets are refused before any filesystem touch:
    // an open request never gets to smuggle a location outside the download
    // tree through a crafted relative path.
    for component in checked.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(OpenRejection::NotArtifact);
        }
    }
    let name = checked
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or(OpenRejection::NotArtifact)?;
    // Staging file, validator sidecar, signature document. The engine never
    // records any of these as completed; the gate is defense in depth and
    // documents the intent.
    let lower = name.to_lowercase();
    if lower.ends_with(".part") || lower.ends_with(".part.meta") || lower.ends_with(".sig") {
        return Err(OpenRejection::NotArtifact);
    }
    Ok(name)
}

/// Shape gate at action time: the artifact must CURRENTLY be a regular file
/// (`symlink_metadata` - a symlink is refused, not followed).
fn require_regular_file(path: &Path) -> Result<std::fs::Metadata, OpenRejection> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| OpenRejection::NotFound {
        detail: "the downloaded file is no longer on disk".to_string(),
    })?;
    if meta.file_type().is_symlink() {
        return Err(OpenRejection::Symlink);
    }
    if !meta.is_file() {
        return Err(OpenRejection::NotAFile);
    }
    Ok(meta)
}

/// The Linux AppImage extension test, case-insensitive.
fn is_app_image(name: &str) -> bool {
    name.to_lowercase().ends_with(".appimage")
}

/// Decides what happens to a launch request. Pure and synchronous so the
/// whole boundary is unit-testable without launching anything.
///
/// The command only serves `.AppImage` targets: every other artifact is
/// opened by the opener plugin from the frontend (OS association;
/// unchanged authority), so a request for one here is refused.
pub(crate) fn plan_open(
    registry: &DownloadRegistry,
    id: i64,
    requested_path: &str,
) -> Result<OpenRoute, OpenRejection> {
    let path = Path::new(requested_path.trim());
    let name = reject_unopenable_name(path)?;
    require_regular_file(path)?;

    if !is_app_image(&name) {
        return Err(OpenRejection::UnsupportedPlatform);
    }

    // ---- Privileged route: launch the AppImage ---------------------------
    // Requires the engine's own completion record for the EXACT path, bound
    // to the caller's download id, and the file must still be the bytes the
    // engine committed.

    // A restored row has a negative local id and no engine identity: it
    // cannot prove the path still refers to engine-committed bytes. Fail
    // closed (the row keeps Show in folder).
    if id < 0 {
        return Err(OpenRejection::NotRegistered);
    }
    let record = registry
        .completed_artifact_for_path(path)
        .ok_or(OpenRejection::NotRegistered)?;
    // The id is an i64 across the IPC bridge but a u32 in the registry: an
    // out-of-range value must refuse, not truncate (2^32 + 42 used to alias
    // to record 42 and PASS this check). Negative ids were refused above,
    // so only the > u32::MAX half can get here.
    let id = u32::try_from(id).map_err(|_| OpenRejection::NotRegistered)?;
    if record.id != id {
        return Err(OpenRejection::IdMismatch);
    }
    // Canonical stability (mirrors the signature verifier): the artifact
    // must still sit where the engine committed it.
    let current = std::fs::canonicalize(&record.path).map_err(|_| OpenRejection::NotFound {
        detail: "the downloaded file is no longer on disk".to_string(),
    })?;
    if current != record.canonical {
        return Err(OpenRejection::ReplacedOnDisk);
    }
    // The committed size is a cheap post-completion replacement detector.
    let meta = require_regular_file(&current)?;
    if meta.len() != record.size {
        return Err(OpenRejection::ReplacedOnDisk);
    }

    Ok(OpenRoute::LaunchAppImage {
        path: record.path.clone(),
        expected_size: record.size,
        expected_canonical: record.canonical.clone(),
    })
}

// ---------------------------------------------------------------------------
// The AppImage launcher (the only place Fress sets an execute bit)
// ---------------------------------------------------------------------------

/// Launches a registry-validated AppImage.
///
/// The execute bit is a consequence of THIS explicit user action on THIS
/// validated file only - never granted to downloads in general. The process
/// is spawned directly (`Command::new(path)` - argv, no shell), detached
/// from the UI, and reaped in the background so Fress exit cannot kill it
/// and running it cannot leave a zombie behind.
#[cfg(target_os = "linux")]
pub(crate) fn launch_app_image(
    path: &Path,
    expected_size: u64,
    expected_canonical: &Path,
) -> Result<(), OpenRejection> {
    use std::os::unix::fs::PermissionsExt;

    // Re-check at launch time (the plan and the launch are two instants):
    // shape, canonical location and committed size in one breath, so a file
    // swapped between plan_open and here is not exec'd. The kernel still
    // re-resolves the path at spawn, so a same-user racer with write access
    // to this directory has a theoretical window after these checks; that
    // actor could exec the file directly anyway, and closing it fully would
    // need /proc/self/fd exec tricks not worth the surface they add.
    let meta = require_regular_file(path)?;
    let current = std::fs::canonicalize(path).map_err(|_| OpenRejection::NotFound {
        detail: "the downloaded file is no longer on disk".to_string(),
    })?;
    if current != expected_canonical || meta.len() != expected_size {
        return Err(OpenRejection::ReplacedOnDisk);
    }

    let mut permissions = meta.permissions();
    if permissions.mode() & 0o111 == 0 {
        permissions.set_mode(permissions.mode() | 0o100);
        std::fs::set_permissions(path, permissions).map_err(|e| {
            OpenRejection::Internal(format!("cannot mark the file executable: {e}"))
        })?;
    }

    let child = std::process::Command::new(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| OpenRejection::Internal(format!("cannot launch the AppImage: {e}")))?;

    // Reap in the background: the launcher process must not become a zombie
    // attached to Fress, and Fress quitting must not matter to it.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Launches a completed AppImage download after the OS-associated open was
/// REFUSED (no handler on stock desktops, no execute bit).
///
/// Inputs (bound by the frontend to one download row):
///   - `id`: the download id from the completion event. Restored rows carry
///     a negative local id (no engine identity survives a restart).
///   - `path`: the EXACT `path` the completion event delivered for that id.
///
/// Errors are typed (`open-artifact/<code>: detail`) so the UI can explain
/// what to do next without pretending the launch succeeded. The command is
/// deliberately AppImage-only: nothing here can become a shell-execution
/// bridge for arbitrary files, names or URLs.
#[tauri::command]
pub(crate) async fn launch_app_image_artifact(
    registry: State<'_, std::sync::Arc<DownloadRegistry>>,
    id: i64,
    path: String,
) -> Result<(), String> {
    let registry = std::sync::Arc::clone(registry.inner());

    // Filesystem introspection runs off the async runtime (multi-hundred-MB
    // artifacts live on slow disks; nothing here is async-bridged).
    let planned = tokio::task::spawn_blocking(move || plan_open(&registry, id, &path))
        .await
        .map_err(|e| OpenRejection::Internal(format!("open task failed: {e}")))
        .and_then(|inner| inner)
        .map_err(|rej| rej.render())?;

    match planned {
        #[cfg(target_os = "linux")]
        OpenRoute::LaunchAppImage {
            path,
            expected_size,
            expected_canonical,
        } => tokio::task::spawn_blocking(move || {
            launch_app_image(&path, expected_size, &expected_canonical)
        })
        .await
        .map_err(|e| OpenRejection::Internal(format!("open task failed: {e}")))
        .and_then(|inner| inner)
        .map_err(|rej| rej.render()),
        #[cfg(not(target_os = "linux"))]
        OpenRoute::LaunchAppImage { .. } => Err(OpenRejection::UnsupportedPlatform.render()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download_finalize::DownloadRegistry;

    /// Unique temp dir per test (no tempfile dependency; mirrors the
    /// download_integration test style).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "fress-open-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&base).unwrap();
            TempDir(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn register(registry: &DownloadRegistry, id: u32, path: &Path) {
        registry.record_completed_artifact(id, path, "https://example.com/a", Some(true));
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
    }

    fn write_len(path: &Path) -> u64 {
        std::fs::metadata(path).unwrap().len()
    }

    // ---- Name gates ------------------------------------------------------

    #[test]
    fn staging_files_and_sidecars_are_never_openable() {
        let registry = DownloadRegistry::default();
        for name in [
            "setup.exe.part",
            "setup.exe.part.meta",
            "Fress_1.0.AppImage.sig",
            "SETUP.EXE.PART", // case-insensitive
        ] {
            let route = plan_open(&registry, 1, &format!("/tmp/downloads/{name}"));
            assert_eq!(route.unwrap_err(), OpenRejection::NotArtifact, "{name}");
        }
    }

    #[test]
    fn traversal_targets_are_refused_before_any_filesystem_touch() {
        let registry = DownloadRegistry::default();
        for candidate in [
            "/home/user/Downloads/../secret.AppImage",
            "downloads/../../etc/passwd",
            "/tmp/a/..",
        ] {
            let route = plan_open(&registry, 1, candidate);
            assert_eq!(
                route.unwrap_err(),
                OpenRejection::NotArtifact,
                "{candidate}"
            );
        }
    }

    #[test]
    fn empty_and_nameless_requests_are_refused() {
        let registry = DownloadRegistry::default();
        assert_eq!(
            plan_open(&registry, 1, "   ").unwrap_err(),
            OpenRejection::NotArtifact
        );
        // A path with no file-name component (the filesystem root).
        assert_eq!(
            plan_open(&registry, 1, "/").unwrap_err(),
            OpenRejection::NotArtifact
        );
    }

    // ---- Existence and shape at action time ------------------------------

    #[test]
    fn a_missing_file_is_rejected_cleanly() {
        let registry = DownloadRegistry::default();
        let route = plan_open(&registry, 1, "/nonexistent/dir/App.AppImage");
        match route.unwrap_err() {
            OpenRejection::NotFound { .. } => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_directory_is_rejected_as_not_a_file() {
        let dir = TempDir::new("dir-reject");
        let target = dir.path().join("folder.AppImage");
        std::fs::create_dir_all(&target).unwrap();
        let route = plan_open(&DownloadRegistry::default(), 1, target.to_str().unwrap());
        assert_eq!(route.unwrap_err(), OpenRejection::NotAFile);
    }

    #[cfg(unix)]
    #[test]
    fn an_unexpected_symbolic_link_is_never_followed() {
        let dir = TempDir::new("symlink-reject");
        let real = dir.path().join("real.bin");
        write(&real, b"payload");
        let link = dir.path().join("App.AppImage");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let route = plan_open(&DownloadRegistry::default(), 1, link.to_str().unwrap());
        assert_eq!(route.unwrap_err(), OpenRejection::Symlink);
    }

    // ---- Desktop routing: only AppImages are this command's business -----

    #[test]
    fn desktop_non_appimage_artifacts_stay_with_the_opener_plugin() {
        let dir = TempDir::new("desktop-other");
        let exe = dir.path().join("Setup (x64).exe");
        write(&exe, b"mz");
        let route = plan_open(&DownloadRegistry::default(), 1, exe.to_str().unwrap());
        assert_eq!(route.unwrap_err(), OpenRejection::UnsupportedPlatform);
    }

    #[test]
    fn apk_requests_are_also_not_this_commands_business() {
        // The APK handoff is the Android adapter's native scope, below the
        // open_path boundary; this desktop command refuses APKs like any
        // other non-AppImage artifact.
        let dir = TempDir::new("desktop-apk");
        let apk = dir.path().join("F-Droid.apk");
        write(&apk, b"apk");
        let route = plan_open(&DownloadRegistry::default(), 7, apk.to_str().unwrap());
        assert_eq!(route.unwrap_err(), OpenRejection::UnsupportedPlatform);
    }

    // ---- The privileged AppImage route is registry-bound -----------------

    #[test]
    fn registered_appimage_with_matching_id_routes_to_launch() {
        let dir = TempDir::new("appimage-ok");
        let app = dir.path().join("Bitwarden-2025.1.0-x86_64.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 42, &app);

        let route = plan_open(&registry, 42, app.to_str().unwrap()).unwrap();
        assert_eq!(
            route,
            OpenRoute::LaunchAppImage {
                path: app.clone(),
                expected_size: 3,
                expected_canonical: std::fs::canonicalize(&app).unwrap(),
            }
        );
    }

    #[test]
    fn an_id_above_u32_max_does_not_alias_to_a_real_record() {
        // The id crosses the IPC bridge as i64 but lives in the registry as
        // u32: a truncated cast used to let 2^32 + 42 alias to record 42 and
        // PASS the id binding. The try_from gate refuses it instead - an id
        // that large cannot exist, so the caller learns not-registered.
        let dir = TempDir::new("appimage-alias");
        let app = dir.path().join("alias.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 42, &app);

        let aliased = i64::from(u32::MAX) + 42;
        let err = plan_open(&registry, aliased, app.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::NotRegistered);
    }

    #[test]
    fn appimage_extension_match_is_case_insensitive() {
        let dir = TempDir::new("appimage-case");
        let app = dir.path().join("tool.APPIMAGE");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 3, &app);
        assert!(matches!(
            plan_open(&registry, 3, app.to_str().unwrap()).unwrap(),
            OpenRoute::LaunchAppImage { .. }
        ));
    }

    #[test]
    fn an_unregistered_path_is_refused_for_launch() {
        let dir = TempDir::new("appimage-unreg");
        let app = dir.path().join("unregistered.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        // A DIFFERENT download completed (the record points elsewhere).
        let other = dir.path().join("other.AppImage");
        write(&other, b"elf");
        register(&registry, 1, &other);

        let err = plan_open(&registry, 1, app.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::NotRegistered);
    }

    #[test]
    fn a_restored_after_restart_row_is_never_auto_launched() {
        let dir = TempDir::new("appimage-restored");
        let app = dir.path().join("old.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        // The SAME path is even registered - but from a NEWER download (id 9);
        // the restored row claims the old negative id.
        register(&registry, 9, &app);
        let err = plan_open(&registry, -1, app.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::NotRegistered);
    }

    #[test]
    fn cross_wiring_two_downloads_is_refused() {
        let dir = TempDir::new("appimage-mismatch");
        let a = dir.path().join("a.AppImage");
        let b = dir.path().join("b.AppImage");
        write(&a, b"elf-a");
        write(&b, b"elf-b");
        let registry = DownloadRegistry::default();
        register(&registry, 11, &a);
        register(&registry, 12, &b);

        // Row 11 asking to open b's artifact: refused.
        let err = plan_open(&registry, 11, b.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::IdMismatch);
        // And the matching pair still routes.
        assert!(matches!(
            plan_open(&registry, 12, b.to_str().unwrap()).unwrap(),
            OpenRoute::LaunchAppImage { .. }
        ));
    }

    #[test]
    fn a_deleted_after_completion_appimage_is_reported_gone() {
        let dir = TempDir::new("appimage-deleted");
        let app = dir.path().join("gone.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 5, &app);
        std::fs::remove_file(&app).unwrap();

        match plan_open(&registry, 5, app.to_str().unwrap()).unwrap_err() {
            OpenRejection::NotFound { .. } => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_truncated_or_replaced_appimage_is_refused_as_replaced() {
        let dir = TempDir::new("appimage-drift");
        let app = dir.path().join("drift.AppImage");
        write(&app, b"elf-bytes-here");
        let registry = DownloadRegistry::default();
        register(&registry, 6, &app);
        write(&app, b"elf"); // same path, different size

        let err = plan_open(&registry, 6, app.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::ReplacedOnDisk);
    }

    #[test]
    fn filenames_with_spaces_unicode_and_parentheses_route_exactly() {
        let dir = TempDir::new("appimage-names");
        let weird = dir.path().join("Программа (beta) - v1.2 (1).AppImage");
        write(&weird, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 77, &weird);

        // The route carries the EXACT path the completion event reported.
        let route = plan_open(&registry, 77, weird.to_str().unwrap()).unwrap();
        assert_eq!(
            route,
            OpenRoute::LaunchAppImage {
                path: weird.clone(),
                expected_size: write_len(&weird),
                expected_canonical: std::fs::canonicalize(&weird).unwrap(),
            }
        );
    }

    #[test]
    fn the_record_cap_eviction_keeps_the_boundary_honest() {
        // After COMPLETED_RECORD_CAP completions the oldest record is gone;
        // a row still holding that id must be refused (not-registered), not
        // silently launched.
        let dir = TempDir::new("appimage-cap");
        let app = dir.path().join("capped.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        register(&registry, 1, &app);
        // Record 40 more downloads (cap is 32, so id 1's record is evicted).
        for i in 0..40u32 {
            let p = dir.path().join(format!("fill-{i}.AppImage"));
            write(&p, b"elf");
            register(&registry, 100 + i, &p);
        }
        let err = plan_open(&registry, 1, app.to_str().unwrap()).unwrap_err();
        assert_eq!(err, OpenRejection::NotRegistered);
    }

    // ---- Rejection rendering (the frontend contract) ----------------------

    #[test]
    fn rejections_render_as_typed_open_artifact_codes() {
        assert_eq!(
            OpenRejection::NotArtifact.render(),
            "open-artifact/not-artifact"
        );
        assert_eq!(
            OpenRejection::NotFound {
                detail: "the downloaded file is no longer on disk".into()
            }
            .render(),
            "open-artifact/not-found: the downloaded file is no longer on disk"
        );
        assert_eq!(
            OpenRejection::IdMismatch.render(),
            "open-artifact/id-mismatch"
        );
        assert_eq!(OpenRejection::Symlink.render(), "open-artifact/symlink");
        assert_eq!(
            OpenRejection::Internal("spawn failed: boom".into()).render(),
            "open-artifact/internal: spawn failed: boom"
        );
    }

    #[test]
    fn completion_records_carry_their_provenance_for_diagnostics() {
        // The registered artifact carries the engine's own verdicts; a
        // diagnostic can distinguish "checksummed" from "merely completed"
        // and show the source, without exposing anything else on disk.
        let dir = TempDir::new("appimage-provenance");
        let app = dir.path().join("signed.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(13, &app, "https://example.com/s", None);
        let record = registry
            .completed_artifact_for_path(&app)
            .expect("record exists");
        assert_eq!(record.id, 13);
        assert_eq!(record.checksum_verified, None);
        assert_eq!(record.url, "https://example.com/s");
        assert_eq!(record.path, app);
        assert_eq!(record.size, 3);
    }

    #[test]
    fn checksum_verified_records_launch_with_provenance_intact() {
        let dir = TempDir::new("appimage-provenance-2");
        let app = dir.path().join("checksummed.AppImage");
        write(&app, b"elf");
        let registry = DownloadRegistry::default();
        registry.record_completed_artifact(14, &app, "https://example.com/c", Some(true));
        assert!(matches!(
            plan_open(&registry, 14, app.to_str().unwrap()).unwrap(),
            OpenRoute::LaunchAppImage { .. }
        ));
    }

    // ---- Launch-time recheck (plan and launch are two instants) ----------

    #[cfg(target_os = "linux")]
    #[test]
    fn a_size_drift_between_plan_and_launch_is_refused() {
        // The plan validated the committed size; the file was replaced at
        // the same location before the launch. The launcher's own recheck
        // must refuse before any chmod or spawn.
        let dir = TempDir::new("appimage-size-drift");
        let app = dir.path().join("drift.AppImage");
        write(&app, b"elf-bytes");
        let canonical = std::fs::canonicalize(&app).unwrap();
        let err = launch_app_image(&app, 999, &canonical)
            .err()
            .expect("a size drift must be refused");
        assert_eq!(err, OpenRejection::ReplacedOnDisk);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_canonical_drift_between_plan_and_launch_is_refused() {
        // Same shape: the expected canonical location no longer matches the
        // file at the requested path (replaced/moved/swapped). Refused.
        let dir = TempDir::new("appimage-canonical-drift");
        let app = dir.path().join("cswap.AppImage");
        write(&app, b"elf-bytes");
        let elsewhere = dir.path().join("elsewhere.AppImage");
        write(&elsewhere, b"other-elf");
        let err = launch_app_image(&app, 9, &std::fs::canonicalize(&elsewhere).unwrap())
            .err()
            .expect("a canonical drift must be refused");
        assert_eq!(err, OpenRejection::ReplacedOnDisk);
    }
}
