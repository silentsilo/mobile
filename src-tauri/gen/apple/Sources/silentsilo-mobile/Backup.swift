// Phone backup on the iPhone: what Android's Backup.kt and BackupPlugin.kt
// do. Photos, videos and contacts are read here; each is sealed to the
// silo's inbox and signed by Rust (`backup.rs`, through rust.h), with a
// signing key that opens nothing. iOS runs the job when it chooses, as a
// BGProcessingTask; there is no schedule to promise.

import BackgroundTasks
import Contacts
import CryptoKit
import Foundation
import Network
import Photos
import UIKit
import UniformTypeIdentifiers
import UserNotifications

private let taskId = "com.silentsilo.mobile.backup"

// MARK: - Settings between runs

/// Kept in the app's own defaults, which never leave this iPhone.
enum BackupPrefs {
  private static let store = UserDefaults.standard
  private static func key(_ name: String) -> String { "backup." + name }

  static var vaultId: String { get { string("vaultId") } set { set("vaultId", newValue) } }
  static var label: String { get { string("label") } set { set("label", newValue) } }
  static var photos: Bool { get { bool("photos") } set { set("photos", newValue) } }
  static var videos: Bool { get { bool("videos") } set { set("videos", newValue) } }
  static var contacts: Bool { get { bool("contacts") } set { set("contacts", newValue) } }
  static var wifiOnly: Bool { get { bool("wifiOnly", true) } set { set("wifiOnly", newValue) } }
  static var chargingOnly: Bool { get { bool("chargingOnly") } set { set("chargingOnly", newValue) } }
  static var remind: Bool { get { bool("remind", true) } set { set("remind", newValue) } }
  /// Albums (collection ids) to back up; empty means the whole library.
  static var folders: [String] {
    get { store.stringArray(forKey: key("folders")) ?? [] }
    set { set("folders", newValue) }
  }
  static var sent: Int { get { int("sent") } set { set("sent", newValue) } }
  static var lastRun: Int { get { int("lastRun") } set { set("lastRun", newValue) } }
  static var lastError: String { get { string("lastError") } set { set("lastError", newValue) } }
  static var contactsHash: String { get { string("contactsHash") } set { set("contactsHash", newValue) } }
  static var contactsSentAt: Int { get { int("contactsSentAt") } set { set("contactsSentAt", newValue) } }
  static var waiting: Int { get { int("waiting") } set { set("waiting", newValue) } }
  static var waitingSince: Int { get { int("waitingSince") } set { set("waitingSince", newValue) } }
  static var remindedAt: Int { get { int("remindedAt") } set { set("remindedAt", newValue) } }
  /// Where the photo library's change history was last read.
  static var changeToken: PHPersistentChangeToken? {
    get {
      guard let data = store.data(forKey: key("changeToken")) else { return nil }
      return try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data)
    }
    set {
      let data = newValue.flatMap { try? NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true) }
      store.set(data, forKey: key("changeToken"))
    }
  }

  static func clear() {
    for name in store.dictionaryRepresentation().keys where name.hasPrefix("backup.") {
      store.removeObject(forKey: name)
    }
    BackupQueue.clear()
  }

  private static func string(_ name: String) -> String { store.string(forKey: key(name)) ?? "" }
  private static func bool(_ name: String, _ fallback: Bool = false) -> Bool {
    store.object(forKey: key(name)) as? Bool ?? fallback
  }
  private static func int(_ name: String) -> Int { store.integer(forKey: key(name)) }
  private static func set(_ name: String, _ value: Any?) { store.set(value, forKey: key(name)) }
}

/// Photos and videos waiting to be sent, oldest first, as `p:<id>` and
/// `v:<id>`. A file rather than defaults: "send everything" can list tens of
/// thousands.
enum BackupQueue {
  private static var file: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("backup-queue.json")
  }

  static func load() -> [String] {
    (try? JSONDecoder().decode([String].self, from: Data(contentsOf: file))) ?? []
  }

  static func save(_ items: [String]) {
    try? FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? JSONEncoder().encode(items).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func clear() { try? FileManager.default.removeItem(at: file) }
}

