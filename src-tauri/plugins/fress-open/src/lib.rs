// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
//! # fress-open
//!
//! Fress's validated native open boundary for completed downloads.
//!
//! The plugin has TWO halves with a hard wall between them:
//!
//! - The **webview never talks to this plugin.** There are no plugin commands
//!   (empty command list in `build.rs`), no ACL permissions, no JS bindings.
//!   The only caller is the app's own `open_downloaded_file` command in
//!   `src-tauri/src/lib.rs`, which first proves the requested path is a
//!   completed download artifact recorded by the download engine in this app
//!   session (the same registry discipline as the updater's signature
//!   verification boundary).
//!
//! - The **native half** turns a validated path into an OS interaction:
//!   - `open_apk`: a `content://` FileProvider URI scoped to the app's
//!     `files/Download` directory, handed to `ACTION_VIEW` with the
//!     `application/vnd.android.package-archive` MIME type and
//!     `FLAG_GRANT_READ_URI_PERMISSION`. This is Android's normal package
//!     installer flow: the installer, not Fress, shows the install consent
//!     and enforces the unknown-sources restrictions. Fress never touches
//!     `PackageInstaller` internals, never requests silent install, and the
//!     declared `REQUEST_INSTALL_PACKAGES` permission only makes the
//!     STANDARD consent flow reachable for the calling app.
//!   - `open_file`: a safe fallback for every other validated file - open by
//!     MIME type when a viewer exists, otherwise a share chooser. Read
//!     grant only, temporary, never write.
//!
//! Desktop builds compile this crate to a no-op state object: the app's
//! `open_downloaded_file` routes desktop opens through the opener plugin's
//! Rust API after the same registry validation, and never reaches here.

use serde::Serialize;
// `Manager` powers the app.manage() call in the plugin setup below.
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.fress.open";

/// The arguments both Kotlin commands accept. Exactly one field, `path`, and
/// it always carries the validated absolute path of a completed download.
/// Desktop builds never reach the android-only methods that use it, hence
/// the quiet dead-code allowance there.
#[derive(Serialize)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct OpenArgs<'a> {
    path: &'a str,
}

/// The handle the app uses to reach the native commands. On desktop the
/// plugin manages an inert instance; every method returns a clear
/// unsupported error so a routing mistake cannot fall through to an
/// unvalidated open.
pub struct FressOpen<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> FressOpen<R> {
    /// Installs a completed, registry-validated APK through the system
    /// package installer (Android only).
    #[cfg(target_os = "android")]
    pub fn open_apk(&self, path: &str) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("openApk", OpenArgs { path })
            .map_err(|e| format!("Cannot open the APK installer: {e}"))
    }

    /// Opens (or offers to share) a completed, registry-validated non-APK
    /// download (Android only).
    #[cfg(target_os = "android")]
    pub fn open_file(&self, path: &str) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("openFile", OpenArgs { path })
            .map_err(|e| format!("Cannot open the file: {e}"))
    }

    #[cfg(not(target_os = "android"))]
    pub fn open_apk(&self, _path: &str) -> Result<(), String> {
        Err("unsupported platform".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub fn open_file(&self, _path: &str) -> Result<(), String> {
        Err("unsupported platform".to_string())
    }
}

/// Extensions to [`tauri::Manager`] to access the plugin's handle from the
/// app layer.
pub trait FressOpenExt<R: Runtime> {
    fn fress_open(&self) -> &FressOpen<R>;
}

impl<R: Runtime, T: tauri::Manager<R>> FressOpenExt<R> for T {
    fn fress_open(&self) -> &FressOpen<R> {
        self.state::<FressOpen<R>>().inner()
    }
}

/// Initializes the plugin. Registers the Kotlin side on Android only; the
/// managed [`FressOpen`] state exists on every platform so the app layer can
/// call it uniformly and get a typed "unsupported" on desktop.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("fress-open")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "FressOpenPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;

            app.manage(FressOpen {
                #[cfg(target_os = "android")]
                handle,
                #[cfg(not(target_os = "android"))]
                _marker: std::marker::PhantomData::<fn() -> R>,
            });
            Ok(())
        })
        .build()
}
