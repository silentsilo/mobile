import { Copy, Eye, EyeOff, History, Paperclip, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes, formatDate, formatDay } from "../shared/format";
import { withEdits } from "../shared/passwordEntry";
import { changedLabels, restoredFrom, withoutHistory } from "../shared/entryHistory";
import { cardDigits, groupCardNumber, avatarColor, inkOn, notesAreSecret, serviceInitials, typeOf } from "../shared/passwordUtil";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, generateTotp, totpSecondsRemaining } from "../shared/totp";
import type { HistoryVersion, PasswordAttachment, PasswordEntry } from "../shared/types";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { HandOverSheet, type HandOverHow } from "../ui/HandOver";
import { isProtected, keepVerified, recentlyVerified, revealed, verifiedUntil } from "../ui/reverify";
import { haptic } from "../ui/haptics";
import { t, useLocale, type Key } from "../i18n";

/** `audit` is the field as the activity log records it: the English label in
 * lower case, as before the labels were translated, or a custom field's own
 * name. It also keys what is revealed, so a language change hides nothing. */
type FieldRow = { key: string; audit: string; label: string; value: string; secret?: boolean; mono?: boolean; held?: boolean };

/** A built-in field: its English name for the log, its label on screen. */
function builtIn(audit: string, label: Key, value: string, extra: { secret?: boolean; mono?: boolean; held?: boolean } = {}): FieldRow {
  return { key: audit, audit, label: t(label), value, ...extra };
}

/** `held` marks a secret the list read without its value: it shows masked
 * until the fingerprint brings the entry whole. */
function fieldsFor(entry: PasswordEntry): FieldRow[] {
  const withheld = new Set(entry.secrets_withheld ?? []);
  const held = (field: string) => withheld.has(field);
  const rows: FieldRow[] = [];
  switch (typeOf(entry)) {
    case "login":
      rows.push(
        builtIn("username", "pw.field_username", entry.username),
        builtIn("password", "pw.field_password", entry.password, { secret: true, held: held("password") }),
        builtIn("website", "pw.field_website", entry.url),
      );
      break;
    case "card": {
      const exp = [entry.card_exp_month, entry.card_exp_year].filter(Boolean).join(" / ");
      rows.push(
        builtIn("cardholder", "pw.field_cardholder", entry.card_holder ?? ""),
        builtIn("number", "pw.field_number", groupCardNumber(cardDigits(entry)), { secret: true, mono: true, held: held("card_number") }),
        builtIn("expires", "pw.field_expires", exp),
        builtIn("security code", "pw.field_security_code", entry.card_code ?? "", { secret: true, mono: true, held: held("card_code") }),
      );
      break;
    }
    case "identity": {
      const address = [entry.id_address, entry.id_city, entry.id_state, entry.id_zip, entry.id_country].filter(Boolean).join(", ");
      rows.push(
        builtIn("name", "pw.field_person_name", entry.id_full_name ?? ""),
        builtIn("email", "pw.field_email", entry.id_email ?? ""),
        builtIn("phone", "pw.field_phone", entry.id_phone ?? ""),
        builtIn("company", "pw.field_company", entry.id_company ?? ""),
        builtIn("address", "pw.field_address", address),
      );
      break;
    }
    case "ssh_key":
      rows.push(
        builtIn("fingerprint", "pw.field_fingerprint", entry.ssh_fingerprint ?? "", { mono: true }),
        builtIn("public key", "pw.field_public_key", entry.ssh_public_key ?? "", { mono: true }),
        builtIn("private key", "pw.field_private_key", entry.ssh_private_key ?? "", { secret: true, mono: true, held: held("ssh_private_key") }),
      );
      break;
    case "note":
      break;
  }
  const custom = (entry.fields ?? []).map((f, i) => ({
    key: `field-${i}`,
    audit: (f.name || (f.hidden ? "Hidden field" : "Field")).toLowerCase(),
    label: f.name || (f.hidden ? t("pw.hidden_field") : t("pw.field")),
    value: f.value,
    secret: f.hidden,
    held: f.hidden && entry.secrets_withheld !== undefined,
  }));
  // A protected entry's notes are one of its secrets, as on desktop.
  const notes =
    entry.notes || held("notes")
      ? [{ key: "Notes", audit: "notes", label: t("pw.field_notes"), value: entry.notes, secret: typeOf(entry) === "note" || notesAreSecret(entry), held: held("notes") }]
      : [];
  return [...rows, ...custom, ...notes].filter((r) => r.value || r.held);
}

