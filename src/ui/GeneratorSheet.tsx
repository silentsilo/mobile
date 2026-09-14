import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_GEN_OPTIONS, generatePassword, passwordStrength, type PasswordGenOptions } from "../shared/passwordUtil";
import { Sheet } from "./chrome";

export function GeneratorSheet({ open, onClose, onUse }: { open: boolean; onClose: () => void; onUse: (password: string) => void }) {
  const [opts, setOpts] = useState<PasswordGenOptions>(DEFAULT_GEN_OPTIONS);
  const [value, setValue] = useState(() => generatePassword(DEFAULT_GEN_OPTIONS));

  useEffect(() => {
    setValue(generatePassword(opts));
  }, [opts]);

  const strength = passwordStrength(value);
  const toggles: { key: "upper" | "digits" | "symbols"; label: string }[] = [
    { key: "upper", label: "Uppercase letters" },
    { key: "digits", label: "Digits" },
    { key: "symbols", label: "Symbols" },
  ];

  return (
    <Sheet open={open} onClose={onClose} title="Generate a password">
      <div className="panel" style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: "6px 6px 6px 16px", background: "var(--field-bg)" }}>
        <span className="mono" style={{ flex: 1, fontSize: "1.12rem", fontWeight: 600, wordBreak: "break-all" }}>
          {value}
        </span>
        <button className="icon-btn" aria-label="Generate another" onClick={() => setValue(generatePassword(opts))}>
          <RefreshCw size={20} />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4 }}>
          {[1, 2, 3, 4].map((i) => (
            <span key={i} style={{ height: 4, borderRadius: 2, background: i <= strength.score ? strength.color : "var(--surface-muted)" }} />
          ))}
        </div>
        <span style={{ fontSize: "0.82rem", fontWeight: 650, color: strength.color }}>{strength.label}</span>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="label">Length</span>
          <span style={{ fontWeight: 700 }}>{opts.length}</span>
        </span>
        <input
          type="range"
          min={8}
          max={64}
          value={opts.length}
          onChange={(e) => setOpts({ ...opts, length: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "var(--accent)", minHeight: 28 }}
        />
      </label>
      <div className="panel">
        {toggles.map(({ key, label }) => (
          <div key={key} className="row" style={{ minHeight: 56, justifyContent: "space-between" }}>
            <span>{label}</span>
            <button
              className="switch"
              role="switch"
              aria-checked={opts[key]}
              aria-label={label}
              onClick={() => setOpts({ ...opts, [key]: !opts[key] })}
            />
          </div>
        ))}
      </div>
      <button className="btn" onClick={() => onUse(value)}>
        Use this password
      </button>
    </Sheet>
  );
}
