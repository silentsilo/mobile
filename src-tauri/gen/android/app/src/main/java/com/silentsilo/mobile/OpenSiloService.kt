package com.silentsilo.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateFormat
import java.util.concurrent.Executors

// Keeps syncing while a silo stays open with the app away, until the lock
// falls due. Android freezes a cached app within seconds, so without this
// the phone heard of other devices' changes only when opened again. The
// notification it needs says the silo is open and locks it in one tap.
class OpenSiloService : Service() {
  companion object {
    private const val CHANNEL = "silo-open"
    private const val ID = 7202
    private const val ACTION_LOCK = "com.silentsilo.mobile.LOCK_ALL"
    // A pass every five minutes; whether a silo is still open, every 30 s.
    private const val EVERY_MS = 5 * 60 * 1000L
    private const val CHECK_MS = 30 * 1000L

    // Called as the app leaves the screen, inside the few seconds Android
    // still allows a foreground service to start.
    fun start(context: Context) {
      try {
        context.startForegroundService(Intent(context, OpenSiloService::class.java))
      } catch (_: Exception) {
        // Not allowed this time: the app syncs when opened, as before.
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, OpenSiloService::class.java))
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private var started = false
  private var lastPass = 0L
  private var syncedAt: Long? = null

  private val tick = object : Runnable {
    override fun run() {
      if (!Native.anyOpen()) {
        stopSelf()
        return
      }
      if (SystemClock.elapsedRealtime() - lastPass >= EVERY_MS) pass()
      handler.postDelayed(this, CHECK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Native.start(applicationContext)
    startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    if (intent?.action == ACTION_LOCK) {
      worker.execute { Native.lockAll() }
      stopSelf()
      return START_NOT_STICKY
    }
    if (!started) {
      started = true
      // Leaving already sent what was waiting; the first pass is due later.
      lastPass = SystemClock.elapsedRealtime()
      handler.postDelayed(tick, CHECK_MS)
    }
    return START_NOT_STICKY
  }

  private fun pass() {
    lastPass = SystemClock.elapsedRealtime()
    worker.execute {
      if (Native.syncOpen()) {
        syncedAt = System.currentTimeMillis()
        handler.post { getSystemService(NotificationManager::class.java).notify(ID, notification()) }
      }
    }
  }

  // Android 15 ends a data sync service after six hours a day; the lock
  // comes long before that, but the service stops cleanly if not.
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    worker.shutdown()
    super.onDestroy()
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, getString(R.string.silo_open_channel), NotificationManager.IMPORTANCE_LOW)
    )
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val lock = PendingIntent.getService(
      this,
      1,
      Intent(this, OpenSiloService::class.java).setAction(ACTION_LOCK),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val text = syncedAt?.let { getString(R.string.silo_open_synced, DateFormat.getTimeFormat(this).format(it)) }
      ?: getString(R.string.silo_open_text)
    return Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_silo)
      .setContentTitle(getString(R.string.silo_open_title))
      .setContentText(text)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .addAction(
        Notification.Action.Builder(
          Icon.createWithResource(this, R.drawable.ic_stat_silo),
          getString(R.string.silo_open_lock),
          lock,
        ).build()
      )
      .build()
  }
}
