package com.silentsilo.mobile

import android.app.Activity
import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Bundle
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import org.json.JSONObject

// The fields of one form, and what the form belongs to.
class FormFields(val username: AutofillId?, val password: AutofillId?, val webDomain: String?, val packageName: String) {
  val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

  companion object {
    fun from(structure: AssistStructure): FormFields {
      var username: AutofillId? = null
      var password: AutofillId? = null
      var domain: String? = null

      fun visit(node: AssistStructure.ViewNode) {
        node.webDomain?.takeIf { it.isNotBlank() }?.let { domain = it }
        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
          when {
            password == null && isPassword(node) -> password = id
            username == null && isUsername(node) -> username = id
          }
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i))
      }
      for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
      return FormFields(username, password, domain, structure.activityComponent.packageName)
    }

    private fun html(node: AssistStructure.ViewNode, name: String): String? =
      node.htmlInfo?.attributes?.firstOrNull { it.first.equals(name, true) }?.second?.lowercase()

    private fun isPassword(node: AssistStructure.ViewNode): Boolean {
      if (node.autofillHints?.any { it.contains("password", true) } == true) return true
      if (html(node, "type") == "password") return true
      val variation = node.inputType and InputType.TYPE_MASK_VARIATION
      return node.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT &&
        (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
    }

    private fun isUsername(node: AssistStructure.ViewNode): Boolean {
      val hints = node.autofillHints
      if (hints?.any { it.contains("user", true) || it.contains("email", true) } == true) return true
      val auto = html(node, "autocomplete")
      if (auto != null && (auto.contains("username") || auto.contains("email"))) return true
      if (html(node, "type") == "email") return true
      val variation = node.inputType and InputType.TYPE_MASK_VARIATION
      if (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS) return true
      val words = listOfNotNull(node.idEntry, node.hint, html(node, "name"), html(node, "id")).joinToString(" ").lowercase()
      return listOf("user", "email", "e-mail", "login", "account", "phone").any { words.contains(it) }
    }
  }
}

// Offers "Unlock SilentSilo" on login forms. Nothing about the silo is read
// until the user unlocks, in AutofillUnlockActivity.
class SiloAutofillService : AutofillService() {
  override fun onFillRequest(request: FillRequest, cancellation: CancellationSignal, callback: FillCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
    val fields = FormFields.from(structure)
    // Never offered inside SilentSilo itself, and only where there is a password.
    if (fields.password == null || fields.packageName == packageName) return callback.onSuccess(null)

    val intent = Intent(this, AutofillUnlockActivity::class.java)
      .putExtra(AutofillUnlockActivity.USERNAME, fields.username)
      .putExtra(AutofillUnlockActivity.PASSWORD, fields.password)
      .putExtra(AutofillUnlockActivity.DOMAIN, fields.webDomain)
      .putExtra(AutofillUnlockActivity.PACKAGE, fields.packageName)
    val sender = PendingIntent.getActivity(
      this,
      System.nanoTime().toInt(),
      intent,
      PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE,
    ).intentSender
    val response = FillResponse.Builder()
      .setAuthentication(fields.ids, sender, AutofillUnlockActivity.row(this, "Fill from SilentSilo"))
      .build()
    callback.onSuccess(response)
  }

  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    callback.onSuccess()
  }
}

// Unlocks the silo with the phone's key, then offers the logins for this
// app or site, best matches first.
class AutofillUnlockActivity : Activity() {
  companion object {
    const val USERNAME = "username"
    const val PASSWORD = "password"
    const val DOMAIN = "domain"
    const val PACKAGE = "package"
    private const val MAX_OFFERED = 20

    fun row(context: android.content.Context, text: String): RemoteViews =
      RemoteViews(context.packageName, R.layout.autofill_row).apply { setTextViewText(R.id.autofill_text, text) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    Native.start(applicationContext)
    val dataDir = applicationContext.dataDir.absolutePath

    val silo = JSONObject(Native.autofillSilo(dataDir))
    val vaultId = silo.optString("vaultId")
    if (vaultId.isEmpty()) return finishWith(null)

    if (silo.optBoolean("open")) {
      offer(Native.autofillLogins(dataDir, "", ""))
      return
    }
    val ids = silo.optJSONArray("credentialIds")
    val list = (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) }
    PhoneKey.unlock(
      this,
      vaultId,
      list,
      "Unlock ${silo.optString("name", "the silo")} to fill",
      onUnlocked = { credentialId, wrapKey -> offer(Native.autofillLogins(dataDir, credentialId, wrapKey)) },
      onFailed = { finishWith(null) },
    )
  }

