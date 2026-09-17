package com.silentsilo.mobile

import android.app.Activity
import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.RemoteViews
import android.widget.SimpleAdapter
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.security.MessageDigest

// The SHA-256 of each certificate an app is signed with, oldest first. It
// is the only thing about another app that cannot be chosen freely: the
// package name is unique on the phone but can be taken over once the real
// app is gone, and the label is whatever the app says.
object Signing {
  fun digests(context: Context, packageName: String): List<ByteArray> {
    return try {
      val signing = context.packageManager
        .getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        .signingInfo
      val certs = when {
        signing == null -> emptyArray()
        signing.hasMultipleSigners() -> signing.apkContentsSigners
        else -> signing.signingCertificateHistory
      }
      certs.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()) }
    } catch (_: Exception) {
      // Android may refuse to say the app exists at all; the package name
      // then has to carry the match on its own.
      emptyList()
    }
  }
}

// What an app is, as an entry records it: `android://<cert>@<package>`, the
// form Android itself uses for an app origin. The certificate is left out
// when the phone will not say what it is.
object AppOrigin {
  private const val SCHEME = "android://"

  fun of(context: Context, packageName: String): String {
    val cert = Signing.digests(context, packageName).lastOrNull()?.let(::encode)
    return if (cert == null) "$SCHEME$packageName" else "$SCHEME$cert@$packageName"
  }

  // The package and the certificate an entry's url names, or null when the
  // url is not an app origin.
  fun parse(url: String): Pair<String, String?>? {
    if (!url.startsWith(SCHEME, ignoreCase = true)) return null
    val rest = url.substring(SCHEME.length).substringBefore('/').trim()
    val at = rest.lastIndexOf('@')
    val packageName = if (at < 0) rest else rest.substring(at + 1)
    val cert = if (at < 0) null else rest.substring(0, at).takeIf { it.isNotEmpty() }
    return if (packageName.isEmpty()) null else packageName to cert
  }

  // A certificate an entry recorded must still be one of the app's own. A
  // key rotation keeps the old one in the app's history, so it matches too.
  fun signedBy(context: Context, packageName: String, cert: String?): Boolean {
    if (cert == null) return true
    return Signing.digests(context, packageName).map(::encode).contains(cert)
  }

  private fun encode(digest: ByteArray): String =
    Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

// Browsers whose word about the site on screen is believed: the same list
// the passkey provider uses, checked by signing certificate. Any other app
// can put any site name in its own views.
object TrustedBrowsers {
  @Volatile private var fingerprints: Map<String, Set<String>>? = null

  private fun load(context: Context): Map<String, Set<String>> =
    fingerprints ?: try {
      val json = JSONObject(context.assets.open("privileged_browsers.json").bufferedReader().use { it.readText() })
      val apps = json.getJSONArray("apps")
      (0 until apps.length()).associate { i ->
        val info = apps.getJSONObject(i).getJSONObject("info")
        val signatures = info.getJSONArray("signatures")
        info.getString("package_name") to (0 until signatures.length())
          .map { signatures.getJSONObject(it) }
          .filter { it.optString("build") == "release" }
          .map { it.getString("cert_fingerprint_sha256").replace(":", "").lowercase() }
          .toSet()
      }
    } catch (_: Exception) {
      emptyMap()
    }.also { fingerprints = it }

  fun contains(context: Context, packageName: String): Boolean {
    val allowed = load(context)[packageName] ?: return false
    return Signing.digests(context, packageName)
      .any { digest -> digest.joinToString("") { "%02x".format(it) } in allowed }
  }
}

// The fields of one form, and what the form belongs to. `webDomain` is the
// site the password field sits in, and only when a trusted browser says so.
class FormFields(val username: AutofillId?, val password: AutofillId?, val webDomain: String?, val packageName: String) {
  val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