// MARK: - The signing key

/// The key this iPhone signs inbox items with, one per silo, in the Secure
/// Enclave when there is one. No Face ID: it signs in the background, and
/// it opens nothing. Format: core FORMATS.md, "The inbox".
enum SenderKeys {
  private static let service = "com.silentsilo.mobile.sender"

  /// The uncompressed P-256 point, made on first use.
  static func publicKey(_ vault: String) -> Data? {
    if let key = enclaveKey(vault, create: true) { return key.publicKey.x963Representation }
    return softwareKey(vault, create: true)?.publicKey.x963Representation
  }

  /// A DER ECDSA signature over SHA-256 of `message`.
  static func sign(_ vault: String, _ message: Data) -> Data? {
    if let key = enclaveKey(vault, create: false) {
      return try? key.signature(for: message).derRepresentation
    }
    return try? softwareKey(vault, create: false)?.signature(for: message).derRepresentation
  }

  static func remove(_ vault: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: vault,
    ]
    SecItemDelete(query as CFDictionary)
  }

  private static func enclaveKey(_ vault: String, create: Bool) -> SecureEnclave.P256.Signing.PrivateKey? {
    guard SecureEnclave.isAvailable else { return nil }
    if let blob = stored(vault) {
      return try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
    }
    guard create,
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, nil),
      let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access),
      store(vault, key.dataRepresentation)
    else { return nil }
    return key
  }

  /// The simulator has no Secure Enclave.
  private static func softwareKey(_ vault: String, create: Bool) -> P256.Signing.PrivateKey? {
    if let raw = stored(vault) { return try? P256.Signing.PrivateKey(rawRepresentation: raw) }
    guard create else { return nil }
    let key = P256.Signing.PrivateKey()
    return store(vault, key.rawRepresentation) ? key : nil
  }

  private static func stored(_ vault: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: vault,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  private static func store(_ vault: String, _ data: Data) -> Bool {
    remove(vault)
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: vault,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: data,
    ]
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }
}

/// For Rust, while it seals an item: the signature into `out`, its length,
/// or -1.
@_cdecl("ss_sender_sign")
public func ssSenderSign(
  _ vault: UnsafePointer<CChar>, _ message: UnsafePointer<UInt8>, _ length: Int,
  _ out: UnsafeMutablePointer<UInt8>, _ capacity: Int
) -> Int {
  let data = Data(bytes: message, count: length)
  guard let signature = SenderKeys.sign(String(cString: vault), data), signature.count <= capacity
  else { return -1 }
  signature.copyBytes(to: out, count: signature.count)
  return signature.count
}

// MARK: - Scheduling

enum BackupScheduler {
  /// Asks iOS for a run. It picks the moment: usually while the iPhone
  /// charges and is idle, sooner or later.
  static func schedule() {
    guard !BackupPrefs.vaultId.isEmpty, BackupPrefs.photos || BackupPrefs.videos || BackupPrefs.contacts
    else {
      cancel()
      return
    }
    let request = BGProcessingTaskRequest(identifier: taskId)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = BackupPrefs.chargingOnly
    request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }

  static func cancel() {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
  }

  /// While the app is open: a run now, on a thread of its own.
  static func runNow() {
    guard !BackupPrefs.vaultId.isEmpty else { return }
    DispatchQueue.global(qos: .utility).async {
      _ = BackupRunner().backUp { false }
    }
  }

  /// When the app comes to the screen: what was taken since goes now, not
  /// when iOS next lets the job run. At most once a minute.
  static func runOnOpening() {
    guard !BackupPrefs.vaultId.isEmpty,
      Int(Date().timeIntervalSince1970) - BackupPrefs.lastRun > 60
    else { return }
    runNow()
  }

