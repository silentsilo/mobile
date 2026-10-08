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

type FieldRow = { key: string; label: string; value: string; secret?: boolean; mono?: boolean };

function fieldsFor(entry: PasswordEntry): FieldRow[] {
  const rows: Omit<FieldRow, "key">[] = [];
  switch (typeOf(entry)) {
    case "login":
      rows.push({ label: "Username", value: entry.username }, { label: "Password", value: entry.password, secret: true }, { label: "Website", value: entry.url });
      break;
    case "card": {
      const exp = [entry.card_exp_month, entry.card_exp_year].filter(Boolean).join(" / ");
      rows.push(
        { label: "Cardholder", value: entry.card_holder ?? "" },
        { label: "Number", value: groupCardNumber(cardDigits(entry)), secret: true, mono: true },
        { label: "Expires", value: exp },
        { label: "Security code", value: entry.card_code ?? "", secret: true, mono: true },
      );
      break;
    }
    case "identity": {
      const address = [entry.id_address, entry.id_city, entry.id_state, entry.id_zip, entry.id_country].filter(Boolean).join(", ");
      rows.push(
        { label: "Name", value: entry.id_full_name ?? "" },
        { label: "Email", value: entry.id_email ?? "" },
        { label: "Phone", value: entry.id_phone ?? "" },
        { label: "Company", value: entry.id_company ?? "" },
        { label: "Address", value: address },
      );
      break;
    }
    case "ssh_key":
      rows.push(
        { label: "Fingerprint", value: entry.ssh_fingerprint ?? "", mono: true },
        { label: "Public key", value: entry.ssh_public_key ?? "", mono: true },
        { label: "Private key", value: entry.ssh_private_key ?? "", secret: true, mono: true },
      );
      break;
    case "note":
      break;
  }
  const custom = (entry.fields ?? []).map((f, i) => ({
    key: `field-${i}`,
    label: f.name || (f.hidden ? "Hidden field" : "Field"),
    value: f.value,
    secret: f.hidden,
  }));
  // A protected entry's notes are one of its secrets, as on desktop.
  const notes = entry.notes
    ? [{ key: "Notes", label: "Notes", value: entry.notes, secret: typeOf(entry) === "note" || notesAreSecret(entry) }]
    : [];
  return [...rows.map((r) => ({ ...r, key: r.label })), ...custom, ...notes].filter((r) => r.value);
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

  const copy = async (label: string, value: string) => {
    if (!(await confirm())) return;
    try {
      await api.copySecret(entry, value, label.toLowerCase());
      toast(`${label} copied. It clears from the clipboard after 45 seconds.`);
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
      toast("Restored. The version it replaced is in the history.");
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
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
        backLabel="Passwords"
        right={
          editable ? (
            <button className="text-btn" onClick={() => void confirm().then((ok) => ok && onEdit())}>
              Edit
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
                  <button className="icon-btn" aria-label={shown ? `Hide ${row.label}` : `Show ${row.label}`} onClick={() => void toggle(row.key)}>
                    {shown ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                )}
                <button className="icon-btn" aria-label={`Copy ${row.label}`} onClick={() => copy(row.label, row.value)}>
                  <Copy size={20} />
                </button>
              </div>
            );
          })}
          {entry.totp_secret && (
            <div className="row divide" style={{ minHeight: 72, paddingRight: 6 }}>
              <div className="row-text" style={{ gap: 4 }}>
                <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                  One-time code
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-code)", fontWeight: 700, letterSpacing: "0.14em" }}>
                  {verified ? spaced(totp.code) : "••• •••"}
                </span>
              </div>
              <svg width="30" height="30" viewBox="0 0 30 30" aria-label={`${totp.left} seconds left`} style={{ flex: "none" }}>
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
                <text x="15" y="19" textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--text-muted)">
                  {totp.left}
                </text>
              </svg>
              <button className="icon-btn" aria-label="Copy one-time code" onClick={() => copy("One-time code", totp.code)} disabled={!totp.code}>
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
                  Passkey
                </span>
                <span>
                  {entry.passkey.user_name || entry.passkey.user_display_name || "Account"} on {entry.passkey.rp_id}
                </span>
                <span className="muted caption">
                  Added {formatDay(entry.passkey.created_at)}
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
              <span className="row-text">Earlier versions ({history.length})</span>
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
                        {changed.length > 0 ? `Next change: ${changed.join(", ")}` : "No change"}
                      </span>
                      {version.password && (
                        <span className={`field-value mono${shown ? "" : " masked"}`}>
                          {shown ? version.password : "••••••••"}
                        </span>
                      )}
                    </div>
                    {version.password && (
                      <button className="icon-btn" aria-label={shown ? "Hide this password" : "Show this password"} onClick={() => void toggle(key)}>
                        {shown ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    )}
                    <button className="text-btn" disabled={busy} onClick={() => void restore(version)}>
                      Restore
                    </button>
                  </div>
                );
              })}
            {historyOpen && (
              <button className="row divide text-btn danger" style={{ minHeight: 52 }} disabled={busy} onClick={() => setConfirmClear(true)}>
                Clear history
              </button>
            )}
          </div>
        )}

        {!editable && <p className="hint small" style={{ padding: "0 4px" }}>Edit this kind of entry in SilentSilo on your computer.</p>}
      </div>

      <Sheet open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear this entry's history?">
        <p className="hint">
          The earlier versions of {entry.service}, with their passwords, are removed from every device on the next sync.
          The current version stays.
        </p>
        <button className="btn danger" onClick={() => void clearHistory()} disabled={busy}>
          Clear history
        </button>
        <button className="btn secondary" onClick={() => setConfirmClear(false)} disabled={busy}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
