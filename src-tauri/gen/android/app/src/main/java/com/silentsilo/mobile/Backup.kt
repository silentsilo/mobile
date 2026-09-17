package com.silentsilo.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.ContactsContract
import android.provider.MediaStore
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

// What the backup job needs between runs. Kept out of Android backup with
// the rest of the app's storage.
class BackupPrefs(context: Context) {
  private val prefs: SharedPreferences = context.getSharedPreferences("backup", Context.MODE_PRIVATE)

  var vaultId: String by string("vaultId")
  var label: String by string("label")
  var photos: Boolean by bool("photos")
  var contacts: Boolean by bool("contacts")
  var wifiOnly: Boolean by bool("wifiOnly", true)
  var chargingOnly: Boolean by bool("chargingOnly")
  // The newest photo already sent: MediaStore's DATE_ADDED, then _ID.
  var addedMark: Long by long("addedMark")
  var idMark: Long by long("idMark")
  var videos: Boolean by bool("videos")
  // The same for videos, which started being sent at their own moment.
  var videoAddedMark: Long by long("videoAddedMark")
  var videoIdMark: Long by long("videoIdMark")
  // Gallery folders (MediaStore bucket ids) to back up, comma separated.
  // Empty means every folder.
  var folders: String by string("folders")
  var sent: Long by long("sent")
  var lastRun: Long by long("lastRun")
  var lastError: String by string("lastError")
  var contactsHash: String by string("contactsHash")
  var contactsSentAt: Long by long("contactsSentAt")
  var remind: Boolean by bool("remind", true)
  var waiting: Long by long("waiting")
  // When the inbox last went from empty to holding something.
  var waitingSince: Long by long("waitingSince")
  var remindedAt: Long by long("remindedAt")

  fun clear() = prefs.edit().clear().apply()

  private fun string(key: String) = Pref({ prefs.getString(key, "") ?: "" }, { prefs.edit().putString(key, it).apply() })
  private fun bool(key: String, default: Boolean = false) =
    Pref({ prefs.getBoolean(key, default) }, { prefs.edit().putBoolean(key, it).apply() })
  private fun long(key: String) = Pref({ prefs.getLong(key, 0) }, { prefs.edit().putLong(key, it).apply() })

  class Pref<T>(private val read: () -> T, private val write: (T) -> Unit) {
    operator fun getValue(owner: Any, property: kotlin.reflect.KProperty<*>): T = read()
    operator fun setValue(owner: Any, property: kotlin.reflect.KProperty<*>, value: T) = write(value)
  }
}

object BackupScheduler {
  private const val CONTENT_JOB = 7101
  private const val PERIODIC_JOB = 7102
  private const val NOW_JOB = 7103

  // A job when photos change, and one every few hours for retries and for
  // contacts, which have no change trigger a job can use. `replace` is for a
  // settings change: otherwise a job already waiting is left alone, because
  // Android runs a periodic job as soon as it is scheduled, and a job that
  // rescheduled itself would run in a loop.
  fun schedule(context: Context, replace: Boolean = true) {
    val prefs = BackupPrefs(context)
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (prefs.vaultId.isEmpty() || (!prefs.photos && !prefs.contacts)) {
      cancel(context)
      return
    }
    if (prefs.photos && (replace || scheduler.getPendingJob(CONTENT_JOB) == null)) {
      scheduler.schedule(
        builder(context, CONTENT_JOB, prefs)
          .addTriggerContentUri(
            JobInfo.TriggerContentUri(
              MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
              JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS,
            )
          )
          .addTriggerContentUri(
            JobInfo.TriggerContentUri(
              MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
              JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS,
            )
          )
          .setTriggerContentUpdateDelay(TimeUnit.SECONDS.toMillis(30))
          .setTriggerContentMaxDelay(TimeUnit.MINUTES.toMillis(10))
          .build()
      )
    } else if (!prefs.photos) {
      scheduler.cancel(CONTENT_JOB)
    }
    if (replace || scheduler.getPendingJob(PERIODIC_JOB) == null) {
      scheduler.schedule(
        builder(context, PERIODIC_JOB, prefs)
          .setPeriodic(TimeUnit.HOURS.toMillis(6))
          .setPersisted(true)
          .build()
      )
    }
  }

  fun runNow(context: Context) {
    val prefs = BackupPrefs(context)
    if (prefs.vaultId.isEmpty()) return
    context.getSystemService(JobScheduler::class.java).schedule(builder(context, NOW_JOB, prefs).build())
  }

  fun cancel(context: Context) {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    listOf(CONTENT_JOB, PERIODIC_JOB, NOW_JOB).forEach { scheduler.cancel(it) }
  }

