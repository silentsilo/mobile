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
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Photo and contacts backup: permissions, the schedule, and what the last
// run did. The sending itself is `BackupRunner`, in a job.
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES], alias = "photos"),
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
    if (args.getBoolean("photos", false)) {
      aliases += if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "photos" else "photosLegacy"
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

  // Asks for photo access if needed, then counts what "all photos" would send.
  @Command
  fun photoCount(invoke: Invoke) {
    val alias = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "photos" else "photosLegacy"
    if (granted(alias)) {
      countPhotos(invoke)
    } else {
      requestPermissionForAliases(arrayOf(alias, "mediaLocation"), invoke, "countPhotos")
    }
  }

  @PermissionCallback
  fun countPhotos(invoke: Invoke) {
    val result = JSObject()
    var count = 0L
    var bytes = 0L
    try {
      activity.contentResolver.query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        arrayOf(MediaStore.Images.Media.SIZE),
        null,
        null,
        null,
      )?.use { rows ->
        while (rows.moveToNext()) {
          count++
          bytes += rows.getLong(0)
        }
      }
    } catch (_: Exception) {
    }
    result.put("count", count)
    result.put("bytes", bytes)
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
    // Where photos start: now, or the oldest photo on the phone.
    if (photos && !prefs.photos) {
      prefs.addedMark = if (args.getBoolean("includeExisting", false)) 0 else System.currentTimeMillis() / 1000
      prefs.idMark = 0
    }
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
      "photosLegacy" -> Manifest.permission.READ_EXTERNAL_STORAGE
      "mediaLocation" -> Manifest.permission.ACCESS_MEDIA_LOCATION
      "notifications" -> Manifest.permission.POST_NOTIFICATIONS
      else -> Manifest.permission.READ_CONTACTS
    }
    return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }
}
