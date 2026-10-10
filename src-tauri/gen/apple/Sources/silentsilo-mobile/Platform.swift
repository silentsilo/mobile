// What Android's FilesPlugin.kt and PdfPages.kt do, for `src-tauri/src/ios.rs`:
// the document picker, the camera, handing a file to another app, PDF pages,
// opening a link, and the provider's sign-in page. Each entry point is called
// from a Rust worker thread and waits for the main thread when it shows UI.

import AuthenticationServices
import Foundation
import PDFKit
import UIKit
import UniformTypeIdentifiers

/// The view controller anything shown here is presented from.
func topController() -> UIViewController? {
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

/// A C string the caller owns and gives back through `ss_free`.
private func owned(_ text: String) -> UnsafeMutablePointer<CChar>? {
  strdup(text)
}

// MARK: - Picking files

final class FilePicker: NSObject, UIDocumentPickerDelegate {
  static let shared = FilePicker()
  private var done = DispatchSemaphore(value: 0)
  private var picked: [URL] = []

  /// The files chosen, copied by iOS into this app's temporary folder.
  func pick() -> [URL] {
    done = DispatchSemaphore(value: 0)
    picked = []
    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      picker.allowsMultipleSelection = true
      picker.delegate = self
      guard let top = topController() else {
        self.done.signal()
        return
      }
      top.present(picker, animated: true)
    }
    done.wait()
    return picked
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    picked = urls
    done.signal()
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    done.signal()
  }
}

@_cdecl("ss_pick_files")
public func ssPickFiles() -> UnsafeMutablePointer<CChar>? {
  let files = FilePicker.shared.pick().map { url -> [String: Any] in
    let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
    return [
      "uri": url.path,
      "name": url.lastPathComponent,
      "size": values?.fileSize ?? 0,
      "mimeType": values?.contentType?.preferredMIMEType ?? "",
    ]
  }
  guard let data = try? JSONSerialization.data(withJSONObject: ["files": files]),
    let text = String(data: data, encoding: .utf8)
  else { return nil }
  return owned(text)
}

// MARK: - The camera

final class Camera: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  static let shared = Camera()
  private var done = DispatchSemaphore(value: 0)
  private var path: String?
  private var folder = ""

  /// A photo written as JPEG into `folder`, or nil when none was taken.
  func take(into folder: String) -> String? {
    guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return nil }
    done = DispatchSemaphore(value: 0)
    path = nil
    self.folder = folder
    DispatchQueue.main.async {
      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.delegate = self
      guard let top = topController() else {
        self.done.signal()
        return
      }
      top.present(picker, animated: true)
    }
    done.wait()
    return path
  }

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    if let image = info[.originalImage] as? UIImage, let jpeg = image.jpegData(compressionQuality: 0.9) {
      try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
      let file = (folder as NSString).appendingPathComponent("\(UUID().uuidString).jpg")
      if FileManager.default.createFile(atPath: file, contents: jpeg) {
        path = file
      }
    }
    picker.dismiss(animated: true)
    done.signal()
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    done.signal()
  }
}

@_cdecl("ss_take_photo")
public func ssTakePhoto(_ folder: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  Camera.shared.take(into: String(cString: folder)).flatMap(owned)
}

// MARK: - Other apps and links

/// The share sheet for a file: open it in another app, save it to Files.
@_cdecl("ss_open_with")
public func ssOpenWith(_ path: UnsafePointer<CChar>) -> Bool {
  let url = URL(fileURLWithPath: String(cString: path))
  let shown = DispatchSemaphore(value: 0)
  var ok = false
  DispatchQueue.main.async {
    if let top = topController() {
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      sheet.popoverPresentationController?.sourceView = top.view
      top.present(sheet, animated: true)
      ok = true
    }
    shown.signal()
  }
  shown.wait()
  return ok
}

/// A web page in Safari, for links the app shows.
@_cdecl("ss_open_url")
public func ssOpenUrl(_ link: UnsafePointer<CChar>) -> Bool {
  guard let url = URL(string: String(cString: link)) else { return false }
  DispatchQueue.main.async { UIApplication.shared.open(url) }
  return true
}

// MARK: - Signing in to a cloud provider

/// The provider's sign-in page in an authentication sheet, which keeps the
/// app running: the answer comes back to the app's own listener on
/// 127.0.0.1, which a suspended app could not take. The sheet never sees a
/// callback of its own; the app closes it once the listener has the code.
final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = SignIn()
  private var session: ASWebAuthenticationSession?

  func open(_ url: URL) {
    DispatchQueue.main.async {
      self.session?.cancel()
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "silentsilo-signin") { _, _ in
        self.session = nil
      }
      session.presentationContextProvider = self
      // No cookies shared with Safari, and no system alert before the page.
      session.prefersEphemeralWebBrowserSession = true
      self.session = session
      session.start()
    }
  }

  func close() {
    DispatchQueue.main.async {
      self.session?.cancel()
      self.session = nil
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    topController()?.view.window ?? ASPresentationAnchor()
  }
}

@_cdecl("ss_sign_in_open")
public func ssSignInOpen(_ link: UnsafePointer<CChar>) -> Bool {
  guard let url = URL(string: String(cString: link)) else { return false }
  SignIn.shared.open(url)
  return true
}

