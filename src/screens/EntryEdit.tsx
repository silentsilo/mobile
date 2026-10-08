import { Eye, EyeOff, Plus, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { withEdits } from "../shared/passwordEntry";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, parseTotpInput } from "../shared/totp";
import type { CustomField, PasswordEntry } from "../shared/types";
import { useBackLayer } from "../ui/back";
import { Field, Notice, Sheet } from "../ui/chrome";
import { GeneratorSheet } from "../ui/GeneratorSheet";
import { haptic } from "../ui/haptics";
import { t, useLocale, type Key } from "../i18n";

function blankEntry(): PasswordEntry {
  const now = Date.now();
  return { id: crypto.randomUUID(), service: "", username: "", password: "", url: "", notes: "", category: "General", created_at: now, updated_at: now, type: "login" };
}

export function EntryEdit({
  entry,
  sync,
  onCancel,
  onSaved,
  onDeleted,
}: {
  entry: PasswordEntry | null;
  sync: SyncStatus | null;
  onCancel: () => void;
  onSaved: (entry: PasswordEntry) => void;
  onDeleted: () => void;
}) {
  useLocale();
  const [original] = useState(() => entry ?? blankEntry());
  const [service, setService] = useState(original.service);
  const [username, setUsername] = useState(original.username);
  const [password, setPassword] = useState(original.password);
  const [url, setUrl] = useState(original.url);
  const [totp, setTotp] = useState(original.totp_secret ?? "");
  const [notes, setNotes] = useState(original.notes);
  const [fields, setFields] = useState<CustomField[]>(original.fields ?? []);
  const [showPassword, setShowPassword] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A field's own problem, shown under it.
  const [fieldError, setFieldError] = useState<{ field: "name" | "totp"; message: Key } | null>(null);
  // The field at fault comes into view with the caret in it.
  useEffect(() => {
    if (fieldError) document.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [fieldError]);
  // Back is Cancel, except while a save or delete is running.
  useBackLayer(true, () => !busy && onCancel());

  const save = async () => {
    setFieldError(null);
    if (!service.trim()) {
      setFieldError({ field: "name", message: "pw.need_name" });
      return;
    }
    // A row left with neither a name nor a value was added and never used.
    const kept = fields.filter((f) => f.name.trim() || f.value);
    const changes: Partial<PasswordEntry> = {
      service: service.trim(),
      username,
      password,
      url: url.trim(),
      notes,
      fields: kept.length > 0 ? kept : undefined,
      updated_at: Date.now(),
    };
    if (totp.trim()) {
      const params = parseTotpInput(totp.trim());
      if (!params) {
        setFieldError({ field: "totp", message: "pw.totp_setup_invalid" });
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
      onSaved(await api.savePassword(entry ?? undefined, withEdits(original, changes)));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    haptic("heavy");
    setBusy(true);
    try {
      await api.deletePassword(original);
      onDeleted();
    } catch (e) {
      setConfirmDelete(false);
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const invalid = (field: "name" | "totp") => fieldError?.field === field;
  const input = (
    value: string,
    onChange: (v: string) => void,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
    field?: "name" | "totp",
  ) => (
    <div className={field && invalid(field) ? "input invalid" : "input"}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (field && invalid(field)) setFieldError(null);
        }}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={field && invalid(field) ? true : undefined}
        aria-describedby={field && invalid(field) ? `${field}-error` : undefined}
        {...props}
      />
    </div>
  );
  const errorFor = (field: "name" | "totp") => (invalid(field) ? t(fieldError!.message) : null);

  return (
    <div className="screen">
      <div className="top-bar">
        <button className="text-btn" style={{ fontWeight: 600 }} onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <div style={{ fontWeight: 700 }}>{entry ? t("pw.edit_entry") : t("pw.new_entry")}</div>
        <button className="text-btn" style={{ fontWeight: 700 }} onClick={save} disabled={busy}>
          {t("common.save")}
        </button>
      </div>
      <div className="screen-body" style={{ gap: 16 }}>
        {/* Up here, next to Save: what went wrong with the save itself. */}
        {error && <Notice tone="error">{error}</Notice>}
        <Field label={t("pw.field_name")} error={errorFor("name")} errorId="name-error">
          {input(service, setService, { autoCapitalize: "words", autoFocus: !entry }, "name")}
        </Field>
        <Field label={t("pw.field_username")}>{input(username, setUsername, { inputMode: "email" })}</Field>
        <Field label={t("pw.field_password")}>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="input" style={{ flex: 1 }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <button className="icon-btn" aria-label={showPassword ? t("pw.hide_password") : t("pw.show_password")} onClick={(e) => { e.preventDefault(); setShowPassword(!showPassword); }}>
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            <button className="icon-btn framed accent" aria-label={t("pw.generate_password")} onClick={(e) => { e.preventDefault(); setGenerating(true); }}>
              <WandSparkles size={20} />
            </button>
          </div>
        </Field>
        <Field label={t("pw.field_website")}>{input(url, setUrl, { inputMode: "url", placeholder: "example.com" })}</Field>
        <Field label={t("pw.totp_setup_key")} error={errorFor("totp")} errorId="totp-error">
          {input(totp, setTotp, { placeholder: t("pw.optional") }, "totp")}
        </Field>
        <Field label={t("pw.field_custom_fields")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {fields.map((field, i) => {
              const update = (change: Partial<CustomField>) =>
                setFields((all) => all.map((f, j) => (j === i ? { ...f, ...change } : f)));
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div className="input" style={{ flex: 1 }}>
                      <input value={field.name} placeholder={t("pw.field_name")} aria-label={t("pw.custom_name_label")} onChange={(e) => update({ name: e.target.value })} />
                    </div>
                    <button className="icon-btn" aria-label={t("pw.custom_remove")} onClick={(e) => { e.preventDefault(); setFields((all) => all.filter((_, j) => j !== i)); }}>
                      <Trash2 size={20} />
                    </button>
                  </div>
                  <div className="input">
                    <input
                      type={field.hidden && !showPassword ? "password" : "text"}
                      value={field.value}
                      placeholder={t("pw.custom_value")}
                      aria-label={field.name ? t("pw.custom_value_label", { name: field.name }) : t("pw.custom_value_label_unnamed")}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => update({ value: e.target.value })}
                    />
                  </div>
                  <label className="hint small check-label">
                    <input type="checkbox" checked={field.hidden} onChange={(e) => update({ hidden: e.target.checked })} />
                    {t("pw.custom_hidden")}
                  </label>
                </div>
              );
            })}
            <button className="btn secondary" onClick={(e) => { e.preventDefault(); setFields((all) => [...all, { name: "", value: "", hidden: false }]); }}>
              <Plus size={20} />
              {t("pw.custom_add")}
            </button>
          </div>
        </Field>
        <Field label={t("pw.field_notes")}>
          <div className="input">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("pw.optional")} />
          </div>
        </Field>
        <div className="spacer" />
        {entry && (
          <button className="btn danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
            <Trash2 size={20} />
            {t("pw.delete_entry")}
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

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("pw.delete_title", { name: original.service })}>
        <p className="hint">
          {sync?.configured ? t("pw.delete_synced") : t("pw.delete_local")} {t("pw.delete_no_trash")}
          {sync?.configured && sync.archive_targets > 0 && ` ${t("pw.delete_archive")}`}
        </p>
        <button className="btn danger" onClick={remove} disabled={busy}>
          {t("pw.delete_for_good")}
        </button>
        <button className="btn secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
