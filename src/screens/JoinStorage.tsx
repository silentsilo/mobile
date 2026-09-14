import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { api, type JoinPreview, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { Field, Sheet, StepBar } from "../ui/chrome";

type Kind = StoreConfigInput["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "s3", label: "S3 bucket" },
  { kind: "web-dav", label: "WebDAV" },
  { kind: "sftp", label: "SFTP" },
];

export function JoinStorage({
  onBack,
  onFound,
}: {
  onBack: () => void;
  onFound: (config: StoreConfigInput, preview: JoinPreview) => void;
}) {
  const [kind, setKind] = useState<Kind>("s3");
  const [f, setF] = useState({
    endpoint: "",
    region: "",
    bucket: "",
    accessKeyId: "",
    secret: "",
    url: "",
    username: "",
    password: "",
    host: "",
    port: "22",
    path: "",
  });
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: e.target.value });

  const ready =
    kind === "s3"
      ? f.endpoint && f.bucket && f.accessKeyId && f.secret
      : kind === "web-dav"
        ? f.url && f.username && f.password
        : f.host && f.username && f.path && f.password;

  const configFor = (hostFingerprint: string | null): StoreConfigInput => {
    if (kind === "s3") {
      return {
        kind,
        endpoint: f.endpoint.trim(),
        region: f.region.trim() || "auto",
        bucket: f.bucket.trim(),
        prefix: "",
        accessKeyId: f.accessKeyId.trim(),
        secretAccessKey: f.secret,
        pathStyle: false,
      };
    }
    if (kind === "web-dav") return { kind, url: f.url.trim(), username: f.username.trim(), password: f.password };
    return {
      kind,
      host: f.host.trim(),
      port: Number(f.port) || 22,
      username: f.username.trim(),
      path: f.path.trim(),
      auth: { method: "password", password: f.password },
      hostFingerprint,
    };
  };

  const look = async (hostFingerprint: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const config = configFor(hostFingerprint);
      const preview = await api.previewJoin(config);
      if (!preview.vault_id) {
        setError("No silo was found in this storage. Check the details against SilentSilo on your computer.");
        return;
      }
      onFound(config, preview);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  // SFTP trusts a server only after its fingerprint has been seen, as on desktop.
  const onContinue = async () => {
    if (kind !== "sftp") return look(null);
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

  const secretInput = (key: "secret" | "password", placeholder?: string) => (
    <div className="input">
      <input type={showSecret ? "text" : "password"} value={f[key]} onChange={set(key)} placeholder={placeholder} autoComplete="off" />
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
    <div className="screen">
      <StepBar step={1} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Where is the backup?</h1>
          <p className="hint">The same storage your silo syncs to from your computer.</p>
        </div>
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
              <Field label="Access key ID">{text("accessKeyId")}</Field>
              <Field label="Secret access key">{secretInput("secret")}</Field>
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
              <Field label="Password">{secretInput("password")}</Field>
            </>
          )}
        </div>
        <p className="hint small">Only encrypted data is kept there. These details stay on this phone.</p>
        {error && <div className="notice error">{error}</div>}
        <div className="spacer" />
        <button className="btn" disabled={!ready || busy} onClick={onContinue}>
          {busy ? "Looking for your silo" : "Continue"}
        </button>
      </div>

      <Sheet open={fingerprint !== null} onClose={() => setFingerprint(null)} title="Check the server's fingerprint">
        <p className="hint">
          Compare this with the fingerprint your server shows. If they differ, someone may be between this phone and your
          server.
        </p>
        <div className="panel mono" style={{ padding: 14, wordBreak: "break-all", fontSize: "0.9rem" }}>
          {fingerprint}
        </div>
        <button className="btn" onClick={() => { const fp = fingerprint; setFingerprint(null); void look(fp); }}>
          They match, continue
        </button>
        <button className="btn secondary" onClick={() => setFingerprint(null)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
