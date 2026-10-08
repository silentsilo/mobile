package com.silentsilo.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView

class MainActivity : TauriActivity() {
  // The screen turning off pauses the app like leaving it does, but the
  // user may want the silo locked at once rather than after the delay.
  private val screenOff = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      Native.screenOff()
    }
  }

  // The theme chosen in the app, before anything is drawn.
  override fun attachBaseContext(newBase: Context) {
    Appearance.applySaved(newBase)
    super.attachBaseContext(newBase)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // No screenshots, screen recordings or recents thumbnail of the silo.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    // Before the app reads its first secret.
    Native.start(applicationContext)
    // A backup run that was killed may have left the contacts vCard in the
    // cache in the clear.
    BackupRunner.sweepCache(applicationContext)
    super.onCreate(savedInstanceState)
    Appearance.systemBars(this)
    registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
  }

  // The phone switching between light and dark, or the app's own choice.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    Appearance.systemBars(this)
  }

  // Android's own autofill must never see the silo: it would keep the
  // recovery code, storage keys and revealed passwords in the system's
  // autofill store, outside the silo and unencrypted.
  override fun onWebViewCreate(webView: WebView) {
    webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
  }

  override fun onDestroy() {
    unregisterReceiver(screenOff)
    super.onDestroy()
  }
}
