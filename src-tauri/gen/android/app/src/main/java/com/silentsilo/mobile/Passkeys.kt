package com.silentsilo.mobile

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.net.Uri
import android.util.Base64
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotSupportedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

// Who is asking for a passkey, as the WebAuthn origin a site checks.
object PasskeyCaller {
  // Browsers the platform vouches for, which pass a site's origin and their
  // own client data hash: Google's list of privileged apps
  // (gstatic.com/gpm-passkeys-privileged-apps/apps.json), release builds
  // only. A browser missing from it is treated as the app it is, and apps
  // are refused (core's `passkey::check_origin`).
  private fun allowlist(context: Context): String =
    try {
      context.assets.open("privileged_browsers.json").bufferedReader().use { it.readText() }
    } catch (_: Exception) {
      """{"apps":[]}"""
    }

  class Origin(val origin: String, val packageName: String, val privileged: Boolean)

  fun of(context: Context, info: CallingAppInfo): Origin {
    val browser = try { info.getOrigin(allowlist(context)) } catch (_: Exception) { null }
    if (browser != null) return Origin(browser.trimEnd('/'), info.packageName, true)
    // An app: its signing certificate, which the relying party lists as its
    // own app or does not.
    @Suppress("DEPRECATION")
    val signer = info.signingInfo.apkContentsSigners.firstOrNull()?.toByteArray() ?: ByteArray(0)
    val hash = MessageDigest.getInstance("SHA-256").digest(signer)
    val encoded = Base64.encodeToString(hash, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    return Origin("android:apk-key-hash:$encoded", info.packageName, false)
  }

  fun hex(bytes: ByteArray?): String = bytes?.joinToString("") { "%02x".format(it) } ?: ""

  // The site a request is for, to name it in the fingerprint prompt.
  fun site(requestJson: String, origin: String): String {
    val json = try { JSONObject(requestJson) } catch (_: Exception) { null }
    val named = json?.optJSONObject("rp")?.optString("id")?.ifEmpty { null }
      ?: json?.optString("rpId")?.ifEmpty { null }
    return named ?: Uri.parse(origin).host ?: origin
  }

  const val NOT_A_BROWSER = "Only a browser can use passkeys from SilentSilo for now."
}

// SilentSilo as a passkey provider (Android 14+). Offers to save a new
// passkey into the silo, and the site's passkeys when asked to sign in.
// Every use goes through a fingerprint on the phone's silo key.
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class PasskeyService : CredentialProviderService() {
  companion object {
    // Each entry needs its own request code, or a later PendingIntent
    // replaces an earlier one's extras and every entry signs with the last.
    private val codes = AtomicInteger()
  }

  private fun intent(target: Class<*>, extras: Bundle.() -> Unit): PendingIntent {
    val intent = Intent(this, target).apply { putExtras(Bundle().apply(extras)) }
    return PendingIntent.getActivity(this, codes.incrementAndGet(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  override fun onBeginCreateCredentialRequest(
    request: BeginCreateCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
  ) {
    if (request !is BeginCreatePublicKeyCredentialRequest) {
      callback.onError(CreateCredentialUnknownException("SilentSilo keeps passkeys only"))
      return
    }
    val info = request.callingAppInfo
    if (info == null || !PasskeyCaller.of(this, info).privileged) {
      callback.onError(CreateCredentialUnknownException(PasskeyCaller.NOT_A_BROWSER))
      return
    }
    Thread {
      Native.start(applicationContext)
      val silo = JSONObject(Native.autofillSilo(applicationContext.dataDir.absolutePath))
      if (silo.optString("vaultId").isEmpty()) {
        callback.onError(CreateCredentialUnknownException("There is no silo on this phone"))
        return@Thread
      }
      val entry = CreateEntry.Builder(silo.optString("name", "SilentSilo"), intent(PasskeyCreateActivity::class.java) {})
        .setDescription("Saved in your silo and synced to its backup")
        .build()
      callback.onResult(BeginCreateCredentialResponse.Builder().addCreateEntry(entry).build())
    }.start()
  }

  override fun onBeginGetCredentialRequest(
    request: BeginGetCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
  ) {
    val dataDir = applicationContext.dataDir.absolutePath
    val caller = request.callingAppInfo?.let { PasskeyCaller.of(this, it) }
    // Apps get no entries rather than an error, so their own sign-in or
    // another provider's still shows.
    if (caller == null || !caller.privileged) {
      callback.onResult(BeginGetCredentialResponse.Builder().build())
      return
    }
    Thread { callback.onResult(offer(dataDir, caller.origin, request)) }.start()
  }

  private fun offer(dataDir: String, origin: String, request: BeginGetCredentialRequest): BeginGetCredentialResponse {
    Native.start(applicationContext)
    val response = BeginGetCredentialResponse.Builder()
    for (option in request.beginGetCredentialOptions.filterIsInstance<BeginGetPublicKeyCredentialOption>()) {
      val overview = JSONObject(Native.passkeyOverview(dataDir, option.requestJson, origin))
      if (overview.optString("vaultId").isEmpty() && !overview.optBoolean("open")) continue
      if (overview.optBoolean("open")) {
        val found = overview.optJSONArray("passkeys") ?: continue
        for (i in 0 until found.length()) {
          val passkey = found.getJSONObject(i)
          val entry = PublicKeyCredentialEntry.Builder(
            this,
            passkey.optString("userName"),
            intent(PasskeyGetActivity::class.java) { putString(PasskeyGetActivity.PASSKEY, passkey.optString("id")) },
            option,
          ).setDisplayName(passkey.optString("displayName").ifEmpty { null }).build()
          response.addCredentialEntry(entry)
        }
      } else {
        // Locked: which passkeys this site has is inside the silo. One entry
        // that unlocks and then offers them.
        val entry = PublicKeyCredentialEntry.Builder(
          this,
          "Passkey in ${overview.optString("name", "SilentSilo")}",
          intent(PasskeyGetActivity::class.java) {},
          option,
        ).build()
        response.addCredentialEntry(entry)
      }
    }
    return response.build()
  }

  override fun onClearCredentialStateRequest(
    request: ProviderClearCredentialStateRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<Void?, ClearCredentialException>,
  ) {
    callback.onResult(null)
  }
}

// Shared by both activities: a fingerprint on the phone's silo key, then
// `use` with the unwrapped key.
private fun Activity.withSiloKey(
  title: String,
  use: (credentialId: String, wrapKey: String) -> Unit,
  failed: (message: String, cancelled: Boolean) -> Unit,
) {
  Native.start(applicationContext)
  val silo = JSONObject(Native.autofillSilo(applicationContext.dataDir.absolutePath))
  val vaultId = silo.optString("vaultId")
  if (vaultId.isEmpty()) return failed("There is no silo on this phone.", false)
  val ids = silo.optJSONArray("credentialIds")
  val list = (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) }
  PhoneKey.unlock(this, vaultId, list, title, onUnlocked = use, onFailed = {
    failed(it.message ?: "Cancelled.", it.code == "cancelled")
  })
}

// Opening the silo and signing take a moment; off the main thread, answered
// back on it.
private fun Activity.inBackground(work: () -> JSONObject, then: (JSONObject) -> Unit) {
  Thread {
    val answer = try { work() } catch (e: Exception) { JSONObject().put("error", e.message ?: "Failed.") }
    runOnUiThread { then(answer) }
  }.start()
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class PasskeyCreateActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
    val call = request?.callingRequest as? CreatePublicKeyCredentialRequest ?: return fail("Not a passkey request")
    val caller = PasskeyCaller.of(this, request.callingAppInfo)
    if (!caller.privileged) return fail(PasskeyCaller.NOT_A_BROWSER)
    val hash = PasskeyCaller.hex(call.clientDataHash)
    val dataDir = applicationContext.dataDir.absolutePath
    val site = PasskeyCaller.site(call.requestJson, caller.origin)

    withSiloKey("Save a passkey for $site", use = { credentialId, wrapKey ->
      inBackground({
        JSONObject(Native.passkeyCreate(dataDir, credentialId, wrapKey, call.requestJson, caller.origin, caller.packageName, hash))
      }) { answer -> answered(answer) }
    }, failed = { message, cancelled -> fail(message, cancelled) })
  }

  private fun answered(answer: JSONObject) {
    val response = answer.optString("response")
    when {
      response.isNotEmpty() -> {
        val result = Intent()
        PendingIntentHandler.setCreateCredentialResponse(result, CreatePublicKeyCredentialResponse(response))
        setResult(RESULT_OK, result)
        finish()
      }
      answer.optString("code") == "excluded" -> finishWith(
        CreatePublicKeyCredentialDomException(InvalidStateError(), answer.optString("error"))
      )
      answer.optString("code") == "unsupported" -> finishWith(
        CreatePublicKeyCredentialDomException(NotSupportedError(), answer.optString("error"))
      )
      else -> fail(answer.optString("error", "The passkey was not saved."))
    }
  }

  private fun fail(message: String, cancelled: Boolean = false) =
    finishWith(if (cancelled) CreateCredentialCancellationException(message) else CreateCredentialUnknownException(message))

  private fun finishWith(error: CreateCredentialException) {
    val result = Intent()
    PendingIntentHandler.setCreateCredentialException(result, error)
    setResult(RESULT_OK, result)
    finish()
  }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class PasskeyGetActivity : Activity() {
  companion object {
    const val PASSKEY = "passkey"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return fail("No request")
    val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull()
      ?: return fail("Not a passkey request")
    val caller = PasskeyCaller.of(this, request.callingAppInfo)
    if (!caller.privileged) return fail(PasskeyCaller.NOT_A_BROWSER)
    val hash = PasskeyCaller.hex(option.clientDataHash)
    val dataDir = applicationContext.dataDir.absolutePath
    val chosen = intent.getStringExtra(PASSKEY)
    val site = PasskeyCaller.site(option.requestJson, caller.origin)

    withSiloKey("Sign in to $site", use = { credentialId, wrapKey ->
      fun sign(passkeyId: String) = inBackground({
        JSONObject(Native.passkeyAssert(dataDir, credentialId, wrapKey, passkeyId, option.requestJson, caller.origin, caller.packageName, hash))
      }) { answer ->
        val response = answer.optString("response")
        if (response.isEmpty()) {
          fail(answer.optString("error", "The sign-in was not signed."))
        } else {
          val result = Intent()
          PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(PublicKeyCredential(response)))
          setResult(RESULT_OK, result)
          finish()
        }
      }
      if (chosen != null) return@withSiloKey sign(chosen)

      // Offered while locked: which passkey, now that the silo is open.
      inBackground({
        JSONObject(Native.passkeyFind(dataDir, credentialId, wrapKey, option.requestJson, caller.origin))
      }) { found ->
        val passkeys = found.optJSONArray("passkeys")
        when {
          passkeys == null -> fail(found.optString("error", "The silo did not open."))
          passkeys.length() == 0 -> fail("The silo has no passkey for this site.")
          passkeys.length() == 1 -> sign(passkeys.getJSONObject(0).optString("id"))
          else -> pick(site, (0 until passkeys.length()).map { passkeys.getJSONObject(it) }) { sign(it) }
        }
      }
    }, failed = { message, cancelled -> fail(message, cancelled) })
  }

  private fun pick(site: String, items: List<JSONObject>, chosen: (String) -> Unit) {
    val dialog = AlertDialog.Builder(this)
      .setTitle("Choose a passkey for $site")
      .setItems(items.map { it.optString("displayName").ifEmpty { it.optString("userName") } }.toTypedArray()) { _, which ->
        chosen(items[which].optString("id"))
      }
      .setOnCancelListener { fail("Cancelled.", cancelled = true) }
      .create()
    // Account names stay out of screenshots, as in the activity.
    dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    dialog.show()
  }

  private fun fail(message: String, cancelled: Boolean = false) {
    val result = Intent()
    PendingIntentHandler.setGetCredentialException(
      result,
      if (cancelled) GetCredentialCancellationException(message) else GetCredentialUnknownException(message),
    )
    setResult(RESULT_OK, result)
    finish()
  }
}
