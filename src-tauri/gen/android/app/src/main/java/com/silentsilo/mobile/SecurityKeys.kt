package com.silentsilo.mobile

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// The link to a FIDO2 security key, held while Rust speaks CTAP2 over it.
// Rust calls these statically from a worker thread; bytes only, no secrets
// decided here. See core `silentsilo-fido/src/ctap2`.
object SecurityKeys {
  private const val TAG = "SecurityKeys"
  @Volatile private var nfc: IsoDep? = null
  @Volatile private var usb: UsbLink? = null

  class UsbLink(
    val connection: UsbDeviceConnection,
    val iface: UsbInterface,
    val input: UsbEndpoint,
    val output: UsbEndpoint,
  )

  fun holdNfc(tag: IsoDep) {
    close()
    nfc = tag
  }

  fun holdUsb(link: UsbLink) {
    close()
    usb = link
  }

  // One APDU to the tag; null when it left the phone.
  @JvmStatic
  fun transceive(apdu: ByteArray): ByteArray? =
    try {
      nfc?.transceive(apdu)
    } catch (e: Exception) {
      Log.w(TAG, "NFC transceive failed: ${e.javaClass.simpleName}")
      null
    }

  @JvmStatic
  fun hidWrite(report: ByteArray): Boolean {
    val link = usb ?: return false
    return try {
      val n = link.connection.bulkTransfer(link.output, report, report.size, 1000)
      n == report.size
    } catch (e: Exception) {
      Log.w(TAG, "USB write failed: ${e.javaClass.simpleName}")
      false
    }
  }

  // One 64-byte report, an empty array when none came in time, null when the
  // key is gone.
  @JvmStatic
  fun hidRead(timeoutMs: Int): ByteArray? {
    val link = usb ?: return null
    val buffer = ByteArray(64)
    return try {
      val n = link.connection.bulkTransfer(link.input, buffer, buffer.size, timeoutMs)
      // A timeout and an unplugged key both read -1; Rust's deadline and
      // `close` end the wait either way.
      if (n == 64) buffer else ByteArray(0)
    } catch (_: Exception) {
      null
    }
  }

  @JvmStatic
  fun close() {
    nfc?.let { runCatching { it.close() } }
    nfc = null
    usb?.let {
      runCatching { it.connection.releaseInterface(it.iface) }
      runCatching { it.connection.close() }
    }
    usb = null
  }
}

@TauriPlugin
class SecurityKeyPlugin(private val activity: Activity) : Plugin(activity) {
  private companion object {
    const val TAG = "SecurityKeys"
    const val PERMISSION_ACTION = "com.silentsilo.mobile.USB_PERMISSION"
    const val POLL_MS = 400L
    const val READER_GRACE_MS = 4000L
  }

  private val main = Handler(Looper.getMainLooper())
  @Volatile private var waiting: Invoke? = null
  private var asked = mutableSetOf<String>()
  private var receiver: BroadcastReceiver? = null
  // One poll at a time: the permission broadcast restarts it rather than
  // starting a second.
  private val poll = Runnable { pollUsb() }