@_cdecl("ss_sign_in_close")
public func ssSignInClose() {
  SignIn.shared.close()
}

// MARK: - PDF pages

@_cdecl("ss_pdf_pages")
public func ssPdfPages(_ path: UnsafePointer<CChar>) -> Int32 {
  guard let document = PDFDocument(url: URL(fileURLWithPath: String(cString: path))) else {
    return -1
  }
  return Int32(document.pageCount)
}

/// Page `index` as a PNG `width` pixels wide, in a buffer the caller frees
/// with `ss_free`; its length goes to `length`.
@_cdecl("ss_pdf_page")
public func ssPdfPage(
  _ path: UnsafePointer<CChar>, _ index: Int32, _ width: Int32, _ length: UnsafeMutablePointer<Int>
) -> UnsafeMutableRawPointer? {
  guard let document = PDFDocument(url: URL(fileURLWithPath: String(cString: path))),
    let page = document.page(at: Int(index))
  else { return nil }
  let bounds = page.bounds(for: .mediaBox)
  guard bounds.width > 0 else { return nil }
  let scale = CGFloat(width) / bounds.width
  let size = CGSize(width: CGFloat(width), height: (bounds.height * scale).rounded())
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: size))
    context.cgContext.translateBy(x: 0, y: size.height)
    context.cgContext.scaleBy(x: scale, y: -scale)
    page.draw(with: .mediaBox, to: context.cgContext)
  }
  guard let png = image.pngData(), let buffer = malloc(png.count) else { return nil }
  png.copyBytes(to: buffer.assumingMemoryBound(to: UInt8.self), count: png.count)
  length.pointee = png.count
  return buffer
}

@_cdecl("ss_free")
public func ssFree(_ pointer: UnsafeMutableRawPointer?) {
  free(pointer)
}

// MARK: - The app switcher

/// Android keeps the app out of its recents screenshot with FLAG_SECURE.
/// iOS takes its snapshot after the scene enters the background, so a plain
/// view laid over the window by then is what the app switcher shows.
final class PrivacyCover {
  static let shared = PrivacyCover()
  private var covers: [UIView] = []

  func install() {
    let center = NotificationCenter.default
    // From the moment the scene stops being active: the app switcher shows
    // the card while the scene is only inactive. A Face ID or NFC sheet does
    // that too, and covers the app itself anyway.
    for name in [UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        self?.cover(note.object as? UIWindowScene)
      }
    }
    center.addObserver(
      forName: UIScene.didActivateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.uncover()
    }
  }

  private func cover(_ scene: UIWindowScene?) {
    guard covers.isEmpty, let window = scene?.windows.first else { return }
    let view = UIView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = .systemBackground
    window.addSubview(view)
    covers.append(view)
  }

  private func uncover() {
    covers.forEach { $0.removeFromSuperview() }
    covers.removeAll()
  }
}

@_cdecl("ss_privacy_cover_install")
public func ssPrivacyCoverInstall() {
  DispatchQueue.main.async { PrivacyCover.shared.install() }
}

// MARK: - Files shared from other apps

/// Moves what the share extension left in the app group's Inbox into this
/// app's temporary folder, where the import reads and then deletes it, and
/// returns `{"files": [...]}` in the shape the picker returns. Moved rather
/// than listed, so each shared file is offered once.
@_cdecl("ss_take_shared")
public func ssTakeShared() -> UnsafeMutablePointer<CChar>? {
  let manager = FileManager.default
  var files: [[String: Any]] = []
  if let inbox = manager.containerURL(forSecurityApplicationGroupIdentifier: "group.com.silentsilo.mobile")?
    .appendingPathComponent("Inbox", isDirectory: true),
    let folders = try? manager.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
  {
    let taken = manager.temporaryDirectory.appendingPathComponent("shared", isDirectory: true)
    // A folder whose name starts with "." is still being written.
    for folder in folders where !folder.lastPathComponent.hasPrefix(".") {
      guard let file = (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))?.first
      else { continue }
      let target = taken.appendingPathComponent(folder.lastPathComponent, isDirectory: true)
      do {
        try manager.createDirectory(at: target, withIntermediateDirectories: true)
        try manager.moveItem(at: file, to: target.appendingPathComponent(file.lastPathComponent))
        try? manager.removeItem(at: folder)
      } catch {
        continue
      }
    }
  }
  // Everything taken and not imported yet, this time's and earlier ones':
  // the import deletes what it read, so nothing shared is lost to a cancel
  // or a closed app. The app keeps each once, by path.
  let taken = manager.temporaryDirectory.appendingPathComponent("shared", isDirectory: true)
  for folder in (try? manager.contentsOfDirectory(at: taken, includingPropertiesForKeys: nil)) ?? [] {
    guard let file = (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))?.first
    else { continue }
    let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    files.append([
      "uri": file.path,
      "name": file.lastPathComponent,
      "size": size,
      "mimeType": UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "",
    ])
  }
  let data = (try? JSONSerialization.data(withJSONObject: ["files": files])) ?? Data("{\"files\":[]}".utf8)
  return owned(String(decoding: data, as: UTF8.self))
}