  /// When the app leaves the screen: one run in the time iOS grants for
  /// finishing work, about 30 seconds. An item that does not fit is sent
  /// again later, under the same id.
  static func runOnLeaving() {
    guard !BackupPrefs.vaultId.isEmpty else { return }
    let stop = StopFlag()
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "backup") {
      stop.set()
      UIApplication.shared.endBackgroundTask(task)
    }
    guard task != .invalid else { return }
    DispatchQueue.global(qos: .utility).async {
      _ = BackupRunner().backUp { stop.isSet }
      DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) }
    }
  }
}

/// Called from main.mm before the app starts: iOS wants the handler before
/// launch ends.
@_cdecl("ss_backup_register")
public func ssBackupRegister() {
  let center = NotificationCenter.default
  center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
    BackupScheduler.runOnOpening()
  }
  center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
    BackupScheduler.runOnLeaving()
  }
  BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
    let stop = StopFlag()
    let done = StopFlag()
    // iOS ends the process if the task is not completed soon after this;
    // an item still uploading is sent again next time, under the same id.
    task.expirationHandler = {
      stop.set()
      if done.setOnce() {
        BackupScheduler.schedule()
        task.setTaskCompleted(success: false)
      }
    }
    DispatchQueue.global(qos: .utility).async {
      let retry = BackupRunner().backUp { stop.isSet }
      if done.setOnce() {
        BackupScheduler.schedule()
        task.setTaskCompleted(success: !retry)
      }
    }
  }
}

final class StopFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func set() { lock.withLock { value = true } }
  var isSet: Bool { lock.withLock { value } }
  /// True for the first caller only.
  func setOnce() -> Bool {
    lock.withLock {
      if value { return false }
      value = true
      return true
    }
  }
}

// MARK: - One run

final class BackupRunner {
  /// iOS may start the job while the app runs one too.
  private static let running = NSLock()

  /// True when something failed that may work later.
  func backUp(_ stopped: () -> Bool) -> Bool {
    guard !BackupPrefs.vaultId.isEmpty, BackupRunner.running.try() else { return false }
    defer { BackupRunner.running.unlock() }
    // Rust learns where the app keeps its files when the app starts, and a
    // background launch starts it too; this waits for that.
    for _ in 0..<50 where !ss_backup_ready() {
      Thread.sleep(forTimeInterval: 0.1)
    }
    guard ss_backup_ready() else { return true }
    Self.sweepContacts()
    BackupPrefs.lastRun = Int(Date().timeIntervalSince1970)
    defer { checkWaiting() }
    if BackupPrefs.wifiOnly, !onWifi() {
      return true
    }
    if sendAgain(stopped) { return true }
    if BackupPrefs.photos || BackupPrefs.videos, photosAllowed() {
      collectNew()
      if sendQueue(stopped) { return true }
    }
    if BackupPrefs.contacts, contactsAllowed(), !stopped() {
      if sendContacts() { return true }
    }
    BackupPrefs.lastError = ""
    return false
  }

  /// Whether the iPhone is on a network that is not metered, as the Wi-Fi
  /// only setting means.
  private func onWifi() -> Bool {
    let monitor = NWPathMonitor()
    let answered = DispatchSemaphore(value: 0)
    var wifi = false
    monitor.pathUpdateHandler = { path in
      wifi = path.status == .satisfied && !path.isExpensive && !path.isConstrained
      answered.signal()
    }
    monitor.start(queue: DispatchQueue(label: "backup.path"))
    _ = answered.wait(timeout: .now() + 3)
    monitor.cancel()
    return wifi
  }

  // MARK: Photos and videos

  /// Adds what the library gained since the last run to the queue, read
  /// from its change history: a photo imported today with last year's date
  /// is new here too.
  private func collectNew() {
    let library = PHPhotoLibrary.shared()
    guard let token = BackupPrefs.changeToken else {
      BackupPrefs.changeToken = library.currentChangeToken
      return
    }
    guard let changes = try? library.fetchPersistentChanges(since: token) else {
      // History older than iOS keeps: start again from now.
      BackupPrefs.changeToken = library.currentChangeToken
      return
    }
    var queue = BackupQueue.load()
    var known = Set(queue)
    var last = token
    for change in changes {
      if let details = try? change.changeDetails(for: .asset) {
        let ids = Array(details.insertedLocalIdentifiers)
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        assets.enumerateObjects { asset, _, _ in
          guard let entry = Self.entry(asset), !known.contains(entry) else { return }
          known.insert(entry)
          queue.append(entry)
        }
      }
      last = change.changeToken
    }
    BackupQueue.save(queue)
    BackupPrefs.changeToken = last
  }

