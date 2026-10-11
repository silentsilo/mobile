import { Eye, EyeOff, Paperclip, Plus, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { withEdits } from "../shared/passwordEntry";
import { categoryChoices, categoryLabel, FALLBACK_CATEGORY, hashColor, resolveCategories, typeOf } from "../shared/passwordUtil";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, parseTotpInput } from "../shared/totp";
import type { CredentialType, CustomField, PasswordAttachment, PasswordCategory, PasswordEntry } from "../shared/types";
import { formatBytes } from "../shared/format";
import { useBackLayer } from "../ui/back";
import { Field, Notice, Sheet } from "../ui/chrome";
import { GeneratorSheet } from "../ui/GeneratorSheet";
import { haptic } from "../ui/haptics";
import { t, useLocale, type Key } from "../i18n";

function blankEntry(category: string | null, type: CredentialType): PasswordEntry {
  const now = Date.now();
  return { id: crypto.randomUUID(), service: "", username: "", password: "", url: "", notes: "", category: category ?? FALLBACK_CATEGORY, created_at: now, updated_at: now, type };
}

type TypedField = {
  key: keyof PasswordEntry;
  label: Key;
  secret?: boolean;
  multiline?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
};

/** The fields each kind of entry has beyond a name, as desktop asks them. */
const TYPED_FIELDS: Record<Exclude<CredentialType, "login" | "note">, TypedField[]> = {
  card: [
    { key: "card_holder", label: "pw.field_cardholder" },
    { key: "card_number", label: "pw.field_number", secret: true, inputMode: "numeric" },
    { key: "card_exp_month", label: "pw.field_expiry_month", inputMode: "numeric" },
    { key: "card_exp_year", label: "pw.field_expiry_year", inputMode: "numeric" },
    { key: "card_code", label: "pw.field_security_code", secret: true, inputMode: "numeric" },
    { key: "card_brand", label: "pw.field_brand" },
  ],
  identity: [
    { key: "id_full_name", label: "pw.field_full_name" },
    { key: "id_company", label: "pw.field_company" },
    { key: "id_email", label: "pw.field_email", inputMode: "email" },
    { key: "id_phone", label: "pw.field_phone", inputMode: "tel" },
    { key: "id_address", label: "pw.field_address", multiline: true },
    { key: "id_city", label: "pw.field_city" },
    { key: "id_state", label: "pw.field_state" },
    { key: "id_zip", label: "pw.field_postal_code" },
    { key: "id_country", label: "pw.field_country" },
  ],
  ssh_key: [
    { key: "ssh_private_key", label: "pw.field_private_key", secret: true, multiline: true },
    { key: "ssh_public_key", label: "pw.field_public_key", multiline: true },
    { key: "ssh_fingerprint", label: "pw.field_fingerprint" },
  ],
};

const TYPE_TITLES: Record<CredentialType, Key> = {
  login: "pw.new_login",
  card: "pw.new_card",
  identity: "pw.new_identity",
  note: "pw.new_note",
  ssh_key: "pw.new_ssh_key",
};

/** The choice that opens a field for a category not in the list yet. */
const NEW_CATEGORY = "new-category:choice";

