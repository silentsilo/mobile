// "SilentSilo" in iOS's AutoFill: opens the silo with Face ID through Rust
// (`autofill/`, via autofill.h), lists its logins with the ones for the
// site or app asking first, and hands the chosen one to iOS. iOS shows this
// only when the person picks SilentSilo; nothing is offered without it.

import AuthenticationServices
import UIKit

struct Login {
  let service: String
  let username: String
  let password: String
  let url: String
}

final class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource,
  UITableViewDelegate, UISearchBarDelegate
{
  private var asked: [String] = []
  private var logins: [Login] = []
  private var suggested: [Login] = []
  private var others: [Login] = []
  private var query = ""

  private let table = UITableView(frame: .zero, style: .insetGrouped)
  private let search = UISearchBar()
  private let status = UILabel()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let retry = UIButton(type: .system)

  // MARK: iOS's entry points

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    asked = serviceIdentifiers.compactMap { host(of: $0.identifier) }
    load()
  }

  /// Nothing is saved with iOS for filling without a prompt, so iOS should
  /// never ask; if it does, it gets the list.
  override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
    extensionContext.cancelRequest(
      withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
  }

  override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
    asked = [host(of: credentialIdentity.serviceIdentifier.identifier)].compactMap { $0 }
    load()
  }

  // MARK: Layout

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground

    let title = UILabel()
    title.text = text("af.title")
    title.font = .preferredFont(forTextStyle: .headline)
    let cancel = UIButton(type: .system)
    cancel.setTitle(text("af.cancel"), for: .normal)
    cancel.addAction(UIAction { [weak self] _ in self?.cancel() }, for: .touchUpInside)
    let bar = UIStackView(arrangedSubviews: [title, UIView(), cancel])
    bar.axis = .horizontal

    search.placeholder = text("af.search")
    search.searchBarStyle = .minimal
    search.delegate = self
    search.autocapitalizationType = .none

    table.dataSource = self
    table.delegate = self
    table.isHidden = true

    status.numberOfLines = 0
    status.textAlignment = .center
    status.textColor = .secondaryLabel
    status.font = .preferredFont(forTextStyle: .body)
    retry.setTitle(text("af.retry"), for: .normal)
    retry.isHidden = true
    retry.addAction(UIAction { [weak self] _ in self?.load() }, for: .touchUpInside)
    let waiting = UIStackView(arrangedSubviews: [spinner, status, retry])
    waiting.axis = .vertical
    waiting.spacing = 12

    for part in [bar, search, table, waiting] as [UIView] {
      part.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(part)
    }
    let margins = view.layoutMarginsGuide
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      bar.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
      search.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
      search.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
      search.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
      table.topAnchor.constraint(equalTo: search.bottomAnchor),
      table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      waiting.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      waiting.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      waiting.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
    ])
  }

  // MARK: Opening the silo

  private func load() {
    loadViewIfNeeded()
    table.isHidden = true
    retry.isHidden = true
    spinner.startAnimating()
    status.text = text("af.opening")
    guard
      let group = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.com.silentsilo.mobile")
    else {
      fail(text("af.failed"))
      return
    }
    let data = group.appendingPathComponent("Data", isDirectory: true).path
    let work = FileManager.default.temporaryDirectory.appendingPathComponent("autofill-work").path
    DispatchQueue.global(qos: .userInitiated).async {
      // Face ID is asked for inside this call.
      let raw = ss_af_logins(data, work)
      let json = raw.map { String(cString: $0) } ?? ""
      ss_af_free(raw)
      let answer = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
      DispatchQueue.main.async { self.show(answer) }
    }
  }

  private func show(_ answer: [String: Any]) {
    spinner.stopAnimating()
    if let error = answer["error"] as? String {
      fail(text("af.failed") + "\n" + error)
      return
    }
    logins = (answer["logins"] as? [[String: String]] ?? []).map {
      Login(
        service: $0["service"] ?? "", username: $0["username"] ?? "",
        password: $0["password"] ?? "", url: $0["url"] ?? "")
    }
    .sorted { $0.service.localizedCaseInsensitiveCompare($1.service) == .orderedAscending }
    if logins.isEmpty {
      fail(text("af.empty"), canRetry: false)
      return
    }
    status.text = nil
    table.isHidden = false
    filter()
  }

  private func fail(_ message: String, canRetry: Bool = true) {
    spinner.stopAnimating()
    status.text = message
    retry.isHidden = !canRetry
  }

  // MARK: Matching

  private func filter() {
    let shown = query.isEmpty
      ? logins
      : logins.filter {
        $0.service.localizedCaseInsensitiveContains(query)
          || $0.username.localizedCaseInsensitiveContains(query)
          || $0.url.localizedCaseInsensitiveContains(query)
      }
    suggested = shown.filter(matches)
    others = shown.filter { !matches($0) }
    table.reloadData()
  }

  /// A login whose site is the one asking, or a part of it.
  private func matches(_ login: Login) -> Bool {
    guard let stored = host(of: login.url) else { return false }
    return asked.contains { $0 == stored || $0.hasSuffix("." + stored) || stored.hasSuffix("." + $0) }
  }

  private func host(of identifier: String) -> String? {
    let trimmed = identifier.trimmingCharacters(in: .whitespaces)
    let withScheme = trimmed.contains("://") ? trimmed : "https://" + trimmed
    guard let host = URL(string: withScheme)?.host?.lowercased(), !host.isEmpty else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
    query = searchText
    filter()
  }

  // MARK: The list

  private func rows(_ section: Int) -> [Login] {
    section == 0 && !suggested.isEmpty ? suggested : others
  }

  func numberOfSections(in tableView: UITableView) -> Int {
    suggested.isEmpty ? 1 : 2
  }

  func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    if suggested.isEmpty { return nil }
    return section == 0 ? text("af.suggested") : text("af.all")
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    rows(section).count
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let login = rows(indexPath.section)[indexPath.row]
    let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
    cell.textLabel?.text = login.service.isEmpty ? (host(of: login.url) ?? "") : login.service
    cell.detailTextLabel?.text = login.username.isEmpty ? text("af.no_user") : login.username
    cell.detailTextLabel?.textColor = .secondaryLabel
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    let login = rows(indexPath.section)[indexPath.row]
    extensionContext.completeRequest(
      withSelectedCredential: ASPasswordCredential(user: login.username, password: login.password),
      completionHandler: nil)
  }

  private func cancel() {
    extensionContext.cancelRequest(
      withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
  }

  private func text(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
  }
}
