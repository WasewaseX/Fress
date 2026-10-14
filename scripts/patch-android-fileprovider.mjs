#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Injects the download-opening plumbing into the GENERATED Android project
// (src-tauri/gen/android), which is intentionally not tracked in git: the
// Tauri CLI regenerates it with `tauri android init` (release.yml does this
// on every release build), so every piece of Android-native configuration
// this app needs must be (re-)applied AFTER generation and BEFORE gradle
// packaging. `tauri android build` runs this script through
// build.beforeBuildCommand on every pass, which is exactly that window.
//
// What gets applied (all idempotent - running twice changes nothing):
//   1. The FileProvider scope. The Tauri template already declares
//      androidx.core.content.FileProvider with authority
//      ${applicationId}.fileprovider and its own @xml/file_paths resource;
//      this script EXTENDS that resource with the one scope the download
//      engine needs - the app's private Download folder (files-path
//      path="Download/", which platform_download_dir() commits into) plus
//      the cache dir. Only if the generated project has NO provider at all
//      (older template) is one declared, with the fress.fileprovider
//      authority and its own resource.
//   2. AndroidManifest.xml - the REQUEST_INSTALL_PACKAGES permission.
//      Declaring it does NOT bypass anything: Android still runs its full
//      unknown-sources consent UI before any package is installed; it only
//      makes the app ELIGIBLE to ask. (The provider declaration rides
//      along with step 1 when the template has none.)
//   3. app/src/main/java/<identifier>/FressFileOpenerPlugin.kt - the Kotlin
//      half of the Rust open_path command, registered as a Tauri mobile
//      plugin (the Rust side registers it with
//      api.register_android_plugin("com.fress.app", "FressFileOpenerPlugin")
//      and calls it with run_mobile_plugin). It builds the content:// URI
//      through the scoped FileProvider, picks the MIME type
//      (application/vnd.android.package-archive for APKs), sets
//      FLAG_GRANT_READ_URI_PERMISSION and falls back to the share sheet
//      when no activity can view the file. Keeping this logic in Kotlin
//      instead of raw JNI means one reviewed implementation, not JNI glue.
//
// The script is a no-op on desktop builds (gen/android does not exist) so
// the shared beforeBuildCommand stays safe for every target.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const genAndroid = join(repoRoot, 'src-tauri', 'gen', 'android');

if (!existsSync(genAndroid)) {
  // Desktop build (or android not initialized yet): nothing to patch.
  console.log('[patch-android-fileprovider] gen/android not present, skipping');
  process.exit(0);
}

const appMain = join(genAndroid, 'app', 'src', 'main');
const manifestPath = join(appMain, 'AndroidManifest.xml');
if (!existsSync(manifestPath)) {
  console.error('[patch-android-fileprovider] gen/android exists but no AndroidManifest.xml - unexpected project layout, aborting');
  process.exit(1);
}

// Read the application identifier from tauri.conf.json so the Kotlin
// helper lands in the same package as the generated MainActivity.
const tauriConf = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const identifier = tauriConf.identifier; // e.g. com.fress.app

let patched = 0;

const manifest = readFileSync(manifestPath, 'utf8');

// The authority the Kotlin side uses MUST match the declared provider.
// The Tauri template ships FileProvider at ${applicationId}.fileprovider;
// a project without it gets the fress.fileprovider authority below.
const templateProviderPresent = /androidx\.core\.content\.FileProvider/.test(manifest) && existsSync(join(appMain, 'res', 'xml', 'file_paths.xml'));
const authoritySuffix = templateProviderPresent ? '.fileprovider' : '.fress.fileprovider';

// ---- 1. FileProvider path configuration --------------------------------
const SCOPE_ENTRY = '    <files-path name="fress_downloads" path="Download/" />';
const resXmlDir = join(appMain, 'res', 'xml');
const filePathsPath = join(resXmlDir, templateProviderPresent ? 'file_paths.xml' : 'fress_file_paths.xml');

