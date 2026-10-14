// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Build script for the Fress open plugin. The empty command list is deliberate:
// the plugin exposes NO commands to the webview. It is an internal native bridge
// the app's own `open_downloaded_file` command calls after the download-registry
// validation has passed, so there is no guest-facing surface to scope and no
// permissions to grant in capabilities.
//
// `android_path("android")` is what wires the Kotlin side into the app's gradle
// build: the helper emits `cargo:android_library_path=<this crate>/android`, the
// app crate's build script picks it up through the `DEP_*_ANDROID_LIBRARY_PATH`
// channel and the generated gradle project includes this folder as a library
// module - which is also what merges this plugin's AndroidManifest.xml (the
// installer permission) into the final APK.
//
// The build script also patches the GENERATED app project's FileProvider paths
// file (see `patch_generated_file_paths` below): the app template already owns
// the `androidx.core.content.FileProvider` declaration, and the open boundary
// needs its `content://` roots to cover the engine's downloads directory.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();

    patch_generated_file_paths();

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let mobile = target_os == "ios" || target_os == "android";
    alias("desktop", !mobile);
    alias("mobile", mobile);
}

// creates a cfg alias if `has_feature` is true.
// `alias` must be a snake case string.
fn alias(alias: &str, has_feature: bool) {
    println!("cargo:rustc-check-cfg=cfg({alias})");
    if has_feature {
        println!("cargo:rustc-cfg={alias}");
    }
}

/// Marker comment + entry inserted into the generated
/// `gen/android/app/src/main/res/xml/file_paths.xml`. Idempotent: the patch
/// is recognized by the marker and re-applied only when absent, so repeated
/// builds (and release CI's fresh `tauri android init`) converge.
const DOWNLOADS_PATH_MARKER: &str = "fress-open downloads entry";
const DOWNLOADS_PATH_ENTRY: &str =
    "    <!-- BEGIN fress-open downloads entry -->\n    <files-path name=\"fress_downloads\" path=\"Download/\" />\n    <!-- END fress-open downloads entry -->";

/// Adds the engine's downloads directory (`filesDir/Download`) to the
/// FileProvider roots the Tauri app template generates.
///
/// Why patch instead of declaring the paths in the plugin: the provider is
/// declared by the generated app manifest with the app's `@xml/file_paths`
/// resource. A second provider in the plugin manifest collides in the
/// manifest merger, and a plugin resource named `file_paths.xml` would be
/// silently shadowed by the app module (app resources beat library
/// resources). Patching the generated file is idempotent and works in
/// release CI, where `tauri android init` regenerates `gen/android` from
/// scratch before every build.
///
/// The patch only ever ADDS a scoped `<files-path>` root for the engine's
/// own download directory - it never widens an existing root. If the app
/// project ever stops declaring the FileProvider (template drift), the
/// Kotlin side fails closed at `FileProvider.getUriForFile` and this script
/// prints a loud warning instead of guessing.
fn patch_generated_file_paths() {
    let Ok(project_path) = std::env::var("TAURI_ANDROID_PROJECT_PATH") else {
        // Not a Tauri android build (plain cargo build, desktop target):
        // the generated project does not exist and nothing needs patching.
        return;
    };
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    let paths_file =
        std::path::Path::new(&project_path).join("app/src/main/res/xml/file_paths.xml");
    let Ok(existing) = std::fs::read_to_string(&paths_file) else {
        println!(
            "cargo:warning=fress-open: the generated app FileProvider paths file is missing at {} - APK installs will fail closed until it exists",
            paths_file.display()
        );
        return;
    };
    // A fresh `tauri android init` regenerates this file without the patch;
    // tie the build script's reruns to it so the entry is always re-applied.
    println!("cargo:rerun-if-changed={}", paths_file.display());

    // Provider sanity check: the generated app manifest must declare the
    // FileProvider this boundary hands URIs through.
    let manifest_file =
        std::path::Path::new(&project_path).join("app/src/main/AndroidManifest.xml");
    if let Ok(manifest) = std::fs::read_to_string(&manifest_file) {
        if !manifest.contains("androidx.core.content.FileProvider") {
            println!(
                "cargo:warning=fress-open: the generated app manifest declares no androidx.core.content.FileProvider - APK installs will fail closed at FileProvider.getUriForFile"
            );
        }
    }

    if existing.contains(DOWNLOADS_PATH_MARKER) {
        return;
    }
    let Some(insert_at) = existing.find("</paths>") else {
        println!(
            "cargo:warning=fress-open: unexpected file_paths.xml shape (no </paths> root) at {} - leaving it untouched",
            paths_file.display()
        );
        return;
    };
    let mut patched = String::with_capacity(existing.len() + DOWNLOADS_PATH_ENTRY.len());
    patched.push_str(&existing[..insert_at]);
    patched.push_str(DOWNLOADS_PATH_ENTRY);
    patched.push('\n');
    patched.push_str(&existing[insert_at..]);
    if std::fs::write(&paths_file, patched).is_ok() {
        println!(
            "cargo:warning=fress-open: added the fress_downloads files-path root to {}",
            paths_file.display()
        );
    }
}
