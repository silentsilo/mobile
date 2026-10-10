// The share sheet's "SilentSilo": copies what another app shares into the
// app group's Inbox, one folder per item, and says to open SilentSilo. The
// app takes them from there (`ss_take_shared` in Platform.swift) and asks
// which silo and folder, as Android's share does. Nothing here holds a key:
// the files wait under iOS file protection until the app seals them.

import UIKit
import UniformTypeIdentifiers

let appGroup = "group.com.silentsilo.mobile"

final class ShareViewController: UIViewController {
  private let message = UILabel()
  private let detail = UILabel()
  private let done = UIButton(type: .system)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    message.font = .preferredFont(forTextStyle: .headline)
    detail.font = .preferredFont(forTextStyle: .body)
    detail.textColor = .secondaryLabel
    for label in [message, detail] {
      label.numberOfLines = 0
      label.textAlignment = .center
    }
    done.setTitle(NSLocalizedString("share.done", comment: "Button that closes the sheet"), for: .normal)
    done.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    done.isEnabled = false
    done.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.startAnimating()
    let stack = UIStackView(arrangedSubviews: [spinner, message, detail, done])
    stack.axis = .vertical
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
    ])

    Task {
      let saved = await saveAll()
      spinner.stopAnimating()
      spinner.isHidden = true
      if saved > 0 {
        message.text = NSLocalizedString("share.saved", comment: "Title once the items are kept")
        detail.text = NSLocalizedString("share.open_app", comment: "What to do next")
      } else {
        message.text = NSLocalizedString("share.failed", comment: "Nothing could be kept")
      }
      done.isEnabled = true
    }
  }

  private func finish() {
    extensionContext?.completeRequest(returningItems: nil)
  }

  /// Copies every shared file into the Inbox; returns how many arrived.
  private func saveAll() async -> Int {
    guard
      let inbox = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
        .appendingPathComponent("Inbox", isDirectory: true)
    else { return 0 }
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
    var saved = 0
    for provider in providers {
      if await save(provider, into: inbox) { saved += 1 }
    }
    return saved
  }

  private func save(_ provider: NSItemProvider, into inbox: URL) async -> Bool {
    // The most specific type the provider offers that is a file at all.
    guard
      let type = provider.registeredTypeIdentifiers
        .compactMap({ UTType($0) })
        .first(where: { $0.conforms(to: .data) || $0.conforms(to: .package) })
    else { return false }
    let suggested = provider.suggestedName
    return await withCheckedContinuation { done in
      // The URL handed over is valid only inside this callback.
      _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        guard let url else {
          done.resume(returning: false)
          return
        }
        let folder = inbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
        var name = suggested ?? url.deletingPathExtension().lastPathComponent
        if URL(fileURLWithPath: name).pathExtension.isEmpty, !url.pathExtension.isEmpty {
          name += "." + url.pathExtension
        }
        let target = folder.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
        do {
          try FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
          try FileManager.default.copyItem(at: url, to: target)
          try (target as NSURL).setResourceValue(
            URLFileProtection.complete, forKey: .fileProtectionKey)
          done.resume(returning: true)
        } catch {
          try? FileManager.default.removeItem(at: folder)
          done.resume(returning: false)
        }
      }
    }
  }
}
