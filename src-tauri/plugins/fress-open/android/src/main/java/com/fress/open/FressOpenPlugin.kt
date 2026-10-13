// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
package com.fress.open

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenArgs {
  lateinit var path: String
}

/**
 * Native half of Fress's download open boundary. Every call that reaches this
 * class has ALREADY been validated by the app's `open_downloaded_file` Rust
 * command against the download registry (session-scoped completed artifacts
 * only); no path from the webview can get here without passing that gate.
 *
 * Both commands hand the file out through the app's FileProvider as a
 * `content://` URI with a temporary READ grant. Nothing is ever copied,
 * executed or modified by this plugin, and no write permission is ever
 * granted.
 */
@TauriPlugin
class FressOpenPlugin(private val activity: Activity) : Plugin(activity) {
  private fun contentUriFor(path: String): Uri {
    val file = File(path)
    val authority = activity.applicationContext.packageName + ".fileprovider"
    // Throws (fail closed) when `file` sits outside the roots configured in
    // the generated app's res/xml/file_paths.xml - which, after the plugin
    // build.rs patch, means "not a completed download in the app's
    // files/Download directory".
    return FileProvider.getUriForFile(activity.applicationContext, authority, file)
  }

  /**
   * Opens a completed APK download with Android's normal package installer.
   *
   * This is the standard, user-consented install path: the system installer
   * displays the package information and, when needed, the unknown-sources
   * consent for Fress as the install source. The plugin deliberately does NOT
   * use PackageInstaller APIs, silent-install extras, or any permission that
   * would bypass that consent - the intent is exactly the one a file manager
   * fires when a user taps an APK they downloaded.
   */
  @Command
  fun openApk(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenArgs::class.java)
      val uri = contentUriFor(args.path)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_ACTIVITY_NEW_TASK
        )
      }
      activity.applicationContext.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Cannot open the APK installer")
    }
  }

  /**
   * Safe open/share fallback for completed non-APK downloads. Opens the file
   * with a capable viewer when the user has one; when nothing on the device
   * claims the MIME type it falls back to the share sheet so the user stays
   * in control of what happens to the file. Read grant only.
   */
  @Command
  fun openFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenArgs::class.java)
      val uri = contentUriFor(args.path)
      val mime = mimeTypeFor(args.path)
      val viewIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        activity.applicationContext.startActivity(viewIntent)
        invoke.resolve()
        return
      } catch (_: ActivityNotFoundException) {
        // No viewer for this type: fall through to the share sheet.
      }
      val shareIntent = Intent.createChooser(
        Intent(Intent.ACTION_SEND).apply {
          type = mime
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        },
        null
      ).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.applicationContext.startActivity(shareIntent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Cannot open the file")
    }
  }

  private fun mimeTypeFor(path: String): String {
    val name = path.substringAfterLast('/')
    val extension = name.substringAfterLast('.', "").lowercase()
    if (extension.isEmpty()) return "application/octet-stream"
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      ?: "application/octet-stream"
  }
}
