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
    // Photos taken for the silo and files opened with other apps, left by a
    // process that ended before it removed them.
    listOf("camera", "open").forEach { java.io.File(context.cacheDir, it).deleteRecursively() }
    Os.setenv("TMPDIR", context.cacheDir.absolutePath, true)
    System.loadLibrary("silentsilo_mobile_lib")
    init(context.dataDir.absolutePath, context.applicationContext)
    started = true
  }

  // The context is for certificate checks, which ask Android.
  @JvmStatic private external fun init(dataDir: String, context: Context)

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

  // The front silo for autofill: {vaultId, name, credentialIds, open}.
  @JvmStatic external fun autofillSilo(dataDir: String): String

  // Its logins, opening it with the unwrapped key unless already open:
  // {logins: [...]} or {error}.
  @JvmStatic external fun autofillLogins(dataDir: String, credentialId: String, wrapKey: String): String

  // Adds a login, or updates the password of the same account: {saved} or {error}.
  @JvmStatic external fun autofillSave(dataDir: String, credentialId: String, wrapKey: String, login: String): String

  // Passkeys, for the provider in Passkeys.kt. Each answers JSON.
  @JvmStatic external fun passkeyOverview(dataDir: String, request: String, origin: String): String

  @JvmStatic external fun passkeyFind(dataDir: String, credentialId: String, wrapKey: String, request: String, origin: String): String

  @JvmStatic
  external fun passkeyCreate(
    dataDir: String,
    credentialId: String,
    wrapKey: String,
    request: String,
    origin: String,
    packageName: String,
    clientDataHash: String,
  ): String

  @JvmStatic
  external fun passkeyAssert(
    dataDir: String,
    credentialId: String,
    wrapKey: String,
    passkeyId: String,
    request: String,
    origin: String,
    packageName: String,
    clientDataHash: String,
  ): String

  // Locks every open silo in this process.
  @JvmStatic external fun lockAll()

  @JvmStatic external fun anyOpen(): Boolean

  // The screen turned off; Rust locks if the user asked for that.
  @JvmStatic external fun screenOff()

  // The ledger of sent items, for sending again what storage lost.
  @JvmStatic external fun recordSent(dataDir: String, itemId: String, kind: String, reference: String)

  @JvmStatic external fun resends(dataDir: String): String

  @JvmStatic external fun resolveResend(dataDir: String, kind: String, reference: String)

  // Items in the silo's inbox not imported yet, or -1 when storage did not say.
  @JvmStatic external fun waitingCount(dataDir: String): Long
}
