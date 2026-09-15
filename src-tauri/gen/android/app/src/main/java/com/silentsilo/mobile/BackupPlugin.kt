package com.silentsilo.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Photo and contacts backup: permissions, the schedule, and what the last
// run did. The sending itself is `BackupRunner`, in a job.
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES], alias = "photos"),
    Permission(strings = [Manifest.permission.READ_MEDIA_VIDEO], alias = "videos"),
    Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "photosLegacy"),
    Permission(strings = [Manifest.permission.ACCESS_MEDIA_LOCATION], alias = "mediaLocation"),
    Permission(strings = [Manifest.permission.READ_CONTACTS], alias = "contacts"),
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
  ]
)
class BackupPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  // Asks for what the chosen backups need. Resolves with the status either way.
  @Command
  fun requestAccess(invoke: Invoke) {
    val args = invoke.getArgs()
    val aliases = mutableListOf<String>()
    val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    if (args.getBoolean("photos", false)) {
      aliases += if (modern) "photos" else "photosLegacy"
      aliases += "mediaLocation"
    }
    if (args.getBoolean("videos", false)) {
      aliases += if (modern) "videos" else "photosLegacy"
      aliases += "mediaLocation"
    }
    if (args.getBoolean("contacts", false)) aliases += "contacts"
    if (args.getBoolean("remind", false) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) aliases += "notifications"
    if (aliases.isEmpty() || aliases.all { granted(it) }) {
      invoke.resolve(statusObject())
      return
    }
    requestPermissionForAliases(aliases.toTypedArray(), invoke, "accessAnswered")
  }

  @PermissionCallback
  fun accessAnswered(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  // Asks for photo and video access if needed, then lists the gallery's
  // folders with what each holds, for choosing and for "send everything".
  @Command
  fun mediaFolders(invoke: Invoke) {
    val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    val aliases = if (modern) arrayOf("photos", "videos", "mediaLocation") else arrayOf("photosLegacy", "mediaLocation")
    if (aliases.all { it == "mediaLocation" || granted(it) }) {
      listFolders(invoke)
    } else {
      requestPermissionForAliases(aliases, invoke, "listFolders")
    }
  }

  @PermissionCallback
  fun listFolders(invoke: Invoke) {
    class Folder(val id: String, var name: String, var photos: Long = 0, var videos: Long = 0, var bytes: Long = 0)
    val folders = linkedMapOf<String, Folder>()
    val columns = arrayOf(
      MediaStore.MediaColumns.BUCKET_ID,
      MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
    )
    for ((uri, video) in listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI to false, MediaStore.Video.Media.EXTERNAL_CONTENT_URI to true)) {
      try {
        activity.contentResolver.query(uri, columns, null, null, null)?.use { rows ->
          while (rows.moveToNext()) {
            val id = rows.getString(0) ?: continue
            val folder = folders.getOrPut(id) { Folder(id, rows.getString(1) ?: "Other") }
            if (video) folder.videos++ else folder.photos++
            folder.bytes += rows.getLong(2)
          }
        }
      } catch (_: Exception) {
      }
    }
    val list = JSArray()
    for (folder in folders.values.sortedByDescending { it.photos + it.videos }) {
      val item = JSObject()
      item.put("id", folder.id)
      item.put("name", folder.name)
      item.put("photos", folder.photos)
      item.put("videos", folder.videos)
      item.put("bytes", folder.bytes)
      list.put(item)
    }
    val result = JSObject()
    result.put("folders", list)
    invoke.resolve(result)
  }

  @Command
  fun senderKey(invoke: Invoke) {
    val vaultId = invoke.getArgs().getString("vaultId")
    val key = SenderKeys.publicKey(vaultId)
    if (key == null) {
      invoke.reject("This phone could not make a signing key.")
      return
    }
    val result = JSObject()
    result.put("publicKey", key.joinToString("") { "%02x".format(it) })
    invoke.resolve(result)
  }

  @Command
  fun configure(invoke: Invoke) {
    val args = invoke.getArgs()
    val prefs = BackupPrefs(activity)
    val vaultId = args.getString("vaultId")
    val photos = args.getBoolean("photos", false)
    if (prefs.vaultId != vaultId) {
      prefs.clear()
      prefs.vaultId = vaultId
    }
    val videos = args.getBoolean("videos", false)
    val start = if (args.getBoolean("includeExisting", false)) 0 else System.currentTimeMillis() / 1000
    // Where each starts: now, or the oldest one on the phone.
    if (photos && !prefs.photos) {
      prefs.addedMark = start
      prefs.idMark = 0
    }
    if (videos && !prefs.videos) {
      prefs.videoAddedMark = start
      prefs.videoIdMark = 0
    }
    prefs.videos = videos
    val folders = args.optJSONArray("folders")
    prefs.folders = (0 until (folders?.length() ?: 0)).joinToString(",") { folders!!.getString(it) }
    prefs.label = args.getString("label")
    prefs.photos = photos
    prefs.contacts = args.getBoolean("contacts", false)
    prefs.wifiOnly = args.getBoolean("wifiOnly", true)
    prefs.chargingOnly = args.getBoolean("chargingOnly", false)
    prefs.remind = args.getBoolean("remind", true)
    BackupScheduler.schedule(activity)
    BackupScheduler.runNow(activity)
    invoke.resolve(statusObject())
  }

  @Command
  fun runNow(invoke: Invoke) {
    BackupScheduler.runNow(activity)
    invoke.resolve()
  }

  @Command
  fun disable(invoke: Invoke) {
    val prefs = BackupPrefs(activity)
    BackupScheduler.cancel(activity)
    if (prefs.vaultId.isNotEmpty()) SenderKeys.remove(prefs.vaultId)
    prefs.clear()
    invoke.resolve(statusObject())
  }

  private fun statusObject(): JSObject {
    val prefs = BackupPrefs(activity)
    val result = JSObject()
    result.put("vaultId", prefs.vaultId)
    result.put("photos", prefs.photos)
    result.put("videos", prefs.videos)
    result.put("folders", JSArray(prefs.folders.split(',').filter { it.isNotBlank() }))
    result.put("videosAllowed", activity.checkSelfPermission(BackupRunner.videoPermission()) == PackageManager.PERMISSION_GRANTED)
    result.put("contacts", prefs.contacts)
    result.put("wifiOnly", prefs.wifiOnly)
    result.put("chargingOnly", prefs.chargingOnly)
    result.put("sent", prefs.sent)
    result.put("lastRun", prefs.lastRun)
    result.put("lastError", prefs.lastError)
    result.put("remind", prefs.remind)
    result.put("waiting", prefs.waiting)
    result.put("photosAllowed", activity.checkSelfPermission(BackupRunner.photoPermission()) == PackageManager.PERMISSION_GRANTED)
    result.put("contactsAllowed", granted("contacts"))
    return result
  }

  private fun granted(alias: String): Boolean {
    val permission = when (alias) {
      "photos" -> Manifest.permission.READ_MEDIA_IMAGES
      "videos" -> Manifest.permission.READ_MEDIA_VIDEO
      "photosLegacy" -> Manifest.permission.READ_EXTERNAL_STORAGE
      "mediaLocation" -> Manifest.permission.ACCESS_MEDIA_LOCATION
      "notifications" -> Manifest.permission.POST_NOTIFICATIONS
      else -> Manifest.permission.READ_CONTACTS
    }
    return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }
}
