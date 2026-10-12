// "SilentSilo" in iOS's AutoFill: opens the silo with Face ID through Rust
// (`autofill/`, via autofill.h), lists its logins with the ones for the
// site or app asking first, and hands the chosen one to iOS. A login saved
// for another site is filled only after a second question that names both.
// iOS shows this only when the person picks SilentSilo; nothing is offered
// without it.

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
  private let asking = UILabel()
  private let status = UILabel()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let retry = UIButton(type: .system)

  // MARK: iOS's entry points

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    asked = sites(serviceIdentifiers)
    load()
  }

  /// Nothing is saved with iOS for filling without a prompt, so iOS should
  /// never ask; if it does, it gets the list.
  override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
    extensionContext.cancelRequest(
      withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
  }

  override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
    asked = sites([credentialIdentity.serviceIdentifier])
    load()
  }

  /// Hosts of the sites iOS named, in its order. Other kinds of identifier
  /// name no site.
  private func sites(_ identifiers: [ASCredentialServiceIdentifier]) -> [String] {
    identifiers
      .filter { $0.type == .domain || $0.type == .URL }
      .compactMap { host(of: $0.identifier) }
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

    // Which site is asking, shown before anything is chosen.
    asking.numberOfLines = 0
    asking.textColor = .secondaryLabel
    asking.font = .preferredFont(forTextStyle: .subheadline)

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

    for part in [bar, asking, search, table, waiting] as [UIView] {
      part.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(part)
    }
    let margins = view.layoutMarginsGuide
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      bar.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
      asking.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 6),
      asking.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      asking.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
      search.topAnchor.constraint(equalTo: asking.bottomAnchor, constant: 8),
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
    if let asker = asked.first {
      asking.text = String(format: text("af.asking"), asker)
    } else {
      asking.text = text("af.asking_unknown")
    }
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
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      // Face ID is asked for inside this call.
      let raw = ss_af_logins(data, work)
      let json = raw.map { String(cString: $0) } ?? ""
      ss_af_free(raw)
      let answer = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
      DispatchQueue.main.async { self?.show(answer) }
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

  /// A login saved for exactly the host asking, or its www. twin. A parent
  /// or child domain is not a match. With no site named, nothing matches.
  private func matches(_ login: Login) -> Bool {
    guard let stored = host(of: login.url) else { return false }
    return asked.contains { bare($0) == bare(stored) }
  }

  /// The lowercased host of a URL, or of a bare domain read as https.
  private func host(of identifier: String) -> String? {
    let trimmed = identifier.trimmingCharacters(in: .whitespaces)
    let withScheme = trimmed.contains("://") ? trimmed : "https://" + trimmed
    guard let host = URL(string: withScheme)?.host?.lowercased(), !host.isEmpty else { return nil }
    return host
  }

  /// The host without a leading "www.", so example.com and www.example.com
  /// compare equal.
  private func bare(_ host: String) -> String {
    host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  /// A login's site as the person knows it: its host, else its service name.
  private func site(of login: Login) -> String {
    if let host = host(of: login.url) { return host }
    return login.service.isEmpty ? text("af.no_site") : login.service
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
    tableView.deselectRow(at: indexPath, animated: true)
    let login = rows(indexPath.section)[indexPath.row]
    if matches(login) {
      fill(login)
    } else {
      confirm(login)
    }
  }

  /// Any other login is filled only after the person sees both sites and
  /// says so. Cancel leaves the list as it was.
  private func confirm(_ login: Login) {
    guard presentedViewController == nil else { return }
    let saved = site(of: login)
    let message: String
    if let asker = asked.first {
      message = String(format: text("af.confirm_other"), saved, asker)
    } else {
      message = String(format: text("af.confirm_unknown"), saved)
    }
    let alert = UIAlertController(title: text("af.confirm_title"), message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: text("af.cancel"), style: .cancel))
    alert.addAction(
      UIAlertAction(title: text("af.fill"), style: .default) { [weak self] _ in self?.fill(login) })
    present(alert, animated: true)
  }

  private func fill(_ login: Login) {
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
