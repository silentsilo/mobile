package com.silentsilo.mobile

import android.app.Activity
import android.app.AlertDialog
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
      // Android may refuse to say the app exists at all. The app is then
      // unknown: nothing is saved for it and nothing is filled on its own.
      emptyList()
    }
  }
}

// What an app is, as an entry records it: `android://<cert>@<package>`, the
// form Android itself uses for an app origin. Null when the phone will not
// say what the certificate is, since the package name alone can be taken.
object AppOrigin {
  private const val SCHEME = "android://"

  fun of(context: Context, packageName: String): String? {
    val cert = Signing.digests(context, packageName).lastOrNull()?.let(::encode) ?: return null
    return "$SCHEME$cert@$packageName"
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
  // An entry saved without one names only a package, which proves nothing.
  fun signedBy(context: Context, packageName: String, cert: String?): Boolean {
    if (cert == null) return false
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

// The fields of one form, and what the form belongs to. `webDomain` and
// `webScheme` are the page the password field sits in, and only when a
// trusted browser says so. `unverifiedPage` is a password field in a web
// page of any other app: the site it names proves nothing, so nothing is
// saved for it and nothing is offered on its own.
class FormFields(
  val username: AutofillId?,
  val password: AutofillId?,
  val webDomain: String?,
  val webScheme: String?,
  val unverifiedPage: Boolean,
  val packageName: String,
) {
  val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

  // Whether a login typed here may be kept: for a site a trusted browser
  // names, or for an app whose signing certificate can be read.
  fun savable(context: Context): Boolean =
    password != null && !unverifiedPage && (webDomain != null || AppOrigin.of(context, packageName) != null)

  companion object {
    fun from(context: Context, structure: AssistStructure): FormFields {
      var username: AutofillId? = null
      var password: AutofillId? = null
      var domain: String? = null
      var scheme: String? = null

      // The site of the password field itself, from its nearest page: a
      // frame from another site on the same screen does not lend its name.
      fun visit(node: AssistStructure.ViewNode, site: String?, siteScheme: String?) {
        val own = node.webDomain?.takeIf { it.isNotBlank() }
        val here = own ?: site
        val hereScheme = if (own != null) node.webScheme else siteScheme
        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
          when {
            password == null && isPassword(node) -> {
              password = id
              domain = here
              scheme = hereScheme
            }
            username == null && isUsername(node) -> username = id
          }
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i), here, hereScheme)
      }
      for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode, null, null)
      val packageName = structure.activityComponent.packageName
      val page = domain
      val trusted = page != null && TrustedBrowsers.contains(context, packageName)
      return FormFields(
        username,
        password,
        if (trusted) page?.lowercase() else null,
        if (trusted) scheme?.lowercase() else null,
        page != null && !trusted,
        packageName,
      )
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

    // Offered with every response for a form that is savable, so a login
    // typed by hand can be kept.
    fun saveInfo(username: AutofillId?, password: AutofillId): SaveInfo {
      val builder = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_USERNAME or SaveInfo.SAVE_DATA_TYPE_PASSWORD, arrayOf(password))
      username?.let { builder.setOptionalIds(arrayOf(it)) }
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
    val password = fields.password
    // Never offered inside SilentSilo itself, and only where there is a password.
    if (password == null || fields.packageName == packageName) return callback.onSuccess(null)
    val savable = fields.savable(this)

    val intent = Intent(this, AutofillUnlockActivity::class.java)
      .putExtra(AutofillUnlockActivity.USERNAME, fields.username)
      .putExtra(AutofillUnlockActivity.PASSWORD, password)
      .putExtra(AutofillUnlockActivity.DOMAIN, fields.webDomain)
      .putExtra(AutofillUnlockActivity.SCHEME, fields.webScheme)
      .putExtra(AutofillUnlockActivity.PACKAGE, fields.packageName)
      .putExtra(AutofillUnlockActivity.APP_LABEL, appLabel(this, fields.packageName))
      .putExtra(AutofillUnlockActivity.UNVERIFIED, fields.unverifiedPage)
      .putExtra(AutofillUnlockActivity.SAVABLE, savable)
    val sender = PendingIntent.getActivity(
      this,
      System.nanoTime().toInt(),
      intent,
      PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE,
    ).intentSender
    val response = FillResponse.Builder()
      .setAuthentication(fields.ids, sender, AutofillUnlockActivity.row(this, getString(R.string.autofill_fill_from)))
    // A page in an untrusted browser, or an app whose certificate cannot be
    // read, is never offered "Save to SilentSilo".
    if (savable) response.setSaveInfo(FormFields.saveInfo(fields.username, password))
    callback.onSuccess(response.build())
  }

  // Android asked "Save to SilentSilo?" and the user said yes. Saving needs
  // the silo open, so it happens in an activity that can ask for a
  // fingerprint.
  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess()
    val fields = FormFields.from(this, structure)
    if (fields.unverifiedPage || fields.packageName == packageName) return callback.onSuccess()
    val (user, pass) = FormFields.typed(structure, fields)
    if (pass.isEmpty()) return callback.onSuccess()
    // What the login is for, as the entry will record it: the site from a
    // trusted browser, otherwise the app that asked, with its certificate.
    // Autofill offers a login again only to the same one. An app whose
    // certificate cannot be read gets nothing saved.
    val origin = if (fields.webDomain != null) null else AppOrigin.of(this, fields.packageName)
    if (fields.webDomain == null && origin == null) return callback.onSuccess()

    val label = appLabel(this, fields.packageName)
    val intent = Intent(this, AutofillSaveActivity::class.java)
      .putExtra(AutofillSaveActivity.USERNAME, user)
      .putExtra(AutofillSaveActivity.PASSWORD, pass)
      .putExtra(AutofillSaveActivity.DOMAIN, fields.webDomain)
      .putExtra(AutofillSaveActivity.SCHEME, fields.webScheme)
      .putExtra(AutofillSaveActivity.APP_LABEL, label)
      .putExtra(AutofillSaveActivity.ORIGIN, origin)
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
// Android gets back only the one login the user ends up with.
class AutofillUnlockActivity : Activity() {
  companion object {
    const val USERNAME = "username"
    const val PASSWORD = "password"
    const val DOMAIN = "domain"
    const val SCHEME = "scheme"
    const val PACKAGE = "package"
    const val APP_LABEL = "appLabel"
    const val UNVERIFIED = "unverified"
    const val SAVABLE = "savable"

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
      getString(R.string.autofill_fill_title),
      asked,
      onUnlocked = { credentialId, wrapKey -> offer(Native.autofillLogins(dataDir, credentialId, wrapKey)) },
      // A key that is gone, changed or locked out is said, as on save; a
      // cancel just closes.
      onFailed = {
        val message = it.message
        if (it.code != "cancelled" && message != null) {
          Toast.makeText(applicationContext, message, Toast.LENGTH_LONG).show()
        }
        finishWith(null)
      },
    )
  }

  private fun offer(answer: String) {
    val json = JSONObject(answer)
    val logins = json.optJSONArray("logins") ?: return finishWith(null)
    val all = (0 until logins.length()).map { logins.getJSONObject(it) }

    // A web page in a browser that is not trusted: the site it names proves
    // nothing, so nothing is matched to it and the user searches instead.
    if (intent.getBooleanExtra(UNVERIFIED, false)) return search(all, unverified = true)

    val domain = intent.getStringExtra(DOMAIN)
    val scheme = intent.getStringExtra(SCHEME)
    val pkg = intent.getStringExtra(PACKAGE) ?: ""
    val matched = all
      .map { it to Matching.score(this, it.optString("url"), domain, scheme, pkg) }
      .filter { it.second > 0 }
      .sortedByDescending { it.second }
      .map { it.first }

    when {
      matched.isEmpty() -> search(all, unverified = false)
      matched.size == 1 -> finishWith(responseFor(matched[0]))
      else -> choose(matched)
    }
  }

  // The one login the user ends up with, and nothing else from the silo.
  private fun responseFor(login: JSONObject): FillResponse? {
    val username = intentId(USERNAME)
    val password = intentId(PASSWORD) ?: return null
    val label = listOf(login.optString("service"), login.optString("username")).filter { it.isNotBlank() }.joinToString(" · ")
    val dataset = Dataset.Builder(row(this, label))
    @Suppress("DEPRECATION")
    if (username != null) dataset.setValue(username, AutofillValue.forText(login.optString("username")))
    @Suppress("DEPRECATION")
    dataset.setValue(password, AutofillValue.forText(login.optString("password")))
    val response = FillResponse.Builder().addDataset(dataset.build())
    if (intent.getBooleanExtra(SAVABLE, false)) response.setSaveInfo(FormFields.saveInfo(username, password))
    return response.build()
  }

  // Several logins are saved for what asked: the user picks one here, and
  // only that one goes back.
  private fun choose(logins: List<JSONObject>) {
    setContentView(R.layout.autofill_pick)
    findViewById<TextView>(R.id.autofill_pick_title).text = getString(R.string.autofill_choose_for, asked)
    findViewById<View>(R.id.autofill_pick_note).visibility = View.GONE
    findViewById<View>(R.id.autofill_pick_search).visibility = View.GONE
    val list = findViewById<ListView>(R.id.autofill_pick_list)
    list.adapter = rows(logins)
    list.setOnItemClickListener { _, _, position, _ ->
      logins.getOrNull(position)?.let { finishWith(responseFor(it)) }
    }
    findViewById<Button>(R.id.autofill_pick_cancel).setOnClickListener { finishWith(null) }
  }

  // Nothing is saved for what asked, or what asked cannot prove its site.
  // The list stays empty until the user types a search, the screen says
  // what asked, and a login chosen here is confirmed once more, so a login
  // is never handed to an app that only looks the part.
  private fun search(logins: List<JSONObject>, unverified: Boolean) {
    if (logins.isEmpty()) return finishWith(null)
    setContentView(R.layout.autofill_pick)
    findViewById<TextView>(R.id.autofill_pick_title).text =
      if (unverified) getString(R.string.autofill_fill_title) else getString(R.string.autofill_nothing_saved, asked)
    if (unverified) {
      val warning = findViewById<TextView>(R.id.autofill_pick_warning)
      warning.text = getString(R.string.autofill_unverified_browser, asked)
      warning.visibility = View.VISIBLE
    }
    val list = findViewById<ListView>(R.id.autofill_pick_list)
    val sorted = logins.sortedBy { it.optString("service").lowercase() }
    var shown = emptyList<JSONObject>()

    fun render(query: String) {
      val words = query.trim()
      shown = if (words.isEmpty()) {
        emptyList()
      } else {
        sorted.filter {
          it.optString("service").contains(words, true) ||
            it.optString("username").contains(words, true) ||
            it.optString("url").contains(words, true)
        }
      }
      list.adapter = rows(shown)
    }

    render("")
    list.setOnItemClickListener { _, _, position, _ ->
      shown.getOrNull(position)?.let { confirm(it) }
    }
    findViewById<EditText>(R.id.autofill_pick_search).addTextChangedListener(object : TextWatcher {
      override fun afterTextChanged(text: Editable?) = render(text?.toString() ?: "")
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
    })
    findViewById<Button>(R.id.autofill_pick_cancel).setOnClickListener { finishWith(null) }
  }

  // Names both places side by side: where the login was saved and what is
  // asking for it now.
  private fun confirm(login: JSONObject) {
    val place = Matching.placeOf(login.optString("url"))
      ?: login.optString("service").ifBlank { login.optString("username") }
    val dialog = AlertDialog.Builder(this)
      .setTitle(R.string.autofill_confirm_title)
      .setMessage(getString(R.string.autofill_confirm_message, place, asked))
      .setPositiveButton(R.string.autofill_confirm_fill) { _, _ -> finishWith(responseFor(login)) }
      .setNegativeButton(R.string.cancel, null)
      .create()
    // Account names stay out of screenshots, as in the activity.
    dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    dialog.show()
  }

  private fun rows(logins: List<JSONObject>): SimpleAdapter =
    SimpleAdapter(
      this,
      logins.map { mapOf("service" to it.optString("service"), "username" to it.optString("username")) },
      R.layout.autofill_pick_row,
      arrayOf("service", "username"),
      intArrayOf(R.id.autofill_pick_service, R.id.autofill_pick_username),
    )

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
// names that same site. The rest is reached by searching the silo, which is
// a step the user takes rather than a row that looks like a suggestion.
object Matching {
  private val SCHEME_PREFIX = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)

  // A web address cut down to what a match compares. The port is -1 when
  // none is given or it is the scheme's default.
  private class Site(val scheme: String, val host: String, val port: Int)

  fun score(context: Context, url: String, webDomain: String?, webScheme: String?, packageName: String): Int {
    val app = AppOrigin.parse(url)
    if (webDomain != null) {
      // The same host, or its www. twin (example.com and www.example.com),
      // never a page above or below it, and never a name that only looks
      // alike. The scheme must agree too: a login kept for http:// never
      // goes to an https:// page or back, and one stored without a scheme
      // counts as https. A port other than the default must be the same.
      if (app != null) return 0
      val stored = site(url) ?: return 0
      val asked = site("${webScheme ?: "https"}://$webDomain") ?: return 0
      if (!bare(stored.host).contains('.')) return 0
      if (stored.scheme != asked.scheme || stored.port != asked.port) return 0
      return when {
        stored.host == asked.host -> 3
        bare(stored.host) == bare(asked.host) -> 2
        else -> 0
      }
    }
    // An app asked. Its package name is the match, and the certificate the
    // entry recorded has to be one the app still signs with.
    if (app == null || !app.first.equals(packageName, ignoreCase = true)) return 0
    return if (AppOrigin.signedBy(context, packageName, app.second)) 3 else 0
  }

  // Where a login was saved, for the user to read: the package of an app,
  // or the site's host. The scheme shows only when it is not https, and the
  // port only when it is not the default.
  fun placeOf(url: String): String? {
    AppOrigin.parse(url)?.let { return it.first }
    val s = site(url) ?: return null
    val scheme = if (s.scheme == "https") "" else "${s.scheme}://"
    val port = if (s.port < 0) "" else ":${s.port}"
    return "$scheme${s.host}$port"
  }

  private fun bare(host: String): String = host.removePrefix("www.")

  private fun site(url: String): Site? {
    val trimmed = url.trim()
    if (trimmed.isEmpty()) return null
    val full = if (SCHEME_PREFIX.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    return try {
      val uri = android.net.Uri.parse(full)
      val scheme = uri.scheme?.lowercase() ?: return null
      val host = uri.host?.lowercase()?.trimEnd('.')?.takeIf { it.isNotEmpty() } ?: return null
      val port = when {
        scheme == "https" && uri.port == 443 -> -1
        scheme == "http" && uri.port == 80 -> -1
        else -> uri.port
      }
      Site(scheme, host, port)
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
    const val SCHEME = "scheme"
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
    // A site's login records its scheme, so an http:// page never gets an
    // https:// login back. An app's login records the app and its
    // certificate, so autofill can offer it back to that app and to nothing
    // else.
    val scheme = intent.getStringExtra(SCHEME)?.lowercase() ?: "https"
    val origin = domain?.let { "$scheme://$it" } ?: intent.getStringExtra(ORIGIN) ?: ""
    if (origin.isEmpty()) return done(getString(R.string.autofill_save_failed))
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
    if (vaultId.isEmpty()) return done(getString(R.string.autofill_no_silo_save))

    val ids = silo.optJSONArray("credentialIds")
    PhoneKey.unlock(
      this,
      vaultId,
      (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) },
      getString(R.string.autofill_save_title),
      where,
      onUnlocked = { credentialId, wrapKey -> save(Native.autofillSave(dataDir, credentialId, wrapKey, login)) },
      onFailed = { if (it.code == "cancelled") done(null) else done(it.message) },
    )
  }

  private fun save(answer: String) {
    val json = JSONObject(answer)
    done(
      when (json.optString("saved")) {
        "new" -> getString(R.string.autofill_saved_new)
        "updated" -> getString(R.string.autofill_saved_updated)
        "unchanged" -> getString(R.string.autofill_saved_unchanged)
        else -> json.optString("error", getString(R.string.autofill_save_failed))
      }
    )
  }

  private fun done(message: String?) {
    if (message != null) Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    finish()
  }
}
