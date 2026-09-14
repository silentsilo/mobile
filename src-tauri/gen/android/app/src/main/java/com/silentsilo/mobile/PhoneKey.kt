package com.silentsilo.mobile

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyPermanentlyInvalidatedException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Unlocking with the phone's silo key, from any activity: the app's own
// window through DeviceKeyPlugin, and the autofill prompt. Format: core
// FORMATS.md, "android-keystore". Credential id = tag(16) || nonce(12) ||
// ciphertext(48).
object PhoneKey {
  const val KEYSTORE = "AndroidKeyStore"
  const val ALIAS_PREFIX = "silentsilo-"
  const val TAG_LEN = 16
  const val NONCE_LEN = 12
  const val WRAPPED_LEN = 48
  const val ID_LEN = TAG_LEN + NONCE_LEN + WRAPPED_LEN
  const val TRANSFORM = "AES/GCM/NoPadding"

  class Failure(message: String, val code: String) : Exception(message)

  // The per-vault string the wrap is bound to.
  fun associatedData(vaultId: String) = "silentsilo-dek-v1:$vaultId".toByteArray()

  // Asks for a fingerprint on whichever offered credential this phone holds,
  // and hands back that credential id with the unwrapped 32-byte key, hex.
  fun unlock(
    activity: Activity,
    vaultId: String,
    credentialIds: List<String>,
    title: String,
    onUnlocked: (credentialId: String, wrapKeyHex: String) -> Unit,
    onFailed: (Failure) -> Unit,
  ) {
    for (raw in credentialIds) {
      val id = unhex(raw) ?: continue
      if (id.size != ID_LEN) continue
      val tag = id.copyOfRange(0, TAG_LEN)
      val nonce = id.copyOfRange(TAG_LEN, TAG_LEN + NONCE_LEN)
      val sealed = id.copyOfRange(TAG_LEN + NONCE_LEN, ID_LEN)
      val key = try { loadKey(ALIAS_PREFIX + hex(tag)) } catch (_: Exception) { null } ?: continue

      val cipher = try {
        Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce)) }
      } catch (_: KeyPermanentlyInvalidatedException) {
        onFailed(
          Failure(
            "The fingerprints or faces on this phone changed, so its silo key no longer works. Unlock with the recovery code and add the phone again.",
            "invalidated",
          )
        )
        return
      } catch (e: Exception) {
        onFailed(Failure("Could not start the key: ${e.message}", "key"))
        return
      }

      prompt(activity, cipher, title, onFailed) { authed ->
        try {
          authed.updateAAD(associatedData(vaultId))
          val wrapKey = authed.doFinal(sealed)
          val wrapHex = hex(wrapKey)
          wrapKey.fill(0)
          onUnlocked(hex(id), wrapHex)
        } catch (e: Exception) {
          onFailed(Failure("This phone's key did not open the silo: ${e.message}", "key"))
        }
      }
      return
    }
    onFailed(Failure("This phone holds no key for this silo.", "absent"))
  }

  fun prompt(
    activity: Activity,
    cipher: Cipher,
    title: String,
    onFailed: (Failure) -> Unit,
    onSuccess: (Cipher) -> Unit,
  ) {
    activity.runOnUiThread {
      val prompt = BiometricPrompt.Builder(activity)
        .setTitle(title)
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButton("Cancel", activity.mainExecutor) { _, _ ->
          onFailed(Failure("Cancelled.", "cancelled"))
        }
        .build()
      prompt.authenticate(
        BiometricPrompt.CryptoObject(cipher),
        CancellationSignal(),
        activity.mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val authed = result.cryptoObject?.cipher
            if (authed == null) onFailed(Failure("The prompt returned no key.", "key")) else onSuccess(authed)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            val code = if (errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
              errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
            ) "cancelled" else "biometric"
            onFailed(Failure(errString.toString(), code))
          }
        },
      )
    }
  }

  fun loadKey(alias: String): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    return store.getKey(alias, null) as SecretKey?
  }

  fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  fun unhex(text: String): ByteArray? {
    if (text.length % 2 != 0) return null
    return try {
      ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    } catch (_: NumberFormatException) {
      null
    }
  }
}