  // After every run: a content trigger fires once, and does not survive a
  // restart, while the periodic job does and brings it back.
  fun rearm(context: Context) {
    try {
      schedule(context, replace = false)
    } catch (_: Exception) {
    }
  }

  private fun builder(context: Context, id: Int, prefs: BackupPrefs) =
    JobInfo.Builder(id, ComponentName(context, BackupJobService::class.java))
      .setRequiredNetworkType(if (prefs.wifiOnly) JobInfo.NETWORK_TYPE_UNMETERED else JobInfo.NETWORK_TYPE_ANY)
      .setRequiresBatteryNotLow(true)
      .setRequiresCharging(prefs.chargingOnly)
}

class BackupJobService : JobService() {
  @Volatile private var stopped = false

  override fun onStartJob(params: JobParameters): Boolean {
    stopped = false
    Thread {
      val retry = try {
        BackupRunner(applicationContext).backUp { stopped }
      } catch (e: Exception) {
        BackupPrefs(applicationContext).lastError = e.message ?: e.toString()
        true
      }
      jobFinished(params, retry && !stopped)
      BackupScheduler.rearm(applicationContext)
    }.start()
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    stopped = true
    return true
  }
}

// One run: new photos in the order they were added, then contacts when they
// changed. Returns true when something failed that may work later.
class BackupRunner(private val context: Context) {
  private val prefs = BackupPrefs(context)
  private val dataDir = context.dataDir.absolutePath

  companion object {
    // Android runs the photo, periodic and "now" jobs side by side. Two runs
    // would send the same photo at once and race each other in storage.
    private val running = java.util.concurrent.atomic.AtomicBoolean(false)

    fun photoPermission(): String =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_IMAGES
      else Manifest.permission.READ_EXTERNAL_STORAGE

    fun videoPermission(): String =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_VIDEO
      else Manifest.permission.READ_EXTERNAL_STORAGE

    fun contactsFile(context: Context) = File(context.cacheDir, "contacts.vcf")

    // The vCard holds every contact in the clear. It is written for the
    // upload and deleted as soon as that returns, so this only finds what a
    // killed process left behind: swept when the app starts, when a run
    // starts, and when backup is turned off. A run going on in this process
    // owns the file and is left alone.
    fun sweepCache(context: Context) {
      if (running.get()) return
      try {
        contactsFile(context).delete()
      } catch (_: Exception) {
      }
    }
  }

  fun backUp(stopped: () -> Boolean): Boolean {
    if (prefs.vaultId.isEmpty()) return false
    // The run already going sends whatever this one would have.
    if (!running.compareAndSet(false, true)) return false
    try {
      return backUpAlone(stopped)
    } finally {
      running.set(false)
    }
  }

  private fun backUpAlone(stopped: () -> Boolean): Boolean {
    Native.start(context)
    // This run owns the file from here on, so it deletes it itself rather
    // than going through the sweep.
    contactsFile().delete()
    prefs.lastRun = System.currentTimeMillis() / 1000
    try {
      if (sendAgain(stopped)) return true
      if (prefs.photos && granted(photoPermission())) {
        if (sendMedia(Media.PHOTO, stopped)) return true
      }
      if (prefs.videos && granted(videoPermission()) && !stopped()) {
        if (sendMedia(Media.VIDEO, stopped)) return true
      }
      if (prefs.contacts && granted(Manifest.permission.READ_CONTACTS) && !stopped()) {
        if (sendContacts()) return true
      }
      prefs.lastError = ""
      return false
    } finally {
      checkWaiting()
    }
  }

  // What storage lost before the silo imported it, found by the app after a
  // sync. A photo still on the phone goes again under the same item id;
  // contacts are marked unsent, so this run sends them again.
  private fun sendAgain(stopped: () -> Boolean): Boolean {
    val list = try { org.json.JSONArray(Native.resends(dataDir)) } catch (_: Exception) { return false }
    for (i in 0 until list.length()) {
      if (stopped()) return true
      val kind = list.getJSONObject(i).optString("kind")
      val reference = list.getJSONObject(i).optString("reference")
      when (kind) {
        "contacts" -> {
          prefs.contactsHash = ""
          prefs.contactsSentAt = 0
          Native.resolveResend(dataDir, kind, reference)
        }
        "photo", "video" -> {
          val id = reference.substringBefore(':').toLongOrNull()
          val added = reference.substringAfter(':').toLongOrNull()
          if (id == null || added == null) {
            Native.resolveResend(dataDir, kind, reference)
            continue
          }
          val outcome = resendMedia(if (kind == "video") Media.VIDEO else Media.PHOTO, id, added)
          if (outcome.startsWith("retry")) {
            prefs.lastError = outcome.removePrefix("retry: ")
            return true
          }
          Native.resolveResend(dataDir, kind, reference)
        }
        else -> Native.resolveResend(dataDir, kind, reference)
      }
    }
    return false
  }