  /// Everything already in the library, for "send what is there too".
  static func queueExisting(photos: Bool, videos: Bool) {
    var queue = BackupQueue.load()
    var known = Set(queue)
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
    PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in
      guard (asset.mediaType == .image && photos) || (asset.mediaType == .video && videos),
        let entry = entry(asset), !known.contains(entry)
      else { return }
      known.insert(entry)
      queue.append(entry)
    }
    BackupQueue.save(queue)
  }

  private static func entry(_ asset: PHAsset) -> String? {
    switch asset.mediaType {
    case .image: return "p:" + asset.localIdentifier
    case .video: return "v:" + asset.localIdentifier
    default: return nil
    }
  }

  /// The ids of the assets in the chosen albums, or nil for all of them.
  private func inChosenAlbums() -> Set<String>? {
    let chosen = BackupPrefs.folders
    guard !chosen.isEmpty else { return nil }
    var ids = Set<String>()
    PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: chosen, options: nil)
      .enumerateObjects { collection, _, _ in
        PHAsset.fetchAssets(in: collection, options: nil).enumerateObjects { asset, _, _ in
          ids.insert(asset.localIdentifier)
        }
      }
    return ids
  }

  private func sendQueue(_ stopped: () -> Bool) -> Bool {
    let queue = BackupQueue.load()
    let scope = inChosenAlbums()
    var done = 0
    // Saved every 25 items and on the way out: "send everything" can queue
    // tens of thousands, and rewriting all of it per item wears the disk.
    defer { BackupQueue.save(Array(queue.dropFirst(done))) }
    while done < queue.count {
      let entry = queue[done]
      if stopped() { return true }
      let video = entry.hasPrefix("v:")
      let id = String(entry.dropFirst(2))
      let wanted = video ? BackupPrefs.videos : BackupPrefs.photos
      let outcome: String? = autoreleasepool {
        guard wanted, scope?.contains(id) ?? true,
          let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        else { return nil }
        return send(asset, video: video)
      }
      if let outcome {
        if outcome.hasPrefix("retry") {
          BackupPrefs.lastError = String(outcome.dropFirst("retry: ".count))
          return true
        }
        if outcome == "ok" {
          BackupPrefs.sent += 1
          BackupPrefs.lastError = ""
        } else {
          BackupPrefs.lastError = String(outcome.dropFirst("skip: ".count))
        }
      }
      done += 1
      if done % 25 == 0 { BackupQueue.save(Array(queue.dropFirst(done))) }
    }
    return false
  }

  /// Exports the original into the app's temporary folder, hands it to
  /// Rust, deletes the copy. "ok", "retry: why" or "skip: why".
  private func send(_ asset: PHAsset, video: Bool) -> String {
    let resources = PHAssetResource.assetResources(for: asset)
    guard
      let resource = resources.first(where: { $0.type == (video ? .video : .photo) })
        ?? resources.first
    else { return "skip: it has nothing to send" }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(
      "backup-" + UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let file = folder.appendingPathComponent(resource.originalFilename)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      return "retry: \(error.localizedDescription)"
    }
    let options = PHAssetResourceRequestOptions()
    // A photo kept only in iCloud is downloaded first.
    options.isNetworkAccessAllowed = true
    let written = DispatchSemaphore(value: 0)
    var failure: Error?
    PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options) {
      failure = $0
      written.signal()
    }
    // An iCloud download has no handle to cancel; it gets ten minutes.
    if written.wait(timeout: .now() + 600) == .timedOut {
      return "retry: the photo did not download in time"
    }
    if let failure { return "retry: \(failure.localizedDescription)" }

    let taken = Int((asset.creationDate ?? Date()).timeIntervalSince1970)
    let month = Self.month.string(from: Date(timeIntervalSince1970: TimeInterval(taken)))
    let kind = video ? "video" : "photo"
    let itemId = nameUUID("\(kind):\(BackupPrefs.vaultId):\(asset.localIdentifier)")
    let item: [String: Any] = [
      "path": file.path,
      "itemId": itemId,
      "name": resource.originalFilename,
      "mimeType": UTType(resource.uniformTypeIdentifier)?.preferredMIMEType ?? "",
      "takenAt": taken,
      "folder": ["Phone backup", BackupPrefs.label, video ? "Videos" : "Photos", month].joined(separator: "\n"),
      "kind": video ? "videos" : "photos",
    ]
    let outcome = callRust(item)
    if outcome == "ok" { ss_backup_record_sent(itemId, kind, asset.localIdentifier) }
    return outcome
  }

  private static let month: DateFormatter = {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.dateFormat = "yyyy-MM"
    return format
  }()

  // MARK: Items storage lost

  /// What storage lost before the silo imported it, found by the app after
  /// a sync. A photo still here goes again under the same item id;
  /// contacts are marked unsent, so this run sends them again.
  private func sendAgain(_ stopped: () -> Bool) -> Bool {
    guard let raw = ss_backup_resends() else { return false }
    let json = String(cString: raw)
    ss_rust_free(raw)
    let list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: String]] ?? []
    for item in list {
      if stopped() { return true }
      let kind = item["kind"] ?? ""
      let reference = item["reference"] ?? ""
      if kind == "photo" || kind == "video",
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [reference], options: nil).firstObject
      {
        let outcome = send(asset, video: kind == "video")
        if outcome.hasPrefix("retry") {
          BackupPrefs.lastError = String(outcome.dropFirst("retry: ".count))
          return true
        }
      } else if kind == "contacts" {
        BackupPrefs.contactsHash = ""
        BackupPrefs.contactsSentAt = 0
      }
      ss_backup_resolve(kind, reference)
    }
    return false
  }

  // MARK: Contacts

  private static var contactsFile: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("contacts.vcf")
  }

  /// The vCard holds every contact in the clear, for the upload and no
  /// longer; this only finds what a killed run left.
  static func sweepContacts() {
    try? FileManager.default.removeItem(at: contactsFile)
  }

  /// Every contact as one vCard file, sent when it differs from the last one
  /// sent and at most once a day.
  private func sendContacts() -> Bool {
    let now = Int(Date().timeIntervalSince1970)
    if now - BackupPrefs.contactsSentAt < 24 * 3600 { return false }
    let file = Self.contactsFile
    defer { try? FileManager.default.removeItem(at: file) }
    var contacts: [CNContact] = []
    let keys = [CNContactVCardSerialization.descriptorForRequiredKeys()]
    do {
      try CNContactStore().enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { contact, _ in
        contacts.append(contact)
      }
    } catch {
      BackupPrefs.lastError = "Contacts: \(error.localizedDescription)"
      return false
    }
    guard !contacts.isEmpty, let data = try? CNContactVCardSerialization.data(with: contacts) else {
      return false
    }
    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    if hash == BackupPrefs.contactsHash {
      BackupPrefs.contactsSentAt = now
      return false
    }
    do {
      // Written while the iPhone is locked, as background runs usually are:
      // the class that allows it. The file goes as soon as it is sent.
      try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      return true
    }
    let day = Self.day.string(from: Date())
    let itemId = nameUUID("contacts:\(BackupPrefs.vaultId):\(hash)")
    let outcome = callRust([
      "path": file.path,
      "itemId": itemId,
      "name": "Contacts \(day).vcf",
      "mimeType": "text/vcard",
      "takenAt": now,
      "folder": ["Phone backup", BackupPrefs.label, "Contacts"].joined(separator: "\n"),
      "kind": "contacts",
    ])
    if outcome.hasPrefix("retry") {
      BackupPrefs.lastError = String(outcome.dropFirst("retry: ".count))
      return true
    }
    if outcome == "ok" {
      BackupPrefs.sent += 1
      ss_backup_record_sent(itemId, "contacts", hash)
    } else {
      BackupPrefs.lastError = "Contacts: " + outcome.dropFirst("skip: ".count)
    }
    BackupPrefs.contactsHash = hash
    BackupPrefs.contactsSentAt = now
    return false
  }

  private static let day: DateFormatter = {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.dateFormat = "yyyy-MM-dd"
    return format
  }()

  // MARK: Waiting items

  /// Items join the silo only when a device opens it. If they have waited
  /// for days, say so, at most once a week.
  private func checkWaiting() {
    let now = Int(Date().timeIntervalSince1970)
    let count = Int(ss_backup_waiting())
    if count < 0 { return }
    if count == 0 {
      BackupPrefs.waiting = 0
      BackupPrefs.waitingSince = 0
      return
    }
    if BackupPrefs.waitingSince == 0 { BackupPrefs.waitingSince = now }
    BackupPrefs.waiting = count
    let waitedLong = now - BackupPrefs.waitingSince >= 3 * 24 * 3600
    let notRecently = now - BackupPrefs.remindedAt >= 7 * 24 * 3600
    if BackupPrefs.remind, waitedLong, notRecently {
      BackupPrefs.remindedAt = now
      let content = UNMutableNotificationContent()
      content.title = NSLocalizedString("backup_title", comment: "")
      content.body = NSLocalizedString("backup_waiting", comment: "")
      UNUserNotificationCenter.current().add(
        UNNotificationRequest(identifier: "backup-waiting", content: content, trigger: nil))
    }
  }

  // MARK: Helpers

  private func callRust(_ item: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: item),
      let raw = ss_backup_send(String(decoding: data, as: UTF8.self))
    else { return "retry: the item could not be handed over" }
    defer { ss_rust_free(raw) }
    return String(cString: raw)
  }

  private func photosAllowed() -> Bool {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return status == .authorized || status == .limited
  }

  private func contactsAllowed() -> Bool {
    contactsReadable()
  }
}

