import { Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { cardDigits, groupCardNumber, hashColor, inkOn, serviceInitials, typeOf } from "../shared/passwordUtil";
import { DEFAULT_TOTP_ALGORITHM, DEFAULT_TOTP_DIGITS, DEFAULT_TOTP_PERIOD, generateTotp, totpSecondsRemaining } from "../shared/totp";
import type { PasswordEntry } from "../shared/types";
import { TopBar, useToast } from "../ui/chrome";

type FieldRow = { label: string; value: string; secret?: boolean; mono?: boolean };

function fieldsFor(entry: PasswordEntry): FieldRow[] {
  const rows: FieldRow[] = [];
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
  if (entry.notes) rows.push({ label: "Notes", value: entry.notes, secret: typeOf(entry) === "note" });
  return rows.filter((r) => r.value);
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

export function Entry({ entry, onBack, onEdit }: { entry: PasswordEntry; onBack: () => void; onEdit: () => void }) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const toast = useToast();
  const totp = useTotp(entry);
  const bg = hashColor(entry.service);
  const editable = typeOf(entry) === "login";

  const copy = async (label: string, value: string) => {
    try {
      await api.copySecret(value);
      toast(`${label} copied. It clears from the clipboard after 30 seconds.`);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const toggle = (label: string) => {
    const next = new Set(revealed);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setRevealed(next);
  };

  const circumference = 2 * Math.PI * 12;

  return (
    <div className="screen">
      <TopBar
        onBack={onBack}
        backLabel="Passwords"
        right={
          editable ? (
            <button className="text-btn" onClick={onEdit}>
              Edit
            </button>
          ) : undefined
        }
      />
      <div className="screen-body tight" style={{ gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 4px" }}>
          <span className="avatar" style={{ width: 56, height: 56, borderRadius: 12, fontSize: "1rem", background: bg, color: inkOn(bg) }}>
            {serviceInitials(entry.service)}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 className="title" style={{ fontSize: "1.5rem" }}>
              {entry.service}
            </h1>
            {entry.url && <span className="muted" style={{ fontSize: "0.9rem" }}>{entry.url.replace(/^https?:\/\//, "")}</span>}
          </div>
        </div>

        <div className="panel">
          {fieldsFor(entry).map((row, i) => {
            const shown = !row.secret || revealed.has(row.label);
            return (
              <div key={row.label} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 68, paddingRight: 6, alignItems: "center" }}>
                <div className="row-text" style={{ gap: 4 }}>
                  <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                    {row.label}
                  </span>
                  <span
                    className={row.mono ? "mono" : undefined}
                    style={{ fontSize: "1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: row.label === "Notes" ? "pre-wrap" : "nowrap", letterSpacing: shown ? undefined : "0.12em" }}
                  >
                    {shown ? row.value : "••••••••••••••••"}
                  </span>
                </div>
                {row.secret && (
                  <button className="icon-btn" aria-label={shown ? `Hide ${row.label}` : `Show ${row.label}`} onClick={() => toggle(row.label)}>
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
                <span className="mono" style={{ fontSize: "1.4rem", fontWeight: 700, letterSpacing: "0.14em" }}>
                  {spaced(totp.code)}
                </span>
              </div>
              <svg width="30" height="30" viewBox="0 0 30 30" aria-label={`${totp.left} seconds left`} style={{ flex: "none" }}>
                <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(139, 92, 246, 0.18)" strokeWidth="3" />
                <circle
                  cx="15"
                  cy="15"
                  r="12"
                  fill="none"
                  stroke="var(--accent-hover)"
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
              <button className="icon-btn" aria-label="Copy one-time code" onClick={() => copy("Code", totp.code)} disabled={!totp.code}>
                <Copy size={20} />
              </button>
            </div>
          )}
        </div>

        {!editable && <p className="hint small" style={{ padding: "0 4px" }}>Edit this kind of entry in SilentSilo on your computer.</p>}
      </div>
    </div>
  );
}