export function EntryEdit({
  entry,
  category: startCategory = null,
  type: startType = "login",
  sync,
  onCancel,
  onSaved,
  onDeleted,
}: {
  entry: PasswordEntry | null;
  /** For a new entry: the category the list was showing. */
  category?: string | null;
  /** For a new entry: the kind chosen before the editor opened. */
  type?: CredentialType;
  sync: SyncStatus | null;
  onCancel: () => void;
  onSaved: (entry: PasswordEntry) => void;
  onDeleted: () => void;
}) {
  useLocale();
  const [original] = useState(() => entry ?? blankEntry(startCategory, startType));
  const type = typeOf(original);
  const typed = type === "login" || type === "note" ? [] : TYPED_FIELDS[type];
  const [extra, setExtra] = useState<Record<string, string>>(() =>
    Object.fromEntries(typed.map((f) => [f.key, String(original[f.key] ?? "")])),
  );
  const [reveal, setReveal] = useState(false);
  const [reauth, setReauth] = useState(Boolean(original.require_reauth));
  // Files attached here are sealed into the silo at once; the entry names
  // them only when saved. Those added and then dropped, or left by a
  // cancel, are taken back out; those removed go once the save is stored.
  const [attachments, setAttachments] = useState<PasswordAttachment[]>(original.attachments ?? []);
  const [attaching, setAttaching] = useState<string | null>(null);
  const addedHere = useRef(new Set<string>());
  const attach = async () => {
    try {
      const picked = await api.pickFiles();
      for (const file of picked) {
        setAttaching(file.name);
        const sealed = await api.attachFile(file);
        addedHere.current.add(sealed.blob_id);
        setAttachments((all) => [...all, sealed]);
      }
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setAttaching(null);
    }
  };
  const detach = (attachment: PasswordAttachment) => {
    setAttachments((all) => all.filter((a) => a.blob_id !== attachment.blob_id));
    if (addedHere.current.delete(attachment.blob_id)) {
      void api.deleteAttachment(attachment.blob_id).catch(() => undefined);
    }
  };
  const cancelRef = useRef(() => {});
  const cancel = () => {
    for (const id of addedHere.current) void api.deleteAttachment(id).catch(() => undefined);
    addedHere.current.clear();
    onCancel();
  };
  cancelRef.current = cancel;
  const [category, setCategory] = useState(original.category || FALLBACK_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [stored, setStored] = useState<PasswordCategory[] | null>(null);
  const [inUse, setInUse] = useState<PasswordEntry[]>([]);
  useEffect(() => {
    api.readPasswordStore().then(
      (store) => {
        setStored(store.categories);
        setInUse(store.entries);
      },
      () => undefined,
    );
  }, []);
  const known = resolveCategories(stored, inUse);
  const choices = categoryChoices(known);
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
  useBackLayer(true, () => !busy && cancelRef.current());

  const save = async () => {
    setFieldError(null);
    if (!service.trim()) {
      setFieldError({ field: "name", message: "pw.need_name" });
      return;
    }
    // A row left with neither a name nor a value was added and never used.
    const kept = fields.filter((f) => f.name.trim() || f.value);
    const named = newCategory.trim();
    const chosen = category === NEW_CATEGORY ? named || FALLBACK_CATEGORY : category;
    // A name typed here joins the list, so desktop shows it too.
    if (category === NEW_CATEGORY && named && !known.some((c) => c.name === named)) {
      try {
        await api.saveCategories([...known, { name: named, color: hashColor(named) }]);
      } catch (e) {
        setError(formatAppError(e));
        return;
      }
    }
    const changes: Partial<PasswordEntry> = {
      category: chosen,
      service: service.trim(),
      username,
      password,
      url: url.trim(),
      notes,
      fields: kept.length > 0 ? kept : undefined,
      require_reauth: reauth || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      updated_at: Date.now(),
    };
    for (const f of typed) {
      const value = extra[f.key] ?? "";
      (changes as Record<string, unknown>)[f.key] = value.trim() ? value : undefined;
    }
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
      const saved = await api.savePassword(entry ?? undefined, withEdits(original, changes));
      // Stored without them now: their content can go from this phone.
      const kept = new Set(attachments.map((a) => a.blob_id));
      for (const gone of (original.attachments ?? []).filter((a) => !kept.has(a.blob_id))) {
        void api.deleteAttachment(gone.blob_id).catch(() => undefined);
      }
      addedHere.current.clear();
      onSaved(saved);
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
        <button className="text-btn" style={{ fontWeight: 600 }} onClick={cancel} disabled={busy || attaching !== null}>
          {t("common.cancel")}
        </button>
        <div style={{ fontWeight: 700 }}>{entry ? t("pw.edit_entry") : t(TYPE_TITLES[type])}</div>
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
        <Field label={t("pw.field_category")}>
          <div className="input">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", font: "inherit", color: "inherit" }}
            >
              {(choices.includes(category) || category === NEW_CATEGORY ? choices : [category, ...choices]).map((name) => (
                <option key={name} value={name}>
                  {categoryLabel(name)}
                </option>
              ))}
              <option value={NEW_CATEGORY}>{t("pw.new_category")}</option>
            </select>
          </div>
        </Field>
        {category === NEW_CATEGORY && (
          <Field label={t("pw.new_category_name")}>
            <div className="input">
              <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} autoCapitalize="words" autoFocus />
            </div>
          </Field>
        )}
        {typed.map((f) => (
          <Field key={f.key} label={t(f.label)}>
            <div className="input">
              {f.multiline ? (
                <textarea
                  className={f.secret && !reveal ? "masked-text" : undefined}
                  value={extra[f.key] ?? ""}
                  onChange={(e) => setExtra((x) => ({ ...x, [f.key]: e.target.value }))}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  rows={f.key === "ssh_private_key" ? 5 : 3}
                />
              ) : (
                <input
                  type={f.secret && !reveal ? "password" : "text"}
                  value={extra[f.key] ?? ""}
                  onChange={(e) => setExtra((x) => ({ ...x, [f.key]: e.target.value }))}
                  inputMode={f.inputMode}
                  autoCapitalize={f.key.startsWith("id_") || f.key === "card_holder" ? "words" : "none"}
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
              {f.secret && (
                <button className="icon-btn" aria-label={reveal ? t("pw.hide_named", { field: t(f.label) }) : t("pw.show_named", { field: t(f.label) })} onClick={(e) => { e.preventDefault(); setReveal(!reveal); }}>
                  {reveal ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              )}
            </div>
          </Field>
        ))}
        {type === "login" && (
          <>
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
          </>
        )}
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
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={type === "note" ? undefined : t("pw.optional")} rows={type === "note" ? 8 : undefined} />
          </div>
        </Field>
        <Field label={t("pw.attachments")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {attachments.length > 0 && (
              <div className="panel">
                {attachments.map((a, i) => (
                  <div key={a.blob_id} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 52 }}>
                    <Paperclip size={18} aria-hidden />
                    <span className="row-text">
                      <span className="row-title">{a.name}</span>
                      <span className="row-sub">{formatBytes(a.size_bytes)}</span>
                    </span>
                    <button className="icon-btn" aria-label={t("pw.remove_attachment", { name: a.name })} onClick={(e) => { e.preventDefault(); detach(a); }}>
                      <X size={20} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button className="btn secondary" disabled={attaching !== null} aria-busy={attaching !== null} onClick={(e) => { e.preventDefault(); void attach(); }}>
              <Paperclip size={20} />
              {attaching ? t("pw.attaching", { name: attaching }) : t("pw.attach_file")}
            </button>
          </div>
        </Field>
        <Field label={t("pw.field_protection")}>
          <label className="check-label" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input type="checkbox" checked={reauth} onChange={(e) => setReauth(e.target.checked)} />
            <span>{t("pw.reauth_option_phone")}</span>
          </label>
          <p className="hint small">{t("pw.reauth_hint")}</p>
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
