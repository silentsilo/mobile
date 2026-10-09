// Security keys held to the back of the iPhone, for `src-tauri/src/ios.rs`.
// CoreNFC finds the key and moves APDUs; CTAP2 is core's
// `silentsilo_fido::ctap2`, as on Android. Every entry point blocks its
// caller, a Rust worker thread, and never runs on the main thread itself.

import CoreNFC
import Foundation
import UIKit

final class NfcLink: NSObject, NFCTagReaderSessionDelegate {
  static let shared = NfcLink()

  private var session: NFCTagReaderSession?
  /// The session this app closed and iOS has not yet reported closed. A new
  /// one begun before that report is ended by iOS "unexpectedly".
  private var closing: NFCTagReaderSession?
  private var tag: NFCISO7816Tag?
  private var found = DispatchSemaphore(value: 0)
  private var failure: String?
  private var prompt = ""
  /// Fresh starts left when iOS ends a session before any key was found.
  private var retries = 0

  /// Opens the system NFC sheet and waits for a key. `nil` once one is
  /// connected; otherwise what went wrong, "Cancelled" when the sheet was
  /// dismissed.
  func waitForKey(prompt: String) -> String? {
    guard NFCTagReaderSession.readingAvailable else {
      return "This iPhone cannot read NFC."
    }
    found = DispatchSemaphore(value: 0)
    failure = nil
    tag = nil
    self.prompt = prompt
    retries = 2
    DispatchQueue.main.async { self.begin(waits: 50) }
    found.wait()
    return failure
  }

  /// Adding a key takes two taps, each its own session. The next one begins
  /// once iOS has reported the last one closed and the app is active again,
  /// or after five seconds of waiting for that.
  private func begin(waits: Int) {
    let ready = closing == nil && UIApplication.shared.applicationState == .active
    if !ready && waits > 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.begin(waits: waits - 1) }
      return
    }
    closing = nil
    let session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: self, queue: nil)
    session?.alertMessage = prompt
    self.session = session
    session?.begin()
  }

  func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

  func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
    if session === closing {
      closing = nil
      return
    }
    // Any other session than the current one is long gone.
    guard session === self.session else { return }
    let waiting = tag == nil && failure == nil
    tag = nil
    self.session = nil
    guard waiting else { return }
    let code = (error as? NFCReaderError)?.code
    if code == .readerSessionInvalidationErrorSessionTerminatedUnexpectedly && retries > 0 {
      retries -= 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.begin(waits: 30) }
      return
    }
    failure = code == .readerSessionInvalidationErrorUserCanceled ? "Cancelled" : error.localizedDescription
    found.signal()
  }

  func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
    guard session === self.session else { return }
    guard let first = tags.first, case let .iso7816(iso) = first else {
      session.restartPolling()
      return
    }
    session.connect(to: first) { error in
      if let error {
        session.invalidate(errorMessage: error.localizedDescription)
        return
      }
      self.tag = iso
      self.found.signal()
    }
  }

  /// One APDU to the key: the response data followed by SW1 SW2, or `nil`
  /// when the key was lost.
  func transceive(_ bytes: Data) -> Data? {
    guard let tag, let apdu = NFCISO7816APDU(data: bytes) else { return nil }
    let done = DispatchSemaphore(value: 0)
    var answer: Data?
    tag.sendCommand(apdu: apdu) { data, sw1, sw2, error in
      if error == nil {
        var out = data
        out.append(sw1)
        out.append(sw2)
        answer = out
      }
      done.signal()
    }
    done.wait()
    return answer
  }

  /// Closes the sheet: with a message when something failed, plainly when
  /// the ceremony is over.
  func release(error: String?) {
    tag = nil
    DispatchQueue.main.async {
      let done = self.session
      self.session = nil
      self.closing = done
      if let error {
        done?.invalidate(errorMessage: error)
      } else {
        done?.invalidate()
      }
    }
  }

  /// Stops a wait for a key; the waiting call returns "Cancelled".
  func cancel() {
    DispatchQueue.main.async {
      self.session?.invalidate()
    }
  }
}

