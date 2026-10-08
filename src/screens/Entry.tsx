import { Copy, Eye, EyeOff, History } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { formatDate, formatDay } from "../shared/format";
import { changedLabels, restoredFrom, withoutHistory } from "../shared/entryHistory";
import { cardDigits, groupCardNumber, avatarColor, inkOn, notesAreSecret, serviceInitials, typeOf } from "../shared/passwordUtil";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, generateTotp, totpSecondsRemaining } from "../shared/totp";
import type { HistoryVersion, PasswordEntry } from "../shared/types";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { ensureVerified, recentlyVerified } from "../ui/reverify";
import { haptic } from "../ui/haptics";
import { t, useLocale, type Key } from "../i18n";

/** `audit` is the field as the activity log records it: the English label in
 * lower case, as before the labels were translated, or a custom field's own
 * name. It also keys what is revealed, so a language change hides nothing. */
type FieldRow = { key: string; audit: string; label: string; value: string; secret?: boolean; mono?: boolean };

/** A built-in field: its English name for the log, its label on screen. */
function builtIn(audit: string, label: Key, value: string, extra: { secret?: boolean; mono?: boolean } = {}): FieldRow {
  return { key: audit, audit, label: t(label), value, ...extra };
}

function fieldsFor(entry: PasswordEntry): FieldRow[] {
  const rows: FieldRow[] = [];
  switch (typeOf(entry)) {
    case "login":
      rows.push(
        builtIn("username", "pw.field_username", entry.username),
        builtIn("password", "pw.field_password", entry.password, { secret: true }),
        builtIn("website", "pw.field_website", entry.url),
      );
      break;
    case "card": {
      const exp = [entry.card_exp_month, entry.card_exp_year].filter(Boolean).join(" / ");
      rows.push(
        builtIn("cardholder", "pw.field_cardholder", entry.card_holder ?? ""),
        builtIn("number", "pw.field_number", groupCardNumber(cardDigits(entry)), { secret: true, mono: true }),
        builtIn("expires", "pw.field_expires", exp),
        builtIn("security code", "pw.field_security_code", entry.card_code ?? "", { secret: true, mono: true }),
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
        builtIn("private key", "pw.field_private_key", entry.ssh_private_key ?? "", { secret: true, mono: true }),
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
  }));
  // A protected entry's notes are one of its secrets, as on desktop.
  const notes = entry.notes
    ? [{ key: "Notes", audit: "notes", label: t("pw.field_notes"), value: entry.notes, secret: typeOf(entry) === "note" || notesAreSecret(entry) }]
    : [];
  return [...rows, ...custom, ...notes].filter((r) => r.value);
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
  onEdit: () => void;
  /** A restore or a cleared history, already stored. */
  onChanged: (entry: PasswordEntry) => void;
}) {
  useLocale();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const history = entry.history ?? [];
  const toast = useToast();
  const totp = useTotp(entry);
  const bg = avatarColor(entry.service);
  const editable = typeOf(entry) === "login";

  // An entry marked to ask again shows and copies nothing until the
  // fingerprint confirms it; one confirmation covers a few minutes.
  const [verified, setVerified] = useState(() => recentlyVerified(entry));
  const confirm = async (): Promise<boolean> => {
    if (verified) return true;
    try {
      await ensureVerified(entry);
      setVerified(true);
      return true;
    } catch (e) {
      toast(formatAppError(e));
      return false;
    }
  };

  /** `audit` is the field's name in the activity log, kept in English. */
  const copy = async (label: string, audit: string, value: string) => {
    if (!(await confirm())) return;
    try {
      await api.copySecret(entry, value, audit);
      haptic("confirm");
      toast(t("pw.field_copied", { field: label }));
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const toggle = async (label: string) => {
    if (!revealed.has(label)) {
      if (!(await confirm())) return;
      try {
        await api.noteRevealed(entry);
      } catch (e) {
        toast(formatAppError(e));
        return;
      }
    }
    const next = new Set(revealed);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setRevealed(next);
  };

  /// A restore changes the secret, so it asks like an edit does. Not asked
  /// about: the current version goes into the history, so it can be undone.
  const restore = async (version: HistoryVersion) => {
    if (!(await confirm())) return;
    setBusy(true);
    try {
      onChanged(await api.savePassword(entry, restoredFrom(entry, version, Date.now()), "restored"));
      toast(t("pw.restored"));
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    haptic("heavy");
    setBusy(true);
    try {
      onChanged(await api.savePassword(entry, withoutHistory(entry), "history_cleared"));
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
          editable ? (
            <button className="text-btn" onClick={() => void confirm().then((ok) => ok && onEdit())}>
              {t("pw.edit")}
            </button>
          ) : undefined
        }
      />
      <div className="screen-body tight" style={{ gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 4px" }}>
          <span className="avatar large" style={{ background: bg, color: inkOn(bg) }}>
            {serviceInitials(entry.service)}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 className="title headline">
              {entry.service}
            </h1>
            {entry.url && <span className="muted small">{entry.url.replace(/^https?:\/\//, "")}</span>}
          </div>
        </div>

        <div className="panel">
          {fieldsFor(entry).map((row, i) => {
            const shown = !row.secret || revealed.has(row.key);
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
                <button className="icon-btn" aria-label={t("pw.copy_named", { field: row.label })} onClick={() => copy(row.label, row.audit, row.value)}>
                  <Copy size={20} />
                </button>
              </div>
            );
          })}
          {entry.totp_secret && (
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
              <button className="icon-btn" aria-label={t("pw.copy_one_time_code")} onClick={() => copy(t("pw.one_time_code"), "one-time code", totp.code)} disabled={!totp.code}>
                <Copy size={20} />
              </button>
            </div>
          )}
        </div>

        {entry.passkey && (
          <div className="panel">
            <div className="row" style={{ minHeight: 68 }}>
              <div className="row-text" style={{ gap: 4 }}>
                <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                  {t("pw.passkey")}
                </span>
                <span>
                  {t("pw.passkey_account", {
                    user: entry.passkey.user_name || entry.passkey.user_display_name || t("pw.passkey_account_unnamed"),
                    site: entry.passkey.rp_id,
                  })}
                </span>
                <span className="muted caption">
                  {t("pw.passkey_added", { date: formatDay(entry.passkey.created_at) })}
                </span>
              </div>
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
                const newer = i === 0 ? entry : history[i - 1];
                const changed = changedLabels(version, newer);
                const key = `history-${i}`;
                const shown = revealed.has(key);
                return (
                  <div key={key} className="row divide" style={{ minHeight: 68, paddingRight: 6, alignItems: "center" }}>
                    <div className="row-text" style={{ gap: 4 }}>
                      <span>{formatDate(version.saved_at)}</span>
                      <span className="muted caption">
                        {changed.length > 0 ? t("pw.history_next_change", { changes: changed.join(", ") }) : t("pw.history_no_change")}
                      </span>
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
                    <button className="text-btn" disabled={busy} onClick={() => void restore(version)}>
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

        {!editable && <p className="hint small" style={{ padding: "0 4px" }}>{t("pw.edit_on_computer")}</p>}
      </div>

      <Sheet open={confirmClear} onClose={() => setConfirmClear(false)} title={t("pw.clear_history_title")}>
        <p className="hint">{t("pw.clear_history_synced", { name: entry.service })}</p>
        <button className="btn danger" onClick={() => void clearHistory()} disabled={busy}>
          {t("pw.clear_history")}
        </button>
        <button className="btn secondary" onClick={() => setConfirmClear(false)} disabled={busy}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
