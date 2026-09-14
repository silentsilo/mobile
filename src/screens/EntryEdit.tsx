import { Eye, EyeOff, Trash2, WandSparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { withEdits } from "../shared/passwordEntry";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, parseTotpInput } from "../shared/totp";
import type { PasswordEntry } from "../shared/types";
import { Field, Sheet } from "../ui/chrome";
import { GeneratorSheet } from "../ui/GeneratorSheet";

function blankEntry(): PasswordEntry {
  const now = Date.now();
  return { id: crypto.randomUUID(), service: "", username: "", password: "", url: "", notes: "", category: "General", created_at: now, updated_at: now, type: "login" };
}

export function EntryEdit({
  entry,
  onCancel,
  onSaved,
  onDeleted,
}: {
  entry: PasswordEntry | null;
  onCancel: () => void;
  onSaved: (entry: PasswordEntry) => void;
  onDeleted: () => void;
}) {
  const [original] = useState(() => entry ?? blankEntry());
  const [service, setService] = useState(original.service);
  const [username, setUsername] = useState(original.username);
  const [password, setPassword] = useState(original.password);
  const [url, setUrl] = useState(original.url);
  const [totp, setTotp] = useState(original.totp_secret ?? "");
  const [notes, setNotes] = useState(original.notes);
  const [showPassword, setShowPassword] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!service.trim()) {
      setError("Give the entry a name.");
      return;
    }
    const changes: Partial<PasswordEntry> = { service: service.trim(), username, password, url: url.trim(), notes, updated_at: Date.now() };
    if (totp.trim()) {
      const params = parseTotpInput(totp.trim());
      if (!params) {
        setError("That one-time code setup key is not valid.");
        return;
      }
      changes.totp_secret = params.secret;
      changes.totp_digits = params.digits === DEFAULT_TOTP_DIGITS ? undefined : params.digits;
      changes.totp_period = params.period === DEFAULT_TOTP_PERIOD ? undefined : params.period;
      changes.totp_algorithm = params.algorithm === DEFAULT_TOTP_ALGORITHM ? undefined : params.algorithm;
    } else {
      changes.totp_secret = undefined;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = withEdits(original, changes);
      await api.upsertPassword(saved);
      onSaved(saved);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deletePassword(original.id);
      onDeleted();
    } catch (e) {
      setConfirmDelete(false);
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const input = (value: string, onChange: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="input">
      <input value={value} onChange={(e) => onChange(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} {...props} />
    </div>
  );

  return (
    <div className="screen">
      <div className="top-bar">
        <button className="text-btn" style={{ fontWeight: 600 }} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <div style={{ fontWeight: 700 }}>{entry ? "Edit entry" : "New entry"}</div>
        <button className="text-btn" style={{ fontWeight: 700 }} onClick={save} disabled={busy}>
          Save
        </button>
      </div>
      <div className="screen-body" style={{ gap: 16 }}>
        <Field label="Name">{input(service, setService, { autoCapitalize: "words", autoFocus: !entry })}</Field>
        <Field label="Username">{input(username, setUsername, { inputMode: "email" })}</Field>
        <Field label="Password">
          <div style={{ display: "flex", gap: 8 }}>
            <div className="input" style={{ flex: 1 }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <button className="icon-btn" style={{ width: 36, height: 36 }} aria-label={showPassword ? "Hide password" : "Show password"} onClick={(e) => { e.preventDefault(); setShowPassword(!showPassword); }}>
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            <button className="icon-btn framed" style={{ width: 48, height: 48, color: "var(--accent-hover)" }} aria-label="Generate a password" onClick={(e) => { e.preventDefault(); setGenerating(true); }}>
              <WandSparkles size={20} />
            </button>
          </div>
        </Field>
        <Field label="Website">{input(url, setUrl, { inputMode: "url", placeholder: "example.com" })}</Field>
        <Field label="One-time code setup key">{input(totp, setTotp, { placeholder: "Optional" })}</Field>
        <Field label="Notes">
          <div className="input">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="spacer" />
        {entry && (
          <button className="btn danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
            <Trash2 size={20} />
            Delete entry
          </button>
        )}
      </div>

      <GeneratorSheet
        open={generating}
        onClose={() => setGenerating(false)}
        onUse={(pw) => {
          setPassword(pw);
          setShowPassword(true);
          setGenerating(false);
        }}
      />

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${original.service}?`}>
        <p className="hint">This removes the entry from the silo on every device that syncs with it.</p>
        <button className="btn danger" onClick={remove} disabled={busy}>
          Delete entry
        </button>
        <button className="btn secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
          Keep it
        </button>
      </Sheet>
    </div>
  );
}
