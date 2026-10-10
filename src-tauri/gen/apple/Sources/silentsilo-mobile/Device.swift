// What Android's DeviceKeyPlugin.kt does besides the key, for
// `src-tauri/src/device_key.rs` and `ios.rs`: the clipboard for secrets,
// haptics, AutoFill's state and settings, and the app group's folder the
// AutoFill extension reads silos from.

import AuthenticationServices
import UIKit
import UniformTypeIdentifiers

/// How long a copied secret stays on the clipboard, as on Android.
private let clipboardSeconds: TimeInterval = 45
/// The clipboard's change count right after our last copy.
private var copiedChange: Int?

private func onMain<T>(_ work: () -> T) -> T {
  Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
}

/// A secret on the clipboard: this iPhone only (no Universal Clipboard to
/// a Mac nearby), gone by itself after 45 seconds.
@_cdecl("ss_copy_secret")
public func ssCopySecret(_ text: UnsafePointer<CChar>) {
  let value = String(cString: text)
  onMain {
    let board = UIPasteboard.general
    board.setItems(
      [[UTType.utf8PlainText.identifier: value]],
      options: [.localOnly: true, .expirationDate: Date(timeIntervalSinceNow: clipboardSeconds)])
    copiedChange = board.changeCount
  }
}

/// On lock: the secret goes, unless something else was copied since.
@_cdecl("ss_clear_secret")
public func ssClearSecret() {
  onMain {
    let board = UIPasteboard.general
    if let copied = copiedChange, board.changeCount == copied {
      board.items = []
    }
    copiedChange = nil
  }
}

@_cdecl("ss_haptic")
public func ssHaptic(_ kind: UnsafePointer<CChar>) {
  let kind = String(cString: kind)
  DispatchQueue.main.async {
    switch kind {
    case "confirm": UINotificationFeedbackGenerator().notificationOccurred(.success)
    case "reject": UINotificationFeedbackGenerator().notificationOccurred(.error)
    case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    default: UISelectionFeedbackGenerator().selectionChanged()
    }
  }
}

/// Whether SilentSilo is turned on under Settings > General > AutoFill &
/// Passwords.
@_cdecl("ss_autofill_enabled")
public func ssAutofillEnabled() -> Bool {
  let answered = DispatchSemaphore(value: 0)
  var enabled = false
  ASCredentialIdentityStore.shared.getState { state in
    enabled = state.isEnabled
    answered.signal()
  }
  _ = answered.wait(timeout: .now() + 3)
  return enabled
}

/// iOS's own page for turning SilentSilo on as an AutoFill provider.
@_cdecl("ss_autofill_open_settings")
public func ssAutofillOpenSettings() -> Bool {
  let answered = DispatchSemaphore(value: 0)
  var opened = false
  ASSettingsHelper.openCredentialProviderAppSettings { error in
    opened = error == nil
    answered.signal()
  }
  _ = answered.wait(timeout: .now() + 5)
  return opened
}

/// The app group's folder for silos and their working copies, shared with
/// the AutoFill extension. Null without the app group entitlement.
@_cdecl("ss_group_dir")
public func ssGroupDir() -> UnsafeMutablePointer<CChar>? {
  guard
    let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: "group.com.silentsilo.mobile")
  else { return nil }
  return strdup(container.appendingPathComponent("Data", isDirectory: true).path)
}

/// Asks iOS for time to finish work after the app leaves the screen, up to
/// about 30 seconds: a sync of what was saved just before. Returns the
/// task's id for `ss_background_end`; iOS's own deadline ends it too.
@_cdecl("ss_background_begin")
public func ssBackgroundBegin() -> Int {
  onMain {
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "sync") {
      UIApplication.shared.endBackgroundTask(task)
    }
    return task.rawValue
  }
}

@_cdecl("ss_background_end")
public func ssBackgroundEnd(_ raw: Int) {
  let task = UIBackgroundTaskIdentifier(rawValue: raw)
  guard task != .invalid else { return }
  DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) }
}
