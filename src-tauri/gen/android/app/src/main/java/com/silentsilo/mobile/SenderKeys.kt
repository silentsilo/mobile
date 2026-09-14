package com.silentsilo.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

// The key this phone signs inbox items with, one per silo. No
// authentication, because it signs in the background; it opens nothing, so
// a stolen phone can only send items until its silo key is removed. Format:
// core FORMATS.md, "The inbox".
object SenderKeys {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val POINT_LEN = 65

  private fun alias(vaultId: String) = "silentsilo-sender-$vaultId"

  // The uncompressed P-256 point, made on first use.
  @JvmStatic
  @Synchronized
  fun publicKey(vaultId: String): ByteArray? =
    try {
      val store = keyStore()
      if (!store.containsAlias(alias(vaultId))) generate(vaultId)
      val point = (store.getCertificate(alias(vaultId)).publicKey as ECPublicKey).w
      val out = ByteArray(POINT_LEN)
      out[0] = 0x04
      fixed(point.affineX).copyInto(out, 1)
      fixed(point.affineY).copyInto(out, 33)
      out
    } catch (_: Exception) {
      null
    }

  // A DER ECDSA signature over SHA-256 of `message`.
  @JvmStatic
  fun sign(vaultId: String, message: ByteArray): ByteArray? {
    return try {
      val key = keyStore().getKey(alias(vaultId), null) as PrivateKey? ?: return null
      Signature.getInstance("SHA256withECDSA").run {
        initSign(key)
        update(message)
        sign()
      }
    } catch (_: Exception) {
      null
    }
  }

  @JvmStatic
  fun remove(vaultId: String) {
    try {
      keyStore().deleteEntry(alias(vaultId))
    } catch (_: Exception) {
    }
  }

  private fun generate(vaultId: String) {
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
      initialize(
        KeyGenParameterSpec.Builder(alias(vaultId), KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .build()
      )
      generateKeyPair()
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  // 32 bytes, big-endian: BigInteger adds a sign byte or drops leading zeros.
  private fun fixed(value: BigInteger): ByteArray {
    val raw = value.toByteArray()
    val out = ByteArray(32)
    val take = minOf(raw.size, 32)
    raw.copyInto(out, 32 - take, raw.size - take, raw.size)
    return out
  }
}
