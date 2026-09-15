package com.silentsilo.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

// Files coming into the silo from the phone: the document picker, the
// camera, and other apps' share sheet. Rust reads each one through a file
// descriptor opened here, so nothing is copied out in the clear on the way.
@TauriPlugin
class FilesPlugin(private val activity: Activity) : Plugin(activity) {
  private var shared: List<Uri> = emptyList()

  override fun load(webView: WebView) {
    takeShare(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    takeShare(intent)
  }

  private fun takeShare(intent: Intent?) {
    intent ?: return
    val uris = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(parcelable(intent))
      Intent.ACTION_SEND_MULTIPLE -> parcelables(intent)
      else -> return
    }
    // Content another app offers, never a raw path or this app's own files:
    // those it would read with SilentSilo's access, not the sender's.
    val offered = uris.filter(::foreign)
    if (offered.isNotEmpty()) shared = offered
    // Handled once: a later restart of the activity must not share again.
    intent.action = Intent.ACTION_MAIN
  }

  private fun foreign(uri: Uri): Boolean =
    uri.scheme == "content" && uri.authority?.startsWith(activity.packageName) != true

  @Suppress("DEPRECATION")
  private fun parcelable(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun parcelables(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

  // What another app shared and has not been saved yet. Taken once.
  @Command
  fun takeShared(invoke: Invoke) {
    val result = JSObject()
    result.put("files", describe(shared))
    shared = emptyList()
    invoke.resolve(result)
  }

  @Command
  fun pickFiles(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("*/*")
      .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    startActivityForResult(invoke, intent, "picked")
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    val uris = mutableListOf<Uri>()
    if (result.resultCode == Activity.RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
      } else {
        data.data?.let { uris += it }
      }
    }
    val out = JSObject()
    out.put("files", describe(uris))
    invoke.resolve(out)
  }

  // The camera app writes into the app's own cache, never the gallery.
  @Command
  fun takePhoto(invoke: Invoke) {
    val dir = File(activity.cacheDir, "camera").apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
      .putExtra(MediaStore.EXTRA_OUTPUT, uri)
      .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    pendingPhoto = file
    try {
      startActivityForResult(invoke, intent, "photoTaken")
    } catch (e: Exception) {
      file.delete()
      invoke.reject("This phone has no camera app to take the photo.")
    }
  }

  private var pendingPhoto: File? = null

  @ActivityCallback
  fun photoTaken(invoke: Invoke, result: ActivityResult) {
    val file = pendingPhoto
    pendingPhoto = null
    val out = JSObject()
    if (result.resultCode == Activity.RESULT_OK && file != null && file.length() > 0) {
      out.put("path", file.absolutePath)
    } else {
      file?.delete()
    }
    invoke.resolve(out)
  }

  // Hands a decrypted copy to another app. The copy sits in the app's cache
  // under open/, which every lock and every start wipes.
  @Command
  fun openWith(invoke: Invoke) {
    val args = invoke.getArgs()
    val file = File(args.getString("path"))
    val open = File(activity.cacheDir, "open").canonicalFile
    if (!file.canonicalPath.startsWith(open.path + File.separator)) {
      invoke.reject("That file is not one opened from the silo.")
      return
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val mime = args.getString("mimeType", null)?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"
    val view = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, mime)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      activity.startActivity(Intent.createChooser(view, null))
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("No app on this phone opens this kind of file.")
    }
  }

  // A read-only descriptor Rust takes ownership of and closes.
  @Command
  fun openFd(invoke: Invoke) {
    val uri = Uri.parse(invoke.getArgs().getString("uri"))
    if (!foreign(uri)) {
      invoke.reject("This file could not be opened.")
      return
    }
    try {
      val fd = activity.contentResolver.openFileDescriptor(uri, "r")?.detachFd()
      if (fd == null) {
        invoke.reject("This file could not be opened.")
        return
      }
      val out = JSObject()
      out.put("fd", fd)
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject("This file could not be opened.")
    }
  }

  private fun describe(uris: List<Uri>): JSArray {
    val list = JSArray()
    for (uri in uris) {
      val item = JSObject()
      item.put("uri", uri.toString())
      var name = uri.lastPathSegment ?: "file"
      var size = -1L
      try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { rows ->
          if (rows.moveToFirst()) {
            rows.getString(0)?.let { name = it }
            if (!rows.isNull(1)) size = rows.getLong(1)
          }
        }
      } catch (_: Exception) {
      }
      item.put("name", name)
      item.put("size", size)
      item.put("mimeType", activity.contentResolver.getType(uri) ?: "")
      list.put(item)
    }
    return list
  }
}