/// The same item id Android's `UUID.nameUUIDFromBytes` makes: MD5, version 3.
func nameUUID(_ name: String) -> String {
  var bytes = Array(Insecure.MD5.hash(data: Data(name.utf8)))
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  let hex = bytes.map { String(format: "%02x", $0) }.joined()
  let parts = [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4),
               hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
  return parts.map(String.init).joined(separator: "-")
}

// MARK: - The app's calls (backup.rs, `Backup::call`)

/// `command` with a JSON `payload`; the answer is JSON, or
/// `{"error": "..."}`. Called from a Rust worker thread: anything that
/// shows UI waits for the main thread.
@_cdecl("ss_backup_call")
public func ssBackupCall(_ command: UnsafePointer<CChar>, _ payload: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  let args = (try? JSONSerialization.jsonObject(with: Data(String(cString: payload).utf8))) as? [String: Any] ?? [:]
  let answer: [String: Any]
  switch String(cString: command) {
  case "status":
    answer = backupStatus()
  case "requestAccess":
    requestAccess(args)
    answer = backupStatus()
  case "mediaFolders":
    requestAccess(["photos": true])
    answer = ["folders": albums()]
  case "senderKey":
    if let key = SenderKeys.publicKey(args["vaultId"] as? String ?? "") {
      answer = ["publicKey": key.map { String(format: "%02x", $0) }.joined()]
    } else {
      answer = ["error": "This phone could not make a signing key."]
    }
  case "configure":
    configure(args)
    answer = backupStatus()
  case "runNow":
    BackupScheduler.runNow()
    answer = [:]
  case "disable":
    BackupScheduler.cancel()
    if !BackupPrefs.vaultId.isEmpty { SenderKeys.remove(BackupPrefs.vaultId) }
    BackupPrefs.clear()
    BackupRunner.sweepContacts()
    answer = backupStatus()
  default:
    answer = ["error": "Unknown backup call."]
  }
  let data = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))
}