/// The key's PIN, asked in a system alert so it never passes through the web
/// view. 0: a PIN was given, 1: the person says the key has none, 2: cancelled.
final class PinPrompt {
  static func ask(note: String?, offerNoPin: Bool) -> (Int32, String) {
    let done = DispatchSemaphore(value: 0)
    var result: (Int32, String) = (2, "")
    // Asked right after the NFC sheet closed: until it has, the scene is not
    // active and the alert would have nowhere to go.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      let alert = UIAlertController(
        title: "Security key PIN", message: note, preferredStyle: .alert)
      alert.addTextField { field in
        field.isSecureTextEntry = true
        field.keyboardType = .default
        field.textContentType = .password
      }
      alert.addAction(
        UIAlertAction(title: "OK", style: .default) { _ in
          result = (0, alert.textFields?.first?.text ?? "")
          done.signal()
        })
      if offerNoPin {
        alert.addAction(
          UIAlertAction(title: "No PIN", style: .default) { _ in
            result = (1, "")
            done.signal()
          })
      }
      alert.addAction(
        UIAlertAction(title: "Cancel", style: .cancel) { _ in
          result = (2, "")
          done.signal()
        })
      guard let root = topController() else {
        done.signal()
        return
      }
      root.present(alert, animated: true)
    }
    done.wait()
    return result
  }

  private static func topController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene =
      scenes.first { $0.activationState == .foregroundActive }
      ?? scenes.first { $0.activationState == .foregroundInactive }
      ?? scenes.first
    let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
    var top = window?.rootViewController
    while let next = top?.presentedViewController { top = next }
    return top
  }
}

// The C entry points `ios.rs` declares. Strings in are NUL-terminated UTF-8;
// strings out are written into the caller's buffer, NUL-terminated and cut
// to fit.

private func copyOut(_ text: String, _ buffer: UnsafeMutablePointer<CChar>, _ capacity: Int) {
  guard capacity > 0 else { return }
  let bytes = Array(text.utf8.prefix(capacity - 1))
  for (index, byte) in bytes.enumerated() {
    buffer[index] = CChar(bitPattern: byte)
  }
  buffer[bytes.count] = 0
}

@_cdecl("ss_nfc_available")
public func ssNfcAvailable() -> Bool {
  NFCTagReaderSession.readingAvailable
}

@_cdecl("ss_nfc_wait_for_key")
public func ssNfcWaitForKey(
  _ prompt: UnsafePointer<CChar>, _ error: UnsafeMutablePointer<CChar>, _ capacity: Int
) -> Bool {
  if let failure = NfcLink.shared.waitForKey(prompt: String(cString: prompt)) {
    copyOut(failure, error, capacity)
    return false
  }
  return true
}

@_cdecl("ss_nfc_transceive")
public func ssNfcTransceive(
  _ apdu: UnsafePointer<UInt8>, _ length: Int, _ out: UnsafeMutablePointer<UInt8>, _ capacity: Int
) -> Int {
  guard let answer = NfcLink.shared.transceive(Data(bytes: apdu, count: length)),
    answer.count <= capacity
  else { return -1 }
  answer.copyBytes(to: out, count: answer.count)
  return answer.count
}

@_cdecl("ss_nfc_release")
public func ssNfcRelease(_ error: UnsafePointer<CChar>?) {
  NfcLink.shared.release(error: error.map { String(cString: $0) })
}

@_cdecl("ss_nfc_cancel")
public func ssNfcCancel() {
  NfcLink.shared.cancel()
}

@_cdecl("ss_ask_pin")
public func ssAskPin(
  _ note: UnsafePointer<CChar>?, _ offerNoPin: Bool, _ pin: UnsafeMutablePointer<CChar>,
  _ capacity: Int
) -> Int32 {
  let (outcome, text) = PinPrompt.ask(note: note.map { String(cString: $0) }, offerNoPin: offerNoPin)
  copyOut(text, pin, capacity)
  return outcome
}
