import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { api, type StorageView, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { Field, Sheet } from "./chrome";

type Kind = StoreConfigInput["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "s3", label: "S3 bucket" },
  { kind: "web-dav", label: "WebDAV" },
  { kind: "sftp", label: "SFTP" },
];

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
}: {
  current?: StorageView | null;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: StoreConfigInput) => Promise<void>;
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

  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: e.target.value });
  // A stored secret may stand in for a blank one on the same kind.
  const secretKept = known === kind;
  // A server the desktop set up with a private key keeps signing in with it.
  const keyKept = secretKept && kind === "sftp" && current?.authMethod === "key";

  const ready =
    kind === "s3"
      ? f.endpoint && f.bucket && f.accessKeyId && (f.secret || secretKept)
      : kind === "web-dav"
        ? f.url && f.username && (f.password || secretKept)
        : f.host && f.username && f.path && (f.password || secretKept);

  const configFor = (hostFingerprint: string | null): StoreConfigInput => {
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

  return (
    <>
      <div className="segmented" role="group" aria-label="Storage type">
        {KINDS.map((k) => (
          <button key={k.kind} aria-pressed={kind === k.kind} onClick={() => { setKind(k.kind); setError(null); }}>
            {k.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
      <p className="hint small">Only encrypted data is kept there. These details stay on this phone.</p>
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
        <button className="btn" onClick={() => { const fp = fingerprint; setFingerprint(null); void submit(fp); }}>
          They match, continue
        </button>
        <button className="btn secondary" onClick={() => setFingerprint(null)}>
          Cancel
        </button>
      </Sheet>
    </>
  );
}