private func backupStatus() -> [String: Any] {
  let photos = PHPhotoLibrary.authorizationStatus(for: .readWrite)
  let allowed = photos == .authorized || photos == .limited
  return [
    "vaultId": BackupPrefs.vaultId,
    "photos": BackupPrefs.photos,
    "videos": BackupPrefs.videos,
    "contacts": BackupPrefs.contacts,
    "folders": BackupPrefs.folders,
    "wifiOnly": BackupPrefs.wifiOnly,
    "chargingOnly": BackupPrefs.chargingOnly,
    "sent": BackupPrefs.sent,
    "lastRun": BackupPrefs.lastRun,
    "lastError": BackupPrefs.lastError,
    "remind": BackupPrefs.remind,
    "waiting": BackupPrefs.waiting,
    "photosAllowed": allowed,
    "videosAllowed": allowed,
    "contactsAllowed": contactsReadable(),
  ]
}

/// Asks for what the chosen backups need, waiting for each answer.
private func requestAccess(_ args: [String: Any]) {
  let answered = DispatchSemaphore(value: 0)
  if (args["photos"] as? Bool ?? false) || (args["videos"] as? Bool ?? false),
    PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined
  {
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in answered.signal() }
    answered.wait()
  }
  if args["contacts"] as? Bool ?? false, CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
    CNContactStore().requestAccess(for: .contacts) { _, _ in answered.signal() }
    answered.wait()
  }
  if args["remind"] as? Bool ?? false {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in answered.signal() }
    answered.wait()
  }
}

