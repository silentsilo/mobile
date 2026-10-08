import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_GEN_OPTIONS, generatePassword, passwordStrength, type PasswordGenOptions } from "../shared/passwordUtil";
import { Sheet, ToggleRow } from "./chrome";
import { t, useLocale } from "../i18n";

export function GeneratorSheet({ open, onClose, onUse }: { open: boolean; onClose: () => void; onUse: (password: string) => void }) {
  useLocale();
  const [opts, setOpts] = useState<PasswordGenOptions>(DEFAULT_GEN_OPTIONS);
  const [value, setValue] = useState(() => generatePassword(DEFAULT_GEN_OPTIONS));

  useEffect(() => {
    setValue(generatePassword(opts));
  }, [opts]);

  const strength = passwordStrength(value);
  const toggles: { key: "upper" | "digits" | "symbols"; label: string }[] = [
    { key: "upper", label: t("pw.gen_upper") },
    { key: "digits", label: t("pw.gen_digits") },
    { key: "symbols", label: t("pw.gen_symbols") },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={t("pw.generate_password")}>
      <div className="panel" style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: "6px 6px 6px 16px", background: "var(--surface-2)" }}>
        <span className="mono" style={{ flex: 1, fontSize: "var(--fs-heading)", fontWeight: 600, wordBreak: "break-all" }}>
          {value}
        </span>
        <button className="icon-btn" aria-label={t("pw.gen_another")} onClick={() => setValue(generatePassword(opts))}>
          <RefreshCw size={20} />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4 }}>
          {[1, 2, 3, 4].map((i) => (
            <span key={i} style={{ height: 4, borderRadius: 2, background: i <= strength.score ? strength.color : "var(--surface-2)" }} />
          ))}
        </div>
        <span className="caption" style={{ fontWeight: 650, color: strength.color }}>{strength.label}</span>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="label">{t("pw.gen_length")}</span>
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
        {toggles.map(({ key, label }, i) => (
          <ToggleRow key={key} first={i === 0} label={label} checked={opts[key]} onChange={() => setOpts({ ...opts, [key]: !opts[key] })} />
        ))}
      </div>
      <button className="btn" onClick={() => onUse(value)}>
        {t("pw.gen_use")}
      </button>
    </Sheet>
  );
}
