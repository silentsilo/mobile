package com.silentsilo.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

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
    // The recents card shows the app's icon instead of an empty one, which
    // read as an app that had not drawn yet.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(false)
    // Before the app reads its first secret.
    Native.start(applicationContext)
    // A backup run that was killed may have left the contacts vCard in the
    // cache in the clear.
    BackupRunner.sweepCache(applicationContext)
    super.onCreate(savedInstanceState)
    holdUpright()
    Appearance.systemBars(this)
    registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
  }

  // The phone switching between light and dark, or the app's own choice.
  // A new font size is applied here too, without restarting the screen: a
  // restart dropped an import or a join half way.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    holdUpright()
    Appearance.systemBars(this)
    webView?.settings?.textZoom = (newConfig.fontScale * 100).toInt()
  }

  // Android's own autofill must never see the silo: it would keep the
  // recovery code, storage keys and revealed passwords in the system's
  // autofill store, outside the silo and unencrypted.
  override fun onWebViewCreate(webView: WebView) {
    webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    this.webView = webView
  }

  // Upright on a phone, where the screens are laid out for it. A tablet or
  // an unfolded phone turns freely and shows the list beside the open item.
  private fun holdUpright() {
    requestedOrientation =
      if (resources.configuration.smallestScreenWidthDp < 600) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  }

  // Back on screen: the app syncs by itself, so the service goes.
  override fun onStart() {
    super.onStart()
    OpenSiloService.stop(this)
  }

  // Leaving with a silo open: keep syncing until it locks.
  override fun onStop() {
    super.onStop()
    if (!isChangingConfigurations && Native.keepsSyncing()) OpenSiloService.start(this)
  }

  override fun onDestroy() {
    unregisterReceiver(screenOff)
    super.onDestroy()
  }
}