/// The library's albums with what each holds, Recents first, for choosing
/// and for "send everything". Sizes are not read: that means asking for
/// every file.
private func albums() -> [[String: Any]] {
  var list: [[String: Any]] = []
  func add(_ collection: PHAssetCollection) {
    let assets = PHAsset.fetchAssets(in: collection, options: nil)
    let photos = assets.countOfAssets(with: .image)
    let videos = assets.countOfAssets(with: .video)
    guard photos + videos > 0 else { return }
    list.append([
      "id": collection.localIdentifier,
      "name": collection.localizedTitle ?? "",
      "photos": photos,
      "videos": videos,
      "bytes": 0,
    ])
  }
  PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumUserLibrary, options: nil)
    .enumerateObjects { collection, _, _ in add(collection) }
  PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
    .enumerateObjects { collection, _, _ in add(collection) }
  return list
}

private func configure(_ args: [String: Any]) {
  let vaultId = args["vaultId"] as? String ?? ""
  if BackupPrefs.vaultId != vaultId {
    BackupPrefs.clear()
    BackupPrefs.vaultId = vaultId
  }
  let photos = args["photos"] as? Bool ?? false
  let videos = args["videos"] as? Bool ?? false
  let existing = args["includeExisting"] as? Bool ?? false
  // Where the change history starts: now, so only what comes later is new.
  if (photos || videos), BackupPrefs.changeToken == nil {
    BackupPrefs.changeToken = PHPhotoLibrary.shared().currentChangeToken
  }
  if existing {
    BackupRunner.queueExisting(photos: photos && !BackupPrefs.photos, videos: videos && !BackupPrefs.videos)
  }
  BackupPrefs.photos = photos
  BackupPrefs.videos = videos
  BackupPrefs.folders = args["folders"] as? [String] ?? []
  BackupPrefs.label = args["label"] as? String ?? ""
  BackupPrefs.contacts = args["contacts"] as? Bool ?? false
  if !BackupPrefs.contacts { BackupRunner.sweepContacts() }
  BackupPrefs.wifiOnly = args["wifiOnly"] as? Bool ?? true
  BackupPrefs.chargingOnly = args["chargingOnly"] as? Bool ?? false
  BackupPrefs.remind = args["remind"] as? Bool ?? true
  BackupScheduler.schedule()
  BackupScheduler.runNow()
}

/// Full access, or on iOS 18 the contacts the person chose to share.
func contactsReadable() -> Bool {
  let status = CNContactStore.authorizationStatus(for: .contacts)
  if #available(iOS 18, *), status == .limited { return true }
  return status == .authorized
}