  companion object {
    fun from(context: Context, structure: AssistStructure): FormFields {
      var username: AutofillId? = null
      var password: AutofillId? = null
      var domain: String? = null

      // The site of the password field itself, from its nearest page: a
      // frame from another site on the same screen does not lend its name.
      fun visit(node: AssistStructure.ViewNode, site: String?) {
        val here = node.webDomain?.takeIf { it.isNotBlank() } ?: site
        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
          when {
            password == null && isPassword(node) -> {
              password = id
              domain = here
            }
            username == null && isUsername(node) -> username = id
          }
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i), here)
      }
      for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode, null)
      val packageName = structure.activityComponent.packageName
      val trusted = domain?.takeIf { TrustedBrowsers.contains(context, packageName) }
      return FormFields(username, password, trusted?.lowercase()?.removePrefix("www."), packageName)
    }

    // What was typed into the username and password fields, for saving.
    fun typed(structure: AssistStructure, fields: FormFields): Pair<String, String> {
      var user = ""
      var pass = ""
      fun visit(node: AssistStructure.ViewNode) {
        val text = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
        if (text != null) {
          if (node.autofillId == fields.username) user = text
          if (node.autofillId == fields.password) pass = text
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i))
      }
      for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
      return user to pass
    }

    // Offered with every response, so a login typed by hand can be kept.
    fun saveInfo(fields: FormFields): SaveInfo {
      val builder = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_USERNAME or SaveInfo.SAVE_DATA_TYPE_PASSWORD, arrayOf(fields.password!!))
      fields.username?.let { builder.setOptionalIds(arrayOf(it)) }
      return builder.build()
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
    val fields = FormFields.from(this, structure)
    // Never offered inside SilentSilo itself, and only where there is a password.
    if (fields.password == null || fields.packageName == packageName) return callback.onSuccess(null)

    val intent = Intent(this, AutofillUnlockActivity::class.java)
      .putExtra(AutofillUnlockActivity.USERNAME, fields.username)
      .putExtra(AutofillUnlockActivity.PASSWORD, fields.password)
      .putExtra(AutofillUnlockActivity.DOMAIN, fields.webDomain)
      .putExtra(AutofillUnlockActivity.PACKAGE, fields.packageName)
      .putExtra(AutofillUnlockActivity.APP_LABEL, appLabel(this, fields.packageName))
    val sender = PendingIntent.getActivity(
      this,
      System.nanoTime().toInt(),
      intent,
      PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE,
    ).intentSender
    val response = FillResponse.Builder()
      .setAuthentication(fields.ids, sender, AutofillUnlockActivity.row(this, "Fill from SilentSilo"))
      .setSaveInfo(FormFields.saveInfo(fields))
      .build()
    callback.onSuccess(response)
  }

  // Android asked "Save to SilentSilo?" and the user said yes. Saving needs
  // the silo open, so it happens in an activity that can ask for a
  // fingerprint.
  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess()
    val fields = FormFields.from(this, structure)
    val (user, pass) = FormFields.typed(structure, fields)
    if (pass.isEmpty() || fields.packageName == packageName) return callback.onSuccess()

    val label = appLabel(this, fields.packageName)
    val intent = Intent(this, AutofillSaveActivity::class.java)
      .putExtra(AutofillSaveActivity.USERNAME, user)
      .putExtra(AutofillSaveActivity.PASSWORD, pass)
      .putExtra(AutofillSaveActivity.DOMAIN, fields.webDomain)
      .putExtra(AutofillSaveActivity.APP_LABEL, label)
      // What the login is for, as the entry will record it: the site from a
      // trusted browser, otherwise the app that asked. Autofill offers a
      // login again only to the same one.
      .putExtra(AutofillSaveActivity.ORIGIN, AppOrigin.of(this, fields.packageName))
      .putExtra(AutofillSaveActivity.PACKAGE, fields.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val sender = PendingIntent.getActivity(
      this,
      System.nanoTime().toInt(),
      intent,
      PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    ).intentSender
    callback.onSuccess(sender)
  }
}

fun appLabel(context: Context, packageName: String): String =
  try {
    context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(packageName, 0)).toString()
  } catch (_: Exception) {
    packageName
  }

// Unlocks the silo with the phone's key, then offers the logins saved for
// this app or site. A fingerprint every time, open silo or not: whatever
// asks is another app, and the prompt names where the login goes, by
// package name when the app is not a browser. Nothing else is offered on
// its own; the rest of the silo is behind a search the user does here.
class AutofillUnlockActivity : Activity() {
  companion object {
    const val USERNAME = "username"
    const val PASSWORD = "password"
    const val DOMAIN = "domain"
    const val PACKAGE = "package"
    const val APP_LABEL = "appLabel"
    private const val MAX_OFFERED = 20

    fun row(context: android.content.Context, text: String): RemoteViews =
      RemoteViews(context.packageName, R.layout.autofill_row).apply { setTextViewText(R.id.autofill_text, text) }
  }

