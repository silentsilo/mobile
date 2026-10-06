import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type CloudKind, type StorageView, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { Field, Sheet } from "./chrome";

type Kind = StoreConfigInput["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "s3", label: "S3 bucket" },
  { kind: "web-dav", label: "WebDAV" },
  { kind: "sftp", label: "SFTP" },
];

const CLOUD: Record<CloudKind, { name: string; company: string; place: string }> = {
  onedrive: { name: "OneDrive", company: "Microsoft", place: "Apps/SilentSilo on your OneDrive" },
  dropbox: { name: "Dropbox", company: "Dropbox", place: "Apps/SilentSilo in your Dropbox" },
  "google-drive": { name: "Google Drive", company: "Google", place: "the SilentSilo folder of your Google Drive" },
};

function isCloud(kind: string): kind is CloudKind {
  return kind in CLOUD;
}

/** The rule core applies, said before anything is sent. */
function folderProblem(folder: string): string | null {
  const name = folder.trim();
  if (!name) return "Give the folder a name.";
  // eslint-disable-next-line no-control-regex
  if (name.length > 100 || /["*:<>?/\\|\u0000-\u001f]/.test(name) || name.startsWith(".") || name.endsWith(".")) {
    return 'Use a plain folder name: no slashes, none of " * : < > ? |, no dot at either end.';
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
        placeholder={secretKept ? "Unchanged" : undefined}
        autoComplete="off"
      />
      <button className="icon-btn" style={{ width: 36, height: 36 }} aria-label={showSecret ? "Hide" : "Show"} onClick={(e) => { e.preventDefault(); setShowSecret(!showSecret); }}>
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
          <p className="hint small">An account you already have</p>
          <div className="segmented" role="group" aria-label="Account">
            {clouds.map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => choose(k)}>
                {CLOUD[k].name}
              </button>
            ))}
          </div>
          <p className="hint small">Storage you run or rent</p>
        </>
      )}
      <div className="segmented" role="group" aria-label="Storage type">
        {KINDS.map((k) => (
          <button key={k.kind} aria-pressed={kind === k.kind} onClick={() => choose(k.kind)}>
            {k.label}
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
                    ? `Finishing the sign-in with ${CLOUD[kind].name}…`
                    : `Finish signing in to ${CLOUD[kind].name} in your browser, then come back here.`}
                </p>
                <button className="btn secondary" onClick={() => void api.cloudCancelSignIn().catch(() => undefined)}>
                  Cancel
                </button>
              </>
            ) : cloud.account ? (
              <>
                <div className="notice">
                  Connected as {cloud.account}
                  {cloud.freeBytes !== null ? `, ${formatBytes(cloud.freeBytes)} free` : ""}
                </div>
                <button className="btn secondary" disabled={busy} onClick={() => void signIn()}>
                  Use another account
                </button>
              </>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={() => void signIn()}>
                  Connect {CLOUD[kind].name}
                </button>
                <p className="hint small">
                  Opens {CLOUD[kind].company}&apos;s sign-in page in your browser. SilentSilo never sees your password,
                  and gets access only to its own folder.
                </p>
              </>
            )}
            {joining ? (
              found === null ? null : found.length > 0 ? (
                <Field label="Silo folder">
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
                <div className="notice error">There is no silo in {CLOUD[kind].place} yet. Sync once from your computer.</div>
              )
            ) : (
              <>
                <Field label="Folder name">
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
                  {folderProblem(cloud.folder) ??
                    `In ${CLOUD[kind].place}. ${CLOUD[kind].company} sees this name. Your files inside are encrypted.`}
                </p>
              </>
            )}
          </>
        )}
        {kind === "s3" && (
          <>
            <Field label="Endpoint">{text("endpoint", "https://s3.example.com", "url")}</Field>
            <Field label="Region">{text("region", "auto")}</Field>
            <Field label="Bucket">{text("bucket")}</Field>
            <Field label="Folder in the bucket (optional)">{text("prefix")}</Field>
            <Field label="Access key ID">{text("accessKeyId")}</Field>
            <Field label="Secret access key">{secretInput("secret")}</Field>
            <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} style={{ width: 22, height: 22 }} />
              <span>Path-style addresses (MinIO and most self-hosted servers)</span>
            </label>
          </>
        )}
        {kind === "web-dav" && (
          <>
            <Field label="URL">{text("url", "https://dav.example.com/silentsilo", "url")}</Field>
            <Field label="Username">{text("username")}</Field>
            <Field label="Password">{secretInput("password")}</Field>
          </>
        )}
        {kind === "sftp" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 8 }}>
              <Field label="Host">{text("host", "nas.example.com")}</Field>
              <Field label="Port">{text("port", "22", "numeric")}</Field>
            </div>
            <Field label="Username">{text("username")}</Field>
            <Field label="Folder on the server">{text("path", "/backups/silentsilo")}</Field>
            <Field label={keyKept ? "Password (blank keeps the stored private key)" : "Password"}>{secretInput("password")}</Field>
          </>
        )}
      </div>
      {plainHttp && (
        <div className="notice warning">
          Plain HTTP. Your files are still encrypted, but the password or access key for this storage travels readable on the
          network, public Wi-Fi included. Use https://.
        </div>
      )}
      <p className="hint small">The silo is encrypted on this phone before it is sent. These details stay on this phone.</p>
      {error && <div className="notice error">{error}</div>}
      <div className="spacer" />
      <button className="btn" disabled={!ready || busy} onClick={onContinue}>
        {busy ? busyLabel : submitLabel}
      </button>

      <Sheet open={fingerprint !== null} onClose={() => setFingerprint(null)} title="Check the server's fingerprint">
        <p className="hint">
          Compare this with the fingerprint your server shows. If they differ, someone may be between this phone and your
          server.
        </p>
        <div className="panel mono" style={{ padding: 14, wordBreak: "break-all", fontSize: "0.9rem" }}>
          {fingerprint}
        </div>
        {rekeyed && (
          <div className="notice error">
            This is not the key this server had before. If you did not change the server, someone may be between this phone
            and it. The saved password is not sent to it: type the password again to trust the new key.
          </div>
        )}
        <button className="btn" disabled={rekeyed && !f.password} onClick={() => { const fp = fingerprint; setFingerprint(null); void submit(fp); }}>
          They match, continue
        </button>
        <button className="btn secondary" onClick={() => setFingerprint(null)}>
          Cancel
        </button>
      </Sheet>
    </>
  );
}