if (templateProviderPresent) {
  // Extend the TEMPLATE's resource (idempotent): the download engine
  // commits into filesDir/Download, a scope the template does not cover.
  const current = readFileSync(filePathsPath, 'utf8');
  if (!current.includes('name="fress_downloads"')) {
    if (!current.includes('<files-path')) {
      writeFileSync(filePathsPath, current.replace(/<\/paths>/, `${SCOPE_ENTRY}\n</paths>\n`));
    } else {
      writeFileSync(filePathsPath, current.replace(/<\/paths>/, `${SCOPE_ENTRY}\n</paths>\n`));
    }
    patched += 1;
  }
  // The cache-path scope: the template already carries one; only an older
  // template without it needs the entry appended.
  if (!current.includes('<cache-path')) {
    const next = readFileSync(filePathsPath, 'utf8').replace(
      /<\/paths>/,
      '    <cache-path name="fress_cache" path="." />\n</paths>\n'
    );
    writeFileSync(filePathsPath, next);
    patched += 1;
  }
} else {
  const filePathsXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Scope of the Fress FileProvider (authority: \${applicationId}.fress.fileprovider).
     Only the download engine's commit folder and the cache dir are shared,
     and only with FLAG_GRANT_READ_URI_PERMISSION to one app at a time. -->
<paths>
    <files-path name="fress_downloads" path="Download/" />
    <cache-path name="fress_cache" path="." />
</paths>
`;
  if (!existsSync(filePathsPath) || readFileSync(filePathsPath, 'utf8') !== filePathsXml) {
    mkdirSync(resXmlDir, { recursive: true });
    writeFileSync(filePathsPath, filePathsXml);
    patched += 1;
  }
}

// ---- 2. Manifest: permission (+ provider only when the template has none)
let nextManifest = manifest;

const PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
if (!nextManifest.includes(`"${PERMISSION}"`)) {
  if (!/<uses-permission\b/.test(nextManifest)) {
    // No other permissions declared yet: insert right after the opening tag.
    nextManifest = nextManifest.replace(/(<manifest[^>]*>\s*)/, `$1<uses-permission android:name="${PERMISSION}" />\n    `);
  } else {
    nextManifest = nextManifest.replace(/(<uses-permission\b[^>]*\/>\s*)/, `$1<uses-permission android:name="${PERMISSION}" />\n    `);
  }
  patched += 1;
}

if (!templateProviderPresent && !nextManifest.includes('fress.fileprovider')) {
  const providerSnippet = `<provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fress.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/fress_file_paths" />
        </provider>`;
  if (nextManifest.includes('</application>')) {
    nextManifest = nextManifest.replace(/(\s*)<\/application>/, `\n        ${providerSnippet}\n    </application>`);
    patched += 1;
  } else {
    console.error('[patch-android-fileprovider] manifest has no </application> element - aborting without changes');
    process.exit(1);
  }
}

if (nextManifest !== manifest) {
  writeFileSync(manifestPath, nextManifest);
}

// ---- 3. Kotlin plugin ---------------------------------------------------
const ktDir = join(appMain, 'java', ...identifier.split('.'));
const ktPath = join(ktDir, 'FressFileOpenerPlugin.kt');
const ktSource = `package ${identifier}

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenPathArgs {
  lateinit var path: String
  var isApk: Boolean = false
}

/**
 * The single Android entry point behind the Rust open_path command.
 *
 * Registered by the Rust side as a Tauri mobile plugin and called with
 * run_mobile_plugin. The path arrives ALREADY VALIDATED: the Rust open_path
 * boundary confirmed it is a completed Fress download artifact (registered
 * in the download engine's completed-artifact records, canonical-stable,
 * right size) before this class is ever invoked. Everything here is the
 * presentation side of that decision: build a content:// URI through the
 * scoped FileProvider, hand it to Android's own handlers, grant one-time
 * read permission.
 *
 * APKs route to the system package installer through the standard
 * ACTION_VIEW + application/vnd.android.package-archive path. Android owns
 * the whole consent flow: the unknown-sources gate, the install
 * confirmation, the cancellation. Nothing here requests, suppresses or
 * works around any of it.
 */
@TauriPlugin
class FressFileOpenerPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        const val APK_MIME: String = "application/vnd.android.package-archive"
    }

    @Command
    fun open(invoke: Invoke) {
        val ret = JSObject()
        try {
            val args = invoke.parseArgs(OpenPathArgs::class.java)
            val file = File(args.path)
            // The FileProvider authority is declared in the app manifest
            // (Tauri template: \${applicationId}.fileprovider). Derived from
            // the package name at runtime - never hardcoded.
            val authority = activity.packageName + "${authoritySuffix}"
            val uri = FileProvider.getUriForFile(activity, authority, file)
            if (args.isApk) {
                val install = Intent(Intent.ACTION_VIEW)
                install.setDataAndType(uri, APK_MIME)
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(install)
                ret.put("status", "ok")
            } else {
                val mime = MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(file.extension.lowercase())
                    ?: "application/octet-stream"
                try {
                    val view = Intent(Intent.ACTION_VIEW)
                    view.setDataAndType(uri, mime)
                    view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(view)
                    ret.put("status", "ok")
                } catch (viewFailed: Exception) {
                    // Nothing installed can view this type: the share sheet is
                    // the honest fallback ("hand the file to an app that can").
                    val share = Intent(Intent.ACTION_SEND)
                    share.type = mime
                    share.putExtra(Intent.EXTRA_STREAM, uri)
                    // The chooser must carry the grant too, or the receiving
                    // app gets a content:// URI it cannot read.
                    share.clipData = ClipData.newRawUri(file.name, uri)
                    share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    share.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(Intent.createChooser(share, file.name))
                    ret.put("status", "ok-shared")
                }
            }
        } catch (failed: Exception) {
            ret.put("status", "error")
            ret.put("message", failed.message ?: failed.javaClass.simpleName)
        }
        invoke.resolve(ret)
    }
}
`;
if (!existsSync(ktPath) || readFileSync(ktPath, 'utf8') !== ktSource) {
  mkdirSync(ktDir, { recursive: true });
  writeFileSync(ktPath, ktSource);
  patched += 1;
}

console.log(`[patch-android-fileprovider] applied (authority: \${applicationId}${authoritySuffix}, ${patched} file(s) written)`);
