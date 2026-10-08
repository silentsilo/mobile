import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type CloudKind, type StorageView, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { Field, Notice, Sheet } from "./chrome";
import { dateLocale, t, useLocale, type Key } from "../i18n";

type Kind = StoreConfigInput["kind"];

const KINDS: { kind: Kind; label: () => string }[] = [
  { kind: "s3", label: () => t("silo.kind_s3") },
  { kind: "web-dav", label: () => "WebDAV" },
  { kind: "sftp", label: () => "SFTP" },
];

/** Each provider's name, its company, and the texts that say where its folder is. */
const CLOUD: Record<CloudKind, { name: string; company: string; noSilo: Key; folderHint: Key }> = {
  onedrive: {
    name: "OneDrive",
    company: "Microsoft",
    noSilo: "silo.cloud_no_silo_onedrive",
    folderHint: "silo.cloud_folder_hint_onedrive",
  },
  dropbox: {
    name: "Dropbox",
    company: "Dropbox",
    noSilo: "silo.cloud_no_silo_dropbox",
    folderHint: "silo.cloud_folder_hint_dropbox",
  },
  "google-drive": {
    name: "Google Drive",
    company: "Google",
    noSilo: "silo.cloud_no_silo_google",
    folderHint: "silo.cloud_folder_hint_google",
  },
};

/** Free space with the language's decimal separator: "12,5 GB" in Romanian. */
function freeSpace(bytes: number): string {
  const [value, unit] = formatBytes(bytes).split(" ");
  const n = Number(value);
  return Number.isFinite(n) && unit ? `${n.toLocaleString(dateLocale())} ${unit}` : formatBytes(bytes);
}

function isCloud(kind: string): kind is CloudKind {
  return kind in CLOUD;
}