function useTotp(entry: PasswordEntry) {
  const period = entry.totp_period ?? DEFAULT_TOTP_PERIOD;
  const [code, setCode] = useState("");
  const [left, setLeft] = useState(() => totpSecondsRemaining(period));

  useEffect(() => {
    if (!entry.totp_secret) return;
    let window = -1;
    const tick = () => {
      const now = Date.now();
      setLeft(totpSecondsRemaining(period, now));
      const current = Math.floor(now / 1000 / period);
      if (current !== window) {
        window = current;
        void generateTotp(
          {
            secret: entry.totp_secret!,
            digits: entry.totp_digits ?? DEFAULT_TOTP_DIGITS,
            period,
            algorithm: entry.totp_algorithm ?? DEFAULT_TOTP_ALGORITHM,
          },
          now,
        ).then(setCode);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [entry.totp_secret, entry.totp_digits, entry.totp_algorithm, period]);

  return { code, left, period };
}

function spaced(code: string) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function Entry({
  entry,
  onBack,
  onEdit,
  onChanged,
}: {
  entry: PasswordEntry;
  onBack: () => void;
  /** The entry whole, after the fingerprint for one that asks. */
  onEdit: (entry: PasswordEntry) => void;
  /** A restore or a cleared history, already stored. */
  onChanged: (entry: PasswordEntry) => void;
}) {
  useLocale();
  const [shownFields, setShownFields] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // An entry marked to ask again comes from the list without its secrets:
  // nothing shows or copies until the fingerprint brings it whole, and one
  // confirmation covers a few minutes, then it hides again.
  const [full, setFull] = useState<PasswordEntry | null>(() => recentlyVerified(entry));
  const view = full ?? entry;
  const verified = full !== null;
  // A save from here hands the entry back; the whole one follows it.
  useEffect(() => setFull(recentlyVerified(entry)), [entry]);
  useEffect(() => {
    if (!full || !isProtected(entry)) return;
    const left = (verifiedUntil(entry) ?? 0) - Date.now();
    const timer = window.setTimeout(() => {
      setFull(null);
      setShownFields(new Set());
    }, Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [full, entry]);
  const confirm = async (): Promise<PasswordEntry | null> => {
    if (full) return full;
    try {
      const whole = await revealed(entry);
      setFull(whole);
      return whole;
    } catch (e) {
      toast(formatAppError(e));
      return null;
    }
  };
  /** A save of the entry whole keeps it shown whole. */
  const changedTo = (saved: PasswordEntry) => {
    keepVerified(saved);
    onChanged(saved);
  };

  const history = view.history ?? [];
  const totp = useTotp(view);
  const bg = avatarColor(view.service);
  // An attached file opens in another app; the one being readied is shown.
  const [opening, setOpening] = useState<string | null>(null);
  const [handing, setHanding] = useState<PasswordAttachment | null>(null);
  const openAttachment = async (attachment: PasswordAttachment, how: HandOverHow) => {
    setHanding(null);
    setOpening(attachment.blob_id);
    try {
      const whole = await confirm();
      if (!whole) return;
      if ((await api.openAttachment(whole, attachment, how)) && how === "save") toast(t("files.saved_to_phone"));
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setOpening(null);
    }
  };
  // Starring changes nothing the entry says, so it is not an edit.
  const star = async () => {
    try {
      changedTo(await api.savePassword(view, withEdits(view, { favorite: !view.favorite }), "arranged"));
      haptic("tick");
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  /** The row's value as the whole entry has it; `audit` is the field's name
   * in the activity log, kept in English. */
  const copy = async (key: string) => {
    const whole = await confirm();
    const row = whole && fieldsFor(whole).find((r) => r.key === key);
    if (!whole || !row) return;
    try {
      await api.copySecret(whole, row.value, row.audit);
      haptic("confirm");
      toast(t("pw.field_copied", { field: row.label }));
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const copyCode = async () => {
    const whole = await confirm();
    if (!whole?.totp_secret) return;
    try {
      const code = await generateTotp(
        {
          secret: whole.totp_secret,
          digits: whole.totp_digits ?? DEFAULT_TOTP_DIGITS,
          period: whole.totp_period ?? DEFAULT_TOTP_PERIOD,
          algorithm: whole.totp_algorithm ?? DEFAULT_TOTP_ALGORITHM,
        },
        Date.now(),
      );
      await api.copySecret(whole, code, "one-time code");
      haptic("confirm");
      toast(t("pw.field_copied", { field: t("pw.one_time_code") }));
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const toggle = async (label: string) => {
    if (!shownFields.has(label)) {
      const whole = await confirm();
      if (!whole) return;
      try {
        await api.noteRevealed(whole);
      } catch (e) {
        toast(formatAppError(e));
        return;
      }
    }
    setShownFields((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  /// A restore changes the secret, so it asks like an edit does. Not asked
  /// about: the current version goes into the history, so it can be undone.
  const restore = async (index: number) => {
    const whole = await confirm();
    const version: HistoryVersion | undefined = whole?.history?.[index];
    if (!whole || !version) return;
    setBusy(true);
    try {
      changedTo(await api.savePassword(whole, restoredFrom(whole, version, Date.now()), "restored"));
      toast(t("pw.restored"));
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    haptic("heavy");
    const whole = await confirm();
    if (!whole) return;
    setBusy(true);
    try {
      changedTo(await api.savePassword(whole, withoutHistory(whole), "history_cleared"));
      setConfirmClear(false);
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const circumference = 2 * Math.PI * 12;

  return (
    <div className="screen">
      <TopBar
        onBack={onBack}
        backLabel={t("pw.back_passwords")}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              className="icon-btn"
              aria-pressed={Boolean(view.favorite)}
              aria-label={view.favorite ? t("pw.unfavorite") : t("pw.favorite")}
              onClick={() => void star()}
            >
              <Star size={22} fill={view.favorite ? "var(--warning)" : "none"} color={view.favorite ? "var(--warning)" : undefined} />
            </button>
            <button className="text-btn" onClick={() => void confirm().then((whole) => whole && onEdit(whole))}>
              {t("pw.edit")}
            </button>
          </div>
        }
      />
      <div className="screen-body tight" style={{ gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 4px" }}>
          <span className="avatar large" style={{ background: bg, color: inkOn(bg) }}>
            {serviceInitials(view.service)}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 className="title headline">
              {view.service}
            </h1>
            {view.url && <span className="muted small">{view.url.replace(/^https?:\/\//, "")}</span>}
          </div>
        </div>

        <div className="panel">
          {fieldsFor(view).map((row, i) => {
            const shown = !row.secret || (verified && shownFields.has(row.key));
            return (
              <div key={row.key} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 68, paddingRight: 6, alignItems: "center" }}>
                <div className="row-text" style={{ gap: 4 }}>
                  <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                    {row.label}
                  </span>
                  {/* Shown values wrap: a long password is read whole, never cut short. */}
                  <span className={`field-value${row.mono ? " mono" : ""}${shown ? "" : " masked"}`}>
                    {shown ? row.value : "••••••••••••••••"}
                  </span>
                </div>
                {row.secret && (
                  <button className="icon-btn" aria-label={shown ? t("pw.hide_named", { field: row.label }) : t("pw.show_named", { field: row.label })} onClick={() => void toggle(row.key)}>
                    {shown ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                )}
                <button className="icon-btn" aria-label={t("pw.copy_named", { field: row.label })} onClick={() => void copy(row.key)}>
                  <Copy size={20} />
                </button>
              </div>
            );
          })}
          {(view.totp_secret || view.secrets_withheld?.includes("totp_secret")) && (
            <div className="row divide" style={{ minHeight: 72, paddingRight: 6 }}>
              <div className="row-text" style={{ gap: 4 }}>
                <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                  {t("pw.one_time_code")}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-code)", fontWeight: 700, letterSpacing: "0.14em" }}>
                  {verified ? spaced(totp.code) : "••• •••"}
                </span>
              </div>
              {/* Sized in em, so the seconds stay readable with large text. */}
              <span className="totp-ring" role="img" aria-label={t("pw.seconds_left", { count: totp.left })}>
                <svg viewBox="0 0 30 30" aria-hidden>
                  <circle cx="15" cy="15" r="12" fill="none" stroke="var(--surface-2)" strokeWidth="3" />
                  <circle
                    cx="15"
                    cy="15"
                    r="12"
                    fill="none"
                    stroke="var(--accent-text)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - totp.left / totp.period)}
                    transform="rotate(-90 15 15)"
                  />
                </svg>
                <span aria-hidden>{totp.left}</span>
              </span>
              <button className="icon-btn" aria-label={t("pw.copy_one_time_code")} onClick={() => void copyCode()} disabled={verified && !totp.code}>
                <Copy size={20} />
              </button>
            </div>
          )}
        </div>

        {view.passkey && (
          <div className="panel">
            <div className="row" style={{ minHeight: 68 }}>
              <div className="row-text" style={{ gap: 4 }}>
                <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                  {t("pw.passkey")}
                </span>
                <span>
                  {t("pw.passkey_account", {
                    user: view.passkey.user_name || view.passkey.user_display_name || t("pw.passkey_account_unnamed"),
                    site: view.passkey.rp_id,
                  })}
                </span>
                <span className="muted caption">
                  {t("pw.passkey_added", { date: formatDay(view.passkey.created_at) })}
                </span>
              </div>
            </div>
          </div>
        )}

        {(view.attachments ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              {t("pw.attachments")}
            </span>
            <div className="panel">
              {(view.attachments ?? []).map((attachment, i) => (
                <button
                  key={attachment.blob_id}
                  className={`row${i > 0 ? " divide" : ""}`}
                  style={{ minHeight: 60, width: "100%" }}
                  disabled={opening !== null}
                  aria-busy={opening === attachment.blob_id}
                  onClick={() => setHanding(attachment)}
                >
                  <Paperclip size={20} aria-hidden />
                  <span className="row-text">
                    <span className="row-title">{attachment.name}</span>
                    <span className="row-sub">
                      {opening === attachment.blob_id ? t("pw.attachment_opening") : formatBytes(attachment.size_bytes)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Closed until asked for: old passwords are secrets too. */}
        {history.length > 0 && (
          <div className="panel">
            <button className="row" style={{ minHeight: 56, width: "100%" }} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              <History size={20} />
              <span className="row-text">{t("pw.history_count", { count: history.length })}</span>
            </button>
            {historyOpen &&
              history.map((version, i) => {
                const newer = i === 0 ? view : history[i - 1];
                const changed = changedLabels(version, newer);
                const key = `history-${i}`;
                const shown = verified && shownFields.has(key);
                return (
                  <div key={key} className="row divide" style={{ minHeight: 68, paddingRight: 6, alignItems: "center" }}>
                    <div className="row-text" style={{ gap: 4 }}>
                      <span>{formatDate(version.saved_at)}</span>
                      <span className="muted caption">
                        {changed.length > 0 ? t("pw.history_next_change", { changes: changed.join(", ") }) : t("pw.history_no_change")}
                      </span>
                      {version.conflict && <span className="muted caption">{t("pw.history_conflict")}</span>}
                      {version.password && (
                        <span className={`field-value mono${shown ? "" : " masked"}`}>
                          {shown ? version.password : "••••••••"}
                        </span>
                      )}
                    </div>
                    {version.password && (
                      <button className="icon-btn" aria-label={shown ? t("pw.hide_this_password") : t("pw.show_this_password")} onClick={() => void toggle(key)}>
                        {shown ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    )}
                    <button className="text-btn" disabled={busy} onClick={() => void restore(i)}>
                      {t("pw.history_restore")}
                    </button>
                  </div>
                );
              })}
            {historyOpen && (
              <button className="row divide text-btn danger" style={{ minHeight: 52 }} disabled={busy} onClick={() => setConfirmClear(true)}>
                {t("pw.clear_history")}
              </button>
            )}
          </div>
        )}

      </div>

      <Sheet open={confirmClear} onClose={() => setConfirmClear(false)} title={t("pw.clear_history_title")}>
        <p className="hint">{t("pw.clear_history_synced", { name: view.service })}</p>
        <button className="btn danger" onClick={() => void clearHistory()} disabled={busy}>
          {t("pw.clear_history")}
        </button>
        <button className="btn secondary" onClick={() => setConfirmClear(false)} disabled={busy}>
          {t("common.cancel")}
        </button>
      </Sheet>
      <HandOverSheet
        open={handing !== null}
        title={handing?.name}
        onClose={() => setHanding(null)}
        onChoose={(how) => handing && void openAttachment(handing, how)}
      />
    </div>
  );
}