  // "ok", "gone" when it left the phone, or "retry: why".
  private fun resendMedia(media: Media, id: Long, added: Long): String {
    val uri = ContentUris.withAppendedId(media.uri, id)
    val columns = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED)
    val row = context.contentResolver.query(uri, columns, null, null, null)?.use { rows ->
      if (rows.moveToFirst() && rows.getLong(3) == added) {
        listOf(rows.getString(0) ?: "${media.kind}-$id", rows.getString(1) ?: "", rows.getLong(2).toString())
      } else {
        null
      }
    } ?: return "gone"
    return send(media, id, added, row[0], row[1], row[2].toLongOrNull() ?: 0) ?: "gone"
  }

  // Items only join the silo when a device opens it. If they have waited
  // for days, say so, at most once a week.
  private fun checkWaiting() {
    val now = System.currentTimeMillis() / 1000
    val count = Native.waitingCount(dataDir)
    if (count < 0) return
    if (count == 0L) {
      prefs.waiting = 0
      prefs.waitingSince = 0
      return
    }
    if (prefs.waitingSince == 0L) prefs.waitingSince = now
    prefs.waiting = count
    val waitedLong = now - prefs.waitingSince >= TimeUnit.DAYS.toSeconds(3)
    val notRecently = now - prefs.remindedAt >= TimeUnit.DAYS.toSeconds(7)
    if (prefs.remind && waitedLong && notRecently && BackupReminder.show(context, count)) {
      prefs.remindedAt = now
    }
  }

  // Photos and videos go the same way: oldest first from where the last run
  // stopped, each under an item id made from the MediaStore row, into
  // Phone backup / <phone> / Photos or Videos / <month taken>.
  enum class Media(val kind: String, val uri: Uri, val folder: String) {
    PHOTO("photo", MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "Photos"),
    VIDEO("video", MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "Videos"),
  }

  private fun marks(media: Media): Pair<Long, Long> =
    if (media == Media.PHOTO) prefs.addedMark to prefs.idMark else prefs.videoAddedMark to prefs.videoIdMark

  private fun setMarks(media: Media, added: Long, id: Long) {
    if (media == Media.PHOTO) {
      prefs.addedMark = added
      prefs.idMark = id
    } else {
      prefs.videoAddedMark = added
      prefs.videoIdMark = id
    }
  }

  private fun sendMedia(media: Media, stopped: () -> Boolean): Boolean {
    val columns = arrayOf(
      MediaStore.MediaColumns._ID,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.MIME_TYPE,
      MediaStore.MediaColumns.DATE_TAKEN,
      MediaStore.MediaColumns.DATE_ADDED,
    )
    val (addedMark, idMark) = marks(media)
    val added = MediaStore.MediaColumns.DATE_ADDED
    val rowId = MediaStore.MediaColumns._ID
    var selection = "($added > ? OR ($added = ? AND $rowId > ?))"
    val args = mutableListOf(addedMark.toString(), addedMark.toString(), idMark.toString())
    val chosen = prefs.folders.split(',').filter { it.isNotBlank() }
    if (chosen.isNotEmpty()) {
      selection += " AND ${MediaStore.MediaColumns.BUCKET_ID} IN (${chosen.joinToString(",") { "?" }})"
      args += chosen
    }
    val order = "$added ASC, $rowId ASC"
    context.contentResolver.query(media.uri, columns, selection, args.toTypedArray(), order)?.use { rows ->
      while (rows.moveToNext()) {
        if (stopped()) return true
        val id = rows.getLong(0)
        val name = rows.getString(1) ?: "${media.kind}-$id"
        val mime = rows.getString(2) ?: ""
        val dateAdded = rows.getLong(4)
        val outcome = send(media, id, dateAdded, name, mime, rows.getLong(3))
          ?: "skip: it could not be opened"

        if (outcome.startsWith("retry")) {
          prefs.lastError = outcome.removePrefix("retry: ")
          return true
        }
        if (outcome == "ok") {
          prefs.sent = prefs.sent + 1
          // An earlier failure is history once something goes through.
          prefs.lastError = ""
        } else {
          prefs.lastError = "$name: ${outcome.removePrefix("skip: ")}"
        }
        setMarks(media, dateAdded, id)
      }
    }
    return false
  }

  // Sends one row and notes it in the ledger. Null when it cannot be opened.
  private fun send(media: Media, id: Long, added: Long, name: String, mime: String, takenMs: Long): String? {
    val taken = if (takenMs > 0) takenMs / 1000 else added
    val month = SimpleDateFormat("yyyy-MM", Locale.ROOT).format(Date(taken * 1000))
    // Photos keep the prefix they were first sent with, so ids never change.
    val itemId = UUID.nameUUIDFromBytes("${media.kind}:${prefs.vaultId}:$id:$added".toByteArray()).toString()
    val folder = listOf("Phone backup", prefs.label, media.folder, month).joinToString("\n")
    val uri = ContentUris.withAppendedId(media.uri, id)
    val outcome = openPhoto(uri)?.use { fd ->
      Native.sendItem(dataDir, fd.fd, itemId, name, mime, taken, folder, if (media == Media.PHOTO) "photos" else "videos")
    } ?: return null
    if (outcome == "ok") Native.recordSent(dataDir, itemId, media.kind, "$id:$added")
    return outcome
  }

  // The original, with its location, when the app may read that.
  private fun openPhoto(uri: Uri): ParcelFileDescriptor? {
    val source = if (granted(Manifest.permission.ACCESS_MEDIA_LOCATION)) {
      try {
        MediaStore.setRequireOriginal(uri)
      } catch (_: Exception) {
        uri
      }
    } else {
      uri
    }
    return try {
      context.contentResolver.openFileDescriptor(source, "r")
    } catch (_: Exception) {
      try {
        context.contentResolver.openFileDescriptor(uri, "r")
      } catch (_: Exception) {
        null
      }
    }
  }

  // Every contact as one vCard file, sent when it differs from the last one
  // sent and at most once a day. The plaintext file lives in the app's cache
  // for the upload and no longer: it goes as soon as the silo has read it.
  private fun sendContacts(): Boolean {
    val now = System.currentTimeMillis() / 1000
    if (now - prefs.contactsSentAt < TimeUnit.DAYS.toSeconds(1)) return false
    val file = contactsFile()
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      var count = 0
      file.outputStream().use { out ->
        context.contentResolver.query(
          ContactsContract.Contacts.CONTENT_URI,
          arrayOf(ContactsContract.Contacts.LOOKUP_KEY),
          null,
          null,
          ContactsContract.Contacts.LOOKUP_KEY,
        )?.use { rows ->
          while (rows.moveToNext()) {
            val key = rows.getString(0) ?: continue
            val uri = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_VCARD_URI, key)
            try {
              context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { asset ->
                val bytes = asset.createInputStream().readBytes()
                digest.update(bytes)
                out.write(bytes)
                count++
              }
            } catch (_: Exception) {
            }
          }
        }
      }
      if (count == 0) return false
      val hash = digest.digest().joinToString("") { "%02x".format(it) }
      if (hash == prefs.contactsHash) {
        prefs.contactsSentAt = now
        return false
      }
      val day = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(Date(now * 1000))
      val itemId = UUID.nameUUIDFromBytes("contacts:${prefs.vaultId}:$hash".toByteArray()).toString()
      val folder = listOf("Phone backup", prefs.label, "Contacts").joinToString("\n")
      val outcome = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        Native.sendItem(dataDir, fd.fd, itemId, "Contacts $day.vcf", "text/vcard", now, folder, "contacts")
      }
      // Ingested, or failed and to be built again next time: either way the
      // plaintext has no reason to outlive this line.
      file.delete()
      if (outcome.startsWith("retry")) {
        prefs.lastError = outcome.removePrefix("retry: ")
        return true
      }
      if (outcome == "ok") {
        prefs.sent = prefs.sent + 1
        Native.recordSent(dataDir, itemId, "contacts", hash)
      } else {
        prefs.lastError = "Contacts: ${outcome.removePrefix("skip: ")}"
      }
      prefs.contactsHash = hash
      prefs.contactsSentAt = now
      return false
    } finally {
      file.delete()
    }
  }

  private fun contactsFile() = contactsFile(context)

  private fun granted(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

}

object BackupReminder {
  private const val CHANNEL = "backup-waiting"
  private const val ID = 7201

  fun show(context: Context, count: Long): Boolean {
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Backup waiting for the silo", NotificationManager.IMPORTANCE_LOW)
    )
    val open = PendingIntent.getActivity(
      context,
      0,
      Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val text = if (count == 1L) "1 item is waiting to be added to your silo." else "$count items are waiting to be added to your silo."
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_silo)
      .setContentTitle("Open SilentSilo to finish the backup")
      .setContentText(text)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    manager.notify(ID, notification)
    return true
  }
}
