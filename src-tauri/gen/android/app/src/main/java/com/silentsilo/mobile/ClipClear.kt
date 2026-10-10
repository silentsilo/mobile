package com.silentsilo.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock

// Takes a copied secret off the clipboard 45 s after the copy, from a system
// alarm: a timer in the app stops when Android freezes or kills it, and the
// secret then stayed. The serial ties the alarm to its copy; a later copy
// replaces it, and a lock that already cleared it marks it done.
object ClipClear {
  private const val PREFS = "clip"
  const val LABEL = "SilentSilo secret"

  fun schedule(context: Context, ttlMs: Long) {
    val serial = SystemClock.elapsedRealtimeNanos()
    prefs(context).edit().putLong("serial", serial).putBoolean("pending", true).apply()
    val intent = Intent(context, ClipClearReceiver::class.java).putExtra("serial", serial)
    val alarm = PendingIntent.getBroadcast(
      context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    context.getSystemService(AlarmManager::class.java)
      .setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ttlMs, alarm)
  }

  fun pending(context: Context): Boolean = prefs(context).getBoolean("pending", false)

  fun done(context: Context) {
    prefs(context).edit().putBoolean("pending", false).apply()
  }

  // From the background the clip's label reads as null and the secret may
  // still be there, so null clears too.
  fun clearIfOurs(context: Context) {
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    val label = clipboard.primaryClipDescription?.label
    if (label == null || label == LABEL) clipboard.clearPrimaryClip()
    done(context)
  }

  fun serial(context: Context): Long = prefs(context).getLong("serial", -1)

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

class ClipClearReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ClipClear.pending(context)) return
    if (intent.getLongExtra("serial", -2) != ClipClear.serial(context)) return
    ClipClear.clearIfOurs(context)
  }
}
