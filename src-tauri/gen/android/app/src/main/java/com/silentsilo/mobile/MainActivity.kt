package com.silentsilo.mobile

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // No screenshots, screen recordings or recents thumbnail of the silo.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    // Before the app reads its first secret.
    Native.start(applicationContext)
    super.onCreate(savedInstanceState)
  }
}