  @Command
  fun status(invoke: Invoke) {
    val adapter = NfcAdapter.getDefaultAdapter(activity)
    invoke.resolve(JSObject().apply {
      put("nfc", adapter != null)
      put("nfcOn", adapter?.isEnabled == true)
      put("usb", activity.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST))
    })
  }

  // Resolves with {transport} once a key is held over NFC or plugged in and
  // allowed, and stays waiting otherwise until `cancel`.
  @Command
  fun waitForKey(invoke: Invoke) {
    main.post {
      stopWaiting("Another security key request started.")
      SecurityKeys.close()
      waiting = invoke
      asked.clear()
      NfcAdapter.getDefaultAdapter(activity)?.enableReaderMode(
        activity,
        { tag -> onTag(tag) },
        NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
        null,
      )
      pollUsb()
    }
  }

  private fun pollSoon(delayMs: Long) {
    main.removeCallbacks(poll)
    main.postDelayed(poll, delayMs)
  }

  // The key's PIN, typed in Android's own dialog so it never reaches the
  // web view. Resolves {pin}, {noPin: true} or {} when cancelled.
  @Command
  fun askPin(invoke: Invoke) {
    val args = invoke.getArgs()
    val note = args.optString("note", "").takeIf { it.isNotEmpty() && it != "null" }
    val offerNoPin = args.optBoolean("offerNoPin", false)
    main.post {
      val field = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        hint = "PIN"
        isSingleLine = true
      }
      val box = FrameLayout(activity).apply {
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        setPadding(pad, pad / 2, pad, 0)
        addView(field)
      }
      var answered = false
      fun answer(result: JSObject) {
        if (answered) return
        answered = true
        field.text?.clear()
        invoke.resolve(result)
      }
      val builder = AlertDialog.Builder(activity)
        .setTitle("Security key PIN")
        .setMessage(note ?: "A security key with a PIN needs it to open the silo, as on your computer. It goes to the key only and is not kept.")
        .setView(box)
        .setPositiveButton("Continue") { _, _ ->
          val pin = field.text?.toString().orEmpty()
          answer(JSObject().apply { if (pin.isNotEmpty()) put("pin", pin) })
        }
        .setNegativeButton("Cancel") { _, _ -> answer(JSObject()) }
        .setOnCancelListener { answer(JSObject()) }
      if (offerNoPin) builder.setNeutralButton("Key has no PIN") { _, _ -> answer(JSObject().apply { put("no_pin", true) }) }
      val dialog = builder.create()
      dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
      dialog.show()
      field.requestFocus()
      dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }
  }

  @Command
  fun cancel(invoke: Invoke) {
    main.post {
      stopWaiting("Cancelled")
      SecurityKeys.close()
      invoke.resolve()
    }
  }

  // Done with the key: the reader off so the next tap is Android's again.
  @Command
  fun release(invoke: Invoke) {
    main.post {
      SecurityKeys.close()
      // Still on for a moment: a key lifted slowly would otherwise be read
      // by Android, which offers to open the key's own web page.
      main.postDelayed({
        if (waiting == null) runCatching { NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity) }
      }, READER_GRACE_MS)
      invoke.resolve()
    }
  }

  // The reader stays on while a found key is in use, since turning it off
  // drops the tag; `release` and `cancel` turn it off.
  private fun stopWaiting(reason: String?, readerOff: Boolean = true) {
    main.removeCallbacksAndMessages(null)
    if (readerOff) runCatching { NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity) }
    receiver?.let { runCatching { activity.unregisterReceiver(it) } }
    receiver = null
    val pending = waiting
    waiting = null
    if (reason != null) pending?.reject(reason)
  }

  private fun found(transport: String) {
    val pending = waiting ?: return
    stopWaiting(null, readerOff = false)
    pending.resolve(JSObject().apply { put("transport", transport) })
  }

  // A tap while nothing waits, a key in use or the moments after, is left
  // alone: holding it would drop the link a request is still using.
  private fun onTag(tag: Tag) {
    if (waiting == null) return
    val iso = IsoDep.get(tag) ?: return
    try {
      iso.connect()
      iso.timeout = 5000
      SecurityKeys.holdNfc(iso)
      main.post { found("nfc") }
    } catch (e: Exception) {
      Log.w(TAG, "NFC connect failed: ${e.javaClass.simpleName}")
      runCatching { iso.close() }
    }
  }

  private fun pollUsb() {
    main.removeCallbacks(poll)
    if (waiting == null) return
    val manager = activity.getSystemService(UsbManager::class.java)
    for (device in manager.deviceList.values) {
      val candidate = fidoInterface(device) ?: continue
      if (!manager.hasPermission(device)) {
        if (asked.add(device.deviceName)) askPermission(manager, device)
        continue
      }
      if (open(manager, device, candidate)) {
        found("usb")
        return
      }
    }
    pollSoon(POLL_MS)
  }

  private fun askPermission(manager: UsbManager, device: UsbDevice) {
    if (receiver == null) {
      val r = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          main.post { pollSoon(0) }
        }
      }
      val filter = IntentFilter(PERMISSION_ACTION)
      if (Build.VERSION.SDK_INT >= 33) {
        activity.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        activity.registerReceiver(r, filter)
      }
      receiver = r
    }
    val intent = Intent(PERMISSION_ACTION).setPackage(activity.packageName)
    val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    manager.requestPermission(device, PendingIntent.getBroadcast(activity, 0, intent, flags))
  }

  // A HID interface with an interrupt endpoint each way of 64 bytes: the
  // FIDO one. A key's keyboard interface has no OUT endpoint.
  private fun fidoInterface(device: UsbDevice): UsbInterface? {
    for (i in 0 until device.interfaceCount) {
      val iface = device.getInterface(i)
      if (iface.interfaceClass != UsbConstants.USB_CLASS_HID) continue
      if (endpoint(iface, UsbConstants.USB_DIR_IN) != null && endpoint(iface, UsbConstants.USB_DIR_OUT) != null) return iface
    }
    return null
  }

  private fun endpoint(iface: UsbInterface, direction: Int): UsbEndpoint? =
    (0 until iface.endpointCount).map { iface.getEndpoint(it) }.firstOrNull {
      it.type == UsbConstants.USB_ENDPOINT_XFER_INT && it.direction == direction && it.maxPacketSize == 64
    }

  private fun open(manager: UsbManager, device: UsbDevice, iface: UsbInterface): Boolean {
    val connection = manager.openDevice(device) ?: return false
    if (!connection.claimInterface(iface, true)) {
      connection.close()
      return false
    }
    // The report descriptor names the FIDO usage page, 0xF1D0.
    val descriptor = ByteArray(256)
    val n = connection.controlTransfer(0x81, 0x06, 0x2200, iface.id, descriptor, descriptor.size, 1000)
    val fido = n > 2 && (0 until n - 2).any {
      descriptor[it] == 0x06.toByte() && descriptor[it + 1] == 0xD0.toByte() && descriptor[it + 2] == 0xF1.toByte()
    }
    if (!fido) {
      connection.releaseInterface(iface)
      connection.close()
      return false
    }
    val input = endpoint(iface, UsbConstants.USB_DIR_IN)
    val output = endpoint(iface, UsbConstants.USB_DIR_OUT)
    if (input == null || output == null) {
      connection.releaseInterface(iface)
      connection.close()
      return false
    }
    SecurityKeys.holdUsb(SecurityKeys.UsbLink(connection, iface, input, output))
    return true
  }
}
