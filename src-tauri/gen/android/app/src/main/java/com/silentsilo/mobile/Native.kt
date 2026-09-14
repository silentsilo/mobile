package com.silentsilo.mobile

import android.content.Context
import android.system.Os

// The Rust library, reached without the app's window: the backup job runs
// in a process where no activity has started.
object Native {
  @Volatile private var started = false

  // Before anything reads a secret: where the app's files are, the Keystore
  // protector for them, and a temporary directory the app may write to.
  @Synchronized
  fun start(context: Context) {
    if (started) return
    Os.setenv("TMPDIR", context.cacheDir.absolutePath, true)
    System.loadLibrary("silentsilo_mobile_lib")
    init(context.dataDir.absolutePath)
    started = true
  }

  @JvmStatic private external fun init(dataDir: String)

  // Seals and uploads one item to the silo's inbox. Returns "ok", or
  // "retry: why" when trying again later may work, or "skip: why" when it
  // will not.
  @JvmStatic
  external fun sendItem(
    dataDir: String,
    fd: Int,
    itemId: String,
    name: String,
    mimeType: String,
    takenAt: Long,
    folder: String,
    kind: String,
  ): String
}
