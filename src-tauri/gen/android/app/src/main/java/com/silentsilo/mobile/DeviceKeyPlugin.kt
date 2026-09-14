package com.silentsilo.mobile

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.StatFs
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The phone's silo key: an AES-256 Keystore key allowing one use per strong
// biometric, wrapping a random 32-byte key. Format: core FORMATS.md,
// "android-keystore". Credential id = tag(16) || nonce(12) || ciphertext(48).
@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {
  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS_PREFIX = "silentsilo-"
    const val TAG_LEN = 16
    const val NONCE_LEN = 12
    const val WRAPPED_LEN = 48
    const val ID_LEN = TAG_LEN + NONCE_LEN + WRAPPED_LEN
    const val TRANSFORM = "AES/GCM/NoPadding"
    const val MIN_WEBVIEW_MAJOR = 105
    const val PROBE_ALIAS = "silentsilo-probe"
    const val CLIP_LABEL = "SilentSilo secret"
    const val CLIP_TTL_MS = 45_000L
  }

  // A secret on the clipboard: marked sensitive so the keyboard and the
  // clipboard preview do not show it, and cleared after 45 s if still ours.
  @Command
  fun copySecret(invoke: Invoke) {
    val text = invoke.getArgs().getString("text")
    activity.runOnUiThread {
      val clipboard = activity.getSystemService(ClipboardManager::class.java)
      val clip = ClipData.newPlainText(CLIP_LABEL, text)
      clip.description.extras = PersistableBundle().apply {
        putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        putBoolean("android.content.extra.IS_SENSITIVE", true)
      }
      clipboard.setPrimaryClip(clip)
      Handler(Looper.getMainLooper()).postDelayed({
        if (clipboard.primaryClipDescription?.label == CLIP_LABEL) {
          clipboard.clearPrimaryClip()
        }
      }, CLIP_TTL_MS)
      invoke.resolve()
    }
  }

  @Command
  fun check(invoke: Invoke) {
    try {
      invoke.resolve(measure())
    } catch (e: Exception) {
      invoke.reject("Could not check this phone: ${e.message}")
    }
  }

  private fun measure(): JSObject {
    val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    val biometrics = activity.getSystemService(BiometricManager::class.java)
    val strongBiometric =
      biometrics.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
        BiometricManager.BIOMETRIC_SUCCESS
    val webview = WebView.getCurrentWebViewPackage()?.versionName ?: ""
    val webviewMajor = webview.substringBefore('.').toIntOrNull() ?: 0

    val result = JSObject()
    result.put("android_release", Build.VERSION.RELEASE)
    result.put("android_supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
    result.put("secure_lock", keyguard.isDeviceSecure)
    result.put("strong_biometric", strongBiometric)
    result.put("keystore", probeKeystore(strongBiometric))
    result.put("webview_version", webview)
    result.put("webview_ok", webviewMajor >= MIN_WEBVIEW_MAJOR)
    result.put("free_bytes", StatFs(activity.filesDir.path).availableBytes)
    return result
  }

  // Makes and deletes a key with the real parameters, StrongBox first.
  private fun probeKeystore(withAuth: Boolean): String {
    for (strongBox in listOf(true, false)) {
      try {
        generate(PROBE_ALIAS, strongBox, withAuth)
        return if (strongBox) "strongbox" else "tee"
      } catch (_: StrongBoxUnavailableException) {
        continue
      } catch (_: Exception) {
        if (!strongBox) return "failed"
      } finally {
        deleteAlias(PROBE_ALIAS)
      }
    }
    return "failed"
  }

  @Command
  fun enrol(invoke: Invoke) {
    val vaultId = invoke.getArgs().getString("vaultId")
    val title = invoke.getArgs().optString("title", "Add this phone to the silo")
    val tag = ByteArray(TAG_LEN).also { SecureRandom().nextBytes(it) }
    val alias = ALIAS_PREFIX + hex(tag)

    val strongBox = try {
      generate(alias, strongBox = true, withAuth = true)
      true
    } catch (_: StrongBoxUnavailableException) {
      try {
        generate(alias, strongBox = false, withAuth = true)
      } catch (e: Exception) {
        invoke.reject("This phone's key storage refused to make a key: ${e.message}")
        return
      }
      false
    } catch (e: Exception) {
      invoke.reject("This phone's key storage refused to make a key: ${e.message}")
      return
    }

    val cipher = try {
      Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, loadKey(alias)) }
    } catch (e: Exception) {
      deleteAlias(alias)
      invoke.reject("Could not start the key: ${e.message}")
      return
    }

    prompt(cipher, title, invoke, onFail = { deleteAlias(alias) }) { authed ->
      val wrapKey = ByteArray(32).also { SecureRandom().nextBytes(it) }
      try {
        authed.updateAAD(associatedData(vaultId))
        val sealed = authed.doFinal(wrapKey)
        val nonce = authed.iv
        if (nonce.size != NONCE_LEN || sealed.size != WRAPPED_LEN) {
          throw IllegalStateException("unexpected sizes ${nonce.size}/${sealed.size}")
        }
        val result = JSObject()
        result.put("credentialId", hex(tag + nonce + sealed))
        result.put("wrapKey", hex(wrapKey))
        result.put("strongBox", strongBox)
        invoke.resolve(result)
      } catch (e: Exception) {
        deleteAlias(alias)
        invoke.reject("Could not seal the key: ${e.message}")
      } finally {
        wrapKey.fill(0)
      }
    }
  }

  @Command
  fun unlock(invoke: Invoke) {
    val args = invoke.getArgs()
    val vaultId = args.getString("vaultId")
    val title = args.optString("title", "Unlock the silo")
    val ids = args.getJSONArray("credentialIds")

    for (i in 0 until ids.length()) {
      val id = unhex(ids.getString(i)) ?: continue
      if (id.size != ID_LEN) continue
      val tag = id.copyOfRange(0, TAG_LEN)
      val nonce = id.copyOfRange(TAG_LEN, TAG_LEN + NONCE_LEN)
      val sealed = id.copyOfRange(TAG_LEN + NONCE_LEN, ID_LEN)
      val alias = ALIAS_PREFIX + hex(tag)
      val key = try { loadKey(alias) } catch (_: Exception) { null } ?: continue

      val cipher = try {
        Cipher.getInstance(TRANSFORM).apply {
          init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        }
      } catch (_: KeyPermanentlyInvalidatedException) {
        invoke.reject(
          "The fingerprints or faces on this phone changed, so its silo key no longer works. Unlock with the recovery code and add the phone again.",
          "invalidated",
        )
        return
      } catch (e: Exception) {
        invoke.reject("Could not start the key: ${e.message}")
        return
      }

      prompt(cipher, title, invoke, onFail = {}) { authed ->
        try {
          authed.updateAAD(associatedData(vaultId))
          val wrapKey = authed.doFinal(sealed)
          val result = JSObject()
          result.put("credentialId", hex(id))
          result.put("wrapKey", hex(wrapKey))
          wrapKey.fill(0)
          invoke.resolve(result)
        } catch (e: Exception) {
          invoke.reject("This phone's key did not open the silo: ${e.message}")
        }
      }
      return
    }
    invoke.reject("This phone holds no key for this silo.", "absent")
  }

  @Command
  fun remove(invoke: Invoke) {
    val id = unhex(invoke.getArgs().getString("credentialId"))
    if (id != null && id.size == ID_LEN) {
      deleteAlias(ALIAS_PREFIX + hex(id.copyOfRange(0, TAG_LEN)))
    }
    invoke.resolve()
  }

  private fun generate(alias: String, strongBox: Boolean, withAuth: Boolean) {
    val spec = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setIsStrongBoxBacked(strongBox)
    if (withAuth) {
      spec
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        .setInvalidatedByBiometricEnrollment(true)
    }
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply {
      init(spec.build())
      generateKey()
    }
  }

  private fun loadKey(alias: String): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    return store.getKey(alias, null) as SecretKey?
  }

  private fun deleteAlias(alias: String) {
    try {
      KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(alias)
    } catch (_: Exception) {
    }
  }

  // The same per-vault string the FIDO2 path salts with.
  private fun associatedData(vaultId: String) = "silentsilo-dek-v1:$vaultId".toByteArray()

  private fun prompt(
    cipher: Cipher,
    title: String,
    invoke: Invoke,
    onFail: () -> Unit,
    onSuccess: (Cipher) -> Unit,
  ) {
    activity.runOnUiThread {
      val prompt = BiometricPrompt.Builder(activity)
        .setTitle(title)
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButton("Cancel", activity.mainExecutor) { _, _ ->
          onFail()
          invoke.reject("Cancelled.", "cancelled")
        }
        .build()
      prompt.authenticate(
        BiometricPrompt.CryptoObject(cipher),
        CancellationSignal(),
        activity.mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val authed = result.cryptoObject?.cipher
            if (authed == null) {
              onFail()
              invoke.reject("The prompt returned no key.")
            } else {
              onSuccess(authed)
            }
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            onFail()
            val code = if (errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
              errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
            ) "cancelled" else "biometric"
            invoke.reject(errString.toString(), code)
          }
        },
      )
    }
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun unhex(text: String): ByteArray? {
    if (text.length % 2 != 0) return null
    return try {
      ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    } catch (_: NumberFormatException) {
      null
    }
  }
}
