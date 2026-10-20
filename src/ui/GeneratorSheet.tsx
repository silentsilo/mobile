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
      <div className="chips" role="tablist" aria-label={t("pw.generate_password")} style={{ padding: 0 }}>
        {(["characters", "words"] as const).map((kind) => (
          <button key={kind} className="chip" role="tab" aria-selected={opts.kind === kind} onClick={() => setOpts({ ...opts, kind })}>
            {kind === "words" ? t("pw.gen_kind_words") : t("pw.gen_kind_characters")}
          </button>
        ))}
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="label">{opts.kind === "words" ? t("pw.gen_words") : t("pw.gen_length")}</span>
          <span style={{ fontWeight: 700 }}>{opts.kind === "words" ? opts.words : opts.length}</span>
        </span>
        <input
          type="range"
          min={opts.kind === "words" ? 3 : 8}
          max={opts.kind === "words" ? 12 : 64}
          value={opts.kind === "words" ? opts.words : opts.length}
          onChange={(e) =>
            setOpts(opts.kind === "words" ? { ...opts, words: Number(e.target.value) } : { ...opts, length: Number(e.target.value) })
          }
          style={{ width: "100%", accentColor: "var(--accent)", minHeight: 28 }}
        />
      </label>
      {opts.kind === "words" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label">{t("pw.gen_separator")}</span>
            <div className="chips" role="tablist" aria-label={t("pw.gen_separator")} style={{ padding: 0 }}>
              {(["-", " ", ".", "_"] as const).map((separator) => (
                <button key={separator} className="chip" role="tab" aria-selected={opts.separator === separator} onClick={() => setOpts({ ...opts, separator })}>
                  {separator === " " ? t("pw.gen_space") : separator}
                </button>
              ))}
            </div>
          </div>
          <div className="panel">
            <ToggleRow first label={t("pw.gen_capitalize")} checked={opts.capitalize} onChange={() => setOpts({ ...opts, capitalize: !opts.capitalize })} />
            <ToggleRow label={t("pw.gen_number")} checked={opts.number} onChange={() => setOpts({ ...opts, number: !opts.number })} />
          </div>
        </>
      ) : (
        <div className="panel">
          {toggles.map(({ key, label }, i) => (
            <ToggleRow key={key} first={i === 0} label={label} checked={opts[key]} onChange={() => setOpts({ ...opts, [key]: !opts[key] })} />
          ))}
        </div>
      )}
      <button className="btn" onClick={() => onUse(value)}>
        {t("pw.gen_use")}
      </button>
    </Sheet>
  );
}