/** The rule core applies, said before anything is sent. */
function folderProblem(folder: string): string | null {
  const name = folder.trim();
  if (!name) return t("silo.folder_empty");
  // eslint-disable-next-line no-control-regex
  if (name.length > 100 || /["*:<>?/\\|\u0000-\u001f]/.test(name) || name.startsWith(".") || name.endsWith(".")) {
    return t("silo.folder_invalid");
  }
  return null;
}

/**
 * The details of a backup storage, for joining a silo, making one, or
 * changing where it backs up. `current` fills in what is stored, without
 * secrets; a secret left blank then keeps the stored one, for the same
 * server only.
 */
export function StorageForm({
  current,
  submitLabel,
  busyLabel,
  onSubmit,
  joining = false,
}: {
  current?: StorageView | null;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: StoreConfigInput) => Promise<void>;
  /** Joining a silo: a cloud account lists the silos it holds. */
  joining?: boolean;
}) {
  useLocale();
  const known = current?.configured && current.kind !== "folder" ? (current.kind as Kind) : null;
  const [kind, setKind] = useState<Kind>(known ?? "s3");
  const [f, setF] = useState({
    endpoint: current?.endpoint ?? "",
    region: current?.region ?? "",
    bucket: current?.bucket ?? "",
    prefix: current?.prefix ?? "",
    accessKeyId: current?.accessKeyId ?? "",
    secret: "",
    url: current?.url ?? "",
    username: current?.username ?? "",
    password: "",
    host: current?.host ?? "",
    port: current?.port ? String(current.port) : "22",
    path: current?.path ?? "",
  });
  const [pathStyle, setPathStyle] = useState(current?.pathStyle ?? false);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // A cloud account: the sign-in's id, what to show of it, and the folder.
  // Stored, a copy keeps its sign-in while the folder stays the same.
  const storedCloud = current?.configured && isCloud(current.kind);
  const [cloud, setCloud] = useState({
    signIn: null as string | null,
    account: storedCloud ? current.username : "",
    freeBytes: null as number | null,
    folder: storedCloud ? current.path : "Silo",
  });
  const [found, setFound] = useState<string[] | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  /// The sign-in a save could still adopt, and whether a save has started.
  /// Leaving the form without one lets the sign-in go; with one, the save
  /// owns it.
  const unsaved = useRef<{ signIn: string | null; submitted: boolean }>({
    signIn: null,
    submitted: false,
  });
  useEffect(
    () => () => {
      const { signIn, submitted } = unsaved.current;
      if (signIn && !submitted) void api.cloudDiscardSignIn(signIn).catch(() => undefined);
    },
    [],
  );
  // Back from the browser while the sign-in still finishes: the token is
  // fetched once the phone lets the app on the network again.
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (!signingIn) {
      setBack(false);
      return;
    }
    const seen = () => {
      if (document.visibilityState === "visible") setBack(true);
    };
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [signingIn]);
  const [clouds, setClouds] = useState<CloudKind[]>([]);
  useEffect(() => {
    let live = true;
    api
      .cloudProviders()
      .then((kinds) => {
        if (live) setClouds((Object.keys(CLOUD) as CloudKind[]).filter((k) => kinds.includes(k)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const choose = (next: Kind) => {
    // Another provider's sign-in is not this one's.
    if (next !== kind && isCloud(next)) {
      const same = known === next;
      setCloud({
        signIn: null,
        account: same ? current?.username ?? "" : "",
        freeBytes: null,
        folder: same ? current?.path ?? "Silo" : "Silo",
      });
      setFound(null);
    }
    setKind(next);
    setError(null);
  };

  const signIn = async () => {
    if (!isCloud(kind)) return;
    setSigningIn(true);
    setError(null);
    try {
      const done = await api.cloudSignIn(kind);
      // Signed in again: the one it replaces is no longer going anywhere.
      const replaced = unsaved.current.signIn;
      if (replaced && replaced !== done.id) void api.cloudDiscardSignIn(replaced).catch(() => undefined);
      unsaved.current.signIn = done.id;
      const folders = joining ? await api.cloudListSilos(done.id) : null;
      setFound(folders);
      // From the state as it is now: a name typed while the sign-in was
      // finishing stays.
      setCloud((prev) => ({
        signIn: done.id,
        account: done.account.label,
        freeBytes: done.account.freeBytes,
        folder: folders && folders.length > 0 ? folders[0]! : prev.folder,
      }));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSigningIn(false);
    }
  };

  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: e.target.value });
  // A stored secret may stand in for a blank one on the same kind.
  const secretKept = known === kind;
  // A server the desktop set up with a private key keeps signing in with it.
  const keyKept = secretKept && kind === "sftp" && current?.authMethod === "key";

  const ready = isCloud(kind)
    ? (cloud.signIn || (known === kind && cloud.account)) && !folderProblem(cloud.folder)
    : kind === "s3"
      ? f.endpoint && f.bucket && f.accessKeyId && (f.secret || secretKept)
      : kind === "web-dav"
        ? f.url && f.username && (f.password || secretKept)
        : f.host && f.username && f.path && (f.password || secretKept);

  const configFor = (hostFingerprint: string | null): StoreConfigInput => {
    if (isCloud(kind)) return { kind, signIn: cloud.signIn, folder: cloud.folder.trim() };
    if (kind === "s3") {
      return {
        kind,
        endpoint: f.endpoint.trim(),
        region: f.region.trim() || "auto",
        bucket: f.bucket.trim(),
        prefix: f.prefix.trim(),
        accessKeyId: f.accessKeyId.trim(),
        secretAccessKey: f.secret || null,
        pathStyle,
      };
    }
    if (kind === "web-dav") return { kind, url: f.url.trim(), username: f.username.trim(), password: f.password || null };
    return {
      kind,
      host: f.host.trim(),
      port: Number(f.port) || 22,
      username: f.username.trim(),
      path: f.path.trim(),
      auth:
        keyKept && !f.password
          ? { method: "key", privateKey: null, passphrase: null }
          : { method: "password", password: f.password || null },
      hostFingerprint,
    };
  };

  const submit = async (hostFingerprint: string | null) => {
    unsaved.current.submitted = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(configFor(hostFingerprint));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  // SFTP trusts a server only after its fingerprint has been seen, as on desktop.
  const onContinue = async () => {
    if (kind !== "sftp") return submit(null);
    setBusy(true);
    setError(null);
    try {
      setFingerprint(await api.probeHostKey(f.host.trim(), Number(f.port) || 22));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const secretInput = (key: "secret" | "password") => (
    <div className="input">
      <input
        type={showSecret ? "text" : "password"}
        value={f[key]}
        onChange={set(key)}
        placeholder={secretKept ? t("silo.unchanged") : undefined}
        autoComplete="off"
      />
      <button className="icon-btn" aria-label={showSecret ? t("silo.hide") : t("silo.show")} onClick={(e) => { e.preventDefault(); setShowSecret(!showSecret); }}>
        {showSecret ? <EyeOff size={20} /> : <Eye size={20} />}
      </button>
    </div>
  );

  const text = (key: keyof typeof f, placeholder?: string, mode?: "url" | "numeric") => (
    <div className="input">
      <input value={f[key]} onChange={set(key)} placeholder={placeholder} inputMode={mode} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    </div>
  );

  // The contents stay encrypted over plain HTTP; the key or password that
  // reaches the storage does not, on whatever network the phone is on.
  const plainHttp = /^http:\/\//i.test(kind === "s3" ? f.endpoint.trim() : kind === "web-dav" ? f.url.trim() : "");

  // The same server answering with another key than the one confirmed before.
  const rekeyed =
    fingerprint !== null &&
    known === "sftp" &&
    !!current?.hostFingerprint &&
    current.host === f.host.trim() &&
    current.port === (Number(f.port) || 22) &&
    current.hostFingerprint !== fingerprint;

  return (
    <>
      {clouds.length > 0 && (
        <>
          <p className="hint small">{t("silo.group_accounts")}</p>
          <div className="segmented" role="group" aria-label={t("silo.account")}>
            {clouds.map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => choose(k)}>
                {CLOUD[k].name}
              </button>
            ))}
          </div>
          <p className="hint small">{t("silo.group_own")}</p>
        </>
      )}
      <div className="segmented" role="group" aria-label={t("silo.storage_type")}>
        {KINDS.map((k) => (
          <button key={k.kind} aria-pressed={kind === k.kind} onClick={() => choose(k.kind)}>
            {k.label()}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {isCloud(kind) && (
          <>
            {signingIn ? (
              <>
                <p className="hint">
                  {back
                    ? t("silo.cloud_finishing", { provider: CLOUD[kind].name })
                    : t("silo.cloud_finish_sign_in", { provider: CLOUD[kind].name })}
                </p>
                <button className="btn secondary" onClick={() => void api.cloudCancelSignIn().catch(() => undefined)}>
                  {t("common.cancel")}
                </button>
              </>
            ) : cloud.account ? (
              <>
                <div className="notice">
                  {cloud.freeBytes !== null
                    ? t("silo.cloud_connected_as_free", { account: cloud.account, size: freeSpace(cloud.freeBytes) })
                    : t("silo.cloud_connected_as", { account: cloud.account })}
                </div>
                <button className="btn secondary" disabled={busy} onClick={() => void signIn()}>
                  {t("silo.cloud_other_account")}
                </button>
              </>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={() => void signIn()}>
                  {t("silo.cloud_connect", { provider: CLOUD[kind].name })}
                </button>
                <p className="hint small">{t("silo.cloud_connect_hint", { company: CLOUD[kind].company })}</p>
              </>
            )}
            {joining ? (
              found === null ? null : found.length > 0 ? (
                <Field label={t("silo.cloud_silo_folder")}>
                  <div className="input">
                    <select
                      value={cloud.folder}
                      onChange={(e) => setCloud({ ...cloud, folder: e.target.value })}
                      style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", font: "inherit", color: "inherit" }}
                    >
                      {found.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>
              ) : (
                <Notice tone="error">{t(CLOUD[kind].noSilo)}</Notice>
              )
            ) : (
              <>
                <Field label={t("silo.cloud_folder_name")}>
                  <div className="input">
                    <input
                      value={cloud.folder}
                      onChange={(e) => setCloud({ ...cloud, folder: e.target.value })}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                </Field>
                <p className="hint small">
                  {folderProblem(cloud.folder) ?? t(CLOUD[kind].folderHint)}
                </p>
              </>
            )}
          </>
        )}
        {kind === "s3" && (
          <>
            <Field label={t("silo.field_endpoint")}>{text("endpoint", "https://s3.example.com", "url")}</Field>
            <Field label={t("silo.field_region")}>{text("region", "auto")}</Field>
            <Field label={t("silo.field_bucket")}>{text("bucket")}</Field>
            <Field label={t("silo.field_prefix")}>{text("prefix")}</Field>
            <Field label={t("silo.field_access_key_id")}>{text("accessKeyId")}</Field>
            <Field label={t("silo.field_secret_key")}>{secretInput("secret")}</Field>
            <label className="check-label">
              <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} />
              <span>{t("silo.field_path_style")}</span>
            </label>
          </>
        )}
        {kind === "web-dav" && (
          <>
            <Field label={t("silo.field_url")}>{text("url", "https://dav.example.com/silentsilo", "url")}</Field>
            <Field label={t("silo.field_username")}>{text("username")}</Field>
            <Field label={t("silo.field_password")}>{secretInput("password")}</Field>
          </>
        )}
        {kind === "sftp" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 8 }}>
              <Field label={t("silo.field_host")}>{text("host", "nas.example.com")}</Field>
              <Field label={t("silo.field_port")}>{text("port", "22", "numeric")}</Field>
            </div>
            <Field label={t("silo.field_username")}>{text("username")}</Field>
            <Field label={t("silo.field_sftp_folder")}>{text("path", "/backups/silentsilo")}</Field>
            <Field label={keyKept ? t("silo.field_password_keeps_key") : t("silo.field_password")}>{secretInput("password")}</Field>
          </>
        )}
      </div>
      {plainHttp && (
        <Notice tone="warning">{t("silo.plain_http")}</Notice>
      )}
      <p className="hint small">{t("silo.encrypted_here")}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="spacer" />
      <button className="btn" aria-busy={busy} disabled={!ready || busy} onClick={onContinue}>
        {busy ? busyLabel : submitLabel}
      </button>

      <Sheet open={fingerprint !== null} onClose={() => setFingerprint(null)} title={t("silo.fp_title")}>
        <p className="hint">{t("silo.fp_hint")}</p>
        <div className="panel mono small" style={{ padding: 14, wordBreak: "break-all" }}>
          {fingerprint}
        </div>
        {rekeyed && (
          <Notice tone="error">{t("silo.fp_changed")}</Notice>
        )}
        <button className="btn" disabled={rekeyed && !f.password} onClick={() => { const fp = fingerprint; setFingerprint(null); void submit(fp); }}>
          {t("silo.fp_match")}
        </button>
        <button className="btn secondary" onClick={() => setFingerprint(null)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </>
  );
}