  // The site, or the app by label and package. A label alone is worth
  // nothing: an app picks its own.
  private val asked: String by lazy {
    intent.getStringExtra(DOMAIN)
      ?: intent.getStringExtra(PACKAGE)?.let { pkg ->
        val label = intent.getStringExtra(APP_LABEL)
        if (label.isNullOrBlank() || label == pkg) pkg else "$label ($pkg)"
      }
      ?: "this app"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    Native.start(applicationContext)
    val dataDir = applicationContext.dataDir.absolutePath

    val silo = JSONObject(Native.autofillSilo(dataDir))
    val vaultId = silo.optString("vaultId")
    if (vaultId.isEmpty()) return finishWith(null)

    val ids = silo.optJSONArray("credentialIds")
    val list = (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) }
    PhoneKey.unlock(
      this,
      vaultId,
      list,
      "Fill a login",
      asked,
      onUnlocked = { credentialId, wrapKey -> offer(Native.autofillLogins(dataDir, credentialId, wrapKey)) },
      onFailed = { finishWith(null) },
    )
  }

  private fun offer(answer: String) {
    val json = JSONObject(answer)
    val logins = json.optJSONArray("logins") ?: return finishWith(null)
    val domain = intent.getStringExtra(DOMAIN)
    val pkg = intent.getStringExtra(PACKAGE) ?: ""

    val all = (0 until logins.length()).map { logins.getJSONObject(it) }
    val matched = all
      .map { it to Matching.score(this, it.optString("url"), domain, pkg) }
      .filter { it.second > 0 }
      .sortedByDescending { it.second }
      .map { it.first }
      .take(MAX_OFFERED)

    if (matched.isEmpty()) search(all) else finishWith(responseFor(matched))
  }

  private fun responseFor(logins: List<JSONObject>): FillResponse? {
    val username = intentId(USERNAME)
    val password = intentId(PASSWORD) ?: return null
    val response = FillResponse.Builder()
    for (login in logins) {
      val label = listOf(login.optString("service"), login.optString("username")).filter { it.isNotBlank() }.joinToString(" · ")
      val dataset = Dataset.Builder(row(this, label))
      @Suppress("DEPRECATION")
      if (username != null) dataset.setValue(username, AutofillValue.forText(login.optString("username")))
      @Suppress("DEPRECATION")
      dataset.setValue(password, AutofillValue.forText(login.optString("password")))
      response.addDataset(dataset.build())
    }
    if (logins.isEmpty()) return null
    response.setSaveInfo(FormFields.saveInfo(FormFields(username, password, intent.getStringExtra(DOMAIN), intent.getStringExtra(PACKAGE) ?: "")))
    return response.build()
  }

  // Nothing is saved for what asked. The whole silo is here, but the user
  // has to find the login and choose it, and the screen says what asked for
  // it, so a login is never handed to an app that only looks the part.
  private fun search(logins: List<JSONObject>) {
    if (logins.isEmpty()) return finishWith(null)
    setContentView(R.layout.autofill_pick)
    findViewById<TextView>(R.id.autofill_pick_title).text = "Nothing saved for $asked"
    val list = findViewById<ListView>(R.id.autofill_pick_list)
    val sorted = logins.sortedBy { it.optString("service").lowercase() }
    var shown = sorted

    fun render(query: String) {
      shown = sorted.filter {
        query.isBlank() ||
          it.optString("service").contains(query, true) ||
          it.optString("username").contains(query, true) ||
          it.optString("url").contains(query, true)
      }
      list.adapter = SimpleAdapter(
        this,
        shown.map { mapOf("service" to it.optString("service"), "username" to it.optString("username")) },
        R.layout.autofill_pick_row,
        arrayOf("service", "username"),
        intArrayOf(R.id.autofill_pick_service, R.id.autofill_pick_username),
      )
    }

    render("")
    list.setOnItemClickListener { _, _, position, _ ->
      shown.getOrNull(position)?.let { finishWith(responseFor(listOf(it))) }
    }
    findViewById<EditText>(R.id.autofill_pick_search).addTextChangedListener(object : TextWatcher {
      override fun afterTextChanged(text: Editable?) = render(text?.toString() ?: "")
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
    })
    findViewById<Button>(R.id.autofill_pick_cancel).setOnClickListener { finishWith(null) }
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

// How well a login fits the app or site asking. 0 is no fit, and no fit is
// what everything the entry does not name gets: a login is offered to an
// app only when it was saved for that same app, and to a site only when it
// names that site. The rest is reached by searching the silo, which is a
// step the user takes rather than a row that looks like a suggestion.
object Matching {
  fun score(context: Context, url: String, webDomain: String?, packageName: String): Int {
    val app = AppOrigin.parse(url)
    if (webDomain != null) {
      // The stored site or a page below it (login.example.com for
      // example.com), never a neighbour under a shared suffix such as
      // github.io, and never a name that only looks alike.
      if (app != null) return 0
      val host = hostOf(url)
      val asked = webDomain.lowercase().removePrefix("www.")
      if (host == null || !host.contains('.')) return 0
      return when {
        host == asked -> 3
        asked.endsWith(".$host") -> 2
        else -> 0
      }
    }
    // An app asked. Its package name is the match, and the certificate the
    // entry recorded has to be one the app still signs with.
    if (app == null || !app.first.equals(packageName, ignoreCase = true)) return 0
    return if (AppOrigin.signedBy(context, packageName, app.second)) 3 else 0
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
}

// Stores a login Android offered to save: unlock, then add it or update the
// password of the same account.
class AutofillSaveActivity : Activity() {
  companion object {
    const val USERNAME = "username"
    const val PASSWORD = "password"
    const val DOMAIN = "domain"
    const val APP_LABEL = "appLabel"
    const val ORIGIN = "origin"
    const val PACKAGE = "package"
  }

  // A fingerprint every time. Only a trusted browser's site may change the
  // password of a login already kept; from any other app a login is added
  // beside it, since an app can call itself anything.
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    Native.start(applicationContext)
    val dataDir = applicationContext.dataDir.absolutePath

    val domain = intent.getStringExtra(DOMAIN)?.lowercase()?.removePrefix("www.")
    val packageName = intent.getStringExtra(PACKAGE)
    // An app's login records the app, so autofill can offer it back to that
    // app and to nothing else.
    val origin = domain?.let { "https://$it" } ?: intent.getStringExtra(ORIGIN) ?: ""
    val where = domain
      ?: packageName?.let { pkg ->
        val label = intent.getStringExtra(APP_LABEL)
        if (label.isNullOrBlank() || label == pkg) pkg else "$label ($pkg)"
      }
      ?: "this app"
    val login = JSONObject()
      .put("service", domain ?: intent.getStringExtra(APP_LABEL) ?: "")
      .put("username", intent.getStringExtra(USERNAME) ?: "")
      .put("password", intent.getStringExtra(PASSWORD) ?: "")
      .put("url", origin)
      .put("fromBrowser", domain != null)
      .toString()

    val silo = JSONObject(Native.autofillSilo(dataDir))
    val vaultId = silo.optString("vaultId")
    if (vaultId.isEmpty()) return done("There is no silo on this phone to save to.")

    val ids = silo.optJSONArray("credentialIds")
    PhoneKey.unlock(
      this,
      vaultId,
      (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) },
      "Save the login",
      where,
      onUnlocked = { credentialId, wrapKey -> save(Native.autofillSave(dataDir, credentialId, wrapKey, login)) },
      onFailed = { if (it.code == "cancelled") done(null) else done(it.message) },
    )
  }

  private fun save(answer: String) {
    val json = JSONObject(answer)
    done(
      when (json.optString("saved")) {
        "new" -> "Saved to SilentSilo."
        "updated" -> "Password updated in SilentSilo."
        "unchanged" -> "SilentSilo already has this login."
        else -> json.optString("error", "The login could not be saved.")
      }
    )
  }

  private fun done(message: String?) {
    if (message != null) Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    finish()
  }
}
