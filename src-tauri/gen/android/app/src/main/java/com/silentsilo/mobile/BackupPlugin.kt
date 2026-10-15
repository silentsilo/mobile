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
    // Android 14 and later: "Select photos" grants only this one.
    Permission(strings = [Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED], alias = "photosSelected"),
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
    // Asked with the others so "Select photos" is a grant that lasts, not
    // one Android takes back when the app leaves the screen.
    if (aliases.isNotEmpty() && BackupRunner.selectedPermission() != null) aliases += "photosSelected"
    if (args.getBoolean("contacts", false)) aliases += "contacts"
    if (args.getBoolean("remind", false) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) aliases += "notifications"
    // Picked photos count as an answer: asking again would reopen Android's
    // "select more" sheet at every settings change.
    val selected = BackupRunner.selectedGranted(activity)
    val answered = { alias: String ->
      alias == "photosSelected" || granted(alias) ||
        (selected && (alias == "photos" || alias == "videos" || alias == "mediaLocation"))
    }
    if (aliases.isEmpty() || aliases.all(answered)) {
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
    val aliases = when {
      BackupRunner.selectedPermission() != null -> arrayOf("photos", "videos", "photosSelected", "mediaLocation")
      modern -> arrayOf("photos", "videos", "mediaLocation")
      else -> arrayOf("photosLegacy", "mediaLocation")
    }
    // The picked photos are enough to list: the folders they sit in.
    if (BackupRunner.selectedGranted(activity) || aliases.all { it == "mediaLocation" || it == "photosSelected" || granted(it) }) {
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
    // Contacts turned off here: nothing else would clear the vCard a killed
    // run left in the cache, because no run is coming.
    if (!prefs.contacts) BackupRunner.sweepCache(activity)
    prefs.wifiOnly = args.getBoolean("wifiOnly", true)
    prefs.chargingOnly = args.getBoolean("chargingOnly", false)
    prefs.remind = args.getBoolean("remind", true)
    BackupScheduler.schedule(activity)
    BackupScheduler.runNow(activity)
    invoke.resolve(statusObject())
  }

  // Asked for on the screen: run here, in the app, rather than as a job.
  // A job ends after about ten minutes, which a large video never fits in;
  // the app can go on for as long as it stays open. Resolves when done.
  @Command
  fun runNow(invoke: Invoke) {
    val context = activity.applicationContext
    val prefs = BackupPrefs(context)
    Thread {
      try {
        BackupRunner(context).backUp { prefs.wifiOnly && !unmetered(context) }
      } catch (e: Exception) {
        prefs.lastError = e.message ?: e.toString()
      }
      invoke.resolve()
    }.start()
  }

  private fun unmetered(context: android.content.Context): Boolean {
    val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return false
    val network = connectivity.activeNetwork ?: return false
    val caps = connectivity.getNetworkCapabilities(network) ?: return false
    return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
  }

  @Command
  fun disable(invoke: Invoke) {
    val prefs = BackupPrefs(activity)
    BackupScheduler.cancel(activity)
    if (prefs.vaultId.isNotEmpty()) SenderKeys.remove(prefs.vaultId)
    prefs.clear()
    BackupRunner.sweepCache(activity)
    invoke.resolve(statusObject())
  }

  private fun statusObject(): JSObject {
    val prefs = BackupPrefs(activity)
    val result = JSObject()
    result.put("vaultId", prefs.vaultId)
    result.put("photos", prefs.photos)
    result.put("videos", prefs.videos)
    result.put("folders", JSArray(prefs.folders.split(',').filter { it.isNotBlank() }))
    val photosFull = activity.checkSelfPermission(BackupRunner.photoPermission()) == PackageManager.PERMISSION_GRANTED
    val videosFull = activity.checkSelfPermission(BackupRunner.videoPermission()) == PackageManager.PERMISSION_GRANTED
    val selected = BackupRunner.selectedGranted(activity)
    result.put("videosAllowed", videosFull || selected)
    result.put("contacts", prefs.contacts)
    result.put("wifiOnly", prefs.wifiOnly)
    result.put("chargingOnly", prefs.chargingOnly)
    result.put("sent", prefs.sent)
    result.put("lastRun", prefs.lastRun)
    result.put("lastError", prefs.lastError)
    result.put("remind", prefs.remind)
    result.put("waiting", prefs.waiting)
    result.put("photosAllowed", photosFull || selected)
    result.put("contactsAllowed", granted("contacts"))
    // "Select photos": only the picked ones are seen, so only those go.
    result.put("photosLimited", selected && ((prefs.photos && !photosFull) || (prefs.videos && !videosFull)))
    result.put("pending", BackupRunner(activity).pendingCount())
    result.put(
      "notificationsAllowed",
      activity.getSystemService(android.app.NotificationManager::class.java)?.areNotificationsEnabled() ?: true,
    )
    return result
  }

  private fun granted(alias: String): Boolean {
    val permission = when (alias) {
      "photos" -> Manifest.permission.READ_MEDIA_IMAGES
      "videos" -> Manifest.permission.READ_MEDIA_VIDEO
      "photosSelected" -> Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
      "photosLegacy" -> Manifest.permission.READ_EXTERNAL_STORAGE
      "mediaLocation" -> Manifest.permission.ACCESS_MEDIA_LOCATION
      "notifications" -> Manifest.permission.POST_NOTIFICATIONS
      else -> Manifest.permission.READ_CONTACTS
    }
    return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }
}
