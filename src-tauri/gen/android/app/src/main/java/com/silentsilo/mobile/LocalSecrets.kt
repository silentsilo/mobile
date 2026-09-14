package com.silentsilo.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Seals the app's local secret files (storage settings, the device secret,
// the silo list) under a Keystore key that never leaves the phone. No
// authentication: the background backup reads the storage settings while
// the silo is locked. Called from Rust, through `Native`.
object LocalSecrets {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val ALIAS = "silentsilo-local-secrets"
  private const val TRANSFORM = "AES/GCM/NoPadding"
  private const val NONCE_LEN = 12

  @JvmStatic
  fun protect(data: ByteArray): ByteArray? =
    try {
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.ENCRYPT_MODE, key())
      cipher.iv + cipher.doFinal(data)
    } catch (_: Exception) {
      null
    }

  @JvmStatic
  fun unprotect(data: ByteArray): ByteArray? {
    if (data.size <= NONCE_LEN) return null
    val key = existing() ?: return null
    return try {
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, data, 0, NONCE_LEN))
      cipher.doFinal(data, NONCE_LEN, data.size - NONCE_LEN)
    } catch (_: Exception) {
      null
    }
  }

  @Synchronized
  private fun key(): SecretKey =
    existing() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
      generateKey()
    }

  private fun existing(): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    return store.getKey(ALIAS, null) as SecretKey?
  }
}