  private fun offer(answer: String) {
    val json = JSONObject(answer)
    val logins = json.optJSONArray("logins") ?: return finishWith(null)
    val username = intentId(USERNAME)
    val password = intentId(PASSWORD) ?: return finishWith(null)
    val domain = intent.getStringExtra(DOMAIN)
    val pkg = intent.getStringExtra(PACKAGE) ?: ""

    val scored = (0 until logins.length()).map { logins.getJSONObject(it) }
      .map { it to Matching.score(it.optString("url"), it.optString("service"), domain, pkg) }
    val matched = scored.filter { it.second > 0 }.sortedByDescending { it.second }.map { it.first }
    // With no match, every login, so a site the entry does not name is still one tap away.
    val offered = (matched.ifEmpty { scored.map { it.first }.sortedBy { it.optString("service").lowercase() } }).take(MAX_OFFERED)

    val response = FillResponse.Builder()
    for (login in offered) {
      val label = listOf(login.optString("service"), login.optString("username")).filter { it.isNotBlank() }.joinToString(" · ")
      val dataset = Dataset.Builder(row(this, label))
      @Suppress("DEPRECATION")
      if (username != null) dataset.setValue(username, AutofillValue.forText(login.optString("username")))
      @Suppress("DEPRECATION")
      dataset.setValue(password, AutofillValue.forText(login.optString("password")))
      response.addDataset(dataset.build())
    }
    finishWith(if (offered.isEmpty()) null else response.build())
  }

  @Suppress("DEPRECATION")
  private fun intentId(name: String): AutofillId? = intent.getParcelableExtra(name)

  private fun finishWith(response: FillResponse?) {
    if (response != null) {
      setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))
    } else {
      setResult(RESULT_CANCELED)
    }
    finish()
  }
}

// How well a login fits the app or site asking. 0 is no fit.
object Matching {
  fun score(url: String, service: String, webDomain: String?, packageName: String): Int {
    val host = hostOf(url)
    if (webDomain != null) {
      val asked = webDomain.lowercase().removePrefix("www.")
      if (host != null) {
        if (host == asked) return 3
        if (registrable(host) == registrable(asked)) return 2
      }
      return if (service.isNotBlank() && label(asked) == service.lowercase().filter { it.isLetterOrDigit() }) 1 else 0
    }
    // An app: its package names the company often enough, e.g. com.github.android.
    val parts = packageName.lowercase().split('.').filter { it.length > 2 && it !in setOf("com", "org", "net", "android", "app", "mobile") }
    val names = listOfNotNull(host?.let { label(it) }, service.lowercase().filter { it.isLetterOrDigit() }.takeIf { it.length > 2 })
    return if (names.any { name -> parts.any { it == name } }) 2 else 0
  }

  private fun hostOf(url: String): String? {
    if (url.isBlank()) return null
    val withScheme = if (url.contains("://")) url else "https://$url"
    return try {
      android.net.Uri.parse(withScheme).host?.lowercase()?.removePrefix("www.")
    } catch (_: Exception) {
      null
    }
  }

  // The last two labels, or three under a short country second level
  // (example.co.uk). Close enough to tell sites apart without a suffix list.
  private fun registrable(host: String): String {
    val labels = host.split('.')
    if (labels.size <= 2) return host
    val secondLevel = labels[labels.size - 2]
    val take = if (labels.last().length == 2 && secondLevel.length <= 3) 3 else 2
    return labels.takeLast(take).joinToString(".")
  }

  private fun label(host: String): String {
    val parts = registrable(host).split('.')
    return parts.first().filter { it.isLetterOrDigit() }
  }
}
