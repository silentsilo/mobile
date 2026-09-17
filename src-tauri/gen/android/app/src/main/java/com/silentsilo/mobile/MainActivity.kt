package com.silentsilo.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // The screen turning off pauses the app like leaving it does, but the
  // user may want the silo locked at once rather than after the delay.
  private val screenOff = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      Native.screenOff()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // No screenshots, screen recordings or recents thumbnail of the silo.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    // Before the app reads its first secret.
    Native.start(applicationContext)
    super.onCreate(savedInstanceState)
    registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
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
